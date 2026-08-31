import type { Msg, ToolSpec } from './types.ts';
import type { Wire } from './wire.ts';
import { estimateTokens } from './tokens.ts';
import { pruneToolResults, resolvePruneConfig, type PruneConfig } from './prune.ts';
import type { Summarizer } from './summarize.ts';

/** 把要被压缩掉的旧消息，浓缩成一句“早前发生了什么”的摘要（不花钱的兜底做法） */
function summarize(msgs: readonly Msg[]): string {
  const asks = msgs.filter((m) => m.role === 'user').map((m) => m.content);
  const text = asks.map((a, i) => `(${i + 1}) ${a}`).join('；');
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

export interface CompactorOptions {
  /**
   * 保留最近「上限的百分之多少」原样不动（不给就退回按条数保留 `keepRecent` 条）。
   *
   * 用比例而不是绝对 token，是因为可用空间是变的：跨回合那次压缩的上限就是总预算，
   * 而回合内压缩的上限是总预算减掉系统提示、工具声明、本回合注入。实测过按窗口算出的
   * 绝对保留量（1200）几乎等于对话的可用空间（1400），结果一次只丢一条、压完还更大。
   *
   * 默认 0.2 = `GB_RETAIN_RATIO / GB_COMPACT_RATIO`（0.16 / 0.8），
   * 所以在没有固定开销时算出来的保留量与"窗口 × 0.16"一致。
   */
  retainRatio?: number;
  /** 没有 `retainRatio` 时保留最近几条 */
  keepRecent?: number;
  /**
   * 压缩时顺手带上的一份任务计划快照（约 30 tok）。
   * 摘要只保留用户说过的话，工具干了什么全丢——实测下一回合模型会重新 glob 满仓库摸索
   * "干到哪儿了"。带上计划比让它重新摸索便宜得多。
   */
  planSnapshot?: () => string;
  /**
   * 削工具输出的字符阈值（压缩第一级）。给 `null` 关掉这一级。
   * 不给就用默认阈值。
   */
  pruneChars?: number | null;
  /**
   * 让模型写结构化摘要。不给就用机械拼接——那种摘要只把用户说过的话串起来，
   * 工具干了什么全丢，模型下一回合可能不知道自己已经读过某个文件。
   */
  summarizer?: Summarizer;
}

/**
 * Compactor：把一串消息压到给定上限以内。分两级，先便宜的：
 *
 * 1. **削工具输出**——不调模型、不丢消息，只把过大的工具结果掐掉中间。
 *    上下文里最肥的就是它，而且它最容易过期：模型要完整内容可以重新调一次工具。
 * 2. **压成摘要**——丢消息，只留最近一段。第一级不够才走这一级。
 *
 * 独立成一个对象是因为有两处要用同一套规则：
 * - `Session` 在回合之间压跨回合历史；
 * - `Loop` 在发请求之前压本回合的对话——那里才看得见「注入 + 系统提示 + 工具声明」
 *   占了多少，而这些恰恰是压不掉的固定开销。
 */
export class Compactor {
  private readonly wire: Wire;
  private readonly retainRatio?: number;
  private readonly keepRecent: number;
  private readonly planSnapshot?: () => string;
  private readonly pruneConfig?: PruneConfig;
  private readonly summarizer?: Summarizer;

  constructor(wire: Wire, opts: CompactorOptions = {}) {
    this.wire = wire;
    this.retainRatio = opts.retainRatio;
    this.keepRecent = Math.max(1, opts.keepRecent ?? 2);
    this.planSnapshot = opts.planSnapshot;
    this.pruneConfig = opts.pruneChars === null ? undefined : resolvePruneConfig(opts.pruneChars);
    this.summarizer = opts.summarizer;
  }

  /**
   * 把 `msgs` 压到 `limit` 以内（原地修改数组）。
   * @param msgs 要压的消息，可能被削减工具输出，也可能被替换成「一条摘要 + 保留区」
   * @param limit 压完之后允许占多少 token
   * @param tools 本回合的工具声明。原样传给摘要调用，好让它命中 provider 的前缀缓存
   * @returns 是否动过。上限本来就够、切点挪无可挪、或者摘要并不比原文小时返回 false
   */
  async compact(msgs: Msg[], limit: number, tools?: ToolSpec[]): Promise<boolean> {
    if (estimateTokens(msgs) <= limit) return false;

    // 第一级：削工具输出。不丢消息，所以只要有效就先做
    let changed = false;
    if (this.pruneConfig) {
      const { pruned, charsRemoved } = pruneToolResults(msgs, this.pruneConfig);
      if (pruned > 0) {
        this.wire.emit({ type: 'context.pruned', prunedMessages: pruned, charsRemoved, ts: Date.now() });
        changed = true;
        if (estimateTokens(msgs) <= limit) return true;
      }
    }

    // 第二级：把旧消息压成一条摘要
    const tokensBefore = estimateTokens(msgs);
    const cut = this.selectCut(msgs, limit);
    if (cut <= 0) return changed;

    const head = msgs.slice(0, cut);
    const byModel = this.summarizer ? await this.summarizer(head, tools) : undefined;
    const plan = this.planSnapshot?.() ?? '';
    const summary: Msg = {
      role: 'system',
      content: `（早前对话摘要）${byModel ?? summarize(head)}${plan ? `\n${plan}` : ''}`,
    };
    // 摘要不比它替换掉的内容小就别换。实测撞过 `1405 -> 1414`：只够丢一条消息时，
    // 摘要前缀加计划快照比原消息还贵，"压缩"反而把上下文顶大了。
    // 模型写的结构化摘要有八个小节，更容易撞这条线——那时就该维持原样
    if (estimateTokens([summary]) >= estimateTokens(head)) return changed;
    msgs.splice(0, cut, summary);

    this.wire.emit({
      type: 'context.compacted',
      droppedMessages: head.length,
      tokensBefore,
      tokensAfter: estimateTokens(msgs),
      byModel: byModel !== undefined,
      ts: Date.now(),
    });
    return true;
  }

  /**
   * 选切点：`[0, cut)` 压成摘要，`[cut, ...]` 原样留下。返回 0 表示压不动。
   *
   * 原生 tool calling 有个硬性配对要求：带 tool_calls 的 assistant 消息和它的 tool 结果
   * 必须同时在场。按位置硬切会切出一条"没有爹"的 tool 消息，网关直接 400
   * （真实模型实测报的是 No tool call found for function call output with call_id …），
   * 整个下一回合都废掉。
   *
   * 所以切点落在 tool 消息上时要挪，而且必须**往前**挪（扩大保留区，把那条 tool
   * 的 assistant 一起留下），不能往后挪：往后挪等于缩小保留区，保留区只剩一条
   * 大工具结果时会直接挪出界，压缩就整个失效了——真实场景里"一次 read_file 读回
   * 五百 token"太常见，这条路必须走得通。
   */
  private selectCut(msgs: readonly Msg[], limit: number): number {
    let cut: number;
    if (this.retainRatio === undefined) {
      cut = msgs.length - this.keepRecent;
    } else {
      const retainTokens = Math.max(1, Math.floor(limit * this.retainRatio));
      // 从尾巴往前累加，够 retainTokens 就停
      cut = msgs.length;
      let acc = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        acc += estimateTokens([msgs[i]]);
        cut = i;
        if (acc >= retainTokens) break;
      }
    }
    while (cut > 0 && msgs[cut].role === 'tool') cut--;
    return cut <= 0 ? 0 : cut;
  }
}
