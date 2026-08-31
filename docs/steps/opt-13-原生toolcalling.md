# 优化 13 · 原生 tool calling（换掉正则解析的地基）

## 换掉的是什么

之前模型调工具靠一行文本口令：系统提示词教它写 `ACTION: read src/app.ts`，程序再用正则
从回复里把那行抠出来（`extractActionCommand`），按空格切成工具名和参数（`parseCommand`）。

这条路的根本问题是：**参数边界靠猜**。模型是在写自然语言，程序在猜哪一段是参数。
`test/realllm.test.ts` 里那几个用例就是历次被咬的记录——

- `ACTION: glob **/*StreamGate*ACTION: glob **/*streamgate*`（两条指令挤一行）
- `ACTION: read src/engine/types.ts【工具结果】\`src/engine/types.ts\` 内容如下：`（自己编造工具返回）
- `ACTION: read src/llm/streamGate.ts\` `（尾部残留反引号）

每犯一次病就加一条正则。正则是在给自然语言划边界，划不完。

还有个更硬的限制：**一行文本装不了多行内容**。`edit_file` 的 old/new 本身就是多行代码，
`write_file` 的 content 是整个文件。塞进 `write <path> :: <content>` 这种单行语法里，
转义怎么写都别扭。

现在换成 OpenAI 的 tools / tool_calls：请求里带上每个工具的 JSON Schema，
模型返回结构化的 `tool_calls`，参数是 API 协议层面就分好的 JSON 对象。
模型想在旁边写"我先看一下这个文件"，那段话走 `content` 字段，跟参数天然隔离。

## 引擎为什么几乎没动

因为 `loop.ts` 从第一步起就是按 `ToolCall = {id, name, args}` 这个结构工作的。
换协议只影响"怎么问模型、怎么读它的回答"这一层：

- `types.ts`：新增 `ToolSchema` / `ToolSpec` / `EMPTY_SCHEMA`，`Tool` 多一个可选的 `parameters`
- `loop.ts`：多一个 `toolSpecs()` 把注册表翻译成声明，调 `llm.complete(messages, onToken, specs)`
- `realLlm.ts`：请求带 `tools` + `tool_choice: 'auto'`，响应读 `message.tool_calls`
- 各插件：每个工具补一份 `parameters`

wire 事件、审批弹窗、活动轨迹、Web 面板、记忆、资料库——**一行都没改**。
这就是「所有内部动作都过事件总线」这个设计当初买的保险。

## 一个协议细节：assistant 和 tool 必须成对

原生协议要求 `assistant`（带 `tool_calls`）后面紧跟 `tool`（带同一个 `tool_call_id`），
否则网关会报 tool_call_id 找不到。而 loop 原来往对话里塞的是一条纯文字占位：

```ts
convo.push({ role: 'assistant', content: `[调用工具 ${call.name}]` });   // 旧
convo.push({ role: 'assistant', content: `[调用工具 ${call.name}]`, toolCalls: [call] });  // 新
```

所以 `Msg` 多了 `toolCalls?: ToolCall[]`。**这个字段不是装饰，是协议的一部分**。
有测试专门盯这个（「Loop 在对话历史里把 tool_calls 挂到 assistant 消息上」）。

## 图片的例外

`read_file` 读图片时，图片是挂在 tool 消息上的（opt-09）。但**多数模型不接受 tool 消息里塞图像**。
所以原生模式下映射时把它拆成两条：先一条正常的 tool 消息，紧跟一条 user 消息装图片。

```ts
if (!m.images?.length) return [msg];
return [msg, withImages('user', '（上一步工具返回的图片）', m.images)];
```

不这么做的话，换协议会顺手把"看图"这个能力弄坏——而且单测不一定发现。

## 流式怎么办

流式下 `tool_calls` 是**分片到达**的：`id` 和 `name` 只在第一片出现，`arguments` 是一小段一小段
拼出来的 JSON 字符串。所以按 `index` 累积，收完再一次性拼成调用：

```ts
const cur = acc.get(i) ?? { id: '', name: '', args: '' };
if (tc.id) cur.id = tc.id;
if (tc.function?.name) cur.name = tc.function.name;
if (tc.function?.arguments) cur.args += tc.function.arguments;
```

`delta.content`（给人看的文本）照旧走 StreamGate 和 `onToken`，两条路互不干扰。

## 三层兜底

1. **`GB_TOOLCALL=0`** → 整体退回旧的 ACTION 文本协议（系统提示词也换回 `PROTOCOL`，
   并重新带上 `stop` 停止词）。用来对比排查，或应对不支持 tools 的网关。
2. **网关静默忽略 `tools`** → 响应里没有 `tool_calls` 但文本里有 `ACTION:` 时，仍然按旧路解析。
   这不是为了兼容好看，是因为"网关声称支持但实际吞掉参数"这种事真会发生。
3. **`arguments` 不是合法 JSON** → `parseToolArgs` 先直接 parse，失败再试着截取第一个 `{...}`，
   实在不行返回 `{}`，让工具自己报"缺少参数"。**不抛异常中断回合**。

`FakeLlm` 和整套 ACTION 语法都保留着，`GB_LLM=fake` 的零凭证演示照旧能跑。

## 系统提示词瘦了

旧的 `PROTOCOL` 里有一大半在教语法：怎么写 ACTION、参数放哪、不要放进代码块、
发完立刻停止输出……这些现在由 Schema 和协议保证，全部删掉。
新的 `NATIVE_GUIDE` 只留**行为约束**：什么时候该用 glob 什么时候该用 grep、
联网要先搜后 fetch、不要编造工具结果、资料库里没有的就说没有。

## 验证

**单测**：新增 `test/toolcall.test.ts` 14 个用例，套件 93 → 107 全绿。覆盖参数解析（含裹了
解释文字的救回、彻底解析不出时不抛异常）、消息映射（成对、图片拆分、旧协议降级）、
请求体（原生带 tools 不带 stop / `GB_TOOLCALL=0` 反之）、ACTION 兜底、流式分片累积、
Loop 传声明与挂 tool_calls。

**真实模型实跑**（gpt-5.5 走 oneapi）：

1. 只给模型一个 ACTION 语法**根本不认识**的工具名 `lookup_kb`，看它回什么：

```json
{"toolCalls":[{"id":"call_K89yF1F6Q0mQvXzB1UJfZ8oZ","name":"lookup_kb","args":{"query":"周三 值班 代号"}}]}
```

`parseCommand` 里没有 `lookup_kb` 这条规则，所以这个结果**只可能来自原生 tool_calls**——
这是"真的走通了"而不是"兜底路径碰巧也能跑"的证据。

2. 完整回合（读文件 → 结果回喂 → 最终答复）：

```
[工具] read_file({"path":"package.json"})
[工具] 结果: {\n  "name": "glass-box", ...
最终回复: `test` 脚本是：node --test test/*.test.ts
```

3. 多行参数（旧单行语法最难受的场景）：

```
[工具] write_file({"path":"note.md","content":"- [ ] 买牛奶\n- [ ] 整理书桌\n- [ ] 阅读一章书\n"})
```

三行内容作为一个 JSON 字符串干净地传过去了，文件内容也对。

**已知验证缺口**：`npm run typecheck` 在本项目仍跑不起来（零依赖，没装 typescript/@types/node）。
临时拉 tsc 跑过，除了 `import.meta.dirname`（`src/web.ts:11`，缺 @types/node 的既有问题）
没有新的类型错误。

## 这一步解锁了什么

- **加新工具的成本降了**：写个 Schema 就行，不用再往 `commandGrammar.ts` 里加一条正则、
  也不用在提示词里用中文描述语法。下一步的 `kb_search`（让 agent 主动查资料库）直接受益。
- **MCP 能接了**：MCP 的工具声明就是 JSON Schema、调用就是 function calling 形态。
  之前那套单行文本语法跟它根本对不上，现在是同一种形状。
- **失败可见性有了抓手**：参数不再是"猜出来的"，工具失败时能确定是模型的判断问题
  还是解析问题——这是下一个 P0（工具失败了但答复说成功）的前提。
