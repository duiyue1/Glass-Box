# 优化 17 · 会话管理（新建 / 侧边栏列表 / 改名 / 删除）

## 缺口

opt-14~16 之后，换会话只有两条路：**分叉**（带上文）或**重启进程**。
想干净地开个新话题——比如上一段聊了两小时的重构，现在要问个完全无关的问题——
只能杀掉进程重开。上下文预算被旧对话吃掉，Web 面板还得重连。

## 做了什么

一个动作：`App.newSession()`。它和 `fork()` 共用「切日志文件」这套机制，区别只在**不继承任何东西**。

```ts
// src/app.ts
const newSession = () => {
  detachJournal();                       // 旧会话停止追加（文件本身不动）
  current = new Journal(sdir, newSessionId());
  detachJournal = current.attach(wire);  // 事件流切到新文件
  session.restore([]);                   // 对话历史清空
  memory.clearHidden();                  // 不再站在任何分叉线上
  wire.emit({ type: 'session.started', sessionId: current.sessionId, path: current.path, ts: Date.now() });
};
```

三个入口，都是薄壳：

- **CLI**：`/new` 命令（`src/chat.ts`，和 `/panel` `/help` `/exit` 并列）
- **Web**：`POST /sessions/new`（`src/web.ts`），回合进行中返回 **409**——理由和 `/sessions/fork` 一样：
  正跑着的回合被换掉历史会错乱
- **面板**：只在**对话页**输入框旁边放一个「+ 新会话」（`showPage()` 里 `$('#newsess').hidden = which !== 'chat'`）。
  顶栏和会话轨迹页都不放——换会话是对话行为，不该散落在导航和取证视图里

## 侧边栏「最近对话」

右侧面板最上面一块列最近 8 个会话：名字、时间、事件数，当前会话用 `●` 标出，点一条跳到会话轨迹页打开它。
数据就是 `GET /sessions`，没有新增后端能力。

刷新时机是 `web.ready` / `turn.end` / `session.started` 三个事件，**200ms 防抖**——
SSE 重连会一次性重放几十条历史事件，不合并就会打出一串 `/sessions` 请求。

没提过问、也没起过名的空会话不进列表（当前会话例外，否则刚新建看着像没反应）。

## 改名：append-only 系统里怎么改一个字段

不能改已有的行。所以改名也是**追加一条事件**：

```ts
// src/engine/journal.ts
export function renameSession(dir, sessionId, title): boolean {
  new Journal(dir, sessionId, lastSeq(dir, sessionId))
    .append({ type: 'session.renamed', sessionId, title: t, ts: Date.now() });
}
```

「当前名字」= 最后一条 `session.renamed`，和其它状态一样从历史算出来（`listSessions` 里
`recs.filter(r => r.ev.type === 'session.renamed').at(-1)`）。改十次就有十条记录，
**什么时候改成什么名字也能查**。

一个坑：**正在活动的那个会话不能走 `renameSession()`**。它的 `Journal` 在内存里维护自己的 `seq`，
另一边直接按 `lastSeq+1` 写文件，两边会撞号。所以 web 层分流：

```ts
if (id === app.journal.sessionId) app.wire.emit({ type: 'session.renamed', ... });  // 让 Journal 发号
else renameSession(sessionsDir(WORKSPACE), id, t);
```

名字上限 80 字（`MAX_TITLE`），超了截断——列表放得下，也免得往日志里塞整篇文章。

## 删除：唯一一个真会丢历史的操作

`POST /sessions/delete` 直接 `unlinkSync` 掉那个 `.jsonl`。两道闸：

- **当前会话不许删**（`400`）：正在写的文件被删掉，后续事件会凭空重建出一个残缺文件
- id 必须过 `isSafeSessionId`（老规矩，防路径穿越）

图片 blob 不跟着删——它们按内容哈希寻址，可能被别的会话共用。
前端删除前 `confirm()` 一次，并且明说「不可恢复」。


## 为什么 `clearHidden()` 而不是清记忆

两件事要分开：

- **分叉屏蔽窗口**是「你为了回到某一刻，主动丢掉的那段时间」——新会话不在任何分叉线上，窗口必须清掉，
  否则新会话会莫名其妙看不到那段时间的事实
- **L1 记忆原子本身不清**。记忆是跨会话资产，这是它存在的理由

所以 `Memory` 新增的是 `clearHidden()`（清窗口），不是 `clear()`（清记忆）。

## 事件是唯一的通知渠道

`newSession()` 不去调 UI，只发一条 `session.started`（无 `forkedFrom`、无 `resumed`）。
Web 前端订阅到「这是全新会话」就把对话区清空、并在轨迹里记一行「新会话」。
CLI 打印新日志路径。引擎侧零改动——又一次「只加不改」。

前端判定条件写成 `!ev.forkedFrom && !ev.resumed`，SSE 重连回放历史时也成立：
回放到最后一个「新建」事件时清屏，正好只剩该会话之后的内容。

## 验证

**单测**：套件 131 → 136 全绿。

- `buildApp` + `newSession()`：会话 id 变了、`session.size()` 归零、
  新文件第一条是 `session.started` 且 `forkedFrom === undefined`、
  之后 `wire.emit` 只进新文件（**旧文件字节数不变**）
- `Memory.clearHidden()` 把屏蔽窗口清空
- 改名两次后 seq 连成 `[1,2,3,4]` **不重号**、最后一次生效、`firstAsk` 不受影响
- 改名拒空名 / 拒非法 id / 拒不存在的文件 / 超长截断到 `MAX_TITLE`
- 删除后文件真的没了、列表里不再出现、删第二次返回 `false` 而不是抛、路径穿越 id 被拒

`tsc --noEmit`（临时装的 typescript 5.6 + @types/node 22，装在 `/tmp` 用完即删，不污染零依赖工程）无错误。

**真实模型实跑**（gpt-5.5，你的 `.env` 原样配置，无任何 `GB_*` 开关）：

```
你> 记住一个口令：我的幸运数字是 4712，之后我会问你
AI> 好的，我记住了：你的幸运数字是 4712。

你> 我的幸运数字是多少？
    · 记忆注入 1 条（8/40 tok）
AI> 你的幸运数字是 4712。

你> /new
[会话] 已开新会话 s_20260818_1450_cc1e（不带上文）

你> 我刚才告诉你的幸运数字是多少？（没告诉过就直说）
AI> 本次对话里你没告诉过我
```

新会话日志里核对到：`session.started` 无 `forkedFrom`，第一个 `turn.end` 的 `messages` 只有 **2 条**
（这一问一答），旧会话文件停止增长。

**Web 端点实跑**：起 `GB_PORT=7894 node src/web.ts`，一条链路走完：

```
POST /sessions/new                        → {"ok":true,"sessionId":"s_20260818_1541_5ed3"}
POST /sessions/rename（改当前会话，走 wire） → {"ok":true,"title":"改名测试 · 当前会话"}
GET  /sessions                            → title= 改名测试 · 当前会话 | events= 2
POST /sessions/delete（删当前会话）          → 400 {"error":"这是当前会话，先「新建会话」再删它"}
POST /sessions/new  然后再删它              → {"ok":true}，文件确认已不存在
```

前端渲染（侧边栏那一块、hover 出现的改名/删除按钮）只做了「内联脚本能被 `new Function` 解析 +
元素 id / CSS 规则都在」这种静态检查，**长什么样没有截图验证过**。

## 一个必须说清的点

新会话**只清对话上文，不清跨会话记忆**。上面那次实跑，新会话里记忆确实注入了
`('fact','一个口令：我的幸运数字是 4712，之后我会问你')`——模型之所以说"本次对话里你没告诉过我"，
是因为我的问法把范围限定在"本次对话"。

也就是说：`/new` 给你的是**干净的对话上下文**，不是**失忆**。
真要连记忆一起隔离，得再加一层「会话作用域记忆」，那是另一个决定，这一步没做。

## 面板上的两处交互取舍

**点历史会话 = 在对话区铺开那次对话**，不是跳到取证视图。
`previewSession()` 拿 `/sessions/view` 的 `messages` 直接渲染成气泡，顶上挂一条黄色横幅
「历史会话 · 只读」，带三个动作：

- **继续这个会话** → `POST /sessions/fork`（最后一步），原会话一个字节不动，之后直接发消息就是接着聊
- **回到当前会话** → 按当前会话的历史重绘对话区
- **看事件轨迹** → 才跳会话轨迹页（滑块 / 逐事件那套是取证用的，不该是点一下的默认结果）

预览是**纯前端视图**，引擎那边还站在原来的会话上。所以如果预览期间来了新回合（`turn.start`），
前端会先退出预览再渲染实时内容——历史和实时混在一屏里是最容易误读的状态。

**资料库页隐藏右侧观测面板**（`body.nopanel`）。状态机、活动轨迹、记忆命中这些是「跑一个回合时」
才有意义的东西，导入资料的时候它们只是噪音。

**发消息只在对话页**：整条输入框（含「+ 新会话」）随页面显隐，`send()` 里再加一道
`if ($('#composer').hidden) return;`。资料库页和会话轨迹页是「管资料 / 看历史」，不是聊天的地方。

## 资料库的作用域：工作区级，不是会话级

这一点原本就是这么设计的，这轮把它写进 UI 文案并补了测试钉住：

- `KbStore` 在 `buildApp` 里按工作区建一次（`.glassbox/kb`），`newSession()` / `fork()` 都不碰它
- 索引和原文都落在磁盘上，换会话、换进程都还在
- 测试：导入 → `newSession()` → 同一个查询仍然命中同样的块；再用一个新的 `KbStore` 从磁盘 `load()`
  也能查到（等价于「重启进程」）

和记忆的分工：**资料库是你主动喂的原始资料**（整篇文档，BM25 检索、命中才注入）；
**记忆是从对话里自动蒸馏的零碎结论**（fact/preference/constraint，会被分叉屏蔽）。
前者跨会话共享，后者才有「这段时间该不该看见」的问题。
