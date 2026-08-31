# 优化 10 · 步数上限与子 agent 的模型

这一步修两个真缺陷。都不是"能力不够"，是"写错了/漏了"。

## 缺陷一：子 agent 用的是假模型

`subagentPlugin.ts` 里这一行从 Step 4 一直留到现在：

```ts
const child = new Loop(childWire, childTools, new FakeLlm(), approver);
                                              ^^^^^^^^^^^^^
```

Step 4 写 subagent 的时候项目里还只有 FakeLlm，Step 6 接真实模型时只改了 `app.ts` 的
`pickLlm()`，**漏了这里**。后果是：你在真实模型模式下 `delegate` 一个子任务，
跑起来的子 agent 只会拿指令语法去解析你那句话——它没有智能，等于白跑一趟。

这类 bug 特别隐蔽，因为它"看起来是工作的"：事件流照样有 `subagent.start` / `subagent.end`，
返回值也是一段中文，只有仔细读内容才会发现那是 FakeLlm 的兜底回复。

修法是**由父级注入**，而不是让插件自己 new 一个：

```ts
export function subagentPlugin(workspace: string, llm: Llm): Plugin
```

`llm` 做成必填参数（而不是"可选，默认 FakeLlm"）——**默认值恰恰是这个 bug 能存活至今的原因**。
必填让类型系统替你盯着：以后谁再加一个用到模型的插件，忘了传就编译不过。

顺带发现的第二个问题：子 agent 用的 `PROTOCOL` 是模块级常量，会把 `delegate`、
`write`、`run` 全列给它，而它其实只有 `read` / `glob` / `grep`。
实测它第一步就去调 `delegate`，白白浪费一步换回一句"未知工具"。
补一条 system 消息说清能力边界后，同一个任务从 4 步降到 2 步：

```
修复前: 用了 delegate, glob, grep, glob   （4 步，第一步是无效调用）
修复后: 用了 glob, grep                    （2 步）
```

## 缺陷二：回合循环没有刹车

`loop.ts` 的主循环是 `for (;;)`：只要模型一直回 `ACTION:`，它就一直转。
"模型卡在反复 grep 同一个词"在真实使用里很常见，而当时唯一的刹车是你按 Ctrl+C——
Web 模式下连这个都没有。

### 设计：不是"到点就掐"，而是"到点先劝，再劝不听才掐"

直接抛异常或硬返回是最省事的，但那样模型没有机会给出结论，
用户拿到的是一个断了的回合。所以分三段：

```
steps < maxSteps          → 正常执行工具
steps 到达上限，模型仍要工具 → 不执行，把"步数已用尽"当成【工具结果】喂回去
再问一次，它还要工具       → 硬停，给出一句说明性的最终答复
```

中间那步是关键：喂回去的是模型**最熟悉的反馈形式**——一条失败的工具结果。

```ts
const result: ToolResult = {
  toolCallId: call.id,
  ok: false,
  content: `未执行 ${call.name}：本回合工具步数已用尽（上限 ${this.maxSteps}）。请基于已有信息直接给出最终答复。`,
};
```

模型在训练里见过无数次"工具失败 → 换个策略"，所以它大概率会顺势收尾。
如果换成抛错或塞一条 system 指令，反而是它没那么熟的路径。

硬停这一层必须存在（`warned` 标记）：不能假设模型一定听劝，
否则"劝 → 不听 → 再劝"本身就是新的死循环。

### 可观测性照旧

新增一个 wire 事件，四个界面都能看到刹车动作：

```ts
| { type: 'turn.limit'; turnId: string; steps: number; maxSteps: number; ts: number }
```

- 日志模式：`[限流] 工具步数已达上限 12，要求模型直接收尾`
- TUI / chat：事件流里出现 `⚑ 步数用尽（12）`
- Web UI：轨迹里一条红色提示

**如果一个限制是不可见的，用户就会把它当成"卡住了"。** 刹车必须留下痕迹。

默认 12 步，`GB_MAX_STEPS` 可调；子 agent 更紧，默认 6 步（`GB_SUB_MAX_STEPS`）——
它只负责查清一件事，不该在里面长跑。

## 顺手加固：脏输出污染工具参数

真实模型跑验证时，活动轨迹里冒出这么一行：

```
搜索 **/*StreamGate*ACTION: glob **/*streamgate*ACTI… 命中 0
读取 llm/streamGate.ts`StreamGate` 定义在：        ← 路径里带着解释文字
```

模型把两条 `ACTION:` 挤在了一行（自我纠正时常见），
而 `extractActionCommand` 是"取整行"，于是整段垃圾都成了工具参数。

加了两道裁剪：遇到第二个 `ACTION:` 就截断、去掉尾部残留的反引号和空白。

```ts
const cut = m[1].split(/action\s*[:：]/i)[0];
return cut.replace(/[`\s]+$/, '').trim();
```

但要说清楚：**这只是止血，不是根治**。
根因是"让模型用自由文本表达结构化调用"，正则加固永远追不上模型的花样。
真正的解法是换成原生 tool calling（参数由接口保证是 JSON），那是更大的一步改造。

## 验证

单元测试（新增 4 条，总数 52 → 56 全绿）：

- 永远要求调工具的模型：实际执行次数**恰好等于上限**，且回合正常 `turn.end`；
- 步数用尽时最后一条 `tool.result` 是 `ok:false` 且含"步数已用尽/未执行 noop"；
- 模型收到提醒后给文本 → 正常结束，不触发硬停；
- 给 `subagentPlugin` 注入一个带标记的模型，断言子 agent 的结论里带着那个标记
  （证明它用的不是内置假模型）。

真实模型（gpt-5.5）端到端：

```
[子agent] 开始: "找出 StreamGate 定义在哪个文件" (工具: read_file, glob, grep)
[子agent] 完成: 用了 glob, grep
[轨迹] 委派 找出 StreamGate 定义在哪个文件 2 步
最终回复: 找到了，`StreamGate` 定义在 src/llm/streamGate.ts …
```

子 agent 真的会自己"先 glob 定位、再 grep 确认"了——这是有智能的表现。

## 这一步的收获

1. **"看起来在工作"的 bug 最危险**。子 agent 一直有事件、有返回值，
   唯一的异常是内容质量——这种缺陷靠日志和测试都不容易发现，只能靠读输出。
2. **别给依赖留默认值**。`new FakeLlm()` 这个默认值让漏改沉睡了四步；
   改成必填参数后，同类错误会在编译期暴露。
3. **限制要"先劝再掐"，并且必须可见**。用模型熟悉的反馈形式（失败的工具结果）
   引导它收尾，比抛错更可能得到一个完整答复；同时保留硬停，因为不能假设它听劝。
4. **提示词要匹配真实能力**。给子 agent 列出它没有的工具，它就会去试——
   浪费的是步数和钱。
