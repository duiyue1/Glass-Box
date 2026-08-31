# Step 5 · 记忆链路（L0 原始 → L1 蒸馏 → 预算封顶检索注入）

> 这一步给 agent 装上「记性」：把每回合的对话存下来、蒸馏成可复用的事实/偏好，下一回合按需检索最相关的几条注入进来——而且**检索有预算上限**，不会把记忆一股脑塞爆上下文。思路来自 TencentDB-Agent-Memory 的分层记忆。

---

## 1. 一句话理解这一步

之前每个回合都是「失忆」的：这回合说的话，下回合就忘了。
现在：你说「记住这个项目用 Gurobi」，它会**蒸馏**出一条事实存起来；等你后面问「Gurobi 怎么配置」，它会**检索**出那条事实并注入到上下文里，于是它"记得"。

关键的工程克制：检索不是"把所有记忆都塞进去"，而是**按相关度排序 + 条数/token 双重封顶**，只带最相关的几条。

---

## 2. 记忆的三段链路

```
你说一句话
    │
 (回合结束)          ┌─────────────────────────────┐
    └───────────────►│ L0 原始记录：原话存证         │
                     │ L1 蒸馏：抽成"原子"(atom)     │  ← 蒸馏
                     └─────────────────────────────┘
                                   │
 (下一回合开始)                     │
    你问相关问题 ──────────────────►检索：按相关度打分 + 预算封顶
                                   │
                                   ▼
                        把最相关的几条注入本回合上下文  ← 注入
```

- **L0（原始）**：原话，用于存证/回溯。
- **L1（原子 atom）**：从对话里抽出的、可精确召回的小颗粒，分四类：
  - `fact` 事实（"这个项目用 Gurobi"）
  - `preference` 偏好（"喜欢用 TypeScript"）
  - `constraint` 约束（"不要用全局变量"）
  - `event` 事件（其它都兜底记成一条事件）

---

## 3. 蒸馏：怎么从对话里抽原子

真实系统会用 LLM 来抽取；这里为了零凭证可跑，用**规则版**（`distill`）：

- `记住/请记住/注意 …` → `fact`
- `我喜欢/偏好/习惯用 …` → `preference`
- `不要/别/禁止 …` → `constraint`
- 都不匹配 → 兜底记一条 `event`

蒸馏发生在**回合结束后**（`turn.end`），相当于"异步蒸馏"——不挡住当前回合。

---

## 4. 检索：相关度打分 + 预算封顶（本步的重点）

`MemoryStore.retrieve(query, budget)` 做三件事：

1. **打分**：把查询拆成检索词（英文整词 + 中文 2-gram），一条原子命中的词越多分越高（BM25 的极简版）。
2. **排序**：按分数降序，同分按新鲜度。
3. **封顶**：从高分往下装，直到达到 `maxItems`（条数）或 `maxTokens`（token）上限，**其余丢弃**并计数。

面板上能看到 `注入 1 条 · 6/40 tok · 丢 1`——这就是"检索得少但检索得准 + 不撑爆上下文"的可视化。

> 为什么要封顶？没有上限的话，记忆一多就会把上下文占满，既费钱又稀释了当前任务。预算封顶是记忆系统能长期用的关键。

---

## 5. 它是怎么"零改动"接进引擎的

还记得 Step4 建的 **ContextProvider** 抽象吗？记忆就是又一个 Provider：

- **注入侧**：`Memory.provider()` 返回一个 ContextProvider，每回合 `provide(userText)` 时检索+注入。引擎（Loop）根本不知道"记忆"的存在，它只是多问了一个 Provider。
- **蒸馏侧**：`Memory` 像 renderer 一样**挂在事件总线上**——监听 `turn.start` 记住输入、`turn.end` 触发蒸馏。

所以这一步几乎没动引擎：新增一个记忆模块，在 `buildApp` 里把它的 provider 加进 providers 列表即可。这正是前几步"事件总线 + Provider 抽象"打好的地基的回报。

---

## 6. 自己跑一下

```bash
# 陈述 -> 之后检索注入（第三回合会注入第一回合的 Gurobi 事实）
node src/index.ts "记住这个项目用 Gurobi 求解器 ;; 我喜欢用 TypeScript ;; Gurobi 怎么配置"

# 预算封顶：只允许注入 1 条，命中 2 条时丢 1 条
GB_MEM_ITEMS=1 node src/tui.ts "记住项目用 Gurobi ;; 我喜欢用 TypeScript ;; TypeScript 和 Gurobi 怎么配置"

# 调节记忆检索预算
GB_MEM_ITEMS=3 GB_MEM_TOKENS=40 node src/index.ts "..."
```

---

## 7. 这一步新增/改了哪些文件

```
src/memory/
  store.ts       # 新增：Atom/L0 类型 + MemoryStore（打分检索 + 预算封顶）
  memory.ts      # 新增：distill 规则蒸馏 + Memory 子系统（挂总线）+ provider()
src/engine/types.ts  # +2 个 wire 事件：memory.distilled / memory.injected
src/app.ts       # buildApp 里创建 Memory，把 memory.provider() 加进 providers
src/index.ts     # 日志新增记忆事件
src/tui/renderer.ts  # 面板新增「记忆」区（原子数 / 注入条目 / 预算 / 丢弃数）
src/skills/registry.ts  # 顺手修了技能匹配的误命中（见下）
```

---

## 8. 验证时抓到的一个真实 bug（顺手修了）

测试时发现输入「我喜欢用 Type**Script**」竟然激活了 `code-review` 技能。
原因：`code-review` 的触发词里有个短词 `cr`，而 "s**cr**ipt" 里正好含 "cr"，子串匹配误命中。

**修复**：技能匹配对**纯英文触发词按"词边界"匹配**（`cr` 只在独立出现时才算命中），中文触发词仍用子串。修完：
- "TypeScript" → 不再误触发 code-review ✓
- "commit" → git-commit ✓；"审查" / 独立 "cr" → code-review ✓

这类"短关键词子串误命中"是关键词匹配的经典坑，做检索/触发逻辑都要留意。

---

## 9. 下一步（Step 6 · 收尾）

Step 6 把假模型换成**真实模型**（Kimi / DeepSeek，OpenAI 兼容接口），验证"只换 `Llm` 实现、引擎其它部分不动"这个从 Step1 就立下的设计承诺；并用 Glass-Box 自己跑一个真实小任务（dogfood 自举）作为收尾。
