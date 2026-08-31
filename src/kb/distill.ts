import type { Llm } from '../engine/loop.ts';

/**
 * 资料蒸馏（第 1 批 · 1a）。
 *
 * 解决的问题：BM25 只认字面。原文写「抢锁失败」，用户问「获取锁超时」，
 * 中文 2-gram 下这两个词一个字都不重合，检索必然为 0 命中。
 * 不上向量也能补一半：**让模型给每篇资料生成一句话摘要 + 一串别名/可能的提问用词**，
 * 作为一个独立的 digest 块参与打分。
 *
 * 关键设计：digest **不直接注入**。摘要里没有「10 秒」这种具体数字，
 * 注入它只会占预算又答不出细节。它的作用是「桥」——命中 digest 说明
 * 这篇文档跟问题相关，于是给这篇文档的正文块加分，把真正含答案的段落捞出来。
 * 打分与提分逻辑在 store.search()，这里只负责生成。
 *
 * 参考 doarchon 的 openkb 结构：raw/ 存原文，wiki/concepts 存编译出的概念页，
 * 检索打在概念页上、答案落在原文里。
 */

export interface Digest {
  /** 一句话摘要 */
  summary: string;
  /** 同义词 / 别称 / 用户可能用的提问说法 */
  aliases: string[];
}

const SYSTEM = [
  '你在为一个中文资料库做检索辅助索引。给你一篇资料，输出两样东西：',
  '1. summary：一句话说明这篇资料讲什么（不超过 60 字，不要复述细节数字）。',
  '2. aliases：8~15 个检索词，覆盖三类——',
  '   (a) 文中出现的关键术语；',
  '   (b) 这些术语的**同义说法**（例如文中写「抢锁失败」，就补「获取锁超时」「争抢锁没成功」「拿不到锁」）；',
  '   (c) 用户可能用来提问的口语说法。',
  '别名要短（2~8 字），不要句子，不要重复，不要编造文中没有的概念。',
  '只输出 JSON，格式：{"summary":"…","aliases":["…","…"]}',
].join('\n');

/** 从模型输出里抠出 JSON。模型爱加```或前后说明，所以取第一个平衡的 {...} */
export function parseDigest(text: string): Digest | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth !== 0) continue;
      try {
        const raw = JSON.parse(text.slice(start, i + 1)) as { summary?: unknown; aliases?: unknown };
        const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
        const aliases = Array.isArray(raw.aliases)
          ? [...new Set(raw.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.trim()))]
              .filter((a) => a.length >= 2 && a.length <= 20)
              .slice(0, 20)
          : [];
        if (!summary && !aliases.length) return undefined;
        return { summary, aliases };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** 蒸馏一篇资料。正文太长时只喂前后各一段——摘要和别名不需要读完全文。 */
export async function distillDoc(llm: Llm, title: string, text: string, maxChars = 6000): Promise<Digest> {
  const body =
    text.length <= maxChars
      ? text
      : `${text.slice(0, maxChars * 0.7)}\n…（中间略）…\n${text.slice(-Math.floor(maxChars * 0.3))}`;
  const out = await llm.complete([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `【标题】${title}\n【正文】\n${body}` },
  ]);
  const digest = parseDigest(out.text ?? '');
  if (!digest) throw new Error(`蒸馏《${title}》失败：模型没给出可解析的 JSON`);
  return digest;
}

/** digest 块的正文：别名要成为可被 BM25 命中的词，所以直接铺开写 */
export function digestText(d: Digest): string {
  const lines = [d.summary && `摘要：${d.summary}`, d.aliases.length && `相关说法：${d.aliases.join('、')}`];
  return lines.filter(Boolean).join('\n');
}
