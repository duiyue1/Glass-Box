import type { Llm, TokenSink } from '../engine/loop.ts';
import type { Msg, LlmResponse } from '../engine/types.ts';
import { GRAMMAR_HELP, parseCommand, toToolCall } from './commandGrammar.ts';

function truncate(s: string, n = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 把文本分小块通过 onToken 吐出，模拟真实模型的流式输出（零凭证也能看到流式效果） */
async function emitStream(text: string, onToken?: TokenSink): Promise<void> {
  if (!onToken || process.env.GB_STREAM === '0') return;
  const delay = Number(process.env.GB_FAKE_STREAM_DELAY ?? 0);
  const size = 6;
  for (let i = 0; i < text.length; i += size) {
    onToken(text.slice(i, i + size));
    if (delay > 0) await sleep(delay);
  }
}

/**
 * FakeLlm：零凭证的“假模型”，用指令语法把用户输入翻译成工具调用，演示完整链路。
 * 与 RealLlm 共用 commandGrammar，因此换成真实模型时引擎与工具协议都不用动。
 */
export class FakeLlm implements Llm {
  /**
   * 假模型没有真窗口，这里给一个小而够用的值：注入配额是从预算里按比例分的，
   * 窗口太小会把资料库配额压到装不下一块，演示时面板上就看不到注入了。
   * 4000 能让注入的量接近真实使用（资料库 ~560 tok）。
   *
   * 想看压缩发生，用 `GB_BUDGET=160` 走绝对值模式——那条路不按比例分注入，
   * 所以两件事互不干扰。
   */
  readonly contextWindow = 4000;

  async complete(messages: Msg[], onToken?: TokenSink): Promise<LlmResponse> {
    // 找"对话里的最后一条"，而不是整条请求的最后一条。
    // Loop 为了前缀缓存把本回合注入拼在对话之后（`[...convo, ...injected]`，见 loop.ts），
    // 注入全是 role='system'。用 at(-1) 的话，只要命中了任何注入（记忆/知识目录/资料库），
    // 末条永远是 system，下面这个"上一步是工具结果"的判断就永不成立——
    // 假模型看不见自己刚调过工具，于是每一步重发同一个调用，直到撞上 GB_MAX_STEPS。
    const last = [...messages].reverse().find((m) => m.role !== 'system');
    if (last?.role === 'tool') {
      const text = `工具返回了「${truncate(last.content)}」，任务完成。`;
      await emitStream(text, onToken);
      return { text };
    }

    const input = ([...messages].reverse().find((m) => m.role === 'user')?.content ?? '').trim();
    const cmd = parseCommand(input);
    if (cmd) return { toolCalls: [toToolCall(cmd, 'c1')] };

    const text = `你好，我是 Glass-Box（FAKE_LLM 模式）。可用指令: ${GRAMMAR_HELP}。你说的是：「${input}」`;
    await emitStream(text, onToken);
    return { text };
  }
}
