# 优化 03 · 精确编辑工具 edit_file（带 diff 审批）

> 之前改文件只有 `write_file`——整文件覆盖，太粗暴，也看不出到底改了啥。这一步加一个 search/replace 式的**精确编辑工具 `edit_file`**，并在审批时**显示 diff**，让你确认前一眼看清"改哪儿"。呼应 Claude Code / codex 的 edit 工具设计。

---

## 1. 一句话理解这一步

- 旧：`write_file` = "把整个文件覆盖成这些内容"（危险、看不出差异）。
- 新：`edit_file` = "把文件里的这段 `old` 换成 `new`"（精准、可预览）。

而且审批时会先给你看一段 diff：
```
[审批] 请求(confirm): 编辑文件: demoedit.txt
   - HELLO
   + 你好世界
是否允许？[y/N]
```

---

## 2. edit_file 的三条安全约定

1. **必须提供 `old`**：明确要替换的原文。
2. **`old` 必须在文件中唯一**：如果出现多次，直接拒绝执行并提示"请提供更精确的上下文"——避免改错地方。
3. **改哪儿看得见**：`assess()` 阶段就读文件、算出 diff 预览，放进审批请求里；审批者展示给人看。

`edit_file` 的风险等级和 `write_file` 一致：工作区内 `confirm`，越界 `dangerous`。只读子 agent 依然拿不到它（`readOnly` 模式只给 `read_file`）。

---

## 3. diff 是怎么接到审批上的

关键改动是给风险评估结构加了一个可选字段：

```ts
interface RiskAssessment {
  level; summary; reason?;
  preview?: string;   // ← 新增：变更预览（diff）
}
```

- `edit_file.assess()` 计算 diff，填进 `preview`。
- 审批请求带着 `preview` 一路走到审批者（`InteractiveApprover` / chat 的审批器 / 日志），谁负责问人，谁就把 diff 打出来。
- 引擎的审批流程一行没改——它只是多传了一个可选字段。这又一次体现了"在稳定接口上做加法"。

diff 生成很朴素（search/replace 场景够用）：`old` 每行标 `-`、`new` 每行标 `+`。

---

## 4. 自己跑一下

```bash
# 指令语法：edit <路径> ||| <旧文本> ||| <新文本>
GB_APPROVE=all node src/index.ts "edit README.md ||| 旧句子 ||| 新句子"

# 交互式下会先给你看 diff 再问 y/N
npm run chat
你> edit some.txt ||| foo ||| bar
```

> 用 `|||` 作分隔符（而不是 `::`），是为了让旧/新文本里能包含冒号等常见字符。

---

## 5. 新增/改动文件

```
src/engine/types.ts        # RiskAssessment 增加可选 preview 字段
src/plugins/fsPlugin.ts    # +edit_file 工具（唯一匹配校验 + assess 生成 diff）；readOnly 时不提供
src/llm/commandGrammar.ts  # +edit 指令解析；GRAMMAR_HELP 增加 edit
src/engine/approval.ts     # InteractiveApprover 打印 diff 预览
src/chat.ts                # 交互审批器打印 diff 预览
src/index.ts               # 日志的 approval.request 打印 diff
test/edit.test.ts          # 新增：唯一替换/多处拒绝/diff 预览/只读不含
test/grammar.test.ts       # +edit 指令解析用例
```

---

## 6. 回归测试

新增 5 条用例（4 条 edit + 1 条 grammar），全量：

```
npm test  →  22 passed / 0 failed
```

实测编辑演示：`edit demoedit.txt ||| HELLO ||| 你好世界` → 审批展示 `- HELLO / + 你好世界` → 放行后文件正确变更。

---

## 7. 下一步（优化 04 预告）

**RealLlm 健壮性**：真实模型有时会把 `ACTION:` 包在 ```代码块``` 里、或前面带点解释，导致解析失败。给 ACTION 解析加"去代码围栏 / 容错抽取"，并对网络失败做一次重试。可选：升级为 OpenAI 原生 tool-calling。
