# Step 2 · 插件化 + 真实工具 + 分级审批

> 这一步做三件事：把「加能力」变成插件（不用改引擎）、给 agent 装上真正有用的工具（读写文件 / 搜索 / 执行命令）、并加一道**安全闸门**——危险操作先问你一句。

---

## 1. 一句话理解这一步

Step1 的 agent 只会 echo。这一步它**真的能干活了**：读文件、写文件、搜代码、跑命令。
但「能干活」也意味着「能闯祸」，所以我们同时装了一道**分级审批**闸门：安全的动作直接放行，有风险的动作先弹出来问你「允许吗？」

---

## 2. 三个核心概念

### (1) 插件（Plugin）——把「加能力」和「引擎」解耦

引擎（Step1 的 loop/wire）本身**一个具体工具都不认识**。所有能力都由插件在启动时「注册」进来：

```
loadPlugins([fsPlugin(), searchPlugin(), shellPlugin()], { tools, wire, workspace })
```

每个插件做的事就是往「工具登记处」放几个工具。好处：**以后加/减能力，引擎代码一行都不用动**。这就是 deepseek-harness「Everything is a Plugin」思想的极简版。

运行时你会看到这样的加载日志（它本身也是一条 wire 事件，所以看得见）：
```
[插件] 加载 fs，提供工具: read_file, write_file
[插件] 加载 search，提供工具: grep
[插件] 加载 shell，提供工具: run_command
```

### (2) 真实工具——agent 的「手”

| 工具 | 能力 | 风险等级 |
| --- | --- | --- |
| `read_file` | 读工作区内文件 | safe（直接执行） |
| `grep` | 按正则搜工作区文件内容 | safe |
| `write_file` | 写文件（覆盖） | confirm；写到工作区外 → dangerous |
| `run_command` | 执行 shell 命令 | confirm；命中危险模式 → dangerous |

### (3) 分级审批——安全闸门

每个工具可以对自己的一次调用做「风险评估」(`assess`)，给出三档：

- **safe**：无害，直接干（读文件、搜索）。
- **confirm**：一般有副作用，要确认（写工作区内文件、普通命令）。
- **dangerous**：可能造成破坏，重点确认（跨工作区写、`rm -rf`、`sudo`、`git push --force` 等）。

关键点：**风险等级可以看参数动态判断**。同样是 `write_file`，写工作区内是 confirm，写到工作区外就升级成 dangerous——因为闯的祸不一样。

---

## 3. 审批发生在流程的哪一步？

在 Step1 的回合循环里，工具执行前**插了一道关卡**（`loop.ts` 的 `executeWithApproval`）：

```
tool_call
   │
   ▼
工具有 assess 吗？评估结果是 safe 吗？
   ├─ 是 safe / 无评估 ──────────────► 直接执行
   └─ 是 confirm / dangerous
             │
             ▼
      向审批者请示（emit approval.request）
             │
        ┌────┴────┐
      放行        拒绝
        │           │
        ▼           ▼
      执行     返回一条“操作被拒绝”的失败结果（绝不执行）
```

被拒绝时，工具**根本不会 run**，只会返回一条失败结果告诉模型「这事没做成」。整个「请求→决定」也都通过 wire 广播，所以玻璃盒里看得一清二楚：

```
[工具] 调用 run_command({"command":"rm -rf /tmp/xxx"})
[审批] 请求(dangerous): 执行命令: rm -rf /tmp/xxx
[审批] 结果: 拒绝
[工具] 结果: 操作被拒绝：run_command（...）
```

---

## 4. 谁来做「放行 / 拒绝」的决定？——两种审批者

我们把「怎么决定」抽象成 `Approver` 接口，给了两种实现：

- **InteractiveApprover**：在真实终端里逐条问你 `[y/N]`。危险操作会带更醒目的标记和原因。（这是给人用的一面，Step3 会把它接到 TUI 上）
- **AutoApprover**：非交互场景（脚本 / 演示 / 测试）用，按预设策略自动决定，方便一键复现效果。

`index.ts` 会自动选：**有终端就交互问你，没终端就用环境变量控制**：

```bash
# 默认：confirm 放行、dangerous 拒绝（安全默认值）
node src/index.ts "write demo.txt :: 内容"

GB_APPROVE=all  node src/index.ts "run ls docs"        # 全部放行
GB_APPROVE=none node src/index.ts "write x.txt :: 内容" # 全部拒绝
```

---

## 5. 自己跑一下（假模型的指令语法）

假模型现在能听懂这些指令，把它们翻译成工具调用：

```bash
node src/index.ts "read package.json"              # 读文件
node src/index.ts "write demo.txt :: 你好"          # 写文件（confirm）
node src/index.ts "grep 事件总线"                    # 搜索
node src/index.ts "run ls docs"                     # 执行命令（confirm）
node src/index.ts "run rm -rf /tmp/x"               # 危险命令（默认被拒）
```

> `write` 的语法是 `write <路径> :: <内容>`，用 `::` 分隔路径和内容。

---

## 6. 这一步新增/改了哪些文件

```
src/engine/
  types.ts       # +RiskLevel/RiskAssessment/ApprovalRequest/Approver；Tool 增加 assess()；新增 3 个 wire 事件
  plugin.ts      # 新增：Plugin 接口 + loadPlugins()
  approval.ts    # 新增：AutoApprover / InteractiveApprover
  loop.ts        # 工具执行前插入 executeWithApproval() 审批关卡
src/plugins/
  paths.ts       # 新增：判断路径是否在工作区内（越界=高风险）
  fsPlugin.ts    # 新增：read_file / write_file
  searchPlugin.ts# 新增：grep
  shellPlugin.ts # 新增：run_command（含危险命令识别）
src/llm/fakeLlm.ts  # 假模型升级：支持 read/write/run/grep/echo 指令语法
src/index.ts        # 组装插件 + 选择审批者；先订阅事件再加载插件（让加载过程可见）
```

---

## 7. 设计取舍 & 一个小坑

- **风险评估放在工具自己身上**（`assess`），而不是引擎里写死一张规则表。因为「什么算危险」只有工具最清楚，也方便每个插件自带策略。
- **审批者是可替换的接口**。同一套引擎，测试用 AutoApprover、真人用 InteractiveApprover、Step3 用 TUI 弹窗，互不影响。
- **小坑**：一开始把「加载插件」写在「订阅事件」之前，结果 `plugin.loaded` 事件在没人监听时就发出去了，日志里看不到。**教训**：可观测系统里，订阅者要先就位，再触发事件。已调整顺序。

---

## 8. 下一步（Step 3 预告）

目前所有东西都打成一条平铺的日志。Step 3 会做**分层 TUI**：左边是对话流，右边是「玻璃盒面板」——实时显示回合状态机、工具调用、审批队列。到那时，`InteractiveApprover` 的确认框也会真正接到界面上。
