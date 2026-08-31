import type { WireEvent } from '../engine/types.ts';

/**
 * 资料库 A/B 评测的纯计算部分：用例结构、指标提取、汇总。
 *
 * 和 run.ts 分开是因为 run.ts 一加载就会真的去问模型；
 * 指标算得对不对必须能单独测（traceView.ts / logView.ts 也是这个分法）。
 */

export interface EvalCase {
  id: string;
  dimension: string;
  /** 单轮提问。多轮用 turns，两者只能有一个 */
  question?: string;
  /** 多轮提问：按顺序问完，只对最后一轮的回答打分（测指代兜底） */
  turns?: string[];
  /** 答对了就必然出现的字面串（大小写不敏感） */
  expectKeywords?: string[];
  /** 资料里没有这条信息，正确行为是明说没有 */
  negative?: boolean;
  /** 参考答案，只给评分模型看 */
  reference?: string;
}

export interface CaseSet {
  name: string;
  note?: string;
  cases: EvalCase[];
}

/** 一条用例要问的话（单轮就是一句） */
export function turnsOf(c: EvalCase): string[] {
  if (c.turns?.length) return c.turns;
  if (c.question) return [c.question];
  throw new Error(`用例 ${c.id} 既没有 question 也没有 turns`);
}

/** 给评分模型看的问题描述：多轮时把前几轮也带上，否则「它的续租周期呢」无法评判 */
export function questionOf(c: EvalCase): string {
  const ts = turnsOf(c);
  return ts.length === 1 ? ts[0] : ts.map((t, i) => `第${i + 1}轮：${t}`).join('\n');
}

export type Arm = 'kb' | 'nokb';

export interface RunMetrics {
  answer: string;
  /** 命中的关键词数 / 关键词总数（负例没有关键词，两者都是 undefined） */
  hits?: number;
  total?: number;
  /** 负例：是否正确地说了「资料里没有」 */
  refused?: boolean;
  /** 回答里有没有标来源 */
  citedSource: boolean;
  injectedItems: number;
  injectedTokens: number;
  kbToolCalls: number;
  steps: number;
  ttftMs?: number;
  wallMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** 模型评分 0~2 */
  judgeScore?: number;
  judgeReason?: string;
  sessionId: string;
}

/** 「资料里没有」的说法有很多种，沾上一种就算正确拒答 */
const REFUSAL =
  /(没(有)?(提|写|说|标|记|找到|相关|涉及|包含|说明|明确)|未(提|写|说明|涉及|找到|包含|标明)|查不到|找不到|不在(本)?文档|资料(库)?(里|中)?(并)?(没有|未)|no (information|mention)|not (specified|mentioned|found|documented))/i;
/** 标了来源：《文档名》/「来源:」/ 章节号引用 */
const CITED = /(来源|出自|依据|《[^》]+》|见\s*\d+\.)/;

/**
 * 关键词命中。
 *
 * 两条规则都是实测踩出来的：
 * 1. 纯数字关键词按数字边界匹配，不能用子串——对照组答「常见配置是 100、128、160 之类」，
 *    子串匹配下 `160` 中、`10` 也被 `100` 中，一个明确答错的回答拿了满分。
 * 2. 带单位的关键词忽略空格——「5 秒」和「5秒」是同一个意思，中文与数字之间空不空格纯属排版。
 */
export function countHits(answer: string, keywords: string[]): number {
  const low = answer.toLowerCase();
  const flat = low.replace(/\s+/g, '');
  return keywords.filter((k) => {
    const key = k.toLowerCase().trim();
    if (!key) return false;
    if (/^\d+$/.test(key)) return new RegExp(`(?<!\\d)${key}(?!\\d)`).test(low);
    return flat.includes(key.replace(/\s+/g, ''));
  }).length;
}

export function looksRefused(answer: string): boolean {
  return REFUSAL.test(answer);
}

export function citesSource(answer: string): boolean {
  return CITED.test(answer);
}

/** 从一个回合的事件流里榨出指标 */
export function metricsOf(
  events: readonly WireEvent[],
): Omit<RunMetrics, 'answer' | 'citedSource' | 'sessionId'> {
  let injectedItems = 0;
  let injectedTokens = 0;
  let kbToolCalls = 0;
  let steps = 0;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let startTs: number | undefined;
  let endTs: number | undefined;
  let firstDeltaTs: number | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case 'turn.start':
        startTs ??= ev.ts;
        break;
      case 'turn.end':
        endTs = ev.ts;
        break;
      case 'llm.delta':
        firstDeltaTs ??= ev.ts;
        break;
      case 'kb.injected':
        injectedItems += ev.items.length;
        injectedTokens += ev.usedTokens;
        break;
      case 'tool.call':
        steps++;
        if (ev.call.name.startsWith('kb_')) kbToolCalls++;
        break;
      case 'llm.response': {
        const u = ev.response.usage;
        if (!u) break;
        promptTokens = (promptTokens ?? 0) + u.prompt;
        completionTokens = (completionTokens ?? 0) + u.completion;
        break;
      }
      default:
        break;
    }
  }

  return {
    injectedItems,
    injectedTokens,
    kbToolCalls,
    steps,
    ...(firstDeltaTs !== undefined && startTs !== undefined ? { ttftMs: firstDeltaTs - startTs } : {}),
    wallMs: startTs !== undefined && endTs !== undefined ? endTs - startTs : 0,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  };
}

export interface ArmSummary {
  arm: Arm;
  /** 正例的关键词命中率（命中数 / 关键词总数） */
  keywordRate: number;
  /** 正例里关键词全中的比例 */
  fullHitRate: number;
  /** 负例里正确拒答的比例 */
  refusalRate?: number;
  citedRate: number;
  judgeAvg?: number;
  /** 同一条用例多次重跑时，评分的最大波动（max-min 的平均）。小改动是否被噪音淹没看它 */
  judgeSpread?: number;
  avgInjectedTokens: number;
  avgPromptTokens?: number;
  avgCompletionTokens?: number;
  avgTtftMs?: number;
  avgWallMs: number;
  kbToolCalls: number;
  /** 一共统计了多少次运行（用例数 × repeat） */
  runCount: number;
}

function mean(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

function defined(xs: (number | undefined)[]): number[] {
  return xs.filter((n): n is number => typeof n === 'number');
}

/**
 * 汇总一个臂的所有运行。
 *
 * runs 的 value 是数组而不是单次结果：`--repeat N` 会把同一条用例跑 N 次，
 * 只看均值会把「这次对下次错」当成稳定表现，所以要保留每次结果并额外报评分波动。
 */
export function summarize(cases: EvalCase[], runs: Map<string, RunMetrics[]>, arm: Arm): ArmSummary {
  const pos = cases.filter((c) => !c.negative);
  const neg = cases.filter((c) => c.negative);
  const get = (c: EvalCase): RunMetrics[] => runs.get(`${c.id}:${arm}`) ?? [];

  let hits = 0;
  let total = 0;
  let full = 0;
  let posRuns = 0;
  for (const c of pos) {
    for (const r of get(c)) {
      if (!r.total) continue;
      posRuns++;
      hits += r.hits ?? 0;
      total += r.total;
      if ((r.hits ?? 0) === r.total) full++;
    }
  }
  const all = cases.flatMap(get);
  let negRuns = 0;
  let refusedOk = 0;
  for (const c of neg) {
    for (const r of get(c)) {
      negRuns++;
      if (r.refused) refusedOk++;
    }
  }

  // 评分波动：每条用例内部的 max-min，再对用例求平均
  const spreads: number[] = [];
  for (const c of cases) {
    const scores = defined(get(c).map((r) => r.judgeScore));
    if (scores.length > 1) spreads.push(Math.max(...scores) - Math.min(...scores));
  }

  const avgPrompt = mean(defined(all.map((r) => r.promptTokens)));
  const avgCompletion = mean(defined(all.map((r) => r.completionTokens)));
  const avgTtft = mean(defined(all.map((r) => r.ttftMs)));
  const judgeAvg = mean(defined(all.map((r) => r.judgeScore)));
  const judgeSpread = mean(spreads);

  return {
    arm,
    keywordRate: total ? hits / total : 0,
    fullHitRate: posRuns ? full / posRuns : 0,
    ...(negRuns ? { refusalRate: refusedOk / negRuns } : {}),
    citedRate: all.length ? all.filter((r) => r.citedSource).length / all.length : 0,
    ...(judgeAvg !== undefined ? { judgeAvg } : {}),
    ...(judgeSpread !== undefined ? { judgeSpread } : {}),
    avgInjectedTokens: mean(all.map((r) => r.injectedTokens)) ?? 0,
    ...(avgPrompt !== undefined ? { avgPromptTokens: avgPrompt } : {}),
    ...(avgCompletion !== undefined ? { avgCompletionTokens: avgCompletion } : {}),
    ...(avgTtft !== undefined ? { avgTtftMs: avgTtft } : {}),
    avgWallMs: mean(all.map((r) => r.wallMs)) ?? 0,
    kbToolCalls: all.reduce((n, r) => n + r.kbToolCalls, 0),
    runCount: all.length,
  };
}

/** 一条用例在某个臂上的结果摘要，给表格用：「2/2」「2/2~1/2」「拒答✓」「3/3 拒答」 */
export function cellOf(c: EvalCase, list: RunMetrics[]): string {
  if (!list.length) return '—';
  if (c.negative) {
    const ok = list.filter((r) => r.refused).length;
    return list.length === 1 ? (ok ? '拒答✓' : '编了✗') : `拒答 ${ok}/${list.length}`;
  }
  const uniq = [...new Set(list.map((r) => `${r.hits ?? 0}/${r.total ?? 0}`))];
  return uniq.join('~');
}

/** 多次运行的评分显示：单次「2分」，多次「1.7分(0~2)」 */
export function judgeCellOf(list: RunMetrics[]): string {
  const scores = defined(list.map((r) => r.judgeScore));
  if (!scores.length) return '';
  if (scores.length === 1) return `${scores[0]}分`;
  const avg = (mean(scores) ?? 0).toFixed(1);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  return lo === hi ? `${avg}分` : `${avg}分(${lo}~${hi})`;
}

/** 解析评分模型的输出：「2|要点齐全」 */
export function parseJudge(text: string): { score?: number; reason?: string } {
  const m = text.trim().match(/([0-2])\s*[|｜:：]?\s*(.*)/);
  if (!m) return { reason: `评分解析失败: ${text.trim().slice(0, 60)}` };
  return { score: Number(m[1]), reason: m[2]?.trim().slice(0, 120) };
}

export function pct(x: number | undefined): string {
  return x === undefined ? '—' : `${Math.round(x * 100)}%`;
}

export function num(x: number | undefined, digits = 0): string {
  return x === undefined ? '—' : x.toFixed(digits);
}
