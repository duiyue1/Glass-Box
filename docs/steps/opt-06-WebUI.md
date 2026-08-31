# 优化 06 · Web UI（浏览器里的玻璃盒）

> 之前只能在终端看。这一步把玻璃盒搬进浏览器：左侧流式对话，右侧实时内部状态面板，审批以弹窗出现并彩色渲染 diff。**仍然零第三方依赖**，也**没有改动引擎一行代码**。

---

## 1. 一句话理解这一步

`npm run web` → 打开 `http://127.0.0.1:7777`。

页面左边是对话（逐字流式），中间夹着淡色的"内部动作轨迹"（调用了什么工具、注入了什么记忆、压缩了多少），右边是一整列实时面板——和终端 TUI 的分区一模一样，只是换了画布。

---

## 2. 为什么这一步几乎不费力

因为架构从 Step1 就为它铺好了路：**所有内部状态都在 wire 事件总线上**。

- 终端 TUI 是事件总线的一个订阅者；
- Web UI 只是**又一个订阅者**——把事件原样 JSON 推给浏览器就完事：

```ts
app.wire.subscribe((ev) => broadcast(ev));   // 就这一行，前端就拿到了全部内部状态
```

前端的事件处理逻辑和 `tui/renderer.ts` 几乎是一一对应的（同一套分区、同一套判断），只是把"画字符"换成了"改 DOM"。

**引擎、插件、技能、记忆、审批全部零改动。**

---

## 3. 传输选型：为什么用 SSE 而不是 WebSocket

- 我们的需求是**单向推送**（服务端 → 浏览器），用户输入走普通 POST 就够了。
- SSE 是纯 HTTP，**Node 内置 `node:http` 就能实现**，浏览器端 `new EventSource('/events')` 一行搞定，自带断线重连。
- WebSocket 需要额外协议握手（或第三方库），对这个场景是过度设计。

四个接口，全部由 `node:http` 手写：
- `GET /` — 返回单文件页面
- `GET /events` — SSE 事件流
- `POST /ask` — 提交一句输入（立刻返回 202，回合异步跑，进度靠事件流看）
- `POST /approve` — 回传审批决定

---

## 4. 一个漂亮的细节：新窗口也能看到"之前发生了什么"

浏览器是随时打开的，而 `plugin.loaded` / `skill.available` / `memory.loaded` 这些事件在启动时就发完了。刷新页面就丢了？

不会。还记得 Step1 的 `Wire` 除了广播还会**记录 history**（黑匣子）吗？新的 SSE 客户端一连上，服务端先把**历史事件全部回放**给它，再接实时流：

```ts
for (const ev of app.wire.history()) res.write(`data: ${JSON.stringify(ev)}\n\n`);
```

所以刷新页面、或者第二个标签页打开，看到的状态都是完整的。当初为了"可回放"加的黑匣子，在这里白捡了一个功能。

---

## 5. 审批怎么从浏览器点回来

终端里是 `readline` 问 y/N；浏览器里没法阻塞，所以用"挂起的 Promise + id"来配对：

```
工具需要审批
   → 服务端生成 id，把 resolve 函数存进 Map，通过 SSE 推 approval.ask{id, request}
   → 浏览器弹窗（显示等级徽章 / 原因 / diff）
   → 你点「允许/拒绝」→ POST /approve {id, approved}
   → 服务端取出 resolve(id) 调用 → 引擎那边的 await 继续往下走
```

`edit_file` 的 diff 在这里终于有了彩色渲染：`+` 绿、`-` 红。等级徽章 `confirm` 是琥珀色、`dangerous` 是红色。快捷键：`Esc` 拒绝、`Cmd/Ctrl+Enter` 允许。

---

## 6. 安全：只监听本地回环

这个 agent **能执行 shell 命令、能读写文件**。如果 Web 服务监听 `0.0.0.0`，同网段的任何人都能用浏览器在你机器上跑命令。

所以：

```ts
const HOST = '127.0.0.1';       // 硬编码本地回环，不提供对外监听的开关
server.listen(PORT, HOST, ...)
```

已用 `lsof` 验证实际监听地址是 `127.0.0.1:PORT` 而非 `*:PORT`。审批也保留强制确认，没有"一键全放行"的默认值。

---

## 7. 页面设计（简约克制）

- 近黑底 + 极细分隔线 + 单一强调色（蓝），不用花哨渐变和阴影堆叠。
- 对话用系统无衬线字体保证中文可读；所有"内部状态"用等宽字体，视觉上和对话自然分层。
- 小型大写字母的分区标题（letter-spacing 拉开），信息密度高但不吵。
- 状态机做成 chip，当前状态点亮；上下文预算是一条会动的细进度条，超预算变琥珀色。
- 顶部一个状态圆点：绿=已连接，琥珀+呼吸=回合进行中。

---

## 8. 新增/改动文件

```
src/web.ts        # 新增：node:http 服务（SSE 广播 + 历史回放 + /ask + /approve + 回合排队）
src/web/ui.html   # 新增：单文件前端（零构建，HTML+CSS+原生 JS）
package.json      # +"web": "node src/web.ts"
README.md         # 补充 Web UI 入口、GB_PORT、目录结构
```

引擎（engine/）、插件、技能、记忆、TUI 全部未改。

---

## 9. 验证

- `GET /` → HTTP 200，20973 字节
- SSE 事件序列（新客户端连上后）：`plugin.loaded ×4 → skill.available → memory.loaded → web.ready`（历史回放正常），随后实时收到
  `turn.start → memory.injected → context.injected → state.change → context.usage → llm.request → llm.response → tool.call → tool.result → llm.delta ×17 → turn.end`
  —— 工具链路、流式增量、状态机全部贯通。
- 审批往返：推送 `approval.ask{level:confirm, preview:"- ## 快速开始\n+ ## 快速开始"}` → `POST /approve {approved:false}` → `approval.decision:false` → `tool.result: 操作被拒绝` ✓
- 监听地址：`lsof` 确认 `TCP 127.0.0.1:7789 (LISTEN)` ✓
- 前端 JS 通过 `node --check` 语法检查，HTML 标签平衡 ✓
- `npm test` → 32 passed / 0 failed（无回归）

> 说明：以上是协议与链路层面的验证。**页面的视觉效果没有用浏览器实际渲染确认过**——为了不给这个"零依赖"项目装 puppeteer 之类的东西。观感请你自己开一下看，不满意我再调。

---

## 10. 可能的后续

- 面板项可点击展开（看完整工具结果 / 完整记忆原子）
- 事件流加过滤器（只看工具 / 只看记忆）
- 把 TUI 的"逐帧回放"搬到 Web：一个时间轴滑块，拖动回看任意时刻的内部状态（黑匣子已经存了全部事件，做得到）
