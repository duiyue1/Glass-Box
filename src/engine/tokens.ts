import type { Msg } from './types.ts';

/**
 * 中日韩字符（含全角标点、假名、谚文）。这类字符一个字就要一个 token 上下，
 * 拉丁文却是约 4 个字符才一个 token——两者混在一起按同一个系数折算会差出好几倍。
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;

/** 一个 CJK 字符折算多少 token（o200k 这类分词器上中文大致 1 个字 1 个 token） */
const CJK_TOKENS = 1;

/**
 * 粗略估算文本的 token 数。真实 tokenizer 复杂且和模型相关，这里按字符种类分两档折算：
 * CJK 一个字算一个 token，其余按 4 个字符一个 token，再加少量固定开销。
 *
 * 分档不是精细化，而是纠错：中文按「字符数 ÷ 4」会低估四倍，
 * 而预算从绝对值改成「窗口的百分之多少」之后，估低就等于该压缩的时候不压，
 * 一直到网关报窗口溢出才发现。
 */
export function estimateText(s: string): number {
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return Math.ceil(cjk * CJK_TOKENS + (s.length - cjk) / 4) + 2;
}

/**
 * 一张图片折算多少 token。真实值取决于模型与图片尺寸（OpenAI 低清模式约 85~258），
 * 这里取一个偏保守的常数，让上下文预算条能反映出"图片是很贵的"。
 */
export const IMAGE_TOKENS = 258;

/** 估算一组消息的总 token 数（含图片折算） */
export function estimateTokens(messages: Msg[]): number {
  return messages.reduce((n, m) => n + estimateText(m.content) + (m.images?.length ?? 0) * IMAGE_TOKENS, 0);
}
