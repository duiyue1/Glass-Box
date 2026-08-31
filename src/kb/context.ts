import type { Llm } from '../engine/loop.ts';
import { firstJson, verifyBody } from './wiki.ts';

/**
 * 块级上下文（Contextual Retrieval）。
 *
 * 要治的毛病：切出来的块是**孤立**的。两个后果——
 *   1. 词面窄：块里写「抢锁失败」，用户问「获取锁超时」，2-gram 下一个字都不重合。
 *      （digest 也治这个，但它是**文档级**的，只能告诉你"这篇相关"，指不到块。）
 *   2. 看不出身份：一段被否决方案的压测数据，和现行约定长得一模一样。
 *      评测里 N3 就是这个失败——问「QPS 上限」，模型把「压测时 QPS 到 200」
 *      （出自明确写着"我们否决过的方案"那一段）当成了答案。
 *
 * 做法照 Anthropic 的 contextual retrieval：入库后**离线**给每块补一句
 * 「这段在讲什么」，进 BM25 索引、也注入给模型；外加一个状态枚举，
 * 让"这段已经被否决了"这件事在提示词里显式可见。
 *
 * 两个刻意的设计：
 * - **一次调用处理整篇**，不是每块一次。省钱是次要的，主要是
 *   "这段属于被否决的方案"这个信息**只存在于全文里**——单看一块判断不出来。
 * - **一句话不许写数字**。它要进索引和提示词，自己编个数出来等于在源头造幻觉；
 *   所以过一道 `verifyBody`（wiki 那道闸），数字/标识符必须能在块正文里字面找到。
 */

/**
 * 块的状态。`mixed` 是真实语料逼出来的：一个块里可以既有现行约定
 * 又有被否决的备选方案（长块 + 重叠切分的必然结果），硬塞进
 * "现行 / 已否决" 二选一只会得到一个错标签。
 */
export type ChunkStatus = 'current' | 'rejected' | 'historical' | 'mixed' | 'unknown';

const STATUSES: readonly ChunkStatus[] = ['current', 'rejected', 'historical', 'mixed', 'unknown'];

/** 注入时显示的中文标签。`current` 是默认值，不标——每块省几个 token */
export const STATUS_LABEL: Record<ChunkStatus, string> = {
  current: '',
  rejected: '已否决的方案（不要当作现行结论）',
  historical: '历史版本（可能已不适用）',
  mixed: '含已否决/历史内容（注意区分）',
  unknown: '',
};

export interface ChunkContext {
  index: number;
  /** 一句话：这段在讲什么、承接哪一节 */
  context: string;
  status: ChunkStatus;
}

const SYSTEM = [
  '你在给一个中文资料库的分块补检索用的上下文。给你一篇资料的全部分块（带序号），',
  '对**每一块**输出两样东西：',
  '',
  '1. context：一句话（不超过 40 字）说清这段在讲什么、承接上文的哪一部分。',
  '   目的是让人只看这句话就知道该不该点开这块。',
  '   **不要写具体数字**（数字在正文里，这句话是索引和导航用的）。',
  '   尽量用同义说法把话说宽一点，比如正文写「抢锁失败」，这里可以说「获取锁失败时的处理」。',
  '2. status：这段内容的状态，只能取以下之一——',
  '   current     = 现行约定',
  '   rejected    = 被明确否决 / 放弃 / 不采用的方案',
  '   historical  = 旧版本、已被替代的说法',
  '   mixed       = 这一块里既有现行内容，也有被否决或历史的内容',
  '   unknown     = 判断不了',
  '   只有原文明确写了「否决/放弃/不采用/已废弃/曾经」这类字样，才可以标 rejected 或 historical。',
  '',
  '每一块都要有一条，序号照抄。只输出 JSON：',
  '{"chunks":[{"index":0,"context":"…","status":"current"}]}',
].join('\n');

/** 单块喂给模型的正文上限：状态判断要看到"否决"这类字样，不能只给开头 */
const PER_CHUNK_CHARS = 1400;

function clip(s: string, n = PER_CHUNK_CHARS): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.floor(n * 0.7))}…（中间略）…${s.slice(-Math.floor(n * 0.3))}`;
}

/**
 * 清洗模型输出：序号越界/重复的丢掉，状态非法的归为 unknown，空 context 丢掉。
 * 不做"缺哪块补哪块"——没给就是没给，缺的块保持原样（没有 context），
 * 由调用方决定要不要重跑。静默造一条假的比缺一条更坏。
 */
export function parseContexts(raw: unknown, chunkCount: number): ChunkContext[] {
  const list = (raw as { chunks?: unknown })?.chunks;
  const out: ChunkContext[] = [];
  const seen = new Set<number>();
  for (const item of Array.isArray(list) ? list : []) {
    const o = item as { index?: unknown; context?: unknown; status?: unknown };
    const index = Number(o.index);
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount || seen.has(index)) continue;
    const context = typeof o.context === 'string' ? o.context.replace(/\s+/g, ' ').trim() : '';
    if (!context) continue;
    seen.add(index);
    const s = String(o.status ?? '').trim().toLowerCase() as ChunkStatus;
    out.push({ index, context: context.slice(0, 60), status: STATUSES.includes(s) ? s : 'unknown' });
  }
  return out.sort((a, b) => a.index - b.index);
}

export interface ContextResult {
  entries: ChunkContext[];
  /** 被机械闸拦下的（一句话里有原文找不到的数字/标识符） */
  rejected: { index: number; missing: string[] }[];
  /** 模型没给上下文的块序号 */
  missing: number[];
}

/**
 * 给一篇资料的全部块补上下文。一次模型调用。
 *
 * @param chunks 这篇文档的正文块（按 index 升序，不含 digest）
 */
export async function contextualizeDoc(
  llm: Llm,
  doc: { title: string },
  chunks: readonly { index: number; headingPath: string; text: string }[],
): Promise<ContextResult> {
  if (!chunks.length) return { entries: [], rejected: [], missing: [] };
  const material = chunks
    .map((c) => `【#${c.index}】[${c.headingPath}]\n${clip(c.text)}`)
    .join('\n\n');
  const out = await llm.complete([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `【资料】《${doc.title}》（共 ${chunks.length} 块）\n\n${material}` },
  ]);
  const maxIndex = Math.max(...chunks.map((c) => c.index)) + 1;
  const parsed = parseContexts(firstJson(out.text ?? ''), maxIndex);
  if (!parsed.length) {
    throw new Error(`模型没给出可解析的上下文：${(out.text ?? '').replace(/\s+/g, ' ').slice(0, 80) || '（空输出）'}`);
  }

  // 机械闸：一句话里的数字/标识符必须能在**它自己那块**里找到。
  // 提示词已经说了不要写数字，这道闸是兜底——模型照旧会写「超过 5 秒会失真」。
  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  const entries: ChunkContext[] = [];
  const rejected: { index: number; missing: string[] }[] = [];
  for (const e of parsed) {
    const chunk = byIndex.get(e.index);
    if (!chunk) continue;
    const check = verifyBody(e.context, [doc.title, chunk.headingPath, chunk.text]);
    if (check.ok) entries.push(e);
    else rejected.push({ index: e.index, missing: check.missing });
  }
  const got = new Set(entries.map((e) => e.index));
  const missing = chunks.map((c) => c.index).filter((i) => !got.has(i));
  return { entries, rejected, missing };
}
