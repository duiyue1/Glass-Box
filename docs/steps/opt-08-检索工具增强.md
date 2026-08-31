# 优化 08 · 检索工具增强（glob + grep）

## 这一步在解决什么问题

之前 agent 找东西只有一把钝刀：`grep <正则>`，全工作区无脑扫。

三个具体的痛点：

1. **找不了文件名**。想知道"项目里有哪些测试文件"，只能 `run ls` 或 `run find`——
   而 `run` 是需要审批的高风险工具。明明是只读的查询，却要走危险通道，这是设计缺陷。
2. **搜不了范围**。搜 `TurnState` 会把 `docs/` 里的讲解文档、`test/` 里的用例全捞出来，
   真正想看的 `src/` 反而被淹了。
3. **输出只有一种**。想问"哪几个文件提到了它"（要文件列表）、
   "一共出现多少次"（要计数），拿到的却总是 30 行内容明细。

真实的 coding agent（Claude Code 等）都是 `Glob` + `Grep` 两把工具配合，
且 grep 支持范围和输出模式。这一步把这套补齐。

## 新增：glob 工具

```
glob **/*.test.ts        → 列出所有测试文件
glob src/*.ts            → 只列 src 下一层的 ts
glob *.{ts,md}           → 多选后缀
```

它是 **safe 级**的（只读，不需要审批）——这正是它存在的意义：
把"列文件"这件无害的事，从 `run find` 那种需要审批的通道里解放出来。

### glob 模式怎么编译成正则

`globToRegExp` 手写了一个极简编译器（零依赖，不引 minimatch）：

| 写法 | 含义 | 编译结果 |
| --- | --- | --- |
| `**/` | 任意层目录（含零层） | `(?:.*/)?` |
| `**` | 任意字符（跨目录） | `.*` |
| `*` | 任意字符（不跨目录） | `[^/]*` |
| `?` | 单个字符 | `[^/]` |
| `{a,b}` | 多选 | `(?:a|b)` |

两个容易踩的细节：

- **不含 `/` 的模式自动补 `**/`**。用户写 `*.ts` 时想的是"所有 ts 文件"，
  不是"根目录下的 ts 文件"。所以 `*.ts` 内部会变成 `**/*.ts`。
- **`**/` 必须允许零层目录**。否则 `src/**/*.ts` 匹配不到 `src/a.ts`，
  只能匹配 `src/deep/c.ts`——这是 glob 实现里最经典的 off-by-one。
  用 `(?:.*/)?` 里的 `?` 解决。

其余字符统统做正则转义，避免文件名里的 `.` `(` 被当成元字符。

结果按**最近修改时间倒序**返回：你正在改的文件，大概率就是你要找的文件。

## 增强：grep

```
grep TurnState in *.ts        只搜 .ts 文件
grep -i streamgate in *.ts    忽略大小写
grep -l TurnState             只列出命中的文件
grep -c TODO in src/**        只统计每个文件命中几处
```

内部就是三个可选参数：`glob`（复用同一个 `globToRegExp` 过滤文件）、
`ignoreCase`（正则加 `i` 标志）、`mode`（`content` / `files` / `count`）。

`content` 模式仍然封顶 30 条，并且在被截断时明确说出来——
"只显示前 30 条"和"一共只有 30 条"是两件完全不同的事，
含糊过去会让模型（和人）得出错误结论。

## 指令语法解析里的一个坑

新语法 `grep <正则> in <文件名模式>` 有个歧义：如果正则本身包含 " in " 怎么办？
比如 `grep built in cache in *.ts`。

解决办法是**贪婪匹配 + 取最后一个 `in`**：

```ts
const scoped = s.match(/^(.+)\s+in\s+(\S+)$/i);
```

`.+` 是贪婪的，会一路吃到最后一个 ` in `，所以正则部分完整保留为 `built in cache`，
范围是 `*.ts`。测试里专门钉了这个 case。

同理，开关（`-i` / `-l` / `-c`）**只在最前面认**：

```ts
for (;;) {
  const m = s.match(/^(-[ilc])\s+/);
  if (!m) break;
  ...
}
```

否则正则里出现 `-i` 就会被误吞。**边界规则要写死，不能靠"应该不会有人这么写"。**

## 顺带受益的地方

- **子 agent 变强了**。`delegate` 给的是 `fsPlugin({readOnly:true}) + searchPlugin()`，
  现在这个只读子 agent 自动获得了 glob 能力——插件化的红利，subagentPlugin 一个字没改。
- **活动轨迹自动收录**。`glob` 上报 `meta.action='searched'`，
  于是轨迹里直接出现 `搜索 **/*.test.ts 命中 12`。上一步的 Activity 也没改。
- **真实模型的提示词升级**。`PROTOCOL` 里加了检索策略建议：先 glob 定位、再 grep 搜内容。
  提示词是模型的"使用说明书"，加了工具不写说明，模型就不会用。

## 验证

在 Glass-Box 自己的代码库里跑：

```
$ node src/index.ts 'glob **/*.test.ts ;; grep -l TurnState in *.ts ;; grep -c ActivityEntry in src/**'

[轨迹] 搜索 **/*.test.ts 命中 12
  → test/search.test.ts, test/activity.test.ts, test/streamGate.test.ts …

[轨迹] 搜索 TurnState 命中 20
  → src/engine/loop.ts, src/engine/types.ts, src/llm/realLlm.ts, src/tui/renderer.ts …
    （notes/docs 被 *.ts 排除掉了）

[轨迹] 搜索 ActivityEntry 命中 11
  → src/activity/activity.ts: 7
    src/engine/types.ts: 2
    src/tui/renderer.ts: 2
    共 11 处，3 个文件
```

`glob **/*.test.ts` 报 12 个，`test/` 目录实际就是 12 个文件——对得上。

测试从 36 条加到 42 条，全绿。新增 6 条覆盖：
glob 编译规则（补 `**/`、`**` vs `*`、`{a,b}`）、glob 工具输出、
grep 的范围过滤与忽略大小写、files/count 两种模式、指令语法（含 " in " 歧义）。

## 这一步的收获

1. **只读操作要有只读的入口**。"列文件"被迫走 `run find` 时，
   用户就被训练成"审批弹窗随手点允许"——安全设计会被绕坏。
   给 safe 工具补齐能力，比加强审批更有效。
2. **一个 glob 编译器，两处复用**。glob 工具和 grep 的范围过滤共用 `globToRegExp`，
   语义天然一致；如果各写一套，迟早出现"glob 能匹配但 grep 匹配不到"的怪事。
3. **语法歧义必须显式裁决并测试**。" in " 出现在正则里、`-i` 出现在正则里——
   这些不是"不太可能"，而是"迟早发生"。
4. **加了工具就要改提示词**。工具是能力，提示词是让模型知道能力存在的唯一途径。
