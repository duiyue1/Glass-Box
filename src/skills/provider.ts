import type { ContextProvider } from '../engine/types.ts';
import type { Wire } from '../engine/wire.ts';
import { estimateText } from '../engine/tokens.ts';
import { renderSkillContent, type SkillRegistry } from './registry.ts';

/** 技能怎么进上下文 */
export type SkillMode =
  /** 目录模式（默认）：只注入摘要目录，正文由模型调 `skill` 工具按需取；用户 `/名字` 可直接内联 */
  | 'catalog'
  /** 旧行为：触发词命中就把整篇正文注入本回合。留着当 A/B 的对照组 */
  | 'inject';

export interface SkillProviderOptions {
  mode: SkillMode;
  /** 正文 token 上限（两种模式都受它约束） */
  maxTokens?: number;
  wire?: Wire;
}

/**
 * 技能的上下文注入。
 *
 * **目录模式下这个 provider 平时什么都不注入**——目录挂在 `skill` 工具的 description 里
 * （见 `plugins/skillPlugin.ts`），那是每次请求的固定开销，不必再当"注入"重发一遍。
 * 它只负责一件事：用户显式 `/名字` 点名时，把正文直接内联进本回合，省掉一个来回。
 * 这条路对标 dsh 的 `/name` 手势——**用户点名要用**，不需要模型再判断一次。
 *
 * inject 模式是旧行为（触发词命中 → 整篇正文注入）。留着不是为了兼容，是为了能对照：
 * 同一份代码两种跑法，才说得清"渐进式加载省了多少、漏了多少"。
 */
export function skillProvider(registry: SkillRegistry, opts: SkillProviderOptions): ContextProvider {
  const { mode, maxTokens, wire } = opts;
  return {
    name: 'skills',
    provide(userText) {
      const hits = mode === 'inject' ? registry.match(userText) : registry.gestures(userText);
      const via = mode === 'inject' ? 'trigger' : 'gesture';
      const out = [];
      for (const s of hits) {
        const loaded = registry.get(s.name, maxTokens);
        if (!loaded) continue;
        // 两条加载路径共用同一个渲染函数：不管谁发起的，模型看到的形状必须一样
        const content =
          mode === 'inject'
            ? `【技能: ${loaded.name}】${loaded.description}\n${loaded.body}`
            : renderSkillContent(loaded);
        wire?.emit({
          type: 'skill.loaded',
          name: loaded.name,
          via,
          tokensEst: loaded.tokensEst,
          truncated: loaded.truncated,
          ts: Date.now(),
        });
        out.push({ source: `skill:${loaded.name}`, content, tokensEst: estimateText(content) });
      }
      return out;
    },
  };
}
