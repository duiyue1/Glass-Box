import type { WireEvent } from './engine/types.ts';
import { formatEntry } from './activity/activity.ts';

/**
 * 把一个 wire 事件渲染成一行（或多行）人类可读日志。
 *
 * 实时日志（index.ts）和会话回放（replay.ts）用的是同一份渲染逻辑——
 * 这正是事件溯源的好处：回放不是「另一套展示」，而是把同样的事件再喂一遍同一个渲染器，
 * 所以回放出来的东西和当时看到的一模一样。
 */
export function formatEvent(ev: WireEvent): string[] {
  const t = new Date(ev.ts).toISOString().slice(11, 23);
  const head = `[${t}]`;
  const line = (s: string) => [`${head} ${s}`];
  const sub = (s: string) => [`${head}    ${s}`];

  switch (ev.type) {
    case 'session.started': {
      const from = ev.forkedFrom ? `（分叉自 ${ev.forkedFrom.sessionId} @${ev.forkedFrom.seq}）` : '';
      return line(`[会话] ${ev.resumed ? '续跑' : '新建'} ${ev.sessionId}${from}`);
    }
    case 'session.renamed':
      return line(`[会话] 改名为「${ev.title}」`);
    case 'plugin.loaded':
      return line(`[插件] 加载 ${ev.name}: ${ev.tools.join(', ') || '(无)'}`);
    case 'skill.available':
      return line(`[技能] 可用: ${ev.skills.join(', ') || '(无)'}`);
    case 'skill.loaded': {
      const how = { tool: '模型加载', gesture: '用户点名', trigger: '触发词注入' }[ev.via];
      return line(`[技能] ${how} ${ev.name} ~${ev.tokensEst}tok${ev.truncated ? '（已截断）' : ''}`);
    }
    case 'turn.start':
      return line(`>> 回合开始: "${ev.userText}"`);
    case 'context.injected':
      return ev.contributions.length
        ? sub(`[上下文] 注入: ${ev.contributions.map((c) => `${c.source}(~${c.tokensEst}tok)`).join(', ')}`)
        : [];
    case 'context.usage':
      return sub(`[上下文] ${ev.tokens}/${ev.budget} tok, ${ev.messages} 条消息`);
    case 'context.compacted':
      return line(`[压缩] 丢弃 ${ev.droppedMessages} 条, ${ev.tokensBefore} -> ${ev.tokensAfter} tok`);
    case 'context.pruned':
      return line(`[削减] ${ev.prunedMessages} 条工具输出, 省掉 ${ev.charsRemoved} 字`);
    case 'token.estimate': {
      const pct = `${ev.drift >= 0 ? '+' : ''}${(ev.drift * 100).toFixed(1)}%`;
      const cached = ev.cached ? `, 缓存命中 ${ev.cached}` : '';
      return sub(`[计量] 估 ${ev.estimated} / 实 ${ev.actual} tok, 偏差 ${pct}${cached}`);
    }
    case 'state.change':
      return sub(`状态: ${ev.from} -> ${ev.to}`);
    case 'llm.response': {
      const kind = ev.response.toolCalls?.length
        ? `工具调用: ${ev.response.toolCalls.map((c) => c.name).join(', ')}`
        : '文本回复';
      return sub(`<- 模型: ${kind}`);
    }
    case 'tool.call':
      return sub(`[工具] ${ev.call.name}(${JSON.stringify(ev.call.args)})`);
    case 'tool.result':
      return sub(`[工具] 结果: ${ev.result.content.replace(/\n/g, '\\n').slice(0, 100)}`);
    case 'approval.request': {
      const out = sub(`[审批] 请求(${ev.request.level}): ${ev.request.summary}`);
      if (ev.request.preview) for (const l of ev.request.preview.split('\n')) out.push(`             ${l}`);
      return out;
    }
    case 'approval.decision':
      return sub(`[审批] ${ev.approved ? '放行' : '拒绝'}`);
    case 'subagent.start':
      return sub(`[子agent] 开始: "${ev.task}" (工具: ${ev.tools.join(', ')})`);
    case 'subagent.end':
      return sub(`[子agent] 完成: 用了 ${ev.toolsUsed.join(', ') || '无'}`);
    case 'memory.loaded':
      return ev.count > 0 ? line(`[记忆] 载入 ${ev.count} 条历史记忆`) : [];
    case 'memory.distilled':
      return sub(
        `[记忆] 蒸馏 +${ev.atoms.length} (共${ev.total}): ${ev.atoms.map((a) => `${a.kind}:${a.text}`).join(' | ')}`,
      );
    case 'memory.injected':
      return ev.items.length
        ? sub(
            `[记忆] 注入 ${ev.items.length} 条(${ev.usedTokens}/${ev.budget}tok,丢${ev.dropped}` +
              `${ev.hiddenByFork ? `,分叉屏蔽${ev.hiddenByFork}` : ''}): ` +
              ev.items.map((i) => i.text).join(' | '),
          )
        : ev.hiddenByFork
          ? sub(`[记忆] 命中的 ${ev.hiddenByFork} 条都因分叉被屏蔽`)
          : [];
    case 'kb.loaded':
      return ev.docs > 0 ? line(`[资料库] ${ev.docs} 篇 / ${ev.chunks} 块`) : [];
    case 'kb.imported':
      return sub(`[资料库] 导入「${ev.title}」v${ev.version} → ${ev.chunks} 块`);
    case 'kb.injected':
      return ev.items.length
        ? sub(
            `[资料库] 注入 ${ev.items.length} 段(${ev.usedTokens}/${ev.budget}tok,命中${ev.considered}丢${ev.dropped}): ` +
              ev.items.map((i) => i.headingPath || i.title).join(' | '),
          )
        : [];
    case 'kb.rewritten':
      return sub(
        `[资料库] 检索改写（${ev.reason === 'no-hit' ? '零命中' : '弱命中'}）: ${ev.original} → ` +
          (ev.picked ? `${ev.picked}（${ev.before}→${ev.after} 段）` : '候选都不如原来，保持不注入'),
      );
    case 'kb.contextualized':
      return sub(
        `[资料库] 补块上下文 ${ev.docs.map((d) => `${d.title} +${d.chunks}`).join('、') || '无'}` +
          `（全库 ${ev.total} 块）${ev.failed.length ? ` 失败 ${ev.failed.length}` : ''}`,
      );
    case 'plan.updated': {
      const view = ev.items
        .map((i) => `${i.id}${i.status === 'done' ? '✔' : i.status === 'doing' ? '▶' : '○'}`)
        .join(' ');
      return sub(`[计划] ${ev.ok ? '' : '被拒：'}${ev.message}${view ? ` | ${view}` : ''}`);
    }
    case 'verify.started':
      return sub(`[自动验证] 跑 ${ev.cmd}（来自 ${ev.from}）…`);
    case 'verify.done':
      return ev.ok
        ? sub(`[自动验证] 通过（${ev.ms}ms）`)
        : [
            ...sub(`[自动验证] 未通过（${ev.ms}ms）: ${ev.cmd}`),
            ...ev.output.split('\n').slice(0, 8).map((l) => `      ${l}`),
          ];
    case 'wiki.injected':
      return ev.items.length
        ? sub(
            `[知识目录] 注入 ${ev.items.length} 条(${ev.usedTokens}/${ev.budget}tok` +
              (ev.stale.length ? `，${ev.stale.length} 条已过期` : '') +
              `): ` +
              ev.items.map((i) => (ev.stale.includes(i.ref) ? `${i.ref}(过期)` : i.ref)).join(' | '),
          )
        : [];
    case 'activity.updated': {
      const last = ev.entries.at(-1);
      return last ? sub(`[轨迹] ${formatEntry(last)}`) : [];
    }
    case 'web.request':
      return sub(
        `[联网] ${ev.ok ? '✓' : '✗'} ${ev.url}${ev.status ? ` ${ev.status}` : ''}` +
          `${ev.bytes ? ` · ${Math.round(ev.bytes / 1024)}KB` : ''} · ${ev.ms}ms${ev.note ? ` · ${ev.note}` : ''}`,
      );
    case 'turn.limit':
      return line(`[限流] 工具步数已达上限 ${ev.maxSteps}，要求模型直接收尾`);
    case 'turn.aborted':
      return line(`[中断] 用户掐掉了本回合（已执行 ${ev.steps} 次工具调用）`);
    case 'turn.end':
      return line('<< 回合结束');
    default:
      return [];
  }
}
