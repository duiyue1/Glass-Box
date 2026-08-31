import type { ContextProvider } from '../engine/types.ts';
import { estimateText } from '../engine/tokens.ts';
import { formatPlan, type PlanStore } from './plan.ts';

/**
 * 把当前任务计划接进每一回合的上下文。
 *
 * 和 kbProvider 的"命中才注入"不同，这里是**有就注入**：计划的全部作用就是
 * 让模型每回合都重新看见"整件事分几步、我在第几步"。命中才给等于没给。
 *
 * 和 wikiProvider 的区别是它**不需要预算裁剪**：清单本身被 MAX_ITEMS/MAX_TEXT
 * 夹住了（12 步 × 80 字，最坏约 250 tok，正常 3~5 步是 40~60 tok）。
 * 没有计划就返回空数组——不注入比注入一句"暂无计划"有用。
 */
export function planProvider(store: PlanStore): ContextProvider {
  return {
    name: 'plan',
    provide: () => {
      const content = formatPlan(store.list());
      if (!content) return [];
      return [{ source: 'plan', content, tokensEst: estimateText(content) }];
    },
  };
}
