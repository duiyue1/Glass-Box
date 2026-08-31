import type { ContextProvider } from '../engine/types.ts';
import type { Wire } from '../engine/wire.ts';
import { pickCatalog, type CatalogOpts, type WikiStore } from './wikiStore.ts';

/**
 * 把 wiki 目录接进每一回合的上下文。
 *
 * 和 kbProvider 的区别是**它不做检索**：目录是"这个知识库里有什么"的地图，
 * 命中才给就没有意义了（模型不知道有这页，就永远不会去问这页）。
 * 所以这里固定注入一份紧凑清单——每条只有 `ref — 一句话摘要`，
 * 正文要不要读由模型自己决定（`kb_read page=<ref>`）。
 *
 * 这就是 progressive disclosure：**给指针，不给内容**。
 * 外面测过的一个现象是 agent 普遍"检索太多、只用一点"
 * （ContextBench：1136 个任务上模型一致偏向召回而不是精度），
 * 目录的作用正是让它先看见地图、再决定要不要付读正文的代价。
 *
 * 成本被两个数字夹住：最多几条（GB_WIKI_ITEMS）、整体几个 token（GB_WIKI_TOKENS）。
 * 砍尾时先砍 source 页——概念页才是带数值约定、会被追问的那批。
 * `GB_WIKI=0` 整体关掉，这样"有目录 / 没目录"是同一份代码的两种跑法（对照组的老规矩）。
 *
 * 过期条目由 `budget.isStale` 判定（app.ts 传进来），在目录里降权并标记——
 * 不排除，理由见 `CatalogOpts.isStale`。
 */
export function wikiProvider(wiki: WikiStore, wire: Wire, budget: CatalogOpts): ContextProvider {
  return {
    name: 'wiki',
    provide: () => {
      // 每回合重读磁盘：条目是普通 .md，用户可能刚在编辑器里改过，也可能刚生成完。
      // 条目数是几十的量级，这点读取代价换"看到的永远是磁盘实况"是值的。
      const pick = pickCatalog(wiki.list(), budget);
      wire.emit({
        type: 'wiki.injected',
        items: pick.pages.map((p) => ({ ref: p.ref, summary: p.summary })),
        usedTokens: pick.tokens,
        budget: budget.maxTokens ?? 0,
        skipped: pick.skipped,
        stale: pick.stale,
        ts: Date.now(),
      });
      if (!pick.text) return [];
      return [{ source: 'wiki', content: pick.text, tokensEst: pick.tokens }];
    },
  };
}
