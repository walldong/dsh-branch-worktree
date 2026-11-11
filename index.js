/**
 * dsh-branch-worktree — one isolated git worktree per branch.
 *
 * Parallel sessions on the same repository never share a directory, so each
 * branch commits and opens its own PR. The Host owns the git writes because a
 * linked worktree's `.git` file points outside the sandbox.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
/** Managed worktrees live outside the repository, so a checkout never shows a stray untracked dir. */
const ROOT = join(homedir(), '.dsh', 'worktrees')

export const inject = ['tools', 'systemPrompt']

export function apply(ctx) {
  ctx.tools.register(tool(ctx))
  // The notice rides the agent's own scope, so it unwinds with the agent.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'branch-worktree:notice',
      order: 910,
      text: () => noticeOf(agent),
    }))
  })
}

function tool(ctx) {
  return {
    name: 'repo_branch',
    description: '在同一个仓库的不同分支上独立干活：每个分支一个隔离目录，互不影响，各自提交、各自开 PR。'
      + 'open（从主干开新分支和独立目录，Harness 侧边栏会多出一个同名项目）| status（当前目录的分支、改动数、领先提交数、PR）'
      + '| commit（提交当前目录的全部改动）| push（推到 origin）| pr（没有就开一个，未推送会先推送）'
      + '| list（仓库里所有分支目录）| close（删掉目录，分支和提交都保留）。'
      + '分支目录里的 .git 在沙箱外：git log / git diff 照常用，但要写 .git 的操作（add、commit、push、开 PR）都走这个工具。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '要做的操作', enum: ['open', 'status', 'commit', 'push', 'pr', 'list', 'close'] },
        branch: { type: 'string', description: '分支名，例如 feat/login。open 必填；close 省略时指当前目录' },
        from: { type: 'string', description: 'open 的起点分支，默认仓库主干' },
        message: { type: 'string', description: 'commit 的提交信息，一句说清改了什么' },
        title: { type: 'string', description: 'PR 标题，省略时用分支的提交信息' },
        body: { type: 'string', description: 'PR 正文' },
        base: { type: 'string', description: 'PR 的目标分支，默认仓库主干' },
        draft: { type: 'boolean', description: '开成草稿 PR' },
        force: { type: 'boolean', description: 'close 时丢弃未提交的改动' },
        deleteBranch: { type: 'boolean', description: 'close 时顺手删掉已合并的分支' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => act(ctx, args, exec),
  }
}

async function act(ctx, args, exec) {
  try {
    const cwd = await directoryOf(ctx, exec?.agent)
    if (!cwd) return { error: '不知道当前目录：这个 agent 没有工作目录' }
    switch (args.action) {
      case 'open': return await open(ctx, cwd, args)
      case 'status': return await status(cwd)
      case 'commit': return await commit(cwd, args)
      case 'push': return await push(cwd)
      case 'pr': return await openPr(cwd, args)
      case 'list': return await list(cwd)
      case 'close': return await close(cwd, args)
      default: return { error: `未知操作 ${args.action}` }
    }
  } catch (error) {
    return { error: String(error?.message || error) }
  }
}

/** The session's live directory when that service is composed, else the header's original project. */
async function directoryOf(ctx, agent) {
  const working = ctx.get?.('workingDirectory')
  if (working && agent) {
    try {
      const dir = await working.ensure(agent)
      if (dir) return dir
    } catch {}
  }
  return agent?.session?.header?.cwd
}

/**
 * Open a branch in its own worktree. Git refuses two checkouts of one branch,
 * so a repeated name fails instead of silently sharing a directory.
 */
async function open(ctx, cwd, args) {
  const repo = await repoOf(cwd)
  if (!repo) throw new Error('当前目录不在 git 仓库里')
  const branch = await checkedBranch(repo, args.branch)
  const path = worktreePath(repo, branch)
  if (existsSync(path)) throw new Error(`这个分支的目录已经存在：${path}（换个分支名，或先 close ${branch}）`)
  const base = String(args.from || '').trim() || await trunkOf(repo)
  if (!await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { ok: true })
    && !await git(repo, ['rev-parse', '--verify', '--quiet', base], { ok: true })) {
    throw new Error(`起点分支不存在：${base}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { ok: true })
  if (exists) await git(repo, ['worktree', 'add', path, branch])
  else await git(repo, ['worktree', 'add', '-b', branch, path, base])
  return {
    repo, branch, base, path,
    workspace: await registerWorkspace(ctx, path, `${basename(repo)} · ${branch}`),
    next: `在这个目录里开一个新会话干活：${path}`,
  }
}

async function status(cwd) {
  const repo = await repoOf(cwd)
  if (!repo) throw new Error('当前目录不在 git 仓库里')
  return { repo, managed: isManaged(cwd), ...await entryOf(cwd), pr: await prOf(cwd) }
}

async function commit(cwd, args) {
  const message = String(args.message || '').trim()
  if (!message) throw new Error('commit 需要 message')
  await git(cwd, ['add', '-A'])
  const staged = await git(cwd, ['diff', '--cached', '--name-only'])
  if (!staged) throw new Error('没有可提交的改动')
  await git(cwd, ['commit', '-m', message])
  return {
    branch: await currentBranch(cwd),
    commit: await git(cwd, ['rev-parse', '--short', 'HEAD']),
    files: staged.split('\n').filter(Boolean).length,
  }
}

async function push(cwd) {
  const branch = await currentBranch(cwd)
  await git(cwd, ['push', '-u', 'origin', 'HEAD'])
  return { branch, upstream: await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}'], { ok: true }) || `origin/${branch}` }
}

/** One PR per branch: an existing PR is returned instead of failing on a second create. */
async function openPr(cwd, args) {
  const branch = await currentBranch(cwd)
  const existing = await prOf(cwd)
  if (existing) return existing
  if (!await git(cwd, ['rev-parse', '--abbrev-ref', '@{u}'], { ok: true })) await push(cwd)
  const repo = await repoOf(cwd)
  const base = String(args.base || '').trim() || await trunkOf(repo)
  const title = String(args.title || '').trim()
  const argv = ['pr', 'create', '--head', branch, '--base', base]
  if (title) argv.push('--title', title, '--body', String(args.body ?? ''))
  else argv.push('--fill')
  if (args.draft) argv.push('--draft')
  const url = (await gh(cwd, argv, { strict: true })).split('\n').filter(Boolean).at(-1)
  return { branch, base, url }
}

async function list(cwd) {
  const repo = await repoOf(cwd)
  if (!repo) throw new Error('当前目录不在 git 仓库里')
  const worktrees = []
  for (const entry of await worktreesOf(repo)) worktrees.push({ ...entry, pr: await prOf(entry.path) })
  return { repo, current: await currentBranch(cwd), worktrees }
}

/** Remove a worktree and keep its commits: the branch survives, so nothing unmerged is deleted. */
async function close(cwd, args) {
  const repo = await repoOf(cwd)
  if (!repo) throw new Error('当前目录不在 git 仓库里')
  const wanted = String(args.branch || '').trim()
  const entries = await worktreesOf(repo)
  const entry = wanted ? entries.find((item) => item.branch === wanted) : entries.find((item) => samePath(item.path, cwd))
  if (!entry) throw new Error(wanted ? `没有这个分支的目录：${wanted}` : '当前目录不是仓库里的分支目录')
  if (samePath(entry.path, repo)) throw new Error('这是主仓库，不能移除')
  await git(repo, ['worktree', 'remove', entry.path, ...(args.force ? ['--force'] : [])])
  let deleted = false
  if (args.deleteBranch && entry.branch) {
    await git(repo, ['branch', '-d', entry.branch])
    deleted = true
  }
  return { path: entry.path, branch: entry.branch, deleted }
}

function noticeOf(agent) {
  const cwd = agent?.session?.header?.cwd
  if (!isManaged(cwd)) return ''
  return [
    `你在独立的分支目录里干活：${cwd}。`,
    '这个目录和仓库的其他分支互不影响，你的改动只落在自己的分支上。',
    '这里的 .git 是一个指向主仓库的指针，在沙箱外：读历史（git log / git diff）照常用，但凡是会写 .git 的操作都走 repo_branch 工具——status 查改动、commit 提交、push 推送、pr 开 PR。直接跑 git add/commit 会被拒绝。',
    '一个分支一个 PR，别在同一个分支里攒无关的改动；别的活就 open 一个新分支。',
  ].join('\n')
}

const isManaged = (cwd) => typeof cwd === 'string' && cwd.startsWith(ROOT + sep)

const samePath = (a, b) => {
  if (!a || !b) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return a === b
  }
}

/** The main checkout, even when called from inside a linked worktree. */
async function repoOf(cwd) {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { ok: true })
  if (!common) return null
  return basename(common) === '.git' ? dirname(common) : common
}

async function trunkOf(repo) {
  const origin = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { ok: true })
  if (origin) return origin.replace(/^origin\//, '')
  for (const name of ['main', 'master']) {
    if (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { ok: true })) return name
  }
  return await currentBranch(repo)
}

async function currentBranch(cwd) {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') throw new Error('当前是 detached HEAD，先 open 一个分支')
  return branch
}

async function checkedBranch(repo, name) {
  const branch = String(name || '').trim()
  if (!branch) throw new Error('open 需要 branch，例如 feat/login')
  if (branch.startsWith('-')) throw new Error('分支名不能以 - 开头')
  const valid = await git(repo, ['check-ref-format', '--branch', branch], { ok: true })
  if (!valid) throw new Error(`分支名不合法：${branch}`)
  return branch
}

/** Deterministic per repo + branch, so one branch always maps to one directory. */
function worktreePath(repo, branch) {
  const slug = basename(repo).replace(/[^\w.-]+/g, '-')
  const key = createHash('sha1').update(repo).digest('hex').slice(0, 8)
  return join(ROOT, `${slug}-${key}`, branch.replace(/[^\w.-]+/g, '-'))
}

async function registerWorkspace(ctx, path, title) {
  const registry = ctx.get?.('workspaceRegistry')
  if (!registry) return null
  try {
    const workspace = await registry.create(path, title)
    return { id: String(workspace.id), title: workspace.title }
  } catch {
    return null
  }
}

async function worktreesOf(repo) {
  const raw = await git(repo, ['worktree', 'list', '--porcelain'])
  const entries = []
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue
    const lines = block.split('\n')
    const path = lines.find((line) => line.startsWith('worktree '))?.slice(9)
    if (!path) continue
    const ref = lines.find((line) => line.startsWith('branch '))?.slice(7)
    entries.push(await entryOf(path, ref ? ref.replace(/^refs\/heads\//, '') : null))
  }
  return entries
}

/** One worktree's live state; a directory that stopped resolving reports nulls instead of throwing. */
async function entryOf(path, branch = null) {
  const files = await git(path, ['status', '--porcelain'], { ok: true })
  const ahead = await git(path, ['rev-list', '--count', '@{u}..HEAD'], { ok: true })
  return {
    path,
    branch: branch ?? (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], { ok: true }) || null),
    dirty: files ? files.split('\n').filter(Boolean).length : 0,
    ahead: ahead === '' ? null : Number(ahead),
  }
}

async function prOf(cwd) {
  if (!await onGithub(cwd)) return null
  const out = await gh(cwd, ['pr', 'view', '--json', 'url,state,number'])
  if (!out) return null
  try {
    const data = JSON.parse(out)
    return { number: data.number, state: data.state, url: data.url }
  } catch {
    return null
  }
}

/** `gh` only answers for a GitHub remote, and asking it otherwise costs a network round trip. */
async function onGithub(cwd) {
  const url = await git(cwd, ['remote', 'get-url', 'origin'], { ok: true })
  return /github\.com[:/]/i.test(url)
}

async function git(cwd, args, { ok = false } = {}) {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 8 << 20, windowsHide: true })
    return stdout.trim()
  } catch (error) {
    if (ok) return ''
    throw new Error(`git ${args[0]} 失败：${tail(error)}`)
  }
}

async function gh(cwd, args, { strict = false } = {}) {
  try {
    const { stdout } = await run('gh', args, { cwd, maxBuffer: 4 << 20, windowsHide: true })
    return stdout.trim()
  } catch (error) {
    if (strict) throw new Error(`gh ${args.slice(0, 2).join(' ')} 失败：${tail(error) || '检查 gh 是否已安装并登录（gh auth login）'}`)
    return ''
  }
}

/** The useful last line: git's own fatal/error line when there is one, else the final line. */
const tail = (error) => {
  const lines = String(error?.stderr || error?.message || '').trim().split('\n').filter(Boolean)
  return lines.filter((line) => /^(fatal|error|remote|hint:.*denied)/i.test(line.trim())).at(-1) || lines.at(-1) || ''
}
