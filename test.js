/**
 * Self-check: a throwaway repository with a bare origin. Opens two branches,
 * proves their files are independent, commits and pushes each on its own, and
 * removes one worktree without touching its commits.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'wt-'))
process.env.HOME = home

const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }).trim()
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const origin = join(home, 'origin.git')
sh(home, 'git', 'init', '--bare', '-b', 'main', origin)
const repo = join(home, 'app')
sh(home, 'git', 'clone', origin, repo)
sh(repo, 'git', 'config', 'user.email', 'a@b.c')
sh(repo, 'git', 'config', 'user.name', 'A')
writeFileSync(join(repo, 'README.md'), '# app\n')
sh(repo, 'git', 'add', '-A')
sh(repo, 'git', 'commit', '-m', 'init')
sh(repo, 'git', 'push', '-u', 'origin', 'main')

// Fake Host: the plugin needs a tool registry and an agent-created listener.
const workspaces = []
const tools = new Map()
let created = null
const ctx = {
  effect(fn) { fn() },
  on(event, handler) { if (event === 'agent/created') created = handler },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  get(name) {
    if (name === 'workspaceRegistry') {
      return { create: async (path, title) => { workspaces.push({ path, title }); return { id: `w${workspaces.length}`, title } } }
    }
    return undefined
  },
}
const { apply } = await import('./index.js')
apply(ctx)
const tool = tools.get('repo_branch')
assert(tool, 'the tool registers')

let agent = { session: { header: { cwd: repo } } }
const call = (args) => tool.execute(args, { agent })

const a = await call({ action: 'open', branch: 'feat/login' })
assert(!a.error, `open a branch: ${JSON.stringify(a)}`)
assert(a.branch === 'feat/login' && a.path.includes('feat-login'), 'branch and directory')
assert(workspaces.length === 1 && workspaces[0].path === a.path, 'the worktree is registered as a project')
const b = await call({ action: 'open', branch: 'fix/typo' })
assert(!b.error && b.path !== a.path, 'a second branch gets its own directory')
const checkouts = sh(repo, 'git', 'worktree', 'list').split('\n').filter(Boolean)
assert(checkouts.length === 3, `main plus two worktrees, got ${checkouts.length}`)

// Same branch name again is refused, never silently shared.
const twice = await call({ action: 'open', branch: 'feat/login' })
assert(String(twice.error).includes('已经存在'), `one directory per branch, got ${JSON.stringify(twice)}`)
const bad = await call({ action: 'open', branch: 'feat/../oops' })
assert(String(bad.error).includes('不合法'), 'an invalid branch name is rejected')

// Independence: one branch writes a file the other never sees.
writeFileSync(join(a.path, 'login.js'), 'export const login = 1\n')
agent = { session: { header: { cwd: a.path } } }
let out = await call({ action: 'status' })
assert(out.branch === 'feat/login' && out.dirty === 1 && out.managed === true, `status reads the worktree: ${JSON.stringify(out)}`)

out = await call({ action: 'commit', message: 'feat: login' })
assert(!out.error && out.files === 1, `commit runs in the branch directory: ${JSON.stringify(out)}`)
const commit = out.commit
assert(!existsSync(join(b.path, 'login.js')), 'the other branch stays clean')
assert(await call({ action: 'status' }).then((s) => s.dirty === 0 && s.ahead === null), 'an unpushed branch reports no upstream')

out = await call({ action: 'push' })
assert(!out.error && out.upstream === 'origin/feat/login', `push sets upstream: ${JSON.stringify(out)}`)
assert(sh(repo, 'git', 'rev-parse', 'feat/login') === sh(repo, 'git', 'rev-parse', `origin/feat/login`), 'origin holds the branch')

// A second branch commits its own work without inheriting the first.
writeFileSync(join(b.path, 'typo.md'), 'fix\n')
agent = { session: { header: { cwd: b.path } } }
await call({ action: 'commit', message: 'fix: typo' })

out = await call({ action: 'list' })
const names = out.worktrees.map((item) => item.branch)
assert(names.includes('main') && names.includes('feat/login') && names.includes('fix/typo'), `list names every branch: ${names}`)
assert(out.worktrees.find((item) => item.branch === 'feat/login').ahead === 0, 'a pushed branch is level with its upstream')
assert(out.worktrees.find((item) => item.branch === 'fix/typo').ahead === null, 'an unpushed branch reports no upstream')

// Closing keeps the branch and its commit; only the directory goes.
agent = { session: { header: { cwd: a.path } } }
out = await call({ action: 'close' })
assert(!out.error && out.branch === 'feat/login' && !existsSync(a.path), `close removes the directory: ${JSON.stringify(out)}`)
assert(sh(repo, 'git', 'rev-parse', '--short', 'feat/login') === commit, 'the branch and its commit survive')
const mainClose = await (async () => { agent = { session: { header: { cwd: repo } } }; return call({ action: 'close' }) })()
assert(String(mainClose.error).includes('主仓库'), 'the main checkout cannot be removed')

// Reopening a closed branch reuses the branch, not a second copy of its base.
agent = { session: { header: { cwd: repo } } }
out = await call({ action: 'open', branch: 'feat/login' })
assert(!out.error && out.path === a.path, 'reopening reuses the same directory')
assert(readFileSync(join(out.path, 'login.js'), 'utf8').includes('login'), 'reopening restores the committed work')
assert(sh(out.path, 'git', 'rev-parse', '--short', 'HEAD') === commit, 'reopening lands on the branch commit')

// Without a GitHub remote the PR step says so instead of silently doing nothing.
out = await call({ action: 'pr', branch: 'feat/login' })
assert(String(out.error).startsWith('gh pr create 失败'), `pr reports a missing GitHub remote: ${JSON.stringify(out)}`)

// A push that cannot work reports what failed instead of pretending.
const detached = join(home, 'lonely')
sh(home, 'git', 'init', '-b', 'main', detached)
sh(detached, 'git', 'config', 'user.email', 'a@b.c')
sh(detached, 'git', 'config', 'user.name', 'A')
writeFileSync(join(detached, 'x'), 'x')
agent = { session: { header: { cwd: detached } } }
out = await call({ action: 'commit', message: 'init' })
assert(!out.error, `commit works without a remote: ${JSON.stringify(out)}`)
out = await call({ action: 'push' })
assert(String(out.error).startsWith('git push 失败'), `a push without a remote fails loudly: ${JSON.stringify(out)}`)
out = await call({ action: 'commit', message: 'noop' })
assert(String(out.error).includes('没有可提交的改动'), 'an empty commit is refused')

// The prompt notice tells a managed branch session to use the tool.
const sections = new Map()
const prompted = {
  id: 's1', session: { header: { cwd: b.path } },
  ctx: { effect: (fn) => fn(), systemPrompt: { section: (s) => { sections.set('s1', s); return () => {} } } },
}
created({ agent: prompted })
const notice = sections.get('s1').text()
assert(notice.includes('repo_branch') && notice.includes(b.path), 'a branch session is told how to commit')
const plain = { id: 's2', session: { header: { cwd: repo } }, ctx: { effect: (fn) => fn(), systemPrompt: { section: (s) => { sections.set('s2', s); return () => {} } } } }
created({ agent: plain })
assert(sections.get('s2').text() === '', 'the main checkout gets no notice')

assert(readFileSync(join(b.path, 'typo.md'), 'utf8') === 'fix\n', 'work survives in the surviving worktree')
console.log('branch worktree ok')
