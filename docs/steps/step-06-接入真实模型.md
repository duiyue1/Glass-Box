# Step 6 · 接入真实模型（收尾）

> 最后一步：把「假模型」换成**真实大模型**（gpt-5.5，OpenAI 兼容接口）。
> 核心不是"接个 API"，而是验证从 Step1 就立下的设计承诺——**只换 `Llm` 一个实现，引擎 / 工具 / 审批 / Skills / 记忆全都不用动**。事实证明：真的没动。

---

## 1. 一句话理解这一步

前面五步 agent 的"大脑"一直是假的（靠规则冒充）。这一步换上真大脑（gpt-5.5）。
换完之后，你用自然语言说「在代码库里搜一下 TurnState」，**真实模型自己决定去调 grep 工具**，拿到结果后再用中文回答你。而这一切，引擎代码一行没改。

---

## 2. 关键设计：为什么"换模型不用改引擎"

从 Step1 起，引擎只依赖一个极简接口：

```ts
interface Llm { complete(messages): Promise<LlmResponse>; }
```

- `FakeLlm` 实现它（规则版）。
- `RealLlm` 也实现它（调 HTTP 接口）。

引擎（Loop）只管调 `llm.complete(...)`，根本不关心背后是真是假。所以换模型 = 换一个实现类，`buildApp` 里选一下而已。这就是「面向接口编程」的价值，在这个项目里被验证了。

---

## 3. 真实模型怎么"学会"用我们的工具

真实模型不知道我们有哪些工具、也不知道该怎么触发。`RealLlm` 用一段**系统提示**教它一个简单协议：

- 告诉它可用的指令语法：`read / write / run / grep / delegate / echo`
- 约定：**要用工具就只回一行 `ACTION: <指令>`**（例如 `ACTION: grep TurnState`）；不用工具就正常中文作答。
- 工具结果会以「工具结果」开头回传给它，让它据此继续。

`RealLlm` 收到回复后：
- 如果发现 `ACTION:` 行 → 用**和 FakeLlm 完全相同的** `parseCommand` 解析成工具调用；
- 否则当作最终文本答复。

> 妙处：FakeLlm 和 RealLlm **共用同一套指令语法解析**（`commandGrammar.ts`）。所以工具协议也没有分叉——假模型能跑的，真模型照样能跑。

（注：更"正统"的做法是用 OpenAI 的 function/tool calling 字段。这里用 `ACTION:` 文本协议，是为了不改 `Llm` 接口签名、对任何 chat 模型都通用。）

---

## 4. 配置与凭证安全

模型配置从环境变量读取，兼容你给的 `MIDSCENE_*` 命名：

```
MIDSCENE_MODEL_BASE_URL=https://<your-openai-compatible-endpoint>/v1
MIDSCENE_MODEL_NAME=gpt-5.5
MIDSCENE_MODEL_API_KEY=sk-****（密钥）
MIDSCENE_MODEL_FAMILY=gpt-5
```

- 这些写在项目根目录的 **`.env`** 里，启动时由 `process.loadEnvFile()` 自动加载。
- **`.env` 已加入 `.gitignore`**，不会被提交，避免密钥泄露。
- 也支持 `GLASSBOX_MODEL_*` 同名变量覆盖。

模型选择逻辑（`pickLlm`）：
- 配了 API key → 默认用 `RealLlm`
- `GB_LLM=fake` → 强制回退假模型（零凭证演示/离线）
- 缺配置 → 自动回退假模型并提示

---

## 5. 自己跑一下

```bash
# 用真实模型（.env 已配好 key，直接就是 RealLlm）
node src/index.ts "用一句话介绍你自己"
node src/index.ts "请在代码库里搜索包含 TurnState 的位置"   # 模型自己决定调 grep
node src/tui.ts  "读取 package.json 并告诉我项目名"        # TUI + 真实模型

# 想离线/零凭证演示，强制假模型
GB_LLM=fake node src/tui.ts "grep Wire"
```

实测（gpt-5.5）：
- 「介绍你自己」→ 纯文本回答（不调工具）✓
- 「搜索 TurnState」→ 模型输出 `ACTION: grep TurnState` → 引擎执行 grep → 模型据结果作答 ✓
- 「读取 package.json」→ `ACTION: read package.json` → 得到 `glass-box` ✓
- `GB_LLM=fake` → 正确回退假模型 ✓

> 真实模型每次请求有网络延迟（约 10 秒级），TUI 的动画节奏会随之变化，这是正常的。

---

## 6. 这一步新增/改了哪些文件

```
src/llm/
  commandGrammar.ts  # 新增：抽出共用的指令语法解析（Fake/Real 共用）
  fakeLlm.ts         # 改为复用 commandGrammar（行为不变）
  realLlm.ts         # 新增：RealLlm（OpenAI 兼容）+ resolveModelConfig()
src/app.ts           # 新增 pickLlm()：按配置选真/假模型；启动时 loadEnvFile()
.env                 # 新增：模型凭证（已被 .gitignore 忽略）
.gitignore           # 新增忽略 .env
```

**引擎（engine/）、插件（plugins/）、技能（skills/）、记忆（memory/）、TUI（tui/）——全部零改动。**

---

## 7. 整个项目回顾（Step1 → Step6）

```
Step1  引擎骨架：turn 状态机(loop) + 事件总线(wire) + 假模型      —— 一切可观测的地基
Step2  插件化 + 真实工具(fs/grep/shell) + 分级审批                —— 能干活，且有安全闸门
Step3  分层 TUI + 玻璃盒实时面板                                  —— 内部状态肉眼可见
Step4  Skills 按需加载 + Subagent + 上下文压缩                    —— 更聪明、更省、可隔离
Step5  分层记忆：L0→L1 蒸馏 + 预算封顶检索注入                    —— 有记性、不撑爆上下文
Step6  接入真实模型（gpt-5.5）                                    —— 验证"换模型不改引擎"
```

一条主线贯穿始终：**所有能力都长在 Step1 那条事件总线 + 两个抽象（Plugin、ContextProvider、Llm 接口）之上**。这让每一步都能"只加不改"，也让整个 agent 的内部对你透明——这就是 Glass-Box。

设计灵感对照：
- 引擎自写、无黑盒、FAKE_LLM 零凭证 —— cchenhao-coding-tui
- 插件化"everything is a plugin" —— deepseek-harness
- Skills 渐进加载 / Subagent(Task) / 分级审批 —— Claude Code
- 分层 streaming 界面 —— kimi-code
- 分层记忆 + 预算检索 —— TencentDB-Agent-Memory

至此，6 步全部完成。
