# Glass-Box · 可观测、可插拔的迷你 coding agent

> 一个跑在终端里的迷你 coding agent。它的特别之处不在"又一个 agent"，而在**把 agent 的内部机制装进玻璃盒**——状态机、工具调用、审批、Skills、记忆、上下文压缩，每一刻都看得见。引擎全自写、无黑盒；零凭证即可跑通。

## 这是什么

用最小的代码，把一个 coding agent 的完整机制讲清楚，并且全程可观测：

- **引擎自写，没有黑盒**：turn 状态机（loop）、事件总线（wire）、工具执行、审批——每一层都能直接读源码。
- **一切走事件总线**：引擎内部每个动作都以事件广播出去，TUI 面板、记忆子系统都只是"事件的订阅者"。这让内部状态对你透明。
- **插件化**：工具（读写/搜索/执行）、模型、能力都是可插拔的插件，加能力不改引擎。
- **安全默认值**：四级审批（含**硬拒绝**）+ 真实路径归属判断 + 危险命令识别 + `.git` 与跨工作区写拒绝，有风险的操作先向你确认。
- **零凭证可跑**：`FakeLlm` 用规则冒充模型，无需任何 API key 就能跑通完整链路；配上真实模型也只换一个实现。

设计灵感来自：cchenhao-coding-tui（自写引擎/FAKE_LLM）、deepseek-harness（everything is a plugin）、Claude Code（Skills/Subagent/分级审批）、kimi-code（分层 streaming 界面）、TencentDB-Agent-Memory（分层记忆 + 预算检索）。

## 快速开始

要求：**Node ≥ 22.6**（直接运行 `.ts`，无需编译；本项目零第三方依赖）。

```bash
cd Glass-Box

# 1) 零凭证跑通一个回合（假模型）
node src/index.ts "echo 你好世界"

# 2) 看玻璃盒面板（真实终端有逐帧动画）
npm run tui

# 3) 交互式多轮对话（推荐，真人边聊边看内部状态 + 实时审批 + 流式回复）
npm run chat

# 4) Web UI（浏览器里的玻璃盒，仅监听 127.0.0.1）
npm run web        # 打开 http://127.0.0.1:7777

# 5) 跑测试（零依赖，Node 自带 test runner）
npm test
```

### 用真实模型

在项目根目录创建 `.env`（已被 `.gitignore` 忽略，不会提交）：

```
MIDSCENE_MODEL_BASE_URL=https://<your-openai-compatible-endpoint>/v1
MIDSCENE_MODEL_NAME=<model-name>
MIDSCENE_MODEL_API_KEY=<your-key>
MIDSCENE_MODEL_FAMILY=gpt-5
```

配了 key 后默认就用真实模型：

```bash
node src/index.ts "请在代码库里搜索包含 TurnState 的位置"   # 模型自己决定调 grep
npm run chat                                                # 交互式对话
GB_LLM=fake npm run chat                                    # 强制回退假模型（离线/演示）
```

## 三个入口

- **`node src/index.ts "<输入>"`** — 日志模式：把内部事件打成一条时间线，适合调试/看流程。
- **`node src/tui.ts "<输入>"`（`npm run tui`）** — 分屏 TUI：左对话流 / 右玻璃盒面板；真实终端逐帧动画，管道输出最终定格。
- **`node src/chat.ts`（`npm run chat`）** — 交互式多轮对话：真人逐句对话，关键动作实时流式提示，`/panel` 随时看面板，有风险操作实时向你请求确认。
  - 命令：`/panel` 看玻璃盒面板 · `/help` 帮助 · `/exit` 退出
  - **回合跑飞了按 `Esc`（或 `Ctrl-C`）中断**：只掐这一个回合，做过的步骤留在历史里，接着聊就行；空闲时按 `Ctrl-C` 才是退出
- **`node src/web.ts`（`npm run web`）** — Web UI：浏览器里的玻璃盒。左侧流式对话 + 内部动作轨迹，右侧实时面板（状态机 / 上下文预算 / Skills / 记忆 / 工具 / 子agent / 审批 / 事件流），审批以弹窗形式出现并彩色渲染 diff。回合进行中输入框旁会出现「停止」按钮。
  - **只监听 `127.0.0.1`**（这个 agent 能执行命令、读写文件，绝不对外暴露）；端口用 `GB_PORT` 调整。

多回合可在 `index.ts` / `tui.ts` 用 `;;` 分隔一次喂入：`node src/index.ts "echo a ;; echo b"`。

## 指令语法（工具）

假模型和真实模型共用同一套工具指令（真实模型通过 `ACTION: <指令>` 触发）：

- `read <path>` — 读文件（工作区内 safe；工作区外需 dangerous 审批；凭证类文件 deny；图片会作为图像交给模型）
- `write <path> :: <内容>` — 写文件（confirm；写 `.git` 下 / 工作区外 / 凭证类文件一律 deny）。
  **覆盖已存在的文件必须先 `read` 过它**，读过之后又被外部改动同样拒绝——覆盖式写入丢掉的内容找不回来。
  审批时显示 diff，两头没变的行折叠掉
- `edit <path> ||| <旧文本> ||| <新文本>` — 精确 search/replace 编辑，审批时显示 diff（要求旧文本唯一）
- `run <命令>` — 执行 shell 命令（confirm；命中危险模式升级 dangerous）。默认前台、超时 120 秒、输出头尾截断。
  原生 tool calling 下可传 `background: true` 放后台跑（dev server、大测试），立刻返回任务号
- `read_output <任务号>` — 取后台任务的**增量**日志与状态（只回上次读过之后的部分，不占步数）
- `kill_command <任务号>` — 终止一个还在跑的后台任务（confirm）
- `grep <正则>` — 搜索工作区文件内容（safe）
  - `grep <正则> in <文件名模式>` — 只搜匹配该模式的文件，如 `grep TurnState in *.ts`
  - `-i` 忽略大小写 · `-l` 只列出命中的文件 · `-c` 只统计每个文件命中几处
- `glob <文件名模式>` — 按文件名找文件（safe），支持 `**` / `*` / `?` / `{a,b}`，按最近修改排序
- `web <搜索词>` — 联网搜索（confirm；零 key，爬搜索引擎结果页），返回 5 条 标题/链接/摘要
- `fetch <url>` — 抓网页正文并转纯文本（confirm；内网/本机地址一律拒绝）
- `delegate <子任务>` — 下放给只读、隔离的子 agent
- `echo <文本>` — 回显（调试用）

## 接外部工具（MCP）

在 `.glassbox/mcp.json` 里声明服务器，启动时自动握手、拉工具列表、注册进工具表——**不改一行引擎代码**：

```json
{
  "servers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": { "command": "python", "args": ["-m", "my_mcp_server"], "env": { "TOKEN": "x" }, "trust": true }
  }
}
```

工具名形如 `mcp__fs__read_text_file`（带服务器名是因为两台服务器很可能都有个叫 `search` 的工具）。几条刻意的约束：

- **默认逐次审批**。MCP 服务器是外部进程，能读文件、能联网，做什么由它自己决定；默认免审批等于把项目所有安全边界一次交出去。确认可信（比如只读的内部文档服务）再加 `"trust": true`。
- **只做 stdio + tools**，不做 SSE/HTTP，也不做 resources/prompts。
- **参数有损降级**：MCP 的 `inputSchema` 是完整 JSON Schema，而引擎的工具表只认扁平标量。array/object 参数会声明成字符串并在说明里写「请传 JSON 字符串」，调用前再解析回来——宁可如实告诉模型，也不假装支持。
- 一台连不上不影响其他台，失败原因和服务器 stderr 会打在启动日志里。`"disabled": true` 临时停用，`GB_MCP=0` 整体关掉。

## 环境变量

- `GB_LLM` — `real` / `fake`，强制模型类型（默认：配了 key 用 real，否则 fake）
- `GB_APPROVE` — 非交互下的自动审批策略：`all` 全放行 / `none` 全拒绝 / 默认 confirm 放行、dangerous 拒绝。
  注意 `all` 也放不行 `deny` 级别（写 `.git`、写工作区外、读写凭证文件）——那条闸门在引擎里，不经过 Approver。
- `GB_COMPACT_RATIO` — 上下文用到模型窗口的这个比例就压缩（默认 0.8）。秤的是**整个请求**：系统提示 + 工具声明 + 本回合注入 + 对话
- `GB_RETAIN_RATIO` — 压缩时保留最近多少（默认 0.16，必须小于 `GB_COMPACT_RATIO`）
- `GB_BUDGET` — 直接写死上下文预算（绝对值模式）。设了它就不看窗口比例，并退回"保留最近 2 条"。
  演示用 `GB_BUDGET=160`：真窗口十几万的话，跑一整天也看不到一次压缩
- `GLASSBOX_MODEL_WINDOW` / `MIDSCENE_MODEL_WINDOW` — 模型上下文窗口（默认 128000）。比例阈值按它算
- `GB_PRUNE=0` — 关掉压缩第一级（削工具输出）；`GB_PRUNE_CHARS` 调阈值（默认 2000 字）。
  超阈值的工具输出掐掉中间、留头留尾，不丢消息、不调模型——上下文里最肥的就是它，而它也最容易靠重新调工具补回来
- `GB_SUMMARY=1` — 让模型写结构化八段摘要（默认关）。实测每次压缩多花 20~50 秒、
  压缩比从 -55% 掉到 -13%，换来的"摘要里保留工具做过什么"暂时量不出来
- `GB_INJECT_RATIO` — 注入总共最多占预算的多少（默认 0.25）。记忆/知识目录/资料库从这里按序领用，
  **只往下收紧不往上放宽**：窗口大时取各自上限，行为与写死默认值时一致
- `GB_MEM_ITEMS` / `GB_MEM_TOKENS` — 记忆检索的条数 / token 上限（默认 3 / 40）
- `GB_MEM_PERSIST=0` — 关闭记忆持久化（默认写入 `.glassbox/memory.json`）
- `GB_KB=0` — 关掉资料库（既不注入片段，也不注册 `kb_*` 工具）；A/B 评测的对照组开关
- `GB_KB_CTX=0` — 关掉块级上下文（每块那句「这段在讲什么」+ 状态标签）；`GB_KB_CTX_INDEX=1` 让那句话也进 BM25 语料（默认不进，实测零收益且会扰动排序）
- `GB_KB_REWRITE=0` — 关掉检索改写（默认 1：一段都没检索到时让模型换 2~3 组检索词再试一轮）；`GB_KB_MIN_TOP1` 设成 >0 可让"命中但分数太低"也触发改写
- `GB_WIKI=0` — 关掉知识目录注入（wiki 条目清单）；`GB_WIKI_ITEMS` / `GB_WIKI_TOKENS` 调它的条数与 token 上限（默认 20 / 240）
- `GB_MAX_IMAGE_MB` — 单张图片的体积上限（默认 4，超过则拒绝读取）
- `GB_MAX_STEPS` — 单回合最多执行多少次工具调用（默认 20，防止模型在工具里打转；`task_plan` 这类纯记账工具不占步数）
- `GB_PARALLEL=0` — 关掉只读工具的并行执行（对照组）。默认开：模型一次要五个 `grep`/`read` 时同时跑，
  墙上时间从"相加"变成"取最大"。只对**全是只读且都不需要审批**的批次生效；
  混进写操作、或有一个要点确认，整批退回排队
- `GB_MCP=0` — 不连任何 MCP 服务器（默认：有 `.glassbox/mcp.json` 就连）
- `GB_SUB_MAX_STEPS` — 子 agent 的步数上限（默认 6）
- `GB_SHELL_TIMEOUT` — 前台 `run_command` 的默认超时毫秒（默认 120000，与自动验证对齐；模型可自己调到上限 600000）。
  原来写死 10 秒，`npm install` / `npm test` / `go build` 没有一个跑得完
- `GB_SHELL_BG_TIMEOUT` — 后台任务的兜底超时（默认 600000，上限 3600000）。到点强杀，进程退出时也会收掉，不留孤儿
- `GB_SHELL_MAX_OUTPUT` — 单个后台任务累积输出的字符上限（默认 200000，超出丢最早的并如实告知丢了多少）
- `GB_WEB=0` — 关闭全部联网工具
- `GB_SEARCH_PROVIDER` — `bing`（默认，国内可直连）/ `ddg`（DuckDuckGo，需能访问）
- `GB_SEARCH_RESULTS` — 搜索返回条数（默认 5）
- `GB_SEARCH_MAX_PER_TURN` — 每回合最多搜索几次（默认 2，用完后强制改用 `fetch` 读正文）
- `GB_WEB_MAX_KB` — 单页最多下载多少 KB（默认 40，超出截断并标注）
- `GB_WEB_TIMEOUT_MS` — 联网请求超时（默认 15000）
- `GB_STREAM=0` — 关闭流式输出
- `GB_FAKE_STREAM_DELAY` — 假模型模拟流式的每块延迟毫秒（默认 0）
- `GB_DELAY` — TUI 动画每帧毫秒（默认 220）
- `GB_PORT` — Web UI 端口（默认 7777，仅绑定 127.0.0.1）
- `GLASSBOX_MODEL_TIMEOUT` / `GLASSBOX_MODEL_RETRIES` — 模型请求超时毫秒 / 最大尝试次数（默认 60000 / 2）
- `MIDSCENE_MODEL_*` / `GLASSBOX_MODEL_*` — 模型配置（base url / name / api key / family）

## 架构一览

一条主线：**所有能力都长在事件总线 + 三个抽象之上**。

- **事件总线 `Wire`**：引擎每个动作都 `emit` 事件并记入 history；任何人都能 `subscribe`（TUI、记忆都是订阅者）。
- **`Plugin` 抽象**：工具/能力在 setup 时注册进 `ToolRegistry`，引擎不认识具体工具。
- **`ContextProvider` 抽象**：Skills、记忆都按需为"本回合"贡献上下文，命中才注入。
- **`Llm` 接口**：`complete(messages)`。FakeLlm / RealLlm 都实现它，换模型不改引擎。
- **`Loop`（单回合状态机）+ `Session`（跨回合历史 + 压缩）**：职责分离。

```
src/
├── index.ts            # 日志模式入口
├── tui.ts              # 分屏 TUI 入口
├── chat.ts             # 交互式多轮对话入口
├── web.ts              # Web UI 服务（node:http + SSE，仅本地回环）
├── web/ui.html         # 单文件前端（零构建、零依赖）
├── app.ts              # buildApp()：组装引擎/插件/skills/记忆/模型
├── engine/             # 引擎核心
│   ├── types.ts        #   类型 + WireEvent
│   ├── wire.ts         #   事件总线 + 黑匣子
│   ├── loop.ts         #   回合状态机
│   ├── session.ts      #   跨回合历史
│   ├── compact.ts      #   上下文压缩（两级：先削工具输出，再压成摘要）
│   ├── prune.ts        #   削工具输出（不调模型、不丢消息）
│   ├── summarize.ts    #   结构化八段摘要（默认关，GB_SUMMARY=1 打开）
│   ├── toolRegistry.ts #   工具登记处
│   ├── plugin.ts       #   Plugin 抽象 + loadPlugins
│   ├── approval.ts     #   分级审批者
│   ├── redact.ts       #   图片脱敏（真数据只走模型请求，事件流留占位）
│   └── tokens.ts       #   token 估算（图片按固定成本折算）
├── plugins/            # fs(read/write/edit) / search(glob+grep) / shell / web / subagent
├── mcp/                # MCP 客户端（stdio + JSON-RPC）+ 把外部工具注册进工具表
├── net/                # 零依赖联网层：http(超时/字节上限/SSRF) / html→文本 / 搜索后端
├── activity/           # 活动轨迹：工具 meta → 创建/修改/执行 清单 + 汇总
├── skills/             # Skills 注册与匹配（+ skills/*.md）
├── memory/             # 分层记忆：L0/L1 + 蒸馏 + 预算检索 + 落盘持久化
├── llm/                # fakeLlm / realLlm(SSE) / 共用指令语法 / 流式闸门
└── tui/renderer.ts     # 事件流 → 分屏画面

test/                   # 单元测试（node --test）
```

## 一步步理解（教学文档）

`docs/steps/` 下有每一步的通俗讲解：

**主线六步**
- `step-01-引擎骨架.md` — turn 状态机 + 事件总线 + 假模型
- `step-02-插件化与分级审批.md` — 插件 + 真实工具 + 安全闸门
- `step-03-分层TUI与玻璃盒面板.md` — 分屏界面 + 实时内部状态
- `step-04-Skills与Subagent与上下文压缩.md` — 三样"更聪明"的能力
- `step-05-记忆链路.md` — 分层记忆 + 预算封顶检索
- `step-06-接入真实模型.md` — 换真实模型（含全项目回顾）

**优化十一步**
- `opt-01-测试套件.md` — node:test 零依赖测试
- `opt-02-记忆持久化.md` — 记忆落盘，跨会话记得
- `opt-03-精确编辑工具.md` — edit_file + diff 审批
- `opt-04-RealLlm健壮性.md` — 容错解析 + 超时 + 重试
- `opt-05-流式输出.md` — SSE 流式 + 内部指令不泄漏
- `opt-06-WebUI.md` — 浏览器里的玻璃盒（node:http + SSE，零依赖）
- `opt-07-活动轨迹.md` — 「创建 3 · 修改 6 · 执行 7」式的结构化活动清单
- `opt-08-检索工具增强.md` — glob 文件名检索 + grep 范围限定/大小写/输出模式
- `opt-09-越界读取与看图.md` — 工作区外读取走审批 + 读图片（多模态）+ 黑匣子脱敏
- `opt-10-步数上限与子agent模型.md` — 回合步数刹车 + 子 agent 用真模型
- `opt-11-全网搜索.md` — web_search + web_fetch（零 key 爬结果页、SSRF 防护、字节封顶）

**opt-12 及之后**：资料库与检索（12~29）、编辑后自动验证（30）、任务计划（31）、上下文预算按窗口比例（32）、
过秤整个请求（33）、压缩分两级 + 注入按比例 + token 对账（34~37）。
每一步一篇，直接看 `docs/steps/` 下的文件名。

## 安全说明

- `.env` 存放模型密钥，已被 `.gitignore` 忽略；分享项目时不要连 `.env` 一起发出去，临时 key 用完建议轮换。
- **风险分四级**：`safe`（免审批）/ `confirm`（问一次）/ `dangerous`（问一次，标红并给原因）/ `deny`（**硬拒绝，不问人**）。
  `deny` 在引擎里直接拦下，连 Approver 都不会被调用——`GB_APPROVE=all` 也放不行。
- **默认按"需确认"处理**：工具没声明 `assess` 就算 `confirm`。以前默认是 safe，等于"忘了声明 = 静默放行"，新增工具或接入 MCP 时最容易在这里破防。
- **路径归属看真实路径，不看字面**：先 `realpath`（文件还不存在时取最深的已存在祖先再拼字面后缀，悬空软链按它指向的目标算），再判断在不在工作区内。
  否则工作区里放一个指向 `~/.ssh/id_rsa` 的软链，字面上它就"在工作区内"。
- 写文件、执行命令等操作默认需要确认；危险命令（`rm -rf`、`sudo`、`git push --force`、`git config`、`git reset`、`git clean`、`git checkout --` 等）会被识别为高风险。
  后四个是"删掉找不回来"的那一类：`git config` 等于写 `.git/config`，`git clean` 删的是未跟踪文件。
- **`.git` 目录一律不可写**（`deny`）。写 `.git/hooks/pre-commit` 等于给下一次 `git commit` 埋一段自动执行的脚本——那是一条绕过所有工具审批的路。
- **写到工作区外一律不可写**（`deny`，含顺着软链出去的情况）；**写凭证类文件一律拒绝**。
- **读取工作区外的文件**属于 dangerous，需要你逐次授权；但凭证类文件（`.env` / `.ssh/` / `*.pem` / `.aws/credentials` / Keychain 等）在**黑名单里永久拒绝**，即使误点"允许"也读不到。
- 图片以 base64 发给模型，**真数据只出现在模型请求里**；事件流 / 黑匣子 / Web SSE 中只保留 `[image image/png ~97KB]` 这样的占位描述。
- 联网工具（`web` / `fetch`）默认需要确认；**内网、本机、云元数据地址（`localhost`、`10.*`、`169.254.*`、`*.internal` 等）在黑名单里永久拒绝**，且每一跳重定向都会重新检查（防 SSRF）。`GB_WEB=0` 可整体断网。

### 「始终允许」（会话级授权）

审批时除了「允许 / 拒绝」，还有第三个选项 **「始终允许」**（终端里按 `a`，Web UI 里点按钮）：本会话内**同类**调用不再问。

- **同类怎么算**：工具名 + 首个字符串参数的前两段。`run_command:npm test` 会覆盖 `npm test -- --watch`，但覆盖不到 `npm install`。
  取整条命令太细（换个参数就要重问），只取工具名太粗（批准过一次 `run_command` 等于交出 shell）。
- **只有 `confirm` 能被记住**。`dangerous` 永不进记忆——点一次头不该换来永久授权。
- **关键配置文件例外**（`package.json` / `package-lock.json` / `tsconfig.json` / `AGENTS.md`，以及 `.github/` `.glassbox/` `skills/` 下的文件）：
  每次都单独确认。改它们会动构建/测试门槛或 agent 自身行为——`package.json` 的 `test` 脚本能把"跑测试"变成任意命令。
- **记忆不另存文件**：`resume` / `fork` 时从会话日志的 `approval.decision` 事件里重算。好处是记忆键算法以后要改，旧日志也能按新算法重算，不会对不上。

为什么这算安全设计而不只是体验优化：加固之后要确认的东西变多了，如果每条命令都问一遍，真人会直接上 `GB_APPROVE=all`——那前面所有的分级、硬拒绝、关键文件保护就一起废了。

- 图片以 base64 发给模型，**真数据只出现在模型请求里**；事件流 / 黑匣子 / Web SSE 中只保留 `[image image/png ~97KB]` 这样的占位描述。
- 联网工具（`web` / `fetch`）默认需要确认；**内网、本机、云元数据地址（`localhost`、`10.*`、`169.254.*`、`*.internal` 等）在黑名单里永久拒绝**，且每一跳重定向都会重新检查（防 SSRF）。`GB_WEB=0` 可整体断网。
