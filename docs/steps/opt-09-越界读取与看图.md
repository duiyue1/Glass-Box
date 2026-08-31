# 优化 09 · 越界读取与看图

## 起因

你在 Web 窗口里让它读桌面上的一张图，得到：

```
调用工具 read_file {"path":"/Users/shuaiili/Desktop/xxx.jpg"}
工具失败  拒绝：路径超出工作区
```

这里其实叠了**两道**墙，只不过第一道先撞上了：

1. **工作区边界**：`read_file` 对越界路径是**硬拒绝**，连审批弹窗都不给；
2. **图片本身读不了**：即使路径放开，`fs.readFileSync(abs, 'utf8')` 会把 JPEG
   变成一屏乱码；而且发给模型的消息一直是纯字符串，模型根本没有"看"的通道。

这一步把两道墙都处理掉。

## 第一道：越界读取从「硬拒绝」改成「dangerous 审批」

原来的逻辑是"不在工作区就不给读"。这个策略有个副作用：
用户被逼着去用 `run cat ~/Desktop/x.txt`——而 `run` 是能执行任意命令的工具。
**把安全的需求推向危险的工具，是安全设计的失败。**

现在分三档：

- 工作区内的普通文件 → `safe`，照旧不打扰你；
- 工作区外的文件 → `dangerous`，弹窗告诉你完整绝对路径，你点允许才读；
- 凭证类文件 → **黑名单，永久拒绝**。

```ts
const SECRET_PATTERNS = [
  /(^|\/)\.ssh\//, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /(^|\/)\.env(\.|$)/,
  /(^|\/)\.aws\/credentials$/, /(^|\/)\.kube\/config$/, /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/, /(^|\/)\.gnupg\//, /\/Library\/Keychains\//,
  /\.(pem|key|p12|pfx|keystore)$/,
];
```

关键设计：**黑名单在 `assess` 和 `run` 里各拦一次**。

为什么要拦两次？因为审批只能防"误操作"，防不住"看起来合理的请求"。
如果模型说"我需要读一下 `.env` 来确认配置"，人是很可能顺手点允许的。
凭证必须有一条**不经过人类判断**的硬边界：

```ts
run(args) {
  if (isSecret(abs)) return { ok: false, content: `拒绝：${p} 属于凭证类文件，永不读取` };
```

顺带修掉了一个之前一直存在的隐患：**工作区里的 `.env` 原本是能被 `read_file` 读出来的**——
里面就是模型 API key，读出来会直接进对话历史再发回给模型。现在也被黑名单挡住了。

注意写入**没有**跟着放开：`write_file` / `edit_file` 对越界路径仍然是硬拒绝。
读错文件浪费点 token，写错文件可能毁掉别人的东西——两者风险不对称，就不该用同一档策略。

## 第二道：让模型真的"看见"图片

链路要打通三个地方：

**1）工具产出图片**（`fsPlugin`）

按扩展名识别 png/jpg/jpeg/gif/webp，读成 Buffer 再转 base64 data URL：

```ts
return {
  ok: true,
  content: `已读取图片 ${name}（${mime}，${size}），已作为图像附给模型`,
  images: [`data:${mime};base64,${buf.toString('base64')}`],
  meta: { action: 'read', path: abs, images: 1 },
};
```

`content` 仍然是给人看的一句话（不是乱码），图片走新字段 `images`——
和上一步 `meta` 的思路一样：**一个字段一个受众，别混用**。

体积封顶 4MB（`GB_MAX_IMAGE_MB` 可调）。base64 会让体积再涨 1/3，
而且要进对话历史反复发送，不封顶迟早炸掉请求。

**2）消息能携带图片**（`types.ts` / `loop.ts`）

`Msg` 和 `ToolResult` 各加一个 `images?: string[]`，Loop 把工具结果转成 tool 消息时带上：

```ts
convo.push({ role: 'tool', content: result.content, toolCallId: call.id, images: result.images });
```

**3）真实模型改用多模态格式**（`realLlm.ts`）

OpenAI 兼容接口里，带图的消息 `content` 要从字符串变成数组：

```ts
if (m.images?.length) {
  return { role, content: [
    { type: 'text', text },
    ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]};
}
return { role, content: text };   // 不带图片时保持纯字符串
```

不带图时仍发字符串——这样非多模态的模型/网关不会因为格式变了而报错。

## 一个不做就会出事的细节：黑匣子脱敏

Glass-Box 的核心是"每个事件都记进 history，Web 端新连接会重放整段 history"。
如果 base64 图片原样进事件流，会同时发生三件坏事：

- `llm.request` 事件里存一份、`tool.result` 事件里再存一份；
- 每个新打开的浏览器标签都要重新收一遍这几 MB；
- `turn.end` 也带着整段对话，又是一份。

所以加了 `src/engine/redact.ts`：**真数据只走"模型请求"这一条路，事件流里只留占位描述。**

```
[image image/jpeg ~97KB]
```

Loop 里三处出口都过一遍脱敏（`llm.request` / `tool.result` / `turn.end`），
对话本体（`convo`）保留真数据给模型。测试里专门断言了黑匣子中不出现 base64 原文。

顺带把 token 估算也补上：一张图按固定 258 tok 折算（`IMAGE_TOKENS`）。
不然上下文预算条会显示"没花什么 token"，而账单不会这么认为。
副作用是好的：图片让历史迅速超预算，压缩机制会主动把旧图片丢掉，不让它一直挂在上下文里。

## 验证

用真实模型（gpt-5.5）读你桌面上那张图：

```
$ GB_APPROVE=all node src/index.ts 'read /Users/shuaiili/Desktop/xxx.jpg'

[审批] 请求(dangerous): 读取工作区外的文件: /Users/shuaiili/Desktop/xxx.jpg
[审批] 放行
[轨迹] 读取 Desktop/xxx.jpg
[工具] 结果: 已读取图片 xxx.jpg（image/jpeg，97 KB），已作为图像附给模型
最终回复: 这是一张数据表截图，红框重点标出了 `user_question` 列。
```

模型确实看到了图的内容（不是猜的——它说出了红框和列名）。

测试从 42 条加到 50 条，全绿。新增 8 条覆盖：
工作区内 safe / 工作区外 dangerous、放行后确实能读、
凭证文件即使放行也拒绝（且不泄漏内容）、图片返回 data URL、
超大图片被拒、事件流脱敏（含"黑匣子里不该出现 base64"这条断言）、
占位串格式、图片计入 token 估算。

## 这一步的收获

1. **别把安全需求逼向危险工具**。硬拒绝"读工作区外"看着更安全，
   实际把用户推去用 `run cat`，整体风险反而更高。
2. **审批挡误操作，黑名单挡"合理请求"**。凭证类文件必须有一条不依赖人类判断的线。
3. **读和写的风险不对称，策略也不该对称**。读放开到审批，写继续硬拒。
4. **可观测性有成本，要主动管理**。"所有事件都留档"遇上多媒体就会爆；
   脱敏层不是可选优化，是这个架构的必要配件。
5. **一个字段一个受众**：`content` 给人和模型读，`meta` 给统计，`images` 给视觉通道。
