# 优化 18 · 轨迹视图（P0+P1+P2）与会话文件懒创建

参考 dsh 的 `packages/client/ui-trajectory`：turn-aware 事件账本、行选中出 inspector、
固定在上方的 Overview 时间轴、从尾部打开并向上翻页、以及一条汇总状态栏。
这一步把这套做法搬到 Glass-Box 的事件日志上，能算的都算，算不出来的明说算不出来。

## 三层改动

### P0 · 派生层：`src/traceView.ts`

`buildTrajectory(records, opts)` 是个纯函数，输入事件记录，输出：

```
turns[]   { index, userText, startTs, endTs, closed, partial, rows[], stats }
between[] { afterTurn, rows[] }        // 不属于任何回合的事件
summary   { turns, steps, llmMs, toolMs, approvalMs, wallMs, avgTtftMs, usage, usageCalls, llmCalls, tokPerSec }
```

关键取舍：

- **耗时靠配对算，不新增事件**：模型 = `llm.request → llm.response`；工具 = `tool.call → tool.result`；
  TTFT = `llm.request → 第一条 llm.delta`。历史会话（几天前跑的）因此也能立刻拿到这些数字
- **等人审批单独算一项**。它既不是模型慢也不是工具慢，混进工具耗时里会误判"工具很卡"
- **`llm.delta` / `state.change` 不占行**。一个回合几百条 delta，铺开就没法看了
- **配不上对就不给数**。分页只看到 `tool.result` 没看到 `tool.call` 时，`ms` 留空——宁可缺，不编

### P1 · 视图层：会话轨迹页重做

- **汇总状态栏**：回合 / 步数 / 模型耗时 / 工具耗时 / 等审批 / 首 token 均值 / 输入输出 token / 输出速度
- **时间轴**：一行一个回合，内部按 模型（蓝）/ 工具（绿）/ 审批（黄）分段；hover 出精确时刻与摘要；
  横向拖选一段时间 → 账本只留这段时间活跃的行；右键清除
- **账本**：回合头可折叠（带该回合的步数/耗时/token），行是 `#seq · 标签 · 摘要 · 耗时`
- **inspector**：点行看完整输入输出（提问全文、模型回复、工具参数与结果、注入的记忆/资料片段、usage）
- **筛选**：11 类事件的开关 chips + 关键词搜索 + 「原始日志」切换（还是 `formatEvent`，和 `npm run replay` 同一份文字）
- **`Between turns`**：会话开始/改名、上下文压缩、记忆蒸馏这些归到「回合之间」，不硬塞进某个回合
- 滑块去掉了：选中行本身就是「回到那一步」，分叉按钮跟着选中行走（「从选中这一步分叉」）

### P2 · 规模与真实 token

- **分页**：`/sessions/view` 支持 `from`/`limit`，默认只发尾部 400 条，返回
  `window{from,to,count,hasEarlier,pageSize}`；账本顶部一个「加载更早的 N 条」
- **翻到中段不撒谎**：服务端算出「窗口开始时还没结束的那个回合」和「窗口之前有几个回合」传给派生层
  （`opts.openTurn` / `opts.turnsBefore`），否则中段的行会被误判成「回合之间」，回合编号也会从 1 重新数
- **真实 token**：`LlmResponse` 加 `usage`，`RealLlm` 从非流式响应解析，流式则带
  `stream_options:{include_usage:true}`（老网关返回 400 时自动脱掉这个参数重来一次，此时还没吐字，重来是安全的）。
  `parseUsage` 同时认 OpenAI 的 `prompt_tokens_details.cached_tokens` 和 DeepSeek 的 `prompt_cache_hit_tokens`

## 顺手治掉一个真实毛病：会话文件懒创建

发现路径是你的一句提问——「对话里的会话删除之后，会话轨迹里怎么还有会话」。查下去发现目录里躺着
**27 个一句话没说的空会话**：每次 `node src/web.ts` 或 `node src/chat.ts` 启动，都会立刻把
`session.started / plugin.loaded ×4 / skill.available / memory.loaded / kb.loaded` 落盘，
于是"起一次进程 = 多一个空会话"。侧边栏把空会话过滤掉了，轨迹页没过滤，两个列表口径不一致，看着就像删不掉。

根治办法是**懒创建**（`Journal` 的 `lazy` 选项）：

```ts
export const MATERIALIZE_ON = new Set(['turn.start', 'kb.imported', 'session.renamed']);
// 启动事件先攒在内存里（seq 照常分配），出现真实动作时按原顺序一次补写
```

三种触发都是"人做了点什么"：说了第一句话、导入了资料、给会话起了名字（说明想留着它）。
`seq` 在 `append()` 时就分配，所以延迟落盘不会跳号、顺序也不变——这一点有测试钉着。

配套：`/sessions` 多返回一个 `currentPending`，前端给还没落盘的当前会话补一条占位项
（「还没写入日志（说第一句话时才建文件）」），否则"我现在在哪个会话"会凭空消失。CLI 打印路径时也标注了。

## 顺手修的两个 bug

- **`[hidden]` 失效**：`#chat` 自带 `display:flex`，盖掉了 `hidden` 属性的 `display:none`。
  结果切到别的页时对话区还占着第 1 列，把轨迹页挤进右边 392px 的窄列——表现就是"改了跟没改一样"。
  加了一条 `[hidden]{display:none !important}`
- `ApprovalRequest` 的字段是 `toolName` 不是 `tool`；`web.request` 事件没有 `kind` 字段。
  两处都是 `tsc --noEmit` 抓出来的（零依赖工程跑不了 typecheck，用临时装在 `/tmp` 的 tsc 跑，用完删）

## 验证

**单测**：137 → **153 全绿**。新增 `test/trace.test.ts`（13 个）+ journal 的懒创建 4 个：

- `parseUsage` 三种形状（OpenAI / DeepSeek / 垃圾输入返回 undefined）
- 耗时配对：模型 300ms、TTFT 150ms、工具 1090ms、等审批 1000ms 各自归位
- token 按回合累加（含 cached），没有 usage 时**不产出总量**
- 窗口配不上对不编耗时；`openTurn` 让中段的行仍挂在原回合下、编号接着往下数
- `llm.delta`/`state.change` 不占行；汇总的平均 TTFT / tok/s / 墙钟
- 懒创建：只发启动事件不建文件、`listSessions` 也不列；第一句话到了按原顺序补写且 `seq` 连续 `[1,2,3,4]`；
  起名/导入资料也触发落盘；不开 lazy 时行为和以前完全一样；`buildApp` 起进程 + 连开两个新会话 → 目录里 0 个文件

**真实模型实跑**（gpt-5.5，你的 `.env` 原样，无 `GB_*` 覆盖）：

```
问：在代码库里搜索 StreamGate 出现在哪些文件
→ /sessions/view 的 trace.summary：
   turns 1 · steps 2 · llmMs 17928 · toolMs 28 · avgTtftMs 2361
   usage {prompt 4304, completion 302, total 4606} · usageCalls 3/3 · tokPerSec 16.8
→ 账本：#10 你 → #11 记忆注入 → #13 注入上下文 → #17 模型 9243ms（要求调用 glob）
        → #21 工具结果 7ms → #26 模型 6240ms（要求调用 grep）→ #30 工具结果 21ms → #39 模型 2445ms
→ between：回合前 9 条启动事件、回合后 1 条记忆蒸馏
```

分页：真实会话（102 事件）`limit=20` → `window{from:83,hasEarlier:true}`，
并正确认出「回合 1（前半截在更早的页里）」。

懒创建：起服务 + 连点两次「新建会话」→ 目录文件数 27 → **27**（没涨）；
CLI 里说一句话 → 28，新文件 `seq 1..22` 连续、首条是 `session.started`、`llm.response` 带 usage。

## 说清楚的三件事

1. **你的网关不返回 `cached_tokens`**，所以"缓存命中率"这一项在你这儿不会显示。代码支持，数据没有——
   这跟 dsh 评测里那个"缓存命中 99%"不是一回事，别当成我们也有
2. **旧会话没有 usage**（改动之前跑的），汇总栏会显示「这段没有 provider usage」，不会补一个估算值糊上去
3. **虚拟滚动没做**。dsh 是"只挂载可见行窗口"，我们是"分页 + 回合折叠"，几千条事件时滚动仍可能变重
