---
name: git-commit
description: 规范的 git 提交信息写法
triggers: commit, 提交, git commit
---
写 commit message 时遵循 Conventional Commits：

- 格式：`<type>(<scope>): <subject>`
- 常用 type：feat / fix / docs / refactor / test / chore
- subject 用祈使句、不超过 50 字，正文说明「为什么改」而非「改了什么」
- 一个提交只做一件事
