import type { Llm } from '../engine/loop.ts';
import { firstJson } from './wiki.ts';
import type { KbSearchResult } from './store.ts';

/**
 * 检索改写（Agentic RAG 的最小闭环）。
 *
 * 现在的检索是**一条直线**：构造查询 → BM25 → 阈值筛 → 注入。查不到就是查不到，
 * 模型只能拿着空手回答（实测这时它会开始写「常见做法有三种」——nokb 组的
 * completion token 是 kb 组的 2.3 倍，就是这么烧的）。
 *
 * 外面说的 Agentic RAG 是把这条直线变成循环：模型自己判断「够不够」，不够就改写查询再来一轮。
 * 这里做的是它的**省钱版**，两点不同：
 *
 * 1. **要不要重试由确定性信号决定，不问模型。** 朴素做法是每回合让模型自评一次
 *    「这些片段够不够」——那是每回合多一次调用，在这个项目里绝大多数回合都是白花的。
 *    我们只在「一段都没注入」这种铁定不够的情况下才启动，正常回合零额外成本。
 * 2. **模型只负责改写查询词，不负责回答。** 它给 2~3 个候选检索词，我们逐个去检，
 *    取最好的一个。判断"哪个更好"也是机械的（命中数 → top1 分数）。
 *
 * 关键的一条纪律：**改写之后仍然弱命中，就保持不注入。**
 * 不能为了"有东西注入"而硬塞——评测里 N3 就是被"看起来像答案的片段"带跑的，
 * 塞垃圾比什么都不塞更坏。
 */

/** 为什么要改写。undefined = 不需要 */
export type RewriteReason = 'no-hit' | 'weak-hit';

export interface RewriteTrigger {
  minTop1?: number;
}

/**
 * 要不要改写：完全看检索结果，不调模型。
 * - `no-hit`：一段都没进注入（可能压根没命中，也可能全被阈值挡了）
 * - `weak-hit`：命中了但最高分低于绝对阈值（默认不启用，BM25 绝对分不同库之间不可比）
 */
export function needsRewrite(res: KbSearchResult, opts: RewriteTrigger = {}): RewriteReason | undefined {
  if (!res.items.length) return 'no-hit';
  const minTop1 = opts.minTop1 ?? 0;
  if (minTop1 > 0) {
    const top1 = Math.max(...res.items.map((i) => i.score));
    if (top1 < minTop1) return 'weak-hit';
  }
  return undefined;
}

const SYSTEM = [
  '你在帮一个中文资料库改写检索词。用户的问法没能在资料里检索到内容，',
  '请给出 2~3 个**替换的检索词组**，让 BM25 有机会命中。',
  '',
  '要点：',
  '1. 用资料里**可能出现的书面术语**，不要用口语句子。比如用户问「锁抢不到咋办」，',
  '   候选可以是「抢锁失败 重试」「获取锁超时」。',
  '2. 每个候选 2~8 个词，词之间用空格分开，不要标点，不要整句。',
  '3. 候选之间要**换角度**（同义词 / 更上位的概念 / 相关的具体字段名），不要只改语序。',
  '4. 不知道资料里有什么就按常见技术文档的写法猜，但不要编具体数字。',
  '',
  '只输出 JSON：{"queries":["…","…"]}',
].join('\n');

/** 清洗候选：去空、去重、去掉和原查询一样的、限长限数量 */
export function normalizeQueries(raw: unknown, original: string, max = 3): string[] {
  const list = (raw as { queries?: unknown })?.queries;
  const seen = new Set([original.replace(/\s+/g, ' ').trim()]);
  const out: string[] = [];
  for (const q of Array.isArray(list) ? list : []) {
    const s = String(q ?? '')
      // 全角半角标点都要清：模型给「抢锁失败, 重试」和「抢锁失败 重试」时，
      // 不清半角逗号的话这两条会被当成不同的候选，白检一次
      .replace(/[，。？！、：；,.?!;:"'`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length > 40 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 让模型给候选检索词。一次调用。
 * 拿不到可用候选就返回空数组——**不抛错**：改写是锦上添花，
 * 它失败不该让整个回合失败（这一轮就退回"没检索到"的老行为）。
 */
export async function rewriteQuery(
  llm: Llm,
  userText: string,
  triedQuery: string,
  hint?: string,
): Promise<string[]> {
  try {
    const out = await llm.complete([
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          `【用户问的】${userText}`,
          `【已经试过的检索词】${triedQuery}（没检索到内容）`,
          hint ? `【资料库里有这些资料】${hint}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ]);
    return normalizeQueries(firstJson(out.text ?? ''), triedQuery);
  } catch {
    return [];
  }
}

/**
 * 从「原结果 + 各候选的结果」里挑一个。机械规则：先看注入了几段，再看最高分。
 * 平手时保留原结果——改写要赢得明显才值得换，否则只是把结果搅一遍。
 */
export function pickBest(
  base: { query: string; res: KbSearchResult },
  tries: readonly { query: string; res: KbSearchResult }[],
): { query: string; res: KbSearchResult; switched: boolean } {
  const top1 = (r: KbSearchResult): number => (r.items.length ? Math.max(...r.items.map((i) => i.score)) : 0);
  let best = base;
  let switched = false;
  for (const t of tries) {
    const better =
      t.res.items.length > best.res.items.length ||
      (t.res.items.length === best.res.items.length && t.res.items.length > 0 && top1(t.res) > top1(best.res));
    if (!better) continue;
    best = t;
    switched = true;
  }
  return { ...best, switched };
}
