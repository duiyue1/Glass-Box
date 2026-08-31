# 优化 01 · 测试套件（零依赖 node:test）

> 六步 demo 功能齐全，但没有一行测试——这是"优化"的第一刀。用 Node 自带的测试运行器给引擎核心加单元测试，锁住行为、防止后续优化改坏东西。依然零第三方依赖。

---

## 1. 为什么先做测试

后面还要继续优化（持久化记忆、精确编辑工具、真实模型健壮性……）。每次改动都可能悄悄改坏已有行为。有了测试，就能在每次优化后一键确认"老功能没退化"。这也是从 Step1 就强调的「只加不改」能否守住的保险。

---

## 2. 用什么测：Node 内置 `node:test`

Node ≥ 18 自带测试运行器和断言库，**不用装 jest/vitest**，完全契合本项目"零依赖 + 直接跑 .ts"的风格：

```bash
npm test          # 等价于 node --test test/*.test.ts
```

写法很朴素：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('说明这条测试在验证什么', () => {
  assert.equal(实际值, 期望值);
});
```

---

## 3. 覆盖了哪些关键行为（16 条用例）

挑的都是"错了会很痛"的核心逻辑：

- **指令语法 `commandGrammar`**：read/write/run/grep/delegate/echo 都能正确解析；非指令返回 null。
  （Fake 和 Real 模型共用它，它错了两个模型一起错。）
- **记忆 `MemoryStore`**：
  - 按关键词命中打分、能检索到相关原子；
  - **条数预算封顶**（`maxItems`）并正确计丢弃数；
  - **token 预算封顶**（`maxTokens`）；
  - 相同内容**去重**。
- **回合 + 审批 `Loop`**：
  - 审批放行 → 工具执行、拿到结果、回合给出最终文本；
  - 审批拒绝 → **工具绝不执行**，返回"被拒"结果（这是安全底线，必须锁死）；
  - 状态机确实经历 thinking → tool_call → tool_result → done。
- **上下文压缩 `Session`**：历史超预算时确实触发 `context.compacted`。
- **技能匹配 `SkillRegistry`**：中文/英文触发词命中；**短英文词按词边界匹配**（回归测试 Step5 修的 "cr 不该命中 script" 那个 bug）。
- **路径安全 `resolveInWorkspace`**：工作区内 `inside=true`，`../` 和绝对路径越界 `inside=false`。

结果：`16 passed / 0 failed`。

---

## 4. 测试怎么写才不脆——用「桩（stub）」隔离

引擎依赖模型和审批者，但测试不想真的调模型。做法是塞入**桩实现**：

```ts
// 桩模型：第一次要求调工具，第二次给文本，凑成一个完整回合
class ToolThenText implements Llm {
  private i = 0;
  async complete() {
    if (this.i++ === 0) return { toolCalls: [{ id: '1', name: 'w', args: {} }] };
    return { text: 'final' };
  }
}
// 桩审批者：直接放行或拒绝
const approver = { decide: async () => false };
```

因为引擎只依赖 `Llm` / `Approver` 接口（从 Step1 就这么设计），测试里随手就能替换成桩——**可测性正是好接口设计的副产品**。

---

## 5. 新增文件

```
test/
  grammar.test.ts   # 指令语法解析
  memory.test.ts    # 记忆检索 + 预算封顶 + 去重
  loop.test.ts      # 回合状态机 + 审批放行/拒绝（桩模型/桩审批）
  session.test.ts   # 上下文压缩触发
  skills.test.ts    # 技能触发词匹配（含词边界回归）
  paths.test.ts     # 工作区路径安全
package.json        # 新增 "test": "node --test test/*.test.ts"
```

---

## 6. 优化路线图（后续步骤预告）

- **优化 01 · 测试套件** ✅（本步）
- **优化 02 · 记忆持久化**：把 L0/L1 落盘 JSON，跨会话/重启也记得。
- **优化 03 · 精确编辑工具 `edit_file`**：search/replace 式编辑 + 审批时显示 diff（呼应 Claude Code/codex 的 edit 工具）。
- **优化 04 · 真实模型健壮性**：ACTION 解析去代码围栏 + 失败重试；可选升级为 OpenAI 原生 tool-calling。
- **优化 05 · 流式输出**：chat 里逐字显示模型回复。

每完成一步都会跑一遍 `npm test`，确保没有回退。
