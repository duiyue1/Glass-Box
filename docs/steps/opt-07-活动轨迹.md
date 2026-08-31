# 优化 07 · 活动轨迹（Activity）

## 这一步在解决什么问题

之前的玻璃盒面板里，「工具调用」那一栏是**过程视角**：

```
✓ write_file{"path":"src/streamGate.ts","content":"import ..."}
    → 已写入 src/streamGage.ts（1420 字符）
✓ edit_file{"path":"src/engine/loop.ts","old":"...","new":"..."}
    → 已编辑 loop.ts（-1 / +4 行）
```

能看，但看着累：参数是一坨 JSON，结果是一句人话，你得自己在脑子里做加法才知道
"这次一共动了几个文件、写了多少行、跑了几条命令"。

这一步补上**结果视角**——一份像施工清单一样的活动轨迹：

```
活动轨迹
  创建 3 · 修改 6 · 执行 7
  · 创建 streamGate.ts +51
  · 修改 loop.ts +4 −1
  · 执行 npm test
```

一眼就知道这个 agent 到底动了什么。这是把「工作过程有清晰的步骤和账目」这件事，
从我（外部的 AI）的习惯，变成 Glass-Box 自己的产品能力。

## 关键设计：让工具自己报账，而不是事后猜

有两种做法：

- **（差）解析文本**：拿 `已写入 demo.txt（11 字符）` 这句话去正则抠文件名和行数。
  一旦文案改了，统计就悄悄错了——而且永远不知道错在哪。
- **（好）结构化上报**：每个工具在返回结果时，顺手带一份机器可读的 `meta`。

我们选后者。`ToolOutput` 从「ok + content」扩展成「ok + content + meta」：

```ts
export interface ToolMeta {
  action?: 'created' | 'edited' | 'ran' | 'read' | 'searched' | 'delegated';
  path?: string;      // 文件类动作
  command?: string;   // 命令 / 正则 / 子任务
  added?: number;     // 增加行数（读取时=文件行数，搜索时=命中数）
  removed?: number;   // 删除行数
}
```

`content` 仍然是给**模型和人**看的自然语言，`meta` 是给**统计**看的账目。
两者分开，谁改都不影响谁。

比如 `write_file` 在写之前先看一眼文件在不在，从而分得清"创建"和"修改"：

```ts
let existed = false;
let oldLines = 0;
try { oldLines = countLines(fs.readFileSync(abs, 'utf8')); existed = true; }
catch { /* 文件不存在 → 本次是创建 */ }
fs.writeFileSync(abs, content, 'utf8');
return {
  ok: true,
  content: `已写入 ${p}（${content.length} 字符）`,
  meta: { action: existed ? 'edited' : 'created', path: p, added: countLines(content), removed: oldLines },
};
```

引擎那边**一行都不用改**：`Loop` 本来就是 `return { toolCallId: call.id, ...out }`，
`meta` 顺着展开自动流到了 `tool.result` 事件里。

## Activity 子系统：又一个纯订阅者

`src/activity/activity.ts` 干三件事：

1. 听 `tool.call`，把 `call.id → call` 记下来（结果事件里只有 id，需要回查工具名和参数）；
2. 听 `tool.result`，用 `meta.action` 生成一条 `ActivityEntry`；
3. 把整份清单 + 汇总，用一条新事件 `activity.updated` 再发回总线。

```ts
export class Activity {
  constructor(wire: Wire) {
    this.wire = wire;
    this.wire.subscribe((ev) => this.onEvent(ev));   // 只订阅，不干预
  }
}
```

注意它**不参与决策**：不改工具、不拦审批、不动上下文。它和记忆、TUI、Web UI 一样，
只是趴在总线上看。这就是前面几步一直坚持"只加不改"的红利——
加一个全新的产品特性，引擎目录一个字没动。

没有 `meta` 的工具（比如 `echo`）会被跳过，不进轨迹——不然清单里会混进"什么也没发生"的行。
另外留了一张 `FALLBACK_KIND` 表按工具名兜底，保证第三方插件忘了写 `meta` 时轨迹也不至于空白。

## 汇总怎么算才符合直觉

照着我平时的账目习惯来：

- **文件类按"唯一文件数"**：同一个 `loop.ts` 改了三次，说"修改 1 个文件"才对，不是 3；
- **命令类按"次数"**：`npm test` 跑了三遍，就是执行 3 次；
- **先创建后修改的文件只算创建**：新建的文件后来又调整了，讲"创建了它"更准确。

```ts
for (const f of createdFiles) editedFiles.delete(f);
return { created: createdFiles.size, edited: editedFiles.size, ran, other };
```

## 数字的量词要选对

一开始我给所有动作都套了 `+N / −N`，结果搜索那行长这样：

```
搜索 line1 +1        ← 什么意思？给 line1 加了一行？
```

`+/−` 在程序员的肌肉记忆里就是"改了几行代码"，用在搜索上是误导。改成按动作分口径：

- 创建 / 修改 → `+2 −1`（行数增删）
- 读取 → `2 行`（文件多大）
- 搜索 → `命中 1`（找到几处）
- 委派 → `3 步`（子 agent 用了几次工具）

## 三个界面同时长出这块面板

因为数据源是同一条事件，三处渲染各写一遍展示逻辑就行：

- **日志模式**（`src/index.ts`）：每条轨迹打一行 `[轨迹] 创建 demo.txt +2`，跑完打一行汇总；
- **TUI / chat**（`src/tui/renderer.ts`）：右侧新增「活动轨迹」区块，最近 6 条 + 汇总行；
- **Web UI**（`src/web/ui.html`）：面板顶部新增卡片，动作名按类型着色（创建=绿、修改=蓝、执行=黄），
  行数用 `+` 绿 `−` 红。

## 验证

```
$ node src/index.ts 'write demo.txt :: line1
line2 ;; edit demo.txt ||| line2 ||| line2-new ;; run echo hi ;; grep line1 ;; read demo.txt'

[轨迹] 创建 demo.txt +2
[轨迹] 修改 demo.txt +1 −1
[轨迹] 执行 echo hi
[轨迹] 搜索 line1 命中 1
[轨迹] 读取 demo.txt 2 行
本次活动轨迹汇总: 创建 1 · 执行 1 · 其它 2
```

TUI 面板：

```
活动轨迹
  修改 1 · 执行 1
  · 修改 demo.txt +2 −2
  · 修改 demo.txt +1 −1
  · 执行 echo hi
```

Web 端也确认了 `/events` 里能收到 `{"type":"activity.updated"...}`。

测试从 32 条加到 36 条，全绿。新增 4 条覆盖：
创建 vs 修改的判定、行数增删、`activity.updated` 事件、无 meta 工具不入轨迹、渲染格式。

## 这一步的收获

1. **统计要靠上报，不要靠解析**。让产生数据的人顺手记账，比事后去猜便宜得多，也准得多。
2. **过程视角和结果视角都要有**。工具调用回答"怎么做的"，活动轨迹回答"做成了什么"。
3. **一个好的架构，新特性是"贴"上去的**。这一步动了 5 个工具的返回值 + 1 个新目录 + 3 处渲染，
   引擎（`loop/session/wire/toolRegistry`）零改动。
4. **展示细节会影响可信度**。`+1` 和 `命中 1` 在数据上等价，但读者的理解完全不同。
