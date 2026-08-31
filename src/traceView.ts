import type { TokenUsage, WireEvent } from './engine/types.ts';
import type { JournalRecord } from './engine/journal.ts';

/**
 * traceView：把只追加的事件流折成「按回合分层的轨迹」。
 *
 * 会话日志是一条平铺的事件流，人看长会话会瞎。这里做纯派生：
 * 回合边界（turn.start/turn.end）分层，工具/模型调用配对算耗时，
 * TTFT 从 llm.request → 第一条 llm.delta 算出来。
 *
 * 它不碰引擎、不写盘、不需要新事件——所有数字都是从已有历史算回来的，
 * 所以历史会话（哪怕是几天前跑的）也能立刻拿到同样的视图。
 */

/** 行的大类，UI 上按它上色和筛选 */
export type RowKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'approval'
  | 'context'
  | 'memory'
  | 'kb'
  | 'web'
  | 'subagent'
  | 'session'
  | 'other';

export interface TraceRow {
  seq: number;
  ts: number;
  kind: RowKind;
  /** 原始事件类型，调试和精确筛选用 */
  type: string;
  /** 左列的短标签，如「工具 read_file」 */
  label: string;
  /** 一行摘要 */
  summary: string;
  /** 这一步自己花了多久（模型调用 / 工具执行 / 等审批）；没有配对时缺省 */
  ms?: number;
  ok?: boolean;
  /** 点开这一行时右侧要看的完整内容 */
  detail?: Record<string, unknown>;
}

export interface TurnStats {
  /** 工具调用次数（= dsh 里的 Step） */
  steps: number;
  /** 模型调用累计耗时 */
  llmMs: number;
  /** 工具执行累计耗时 */
  toolMs: number;
  /** 等人审批的累计时间：它既不是模型慢也不是工具慢，混在一起会误判 */
  approvalMs: number;
  /** 首 token 延迟（该回合第一次模型调用） */
  ttftMs?: number;
  /** 回合墙钟时长 */
  wallMs?: number;
  /** provider 报的真实 token（多次模型调用累加） */
  usage?: TokenUsage;
  /** 我们自己估的上下文占用（末次 context.usage） */
  ctxTokens?: number;
  ctxBudget?: number;
}

export interface TraceTurn {
  index: number;
  turnId: string;
  userText: string;
  startTs: number;
  endTs?: number;
  /** 回合是否正常收尾（没有 turn.end 说明进程被 kill 了，或者这一页只截到一半） */
  closed: boolean;
  /** 这个回合的开头不在当前窗口里（分页翻到中段时会出现） */
  partial?: boolean;
  rows: TraceRow[];
  stats: TurnStats;
}

/** 不属于任何回合的事件（会话开始/改名、压缩、记忆蒸馏……） */
export interface BetweenBlock {
  /** 排在第几个回合之后（0 = 第一个回合之前） */
  afterTurn: number;
  rows: TraceRow[];
}

export interface TraceSummary {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  approvalMs: number;
  wallMs: number;
  /** 各回合首 token 延迟的平均值 */
  avgTtftMs?: number;
  usage?: TokenUsage;
  /** 有多少次模型调用带回了 usage——没有全带时不能把总量当准数 */
  usageCalls: number;
  llmCalls: number;
  /** 输出速度：completion tokens / 模型耗时 */
  tokPerSec?: number;
}

export interface Trajectory {
  turns: TraceTurn[];
  between: BetweenBlock[];
  summary: TraceSummary;
}

const KIND_OF: Record<string, RowKind> = {
  'turn.start': 'user',
  'llm.request': 'assistant',
  'llm.response': 'assistant',
  'tool.call': 'tool',
  'tool.result': 'tool',
  'approval.request': 'approval',
  'approval.decision': 'approval',
  'context.injected': 'context',
  'context.usage': 'context',
  'context.compacted': 'context',
  'context.pruned': 'context',
  'token.estimate': 'context',
  'turn.limit': 'other',
  'turn.aborted': 'other',
  'verify.started': 'tool',
  'verify.done': 'tool',
  'plan.updated': 'context',
  'memory.injected': 'memory',
  'memory.distilled': 'memory',
  'memory.loaded': 'memory',
  'kb.injected': 'kb',
  'kb.rewritten': 'kb',
  'kb.contextualized': 'kb',
  'wiki.injected': 'kb',
  'kb.imported': 'kb',
  'kb.loaded': 'kb',
  'web.request': 'web',
  'subagent.start': 'subagent',
  'subagent.end': 'subagent',
  'session.started': 'session',
  'session.renamed': 'session',
  'plugin.loaded': 'session',
  'skill.available': 'session',
  'skill.loaded': 'session',
};

const cut = (s: unknown, n = 120): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 详情里保留的正文上限：够看清发生了什么，又不至于把整份日志塞进 HTTP 响应 */
const DETAIL_CHARS = 4000;
const keep = (s: unknown): string => {
  const t = String(s ?? '');
  return t.length > DETAIL_CHARS ? t.slice(0, DETAIL_CHARS) + `\n…（还有 ${t.length - DETAIL_CHARS} 字）` : t;
};

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  const out: TokenUsage = {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
  };
  if (a.cached !== undefined || b.cached !== undefined) out.cached = (a.cached ?? 0) + (b.cached ?? 0);
  return out;
}

/** 一个事件渲染成账本里的一行（不含耗时，耗时由配对逻辑补） */
function describe(ev: WireEvent): { label: string; summary: string; detail?: Record<string, unknown> } {
  switch (ev.type) {
    case 'turn.start':
      return { label: '你', summary: cut(ev.userText, 160), detail: { 提问: keep(ev.userText) } };
    case 'llm.response': {
      const r = ev.response;
      const what = r.toolCalls?.length
        ? `要求调用 ${r.toolCalls.map((c) => c.name).join(', ')}`
        : cut(r.text, 160);
      return {
        label: '模型',
        summary: what,
        detail: {
          回复文本: keep(r.text ?? ''),
          工具调用: r.toolCalls?.map((c) => ({ name: c.name, args: c.args })) ?? [],
          usage: r.usage ?? '（这次调用没拿到 provider 的 usage）',
        },
      };
    }
    case 'tool.call':
      return { label: `工具 ${ev.call.name}`, summary: cut(JSON.stringify(ev.call.args), 160), detail: { 参数: ev.call.args } };
    case 'tool.result':
      return {
        label: '工具结果',
        summary: cut(ev.result.content, 160),
        detail: { 成功: ev.result.ok, 内容: keep(ev.result.content), meta: ev.result.meta ?? {} },
      };
    case 'approval.request':
      return { label: '请求审批', summary: `${ev.request.toolName} · ${ev.request.level} · ${cut(ev.request.summary, 80)}` };
    case 'approval.decision':
      return {
        label: ev.approved ? '审批通过' : '审批拒绝',
        summary: `${ev.request.toolName} · ${cut(ev.request.summary, 80)}`,
        detail: { 风险: ev.request.level, 理由: ev.request.reason ?? '', 预览: keep(ev.request.preview ?? '') },
      };
    case 'context.injected':
      return {
        label: '注入上下文',
        summary: ev.contributions.map((c) => `${c.source} ${c.tokensEst}tok`).join(' · ') || '（无）',
      };
    case 'context.usage':
      return { label: '上下文占用', summary: `${ev.tokens}/${ev.budget} tok · ${ev.messages} 条消息` };
    case 'context.compacted':
      return { label: '上下文压缩', summary: `丢 ${ev.droppedMessages} 条 · ${ev.tokensBefore} → ${ev.tokensAfter} tok` };
    case 'context.pruned':
      return { label: '工具输出削减', summary: `${ev.prunedMessages} 条 · 省 ${ev.charsRemoved} 字` };
    case 'token.estimate':
      return {
        label: 'token 计量对账',
        summary: `估 ${ev.estimated} / 实 ${ev.actual} · 偏差 ${ev.drift >= 0 ? '+' : ''}${(ev.drift * 100).toFixed(1)}%`,
      };
    case 'memory.injected':
      return {
        label: '记忆注入',
        summary:
          `${ev.items.length} 条（${ev.usedTokens}/${ev.budget} tok）` +
          (ev.hiddenByFork ? ` · 分叉屏蔽 ${ev.hiddenByFork}` : ''),
        detail: { 条目: ev.items, 丢弃: ev.dropped, 分叉屏蔽: ev.hiddenByFork ?? 0 },
      };
    case 'memory.distilled':
      return { label: '记忆蒸馏', summary: `+${ev.atoms.length}（共 ${ev.total}）`, detail: { 新原子: ev.atoms } };
    case 'memory.loaded':
      return { label: '记忆加载', summary: `${ev.count} 条` };
    case 'kb.injected':
      return {
        label: '资料库注入',
        summary: `${ev.items.length} 段（${ev.usedTokens}/${ev.budget} tok，命中 ${ev.considered} 丢 ${ev.dropped}）`,
        detail: { 片段: ev.items },
      };
    case 'kb.rewritten':
      return {
        label: '检索改写',
        summary:
          `${ev.reason === 'no-hit' ? '零命中' : '弱命中'} · ${ev.before}→${ev.after} 段` +
          (ev.picked ? ` · 换成「${ev.picked}」` : ' · 候选都不如原来'),
        detail: { 原查询: ev.original, 候选: ev.candidates, 采用: ev.picked ?? '（未更换）' },
      };
    case 'kb.contextualized':
      return {
        label: '补块上下文',
        summary: `${ev.docs.reduce((n, d) => n + d.chunks, 0)} 块（全库 ${ev.total}）` +
          (ev.failed.length ? ` · 失败 ${ev.failed.length}` : ''),
        detail: { 每篇: ev.docs, 失败: ev.failed },
      };
    case 'plan.updated':
      return {
        label: '任务计划',
        summary:
          `${ev.ok ? ev.message : `被拒：${ev.message}`} · ` +
          `${ev.items.filter((i) => i.status === 'done').length}/${ev.items.length} 完成`,
        detail: ev.items.length
          ? { 清单: ev.items.map((i) => `${i.id} [${i.status}] ${i.text}`).join('\n') }
          : undefined,
      };
    case 'verify.started':
      return { label: '自动验证', summary: `${ev.cmd}（来自 ${ev.from}）` };
    case 'verify.done':
      return {
        label: '自动验证',
        summary: `${ev.ok ? '通过' : '未通过'} · ${ev.cmd} · ${ev.ms}ms`,
        detail: ev.ok ? undefined : { 输出: ev.output },
      };
    case 'wiki.injected':
      return {
        label: '知识目录',
        summary: `${ev.items.length} 条（${ev.usedTokens}/${ev.budget} tok）` +
          (ev.stale.length ? ` · 过期 ${ev.stale.length}` : '') +
          (ev.skipped.length ? ` · 落选 ${ev.skipped.length}` : ''),
        detail: { 条目: ev.items, 已过期: ev.stale, 落选: ev.skipped },
      };
    case 'kb.imported':
      return { label: '资料导入', summary: `${ev.title} v${ev.version} · ${ev.chunks} 块 · ${ev.chars} 字` };    case 'kb.loaded':
      return { label: '资料库加载', summary: `${ev.docs} 篇 / ${ev.chunks} 块` };
    case 'web.request':
      return {
        // 事件里没有「搜索还是抓取」的字段，用 note 里的线索区分不了，就统一叫联网
        label: '联网',
        summary: `${ev.ok ? '✓' : '✗'} ${cut(ev.url, 90)} · ${ev.ms}ms${ev.note ? ` · ${ev.note}` : ''}`,
        detail: { url: ev.url, 状态: ev.status ?? '', 字节: ev.bytes ?? '', 备注: ev.note ?? '' },
      };
    case 'subagent.start':
      return { label: '子 agent 启动', summary: cut(ev.task, 120), detail: { 可用工具: ev.tools } };
    case 'subagent.end':
      return { label: '子 agent 结束', summary: `${ev.steps} 步 · ${cut(ev.result, 100)}`, detail: { 结果: keep(ev.result) } };
    case 'turn.limit':
      return { label: '步数用尽', summary: `已用 ${ev.steps} / 上限 ${ev.maxSteps}` };
    case 'turn.aborted':
      return { label: '被中断', summary: `用户掐掉了本回合（已执行 ${ev.steps} 次工具调用）` };
    case 'session.started': {
      const from = ev.forkedFrom ? `（分叉自 ${ev.forkedFrom.sessionId}@${ev.forkedFrom.seq}）` : '';
      return { label: '会话开始', summary: `${ev.resumed ? '续跑' : '新建'} ${ev.sessionId}${from}` };
    }
    case 'session.renamed':
      return { label: '会话改名', summary: ev.title };
    case 'plugin.loaded':
      return { label: '插件加载', summary: `${ev.name}: ${ev.tools.join(', ') || '(无)'}` };
    case 'skill.available':
      return { label: 'Skills', summary: ev.skills.join(', ') || '(无)' };
    case 'skill.loaded': {
      const how = { tool: '模型加载', gesture: '用户点名', trigger: '触发词注入' }[ev.via];
      return {
        label: '技能加载',
        summary: `${ev.name}（${how}）~${ev.tokensEst}tok${ev.truncated ? '，已截断' : ''}`,
      };
    }
    case 'turn.end':
      return { label: '回合结束', summary: `${ev.messages.length} 条历史消息` };
    default:
      return { label: (ev as { type: string }).type, summary: '' };
  }
}

/** 这些事件不单独占一行：要么太碎（每个 token 一条），要么只是状态机噪音 */
const SKIP = new Set(['llm.delta', 'state.change', 'llm.request', 'activity.updated']);

export interface TraceOptions {
  /**
   * 窗口开始时已经在进行中的那个回合。
   * 分页只看尾部一页时，中段的行往前找不到 turn.start，
   * 不带这个信息就会被误判成「回合之间」——那是在骗人。
   */
  openTurn?: { turnId: string; userText: string; startTs: number };
  /** 窗口之前已经有多少个完整回合，用来给回合编号（让 #3 就是第 3 个回合） */
  turnsBefore?: number;
}

/**
 * 把一段事件记录折成轨迹。
 * records 可以是整份日志，也可以是一个窗口（分页时只传尾部若干条）——
 * 窗口内配不上对的调用（比如只看到 tool.result 没看到 tool.call）就不算耗时，不编数。
 */
export function buildTrajectory(records: JournalRecord[], opts: TraceOptions = {}): Trajectory {
  const turns: TraceTurn[] = [];
  const between: BetweenBlock[] = [];
  const base = opts.turnsBefore ?? 0;
  let cur: TraceTurn | undefined;

  if (opts.openTurn) {
    cur = {
      index: base,
      turnId: opts.openTurn.turnId,
      userText: opts.openTurn.userText,
      startTs: opts.openTurn.startTs,
      closed: false,
      partial: true,
      rows: [],
      stats: { steps: 0, llmMs: 0, toolMs: 0, approvalMs: 0 },
    };
    turns.push(cur);
  }

  // 配对用的挂起状态
  let llmReqTs: number | undefined;
  let firstDeltaTs: number | undefined;
  const toolCallTs = new Map<string, number>();
  let approvalTs: number | undefined;

  const pushBetween = (row: TraceRow) => {
    const afterTurn = turns.length;
    let block = between.at(-1);
    if (!block || block.afterTurn !== afterTurn) {
      block = { afterTurn, rows: [] };
      between.push(block);
    }
    block.rows.push(row);
  };

  for (const { seq, ev } of records) {
    // 计时用的事件即使不占行也要先吃掉
    if (ev.type === 'llm.request') {
      llmReqTs = ev.ts;
      firstDeltaTs = undefined;
      continue;
    }
    if (ev.type === 'llm.delta') {
      if (firstDeltaTs === undefined) firstDeltaTs = ev.ts;
      continue;
    }
    if (SKIP.has(ev.type)) continue;

    if (ev.type === 'turn.start') {
      cur = {
        index: base + turns.length + (opts.openTurn ? 0 : 1),
        turnId: ev.turnId,
        userText: ev.userText,
        startTs: ev.ts,
        closed: false,
        rows: [],
        stats: { steps: 0, llmMs: 0, toolMs: 0, approvalMs: 0 },
      };
      turns.push(cur);
      const d = describe(ev);
      cur.rows.push({ seq, ts: ev.ts, kind: 'user', type: ev.type, ...d });
      continue;
    }

    if (ev.type === 'turn.end') {
      if (cur) {
        cur.endTs = ev.ts;
        cur.closed = true;
        cur.stats.wallMs = ev.ts - cur.startTs;
        cur = undefined;
      }
      continue;
    }

    const d = describe(ev);
    const row: TraceRow = {
      seq,
      ts: ev.ts,
      kind: KIND_OF[ev.type] ?? 'other',
      type: ev.type,
      label: d.label,
      summary: d.summary,
      detail: d.detail,
    };

    // 耗时配对
    if (ev.type === 'llm.response') {
      if (llmReqTs !== undefined) {
        row.ms = ev.ts - llmReqTs;
        if (cur) cur.stats.llmMs += row.ms;
        if (firstDeltaTs !== undefined && cur && cur.stats.ttftMs === undefined) {
          cur.stats.ttftMs = firstDeltaTs - llmReqTs;
        }
      }
      if (cur && ev.response.usage) cur.stats.usage = addUsage(cur.stats.usage, ev.response.usage);
      llmReqTs = undefined;
    } else if (ev.type === 'tool.call') {
      toolCallTs.set(ev.call.id, ev.ts);
      if (cur) cur.stats.steps++;
    } else if (ev.type === 'tool.result') {
      const started = toolCallTs.get(ev.result.toolCallId);
      if (started !== undefined) {
        row.ms = ev.ts - started;
        if (cur) cur.stats.toolMs += row.ms;
        toolCallTs.delete(ev.result.toolCallId);
      }
      row.ok = ev.result.ok;
    } else if (ev.type === 'approval.request') {
      approvalTs = ev.ts;
    } else if (ev.type === 'approval.decision') {
      if (approvalTs !== undefined) {
        row.ms = ev.ts - approvalTs;
        if (cur) cur.stats.approvalMs += row.ms;
        approvalTs = undefined;
      }
      row.ok = ev.approved;
    } else if (ev.type === 'context.usage' && cur) {
      cur.stats.ctxTokens = ev.tokens;
      cur.stats.ctxBudget = ev.budget;
    } else if (ev.type === 'web.request') {
      row.ok = ev.ok;
      row.ms = ev.ms;
    }

    if (cur) cur.rows.push(row);
    else pushBetween(row);
  }

  // 汇总
  let steps = 0;
  let llmMs = 0;
  let toolMs = 0;
  let approvalMs = 0;
  let usage: TokenUsage | undefined;
  let usageCalls = 0;
  let llmCalls = 0;
  const ttfts: number[] = [];
  for (const t of turns) {
    steps += t.stats.steps;
    llmMs += t.stats.llmMs;
    toolMs += t.stats.toolMs;
    approvalMs += t.stats.approvalMs;
    usage = addUsage(usage, t.stats.usage);
    if (t.stats.ttftMs !== undefined) ttfts.push(t.stats.ttftMs);
    for (const r of t.rows) {
      if (r.type !== 'llm.response') continue;
      llmCalls++;
      const u = (r.detail?.usage ?? undefined) as unknown;
      if (u && typeof u === 'object') usageCalls++;
    }
  }
  const first = records[0]?.ev.ts;
  const last = records.at(-1)?.ev.ts;
  const summary: TraceSummary = {
    turns: turns.length,
    steps,
    llmMs,
    toolMs,
    approvalMs,
    wallMs: first !== undefined && last !== undefined ? last - first : 0,
    usageCalls,
    llmCalls,
  };
  if (ttfts.length) summary.avgTtftMs = Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length);
  if (usage) {
    summary.usage = usage;
    if (llmMs > 0) summary.tokPerSec = Math.round((usage.completion / llmMs) * 1000 * 10) / 10;
  }
  return { turns, between, summary };
}
