# 优化 04 · RealLlm 健壮性（容错解析 + 超时 + 重试）

> 真实模型的输出不像假模型那样"听话"：它可能把 `ACTION:` 包进代码块、前面加一段解释、用中文冒号；网络也可能超时或抖动。这一步让 `RealLlm` 更抗造。

---

## 1. 一句话理解这一步

之前 `RealLlm` 解析 `ACTION:` 的方式比较死板，真实模型稍微"发挥"一下就可能解析失败、该调的工具没调成。这一步：
- **容错解析**：不管模型把 ACTION 包在 ```代码块``` 里、还是前面写了一句"好的，我来搜索"，都能把指令抽出来。
- **超时 + 重试**：网络异常、超时、或服务端 5xx，会自动重试；不再一次失败就放弃。

---

## 2. 容错解析：`extractActionCommand`

把"从模型回复里抽出 ACTION 指令"抽成一个**纯函数**（好测、无副作用）。它容忍三类常见脏输出：

```
```                          →  去掉代码围栏
ACTION: read package.json
```

好的，我来搜索一下。           →  忽略前置解释文字
ACTION：grep foo              →  兼容中文冒号「：」
```

抽不到就返回 `null`，当作普通文本回复。抽到的指令仍然交给**和 FakeLlm 共用的** `parseCommand` 去解析成工具调用——解析逻辑不分叉。

> 为什么抽成纯函数：这样不用真的联网就能对"各种奇形怪状的模型输出"写单元测试。可测性来自把 IO 和纯逻辑分开。

---

## 3. 超时 + 重试：`postChat`

请求逻辑收敛到一个带重试的方法里：

- **超时**：用 `AbortController` 给每次请求设上限（默认 60s，`GLASSBOX_MODEL_TIMEOUT` 可调），避免卡死。
- **重试**：网络异常 / 超时 / HTTP ≥ 500 → 自动重试，最多 `GLASSBOX_MODEL_RETRIES` 次（默认 2）。
- **不重试**：4xx（如鉴权失败、参数错误）是客户端问题，重试也没用，直接返回错误信息。

失败时返回一条 `（模型调用失败：…）` 文本而不是抛异常——保证 agent 回合能优雅收尾，不会整个崩掉。

---

## 4. 配置项

- `GLASSBOX_MODEL_TIMEOUT` — 单次请求超时毫秒（默认 60000）
- `GLASSBOX_MODEL_RETRIES` — 最大尝试次数（默认 2）

（模型 base url / name / key 仍从 `.env` 的 `MIDSCENE_*` 或 `GLASSBOX_*` 读取。）

---

## 5. 新增/改动文件

```
src/llm/realLlm.ts     # +extractActionCommand()（纯函数容错解析）；postChat() 超时+重试；
                       #  失败返回文本而非抛错
test/realllm.test.ts   # 新增：代码块/前置文字/中文冒号/纯文本/可被 parseCommand 识别
```

引擎、工具、审批、记忆、TUI 均未改动。

---

## 6. 回归测试 + 真实模型冒烟

```
npm test  →  27 passed / 0 failed   （新增 5 条解析用例）
```

真实模型冒烟（gpt-5.5）：「请在代码库里搜索 edit_file 的定义」→ 模型正确发起 `grep` → 据结果作答。重构后真实链路无回退。

---

## 7. 关于"原生 tool-calling"

更"正统"的做法是用 OpenAI 的 function/tool calling 字段传工具 schema、解析结构化 `tool_calls`，比文本 `ACTION:` 协议更稳。本步没上，原因：
- 需要给 `Llm.complete` 传入工具 schema，改动接口签名，牵连更大；
- 不是所有 OpenAI 兼容网关都完整支持 tool calling 字段。

当前的"容错文本协议"对演示已经足够稳。若将来要上原生 tool-calling，它会是一个独立的 `Llm` 实现（比如 `ToolCallingLlm`），依旧只在 `pickLlm()` 里切换，引擎照样不动。

---

## 8. 下一步（优化 05 预告）

**流式输出**：目前模型回复是"一次性蹦出来"。给 chat 加**逐字流式显示**（SSE），边生成边打印，交互体感更接近真实 coding agent。
