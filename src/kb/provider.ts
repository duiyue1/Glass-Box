import type { ContextProvider } from '../engine/types.ts';
import type { Llm } from '../engine/loop.ts';
import type { Wire } from '../engine/wire.ts';
import { buildQuery } from './query.ts';
import { needsRewrite, pickBest, rewriteQuery } from './rewrite.ts';
import { formatHits, type KbBudget, type KbStore } from './store.ts';

export interface KbProviderOptions {
  /** 给了 llm 才启用检索改写；没有就退回一次性检索 */
  llm?: Llm;
  /** 最多改写几轮（一轮 = 一次模型调用 + 逐个候选检索）。0 = 关掉 */
  maxRewrites?: number;
  /** 命中但最高分低于这个绝对分也算"不够"（默认 0 = 只在零命中时改写） */
  minTop1?: number;
}

/**
 * 资料库作为 ContextProvider 接入 Loop：命中才注入，和 skills/记忆是同一个口子。
 * 注入内容带来源标注，并发 kb.injected 事件——面板上能看见这次到底喂了哪几段进去。
 *
 * 查询不是直接用用户原话：先去停用词，实词太少时（"它的重试策略呢"）借上一轮的关键词，
 * 否则多轮追问基本检索不到东西。用的查询串会记进事件里，方便事后对账。
 *
 * **一段都没检索到时会再试一轮**（Agentic RAG 的最小闭环）：让模型换 2~3 组检索词，
 * 逐个去检，机械地挑最好的一个。触发条件是确定性的（零命中），所以正常回合不额外花钱；
 * 改写完还是空的话就保持不注入——宁可什么都不给，也不塞看起来像答案的垃圾。
 */
export function kbProvider(
  store: KbStore,
  wire: Wire,
  budget: KbBudget,
  opts: KbProviderOptions = {},
): ContextProvider {
  // 上一轮的关键词，只活在内存里：它是"话题上下文"，不值得落盘
  let prevKeywords: string[] = [];
  // 注入正文默认留档；日志体积敏感时 GB_KB_LOG_TEXT=0 关掉
  const logText = process.env.GB_KB_LOG_TEXT !== '0';
  const maxRewrites = opts.maxRewrites ?? 0;

  return {
    name: 'kb',
    provide: async (userText) => {
      const q = buildQuery(userText, prevKeywords);
      prevKeywords = q.keywords;
      let query = q.query;
      let res = store.search(query, budget);

      // ── 改写一轮 ──
      // 只在确定性信号说"不够"时才启动。判断"哪个候选更好"也是机械的，
      // 模型只负责出检索词——它出的词好不好，由 BM25 的结果说话。
      const reason = maxRewrites > 0 && opts.llm ? needsRewrite(res, { minTop1: opts.minTop1 }) : undefined;
      if (reason && opts.llm) {
        // 给模型一点线索：库里有哪些资料。没有这个它只能凭空猜术语
        const hint = store
          .list()
          .filter((d) => d.status === 'active')
          .map((d) => d.title)
          .join('、');
        const candidates = await rewriteQuery(opts.llm, userText, query, hint);
        const tries = candidates.map((c) => ({ query: c, res: store.search(c, budget) }));
        const best = pickBest({ query, res }, tries);
        wire.emit({
          type: 'kb.rewritten',
          reason,
          original: query,
          candidates: tries.map((t) => ({ query: t.query, items: t.res.items.length })),
          picked: best.switched ? best.query : undefined,
          before: res.items.length,
          after: best.res.items.length,
          ts: Date.now(),
        });
        if (best.switched) {
          query = best.query;
          res = best.res;
          // 改写命中的关键词才是这轮真正的话题，指代兜底要顺着它往下传
          prevKeywords = query.split(/\s+/).filter(Boolean).slice(0, 6);
        }
      }

      const content = res.items.length ? formatHits(res.items) : '';
      wire.emit({
        type: 'kb.injected',
        items: res.items.map((i) => ({
          title: i.chunk.title,
          headingPath: i.chunk.headingPath,
          score: Math.round(i.score * 100) / 100,
          tokens: i.chunk.tokens,
          neighbor: i.neighbor,
        })),
        usedTokens: res.usedTokens,
        budget: budget.maxTokens,
        dropped: res.dropped,
        considered: res.considered,
        cappedByDoc: res.cappedByDoc,
        belowThreshold: res.belowThreshold,
        query,
        usedPrev: q.usedPrev,
        // 审计口：把真正拼进提示词的正文原样留档，事后能一字不差地复核
        content: logText && content ? content : undefined,
        ts: Date.now(),
      });
      if (res.items.length === 0) return [];
      return [{ source: 'kb', content, tokensEst: res.usedTokens }];
    },
  };
}
