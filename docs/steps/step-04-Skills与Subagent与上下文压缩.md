# Step 4 · Skills 按需加载 + Subagent + 上下文压缩

> 这一步让 agent「更聪明」，加了三样当下主流 coding agent 的核心能力，并且都接到了玻璃盒面板上：
> **Skills**（相关才加载，省 token）、**Subagent**（把子任务下放给隔离的子 agent）、**上下文压缩**（对话太长自动浓缩）。

---

## 1. 一句话理解这一步

- **Skills**：把「专项知识」写成一个个 `.md` 文件，只有当你的话里出现相关关键词时才把它塞进上下文——不相关就不占地方。
- **Subagent**：主 agent 遇到「去查一下」这类子任务，可以派一个**权限受限、上下文独立**的小弟去干，干完只把结论带回来。
- **上下文压缩**：对话越来越长会超出模型能装下的量，于是把**早前的对话**浓缩成一句摘要，腾出空间，同时面板上能看到「占用条」和「压缩发生的时刻」。

---

## 2. 一个新的核心抽象：ContextProvider（按需上下文）

在 Step1 里，一个回合的消息就是「历史 + 你这句话」。这一步引入了**上下文提供者**：

```
一个回合开始时：
   问每个 Provider：「针对用户这句话，你有要补充的上下文吗？」
   命中的内容作为临时 system 消息，只加到「这一回合」，不写进对话历史。
```

**Skills 就是一种 ContextProvider**（Step5 的记忆也会是）。这个抽象的好处：加一种新的「按需上下文」不用改引擎，塞一个 Provider 进去就行。

关键区别：**注入的内容是「本回合临时的」**。所以 `Loop` 现在把「会持久化的对话（convo）」和「本回合临时注入（injected）」分开——历史不会被 skill 内容越堆越大。

---

## 3. Skills：相关才加载

技能就是 `skills/` 下的 markdown，头部用 `---` 声明元信息：

```markdown
---
name: git-commit
description: 规范的 git 提交信息写法
triggers: commit, 提交, git commit
---
写 commit message 时遵循 Conventional Commits……
```

- `SkillRegistry` 启动时把它们都读进来（只读元信息和正文，不注入）。
- 每回合用 `triggers` 去**匹配你的输入**，命中的技能正文才注入。
- 面板 Skills 区用 `★` 标出「本会话已激活」的技能，`·` 是「可用但没触发」。

例子：你说「**commit** 这次改动」，`git-commit` 技能命中并注入（面板显示 `★ git-commit`）；说别的就不会加载它，省下 token。这正是 Claude Code「Skills 渐进式加载」的核心。

---

## 4. Subagent：把子任务下放出去

`delegate <子任务>` 会派出一个子 agent，它有三个特点：

1. **上下文隔离**：子 agent 有**自己的 Wire**，它的内部事件不会污染主时间线。
2. **工具受限**：只给只读工具（`read_file` + `grep`），干不了破坏性的事——这就是「最小权限」。
3. **只回结论**：主 agent 只拿到子 agent 的最终结果，不用背负它中间那一堆搜索过程。

面板「子 agent」区显示：派了什么任务、用了哪些工具、是否完成。这是 Claude Code 的 Task / AgentSwarm 的极简版。

> 为什么要隔离？因为让子 agent 独立处理「探索/搜索」这类噪音大的子任务，主 agent 的上下文才能保持干净、专注。

---

## 5. 上下文压缩：对话太长怎么办

模型一次能读的内容有上限（token 预算）。对话越长，越接近上限。做法：

```
每个回合开始前，先看历史有多长：
   没超预算 → 照常
   超了     → 保留最近 N 条，把更早的对话浓缩成一条「摘要」system 消息
```

- 负责这件事的是新引入的 **`Session`**（它持有跨回合的历史；单回合机制仍在 `Loop`）。
- 压缩时发出 `context.compacted` 事件，面板上：
  - **上下文预算条** `[████████░░░░] 83/40 tok` 实时显示占用；
  - `⚑ 压缩: 丢弃 4 条: 112→71 tok` 标出压缩发生的时刻和效果。

> token 数用「字符数 ÷ 4」粗略估算——真实 tokenizer 和模型相关，演示够用。

---

## 6. 自己跑一下

```bash
# Skills：commit 触发 git-commit（日志里看到 [上下文] 注入: skill:git-commit）
node src/index.ts "commit 这次改动"

# Subagent：把 grep 子任务下放（看到 [子agent] 开始/完成）
node src/index.ts "delegate grep TurnState"

# 上下文压缩：多回合用 ";;" 分隔 + 调低预算，触发 [压缩]
GB_BUDGET=30 node src/index.ts "echo 一 ;; echo 二 ;; echo 三 ;; echo 四"

# 一次看全（TUI 面板，真实终端有动画）
GB_BUDGET=40 node src/tui.ts "commit 这次改动 ;; delegate grep Wire ;; echo 收尾"
```

多回合语法：用 `;;` 分隔多句，会在**同一个会话**里依次执行，历史累积、按需压缩。

---

## 7. 这一步新增/改了哪些文件

```
src/engine/
  types.ts       # +ContextContribution/ContextProvider；+6 个 wire 事件（context.* / skill.* / subagent.*）
  tokens.ts      # 新增：token 粗略估算
  loop.ts        # 回合开始注入按需上下文；区分「持久 convo」与「临时 injected」；发 context.injected/usage
  session.ts     # 新增：跨回合历史 + 上下文压缩
src/skills/
  registry.ts    # 新增：加载 skills/*.md，按 triggers 匹配
  provider.ts    # 新增：把 skills 包成 ContextProvider
src/plugins/
  fsPlugin.ts    # 支持 readOnly 选项（只读子 agent 用）
  subagentPlugin.ts  # 新增：delegate 工具（隔离 Wire + 受限工具的子 agent）
src/llm/fakeLlm.ts   # +delegate 指令
src/app.ts       # 新增：buildApp() 统一组装；先构造后 init（事件不丢）；parseTurns() 多回合
src/index.ts     # 改用 buildApp + Session 多回合；日志新增 context/skill/subagent 事件
src/tui.ts       # 改用 buildApp + Session 多回合
src/tui/renderer.ts  # 面板新增：上下文预算条+压缩、Skills、子 agent
skills/git-commit.md, skills/code-review.md  # 两个示例技能
```

---

## 8. 设计取舍

- **Skills 和记忆共用 ContextProvider 抽象**：Step5 的记忆几乎可以「即插即用」，只是另一个 Provider。
- **单回合机制在 Loop、跨回合历史在 Session**：职责清晰。压缩是「历史管理」，自然归 Session。
- **子 agent 用独立 Wire**：既隔离了噪音，又保留了可观测性（需要时可以单独回放子 agent 的事件流）。
- **buildApp 构造/init 两段式**：解决了老问题——实时订阅模式下要保证「先订阅、后发事件」，否则 `plugin.loaded`/`skill.available` 会丢。

---

## 9. 下一步（Step 5 预告）

Step 5 接入**记忆链路**（呼应 TencentDB-Agent-Memory 的分层思路）：
把对话存成 L0 原始记录，异步蒸馏成 L1「事实/偏好」原子，下一回合用**预算封顶的检索**把最相关的几条记忆注入进来——而它接入的方式，正是这一步刚建好的 **ContextProvider**。
