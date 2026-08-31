import type { Plugin } from '../engine/plugin.ts';
import { safeAssess, type Tool } from '../engine/types.ts';
import { DEFAULT_DESC_CHARS, renderSkillContent, type SkillRegistry } from '../skills/registry.ts';

export interface SkillPluginOptions {
  /** 目录里单条描述的字符上限 */
  descChars?: number;
  /** 加载回来的正文 token 上限，超了截断 */
  maxTokens?: number;
}

/**
 * skill 插件：把"加载一个技能的完整正文"变成模型可以调用的工具。
 *
 * 这是渐进式加载的第二层。三家参照物的做法一致，这里抄的是它们的共同点：
 * - **目录只有摘要**：`name` + 截断后的 `description`，放在这个工具的 description 里。
 *   Claude Code 就是把所有技能的 name/description 动态拼进 Skill 工具的说明；
 *   dsh 换成一条持久 user 消息。放进工具声明的好处是它属于每次请求的**稳定前缀**，
 *   网关的前缀缓存能命中，而"注入"是挂在消息数组最前面、回合内每次请求都重发的。
 * - **正文以工具结果回来**，不再做一份注入副本：纯追加，不动已有前缀。
 * - **资源只给指引不给附件**：告诉模型基准目录，它引用到哪个文件自己去 read_file。
 *
 * 参数用 enum 把可选值钉死：名字对不对由 API 协议保证，不靠模型自觉。
 * `free: true` —— 加载指令不该占掉干活的工位（同 `task_plan` 的理由）。
 * `cacheable: true` —— 同一回合内重复加载同一个技能直接复用，不重复读盘也不占步数。
 */
export function skillPlugin(registry: SkillRegistry, opts: SkillPluginOptions = {}): Plugin {
  const descChars = opts.descChars ?? DEFAULT_DESC_CHARS;
  const maxTokens = opts.maxTokens;
  return {
    name: 'skill',
    setup(ctx) {
      const names = registry.list().map((s) => s.name);
      // 一个技能都没有就不注册：没得选的工具白占 schema token，还会引诱模型乱调
      if (!names.length) return;
      const skill: Tool = {
        name: 'skill',
        free: true,
        cacheable: true,
        assess: safeAssess,
        description:
          '加载一个技能（一套针对特定任务的可复用指令）的完整正文。' +
          '下面的清单只有摘要，不要凭摘要猜里面写了什么；' +
          '任务对上了某个技能的描述，就先调这个工具把它取回来，再照它说的做。' +
          `\n可用技能：\n${registry.catalog(descChars)}`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名，必须是清单里的精确名字', enum: names },
          },
          required: ['name'],
        },
        run(args) {
          const raw = typeof args.name === 'string' ? args.name.trim() : '';
          if (!raw) return { ok: false, content: `要给 name。可用技能：${names.join(' / ')}` };
          const loaded = registry.get(raw, maxTokens);
          if (!loaded) {
            return { ok: false, content: `技能 "${raw}" 不存在或已不可用。可用技能：${names.join(' / ')}` };
          }
          ctx.wire.emit({
            type: 'skill.loaded',
            name: loaded.name,
            via: 'tool',
            tokensEst: loaded.tokensEst,
            truncated: loaded.truncated,
            ts: Date.now(),
          });
          return { ok: true, content: renderSkillContent(loaded), meta: { action: 'read', path: loaded.file } };
        },
      };
      ctx.tools.register(skill);
    },
  };
}
