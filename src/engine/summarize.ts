import type { Msg, ToolSpec } from './types.ts';
import type { Llm } from './loop.ts';

/**
 * 生成"早前发生了什么"的摘要。返回 `undefined` 表示这次生成不成功，
 * 调用方应该退回不花钱的机械摘要。
 */
export type Summarizer = (msgs: readonly Msg[], tools?: ToolSpec[]) => Promise<string | undefined>;

/**
 * 压缩指令。八个小节照抄 dsh / Claude Code / Codex 那套结构——
 * 三家收敛到几乎一样的分段，不是巧合：这几项正好覆盖"接手的人需要知道什么"。
 *
 * 硬性要求每节都留、空的写"（无）"：模型一旦被允许省略小节，
 * 它会优先省掉"出过的错"和"待办"，而那恰恰是最贵的信息——
 * 重新踩一遍坑的代价远高于多几十个 token。
 */
const INSTRUCTION = `请把上面这段对话压缩成一份交接备忘，供接手的人在看不到原始对话的情况下继续干活。

严格按下面八个小节输出，**每一节都必须出现**，没有内容就写"（无）"，不许删节：

## 1. 最初的请求与意图
用户要做什么，原话里的关键措辞保留。

## 2. 关键技术概念
涉及的机制、约定、术语。

## 3. 涉及的文件与代码
读过、改过、提到过的文件路径，以及各自发生了什么。改过的要写清改了什么。

## 4. 出过的错与怎么修的
报错原文的关键部分、根因、最终修法。这一节最不能省。

## 5. 未完成的事
已经说要做但还没做完的。

## 6. 当前正在做的事
中断在哪一步。

## 7. 下一步
接手的人应该先做什么。

## 8. 必须遵守的约束
用户明确提过的要求、禁止事项、偏好。

规则：
- 只写上面对话里出现过的内容，不补、不猜、不给建议。
- 文件路径、命令、报错、数字原样照抄，不要改写或换算。
- 不要提到"压缩""摘要""上下文"这类词，直接写内容本身。
- 如果上面已经有一份交接备忘，把它和后来发生的事**合并**成一份新的，不要照抄旧的。`;

/**
 * 用模型生成结构化摘要。
 *
 * 这里有个省钱的讲究：**不给摘要器另起一套系统提示**，而是把待压缩的消息原样回放、
 * 把压缩指令作为最后一条 user 消息追加。这样这次辅助调用就是上一次请求的真前缀，
 * provider 的前缀缓存能命中——实测网关会报 `缓存命中 3584`，
 * 也就是说这次摘要的输入基本是白拿的。工具声明同理要照原样传。
 *
 * @param llm 用来生成摘要的模型（跟主对话用同一个）
 */
export function llmSummarizer(llm: Llm): Summarizer {
  return async (msgs, tools) => {
    try {
      const resp = await llm.complete([...msgs, { role: 'user', content: INSTRUCTION }], undefined, tools);
      // 摘要里出现工具调用说明模型没听懂指令，这种输出不能用
      if (resp.toolCalls?.length) return undefined;
      const text = resp.text?.trim();
      return text ? text : undefined;
    } catch {
      // 摘要失败不该让整个回合失败：调用方会退回机械摘要
      return undefined;
    }
  };
}
