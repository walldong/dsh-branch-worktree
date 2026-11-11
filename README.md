# dsh-branch-worktree

让同一个仓库的不同分支**同时**开工：每个分支一个独立目录，互不干扰，各自提交，各自开 PR。

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.1-1f6b4a)](https://github.com/deepseek-ai/deepseek-harness)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 问题

一个 agent 一个目录。想同时干两件事，就得排队：

- 让甲改登录、乙修错别字 —— 只能等前者提交完、切回主干、乙再开始
- 硬要并行？两个会话在**同一份工作区**里改同一批文件，谁也说不清谁的改动
- `git checkout` 切分支会把另一个会话正在读的文件换掉，工具直接跑错

## 做法

一个分支一个 `git worktree`，一个 worktree 一个目录，一个目录一个 DSH 项目（侧边栏直接多一行）：

```
                    ~/app（主干，main）
                    ├── ~/.dsh/worktrees/app-1a2b3c4d/feat-login    ← 会话甲
                    └── ~/.dsh/worktrees/app-1a2b3c4d/fix-typo      ← 会话乙
```

它们是**同一个仓库**：共享对象库和提交历史，`git log` 互相可见，但工作区、索引、HEAD 各管各的。所以：

- 甲的未提交改动，乙完全看不到；乙 `git status` 永远是干净的
- 甲 `git commit` 只动 `feat/login`，乙 `git commit` 只动 `fix/typo`
- 两边各自 `git push`、各自 `gh pr create`，互不抢占
- 分支目录放在仓库外面，`git status` 里不会多出一个奇怪的未跟踪目录

## 装

```
dsh plugin --profile desktop add github:walldong/dsh-branch-worktree
```

重启 Harness 后，agent 多出 `repo_branch` 工具。

## 用

agent 自己会用，你也可以直接说："开个 `feat/login` 分支做登录，另外开 `fix/typo` 修文案。"

| action | 干什么 |
| --- | --- |
| `open` | 从主干开分支 + 独立目录，并注册成 Harness 项目。返回新目录路径 |
| `status` | 当前目录：分支、改动文件数、领先上游几个提交、PR 状态 |
| `commit` | `git add -A` + 提交，返回短 SHA |
| `push` | 推到 `origin` 并设置 upstream |
| `pr` | 已有 PR 就返回它，否则推送后 `gh pr create` |
| `list` | 仓库里所有分支目录，各自的改动数和领先提交数 |
| `close` | 删掉目录，**分支和提交都保留**（`deleteBranch` 才删分支） |

### 为什么提交要走工具

分支目录里的 `.git` 是一个指向主仓库 `.git/worktrees/<name>` 的**文件**。沙箱的 workspace 边界按会话目录划，那个文件在外面 —— agent 自己 `git commit` 会撞上写入拒绝。所以提交、推送、开 PR 都由 Host 执行：工具在宿主进程里跑，不受会话沙箱限制。

分支会话的系统提示里会写明这一点，不用你教。

### 一点设计

- **一个分支一个目录**，由仓库路径 + 分支名哈希决定，重复 `open` 同一个分支会退回同一个目录（git 本身也拒绝同一分支检出两次）
- **删目录不删分支**：`close` 只 `worktree remove`，没合并的提交一个都丢不了
- **有 PR 就不再开**：`pr` 先查，避免一个分支堆出三个 PR
- **主干自己判断**：先看 `origin/HEAD`，退一步找 `main` / `master`
- `gh` 没装或没登录时，`pr` 直接报错说清楚，不假装成功

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：`repo_branch` 工具 + 分支会话的提示段 |
| `cordis.patch.yml` | bundle patch |
| `test.js` | 自检：临时仓库 + 裸 origin，验证隔离、提交、推送、关闭、重开、报错 |

## 自检

```
node test.js
```

## License

MIT
