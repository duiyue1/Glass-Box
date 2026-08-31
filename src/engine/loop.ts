import type {
  Msg,
  LlmResponse,
  TurnState,
  ToolResult,
  Approver,
  ApprovalDecision,
  ApprovalRequest,
  RiskAssessment,
  ToolCall,
  Tool,
  ToolSpec,
  ContextProvider,
} from './types.ts';
import { EMPTY_SCHEMA, toDecision } from './types.ts';
import type { Wire } from './wire.ts';
import type { ToolRegistry } from './toolRegistry.ts';
import { estimateTokens } from './tokens.ts';
import type { Compactor } from './compact.ts';
import { redactMsgs, redactResult } from './redact.ts';
import type { BlobStore } from './blobs.ts';
import type { TurnVerifier, VerifyOutcome } from '../verify/verifier.ts';

/** 流式输出的接收端：模型每产生一小段文本就回调一次 */
export type TokenSink = (text: string) => void;

/**
 * 网关拒绝请求，理由是上下文超过了模型窗口。
 * 单独成一类是因为它有救：把历史压掉一段就能原样重试，
 * 而不该像别的调用失败那样，把一句"（模型调用失败…）"当成模型的回答写进历史。
 */
export class ContextOverflowError extends Error {
  // 不用参数属性（`constructor(readonly x)`）：Node 的类型剥离模式不支持它，
  // 整个模块会连带报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
  readonly detail: string;

  constructor(detail: string) {
    super(`上下文超过模型窗口：${detail}`);
    this.name = 'ContextOverflowError';
    this.detail = detail;
  }
}

/**
 * 引擎对“模型”的唯一要求：给它一串消息（和可用工具的声明），它给回一个响应。
 * tools 是可选的：FakeLlm 不需要它，只认自己那套指令语法。
 */
export interface Llm {
  complete(
    messages: Msg[],
    onToken?: TokenSink,
    tools?: ToolSpec[],
    /** 用户按了停：模型实现应该把它接到自己的请求上，让连接立刻断开 */
    signal?: AbortSignal,
  ): Promise<LlmResponse>;
  /**
   * 这个模型的上下文窗口有多少 token。压缩阈值按它的百分比算，
   * 所以窗口是模型的属性、跟着模型实现走，不该由引擎猜。不给就用保守默认值。
   */
  readonly contextWindow?: number;
  /**
   * 这次请求里「除了对话消息之外」还要占多少 token：系统提示 + 工具声明。
   * 只有模型实现知道自己会往请求里拼什么，所以这笔账得它自己算。
   * 不实现就当 0（FakeLlm 不发系统提示）。
   */
  overhead?(tools?: ToolSpec[]): number;
}

export interface LoopOptions {
  /** 上下文提供者：Skills、记忆等，命中才为本回合注入内容 */
  providers?: ContextProvider[];
  /** 上下文预算（估算 token）：系统提示 + 工具声明 + 本回合注入 + 对话，加起来的上限 */
  budget?: number;
  /**
   * 压缩器。给了它，回合内每次发请求前都会把对话压到预算以内；
   * 不给就只观测不压（跨回合那次压缩仍由 Session 负责）。
   */
  compactor?: Compactor;
  /** 单个回合内最多执行多少次工具调用（防止模型在工具里打转） */
  maxSteps?: number;
  /** 图片仓库：事件流里只留 blob 引用，原图存这里，回放时可无损还原 */
  blobs?: BlobStore;
  /**
   * 自动验证：本回合动过文件、且模型准备收尾时，跑一次项目自己的检查。
   * 不给就完全不验证（对照组 GB_VERIFY=0 走的就是这条）。
   */
  verifier?: TurnVerifier;
  /** 验证失败最多喂回几次让它自修。超了就停手，不许无限烧钱 */
  maxVerifyRounds?: number;
  /**
   * 一次返回多个只读工具调用时同时跑。默认开（`GB_PARALLEL=0` 关，做对照组）。
   * 只对「全是 cacheable 且都不需要审批」的批次生效，见 runTurn 里的判定。
   */
  parallelReads?: boolean;
}

/** 验证失败时喂回给模型的内容。说清是机械检查的结果，并要求它直接改 */
const VERIFY_FEEDBACK = (out: VerifyOutcome): string =>
  [
    '【自动验证】本回合改过文件，跑了项目自己的检查，没有通过。',
    `命令：${out.cmd}（${out.ms}ms）`,
    '输出：',
    out.output,
    '',
    '请直接修掉这些问题。如果判断这些失败与本次改动无关，或者修不了，说明理由，不要重复解释已经做过的事。',
  ].join('\n');

/** 自修到上限还是红的：这句会接在模型最后那句话后面，别让"改好了"看起来像真的 */
const VERIFY_CAP = (cmd: string, max: number): string =>
  `【自动验证】仍未通过（${cmd}），已达自修上限 ${max} 次，停止重试。`;

/** 剩几步开始提醒"优先落盘" */
const LOW_STEPS_WARN = 2;

/** 步数用尽且模型仍在要工具时的兜底答复 */
const STOP_TEXT = (max: number) =>
  `（本回合已达工具步数上限 ${max}，为避免无限循环已停止。可以把任务拆小一点再问我，或用 GB_MAX_STEPS 调大上限。）`;

/**
 * 被用户掐掉时写进历史的那句话。
 * 必须留下痕迹：下一回合的模型要知道上面那串动作是**没做完**被打断的，
 * 否则它会以为一切照计划完成了，接着往下走。
 */
const ABORT_TEXT = '（已按用户要求中断，上面的步骤没有做完。）';

/**
 * Loop：一个回合（turn）的状态机，也是整个 coding agent 的心脏。
 *
 * 一个回合：
 *   [注入按需上下文] -> thinking（问模型）
 *     -> 模型要调工具? -> [按需审批] -> tool_call -> tool_result -> 回到 thinking
 *     -> 模型给文本?   -> done
 *
 * 注意：注入的上下文（skills/记忆）是「本回合临时的」，不会写进持久对话历史。
 */
export class Loop {
  private state: TurnState = 'idle';
  private readonly wire: Wire;
  private readonly tools: ToolRegistry;
  private readonly llm: Llm;
  private readonly approver: Approver;
  private readonly providers: ContextProvider[];
  private readonly budget: number;
  private readonly maxSteps: number;
  private readonly blobs?: BlobStore;
  private readonly verifier?: TurnVerifier;
  private readonly maxVerifyRounds: number;
  private readonly compactor?: Compactor;
  private readonly parallelReads: boolean;

  constructor(wire: Wire, tools: ToolRegistry, llm: Llm, approver: Approver, opts: LoopOptions = {}) {
    this.wire = wire;
    this.tools = tools;
    this.llm = llm;
    this.approver = approver;
    this.providers = opts.providers ?? [];
    this.budget = opts.budget ?? 400;
    // 默认 20：12 对"改几个文件 + 补测试 + 写文档"这类任务偏小，实测被它卡过
    this.maxSteps = Math.max(1, opts.maxSteps ?? Number(process.env.GB_MAX_STEPS ?? 20));
    this.blobs = opts.blobs;
    this.verifier = opts.verifier;
    this.maxVerifyRounds = Math.max(0, opts.maxVerifyRounds ?? Number(process.env.GB_VERIFY_RETRY ?? 2));
    this.compactor = opts.compactor;
    this.parallelReads = opts.parallelReads ?? process.env.GB_PARALLEL !== '0';
  }

  private setState(turnId: string, to: TurnState): void {
    const from = this.state;
    this.state = to;
    this.wire.emit({ type: 'state.change', turnId, from, to, ts: Date.now() });
  }

  /**
   * 跑一个回合。history 是持久对话；返回值也是持久对话（不含本回合注入的临时上下文）。
   *
   * @param signal 用户中断。给了它，回合会在每一步的间隙检查一次；
   * 掐掉之后仍然正常收尾（turn.end），历史保持合法可续聊。
   */
  async runTurn(userText: string, history: Msg[] = [], signal?: AbortSignal): Promise<Msg[]> {
    const turnId = `t_${Date.now()}`;
    this.wire.emit({ type: 'turn.start', turnId, userText, ts: Date.now() });

    // 1) 按需收集上下文（skills / 记忆）——只影响本回合，不进 convo
    const contributions = [];
    for (const p of this.providers) {
      const got = await p.provide(userText);
      contributions.push(...got);
    }
    const injected: Msg[] = contributions.map((c) => ({ role: 'system', content: c.content }));
    this.wire.emit({
      type: 'context.injected',
      turnId,
      contributions: contributions.map((c) => ({ source: c.source, tokensEst: c.tokensEst })),
      ts: Date.now(),
    });

    // convo = 会持久化的对话部分
    const convo: Msg[] = [...history, { role: 'user', content: userText }];

    // 压不掉的那部分：系统提示 + 工具声明 + 本回合注入。
    // 三样都在这个回合里固定不变，所以只算一次。
    // 预算过去只秤了对话历史，实测因此漏掉一大半——注入的资料库/知识目录/记忆
    // 加系统提示能有两千多 token，而历史只剩几十。
    const specs = this.toolSpecs();
    const fixedTokens = estimateTokens(injected) + (this.llm.overhead?.(specs) ?? 0);
    // 固定开销本身就超预算时，把对话压成零也不够。说出来，否则面板上只看到
    // 一个超标的数字、压缩却一次都不发生，会以为压缩坏了
    if (fixedTokens >= this.budget && process.env.GB_LLM_QUIET !== '1') {
      console.error(
        `[Glass-Box] 系统提示+工具声明+注入已占 ${fixedTokens} tok，超过预算 ${this.budget}；` +
          '压缩对话解决不了，请调大窗口或收紧注入预算（GB_KB_TOKENS / GB_WIKI_TOKENS）',
      );
    }

    let steps = 0;
    // free 工具用掉的步数单独记：不占 maxSteps，但也不能无限（上限 maxSteps*2 兜死循环）
    let freeSteps = 0;
    // 本回合只读检索的结果缓存：sig -> 内容；以及"这段内容第一次是哪个 sig 产出的"
    const cache = new Map<string, string>();
    const seenResults = new Map<string, string>();
    // 只提醒一次"快到上限了"
    let lowWarned = false;
    // 步数用尽后再给模型一次机会收尾（这一次它若还要调工具，就硬停）
    let warned = false;
    // 上一次失败的调用签名：连续原封不动地重试同一个失败调用是没有意义的
    let lastFailedSig: string | null = null;
    // 本回合成功调用过的工具（verifier 据此判断"动过文件没有"）
    const usedTools: string[] = [];
    // 验证失败已经喂回几次
    let verifyRounds = 0;

    for (;;) {
      // 中断只在「步与步之间」生效。在这里检查是安全的：assistant/tool 一定是成对进过历史的
      if (signal?.aborted) return this.abortTurn(turnId, convo, steps);
      this.setState(turnId, 'thinking');
      // 只有对话能压，所以留给它的上限是预算减掉压不掉的那部分。
      // 放在每次发请求之前：工具结果是回合内长出来的，回合开始时压一次不够。
      // specs 一起递进去：摘要要调模型，带上同样的工具声明才能命中前缀缓存
      await this.compactor?.compact(convo, this.budget - fixedTokens, specs);
      const messages = [...injected, ...convo];
      const estimated = fixedTokens + estimateTokens(convo);
      this.wire.emit({
        type: 'context.usage',
        turnId,
        tokens: estimated,
        budget: this.budget,
        messages: messages.length,
        ts: Date.now(),
      });
      this.wire.emit({ type: 'llm.request', turnId, messages: redactMsgs(messages, this.blobs), ts: Date.now() });
      let resp: LlmResponse;
      try {
        resp = await this.llm.complete(
          messages,
          (text) => {
            this.wire.emit({ type: 'llm.delta', turnId, text, ts: Date.now() });
          },
          specs,
          signal,
        );
      } catch (e) {
        // 中断会让底层 fetch 抛 AbortError。那不是故障，是用户按了停
        if (signal?.aborted) return this.abortTurn(turnId, convo, steps);
        throw e;
      }
      this.wire.emit({ type: 'llm.response', turnId, response: resp, ts: Date.now() });
      // 拿网关报回来的真实用量给自己的估算对账。零依赖用不了真分词器，
      // 这个偏差率就是唯一能知道"估得准不准"的途径，顺便当机械指标使
      if (resp.usage?.prompt) {
        this.wire.emit({
          type: 'token.estimate',
          turnId,
          estimated,
          actual: resp.usage.prompt,
          drift: (estimated - resp.usage.prompt) / resp.usage.prompt,
          cached: resp.usage.cached,
          ts: Date.now(),
        });
      }
      // 溢出交给会话层：它才有权决定压掉哪一段历史。这里先让事件流留下记录再抛
      if (resp.overflow) throw new ContextOverflowError(resp.text ?? '网关未给出细节');

      const calls = resp.toolCalls ?? [];
      if (calls.length > 0) {
        // free 工具（task_plan 这类纯记账）不占步数：maxSteps 是为了拦"在真实操作里打转"，
        // 记账挤掉写文件是本末倒置。但 free 也不能无限——单独给它一个宽松上限兜住死循环。
        const isFree = (name: string) => Boolean(this.tools.get(name)?.free);
        const allFree = calls.every((c) => isFree(c.name));
        const freeExhausted = freeSteps >= this.maxSteps * 2;
        // 已经提醒过一次还要继续调工具 -> 不再等它自觉，直接收尾
        if (warned && !(allFree && !freeExhausted)) {
          convo.push({ role: 'assistant', content: STOP_TEXT(this.maxSteps) });
          return this.finish(turnId, convo);
        }
        if (steps >= this.maxSteps && !(allFree && !freeExhausted)) {
          warned = true;
          this.wire.emit({ type: 'turn.limit', turnId, steps, maxSteps: this.maxSteps, ts: Date.now() });
          // 把"步数用尽"当成工具结果喂回去：模型看到的是熟悉的失败反馈，而不是凭空断线
          for (const call of calls) {
            const result: ToolResult = {
              toolCallId: call.id,
              ok: false,
              content: `未执行 ${call.name}：本回合工具步数已用尽（上限 ${this.maxSteps}）。请基于已有信息直接给出最终答复。`,
            };
            this.wire.emit({ type: 'tool.result', turnId, result, ts: Date.now() });
            convo.push({ role: 'assistant', content: `[调用工具 ${call.name}]`, toolCalls: [call] });
            convo.push({ role: 'tool', content: result.content, toolCallId: call.id });
          }
          continue;
        }

        const sigs = calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`);
        // 缓存命中的先挑出来：它们不真跑、不占步数，两条执行路径都要用这个判断
        const reused = calls.map((c, i) =>
          this.tools.get(c.name)?.cacheable ? cache.get(sigs[i]) : undefined,
        );

        /**
         * 这一批能不能同时跑。
         *
         * 模型一次要五个 grep/read 是常态，而它们过去只能排队——一批只读检索的墙上时间
         * 等于每个的时间相加，纯属白等。三个条件一起保证「同时跑」不引入任何新语义：
         * - **全是 cacheable**：这个标记的定义就是「只读且可缓存」，跑的顺序不影响结果；
         * - **一个都不需要审批**：否则几个弹窗同时冒出来，人不知道自己在批哪一个；
         * - **没有刚失败过的重试**：那条要走「挡回去」的分支，不该真跑。
         */
        const parallel =
          this.parallelReads &&
          calls.length > 1 &&
          calls.every((c, i) => {
            const t = this.tools.get(c.name);
            if (!t?.cacheable) return false;
            const level = t.assess?.(c.args)?.level;
            return (!level || level === 'safe') && sigs[i] !== lastFailedSig;
          });

        /** 拿到一个 call 的结果：缓存命中直接复用，刚失败过的挡回去，否则真执行 */
        const settle = (call: ToolCall, i: number): Promise<ToolResult> => {
          if (signal?.aborted) {
            // 中断了但这一批已经开了头：剩下的也要各自给一条结果，
            // 否则 assistant 的 tool_calls 配不上 tool 消息，历史就废了
            return Promise.resolve({
              toolCallId: call.id,
              ok: false,
              content: `未执行 ${call.name}：用户中断了本回合。`,
            });
          }
          if (reused[i] !== undefined) {
            // 同名同参又来一次（实测很常见：同一个目录换三种 glob 写法轮着发）。
            // 直说"复用了"，比默默返回同样内容更有可能让它停下来去干正事。
            return Promise.resolve({
              toolCallId: call.id,
              ok: true,
              content: `${reused[i]}\n（本回合已经用同样参数调过 ${call.name}，直接复用上次结果，未重复执行）`,
            });
          }
          if (sigs[i] === lastFailedSig) {
            // 完全相同的调用刚刚才失败过：直接挡回去，别再花一次真实执行/审批
            return Promise.resolve({
              toolCallId: call.id,
              ok: false,
              content: `未执行 ${call.name}：完全相同的参数上一步刚失败过，重试不会有不同结果。请修正参数或换一种方法（例如先用 glob 确认文件是否存在）。`,
            });
          }
          return this.executeWithApproval(turnId, call, this.tools.get(call.name));
        };

        /** 记一次步数（缓存命中、以及中断后被挡下的都不算：它们没有真的做任何事） */
        const charge = (call: ToolCall, i: number): void => {
          if (reused[i] !== undefined || signal?.aborted) return;
          if (isFree(call.name)) freeSteps++;
          else steps++;
        };

        /** 结果入账：缓存写入、去重提示、事件、进对话 */
        const absorb = (call: ToolCall, i: number, out: ToolResult): void => {
          const tool = this.tools.get(call.name);
          const sig = sigs[i];
          let result = out;
          lastFailedSig = result.ok ? null : sig;
          if (result.ok) usedTools.push(call.name);

          if (reused[i] === undefined && result.ok) {
            if (tool?.cacheable && !result.images?.length) {
              cache.set(sig, result.content);
              // 换个写法但结果一模一样：也直说，省下它下一轮再换一种写法
              const same = seenResults.get(result.content);
              if (same && same !== sig) {
                result = {
                  ...result,
                  content: `${result.content}\n（这次的结果和本回合早前那次 ${same.split(':')[0]} 完全一样——换检索写法不会有新信息了）`,
                };
              } else if (!same) {
                seenResults.set(result.content, sig);
              }
            } else if (!tool?.cacheable && !tool?.free) {
              // 写文件/执行命令之后，之前检索到的东西可能已经过期，缓存整体作废。
              // free 工具（task_plan 记账、read_output 轮询日志）不碰工作区，
              // 让它们清掉检索缓存是误伤：记一次计划就要把读过的文件全部重读一遍。
              cache.clear();
              seenResults.clear();
            }
          }

          this.setState(turnId, 'tool_result');
          this.wire.emit({ type: 'tool.result', turnId, result: redactResult(result, this.blobs), ts: Date.now() });

          convo.push({ role: 'assistant', content: `[调用工具 ${call.name}]`, toolCalls: [call] });
          convo.push({ role: 'tool', content: result.content, toolCallId: call.id, images: result.images });
        };

        if (parallel) {
          // 步数账和 tool.call 事件按 calls 的原顺序先记好：谁先跑完是不确定的，
          // 但事件流和账必须稳定可回放。tool.result 同样按原顺序入账。
          this.setState(turnId, 'tool_call');
          for (const [i, call] of calls.entries()) {
            charge(call, i);
            this.wire.emit({ type: 'tool.call', turnId, call, parallel: calls.length, ts: Date.now() });
          }
          const results = await Promise.all(calls.map((call, i) => settle(call, i)));
          for (const [i, call] of calls.entries()) absorb(call, i, results[i]);
        } else {
          for (const [i, call] of calls.entries()) {
            charge(call, i);
            this.setState(turnId, 'tool_call');
            this.wire.emit({ type: 'tool.call', turnId, call, ts: Date.now() });
            absorb(call, i, await settle(call, i));
          }
        }
        // 快到上限时提醒一次：实测过"12 步用完，最后两个 write_file 被丢掉"，
        // 而那两步才是真正要交付的东西。提醒放在工具结果后面，模型下一轮就能看到。
        const left = this.maxSteps - steps;
        if (left > 0 && left <= LOW_STEPS_WARN && !lowWarned) {
          lowWarned = true;
          convo.push({
            role: 'system',
            content: `【步数提醒】本回合还剩 ${left} 次工具调用。如果还有改动没落盘，先写文件，别再检索了。`,
          });
        }
        continue;
      }

      const answer: Msg = { role: 'assistant', content: resp.text ?? '' };
      convo.push(answer);

      // 模型认为完事了。如果本回合动过文件，这里跑一次项目自己的检查——
      // "改好了"这句话必须有机械证据。失败就把错误喂回去让它继续修（走的还是同一个循环）。
      // 被中断时不跑：人已经喊停了，再花两分钟跑测试是帮倒忙。
      if (!signal?.aborted && this.verifier?.needed(usedTools)) {
        const out = await this.verifier.run(turnId);
        if (out && !out.ok && verifyRounds < this.maxVerifyRounds) {
          verifyRounds++;
          // 用 system 而不是伪造一条 user 消息：这是环境反馈，不是用户说的话
          convo.push({ role: 'system', content: VERIFY_FEEDBACK(out) });
          continue;
        }
        // 已经到自修上限还是没过：把"仍未通过"接在模型这句话后面，而不是再 push
        // 一条 system。CLI 和面板都拿 messages.at(-1) 当最终回复，多押一条系统消息
        // 会把模型的回答顶掉（真实模型跑出来过：用户只看到这句系统提示）。
        if (out && !out.ok) {
          answer.content = `${answer.content}\n\n${VERIFY_CAP(out.cmd, this.maxVerifyRounds)}`.trim();
        }
      }
      return this.finish(turnId, convo);
    }
  }

  /** 把注册表里的工具翻译成发给模型的声明。缺 Schema 的按无参数处理。 */
  private toolSpecs(): ToolSpec[] {
    return this.tools.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? EMPTY_SCHEMA,
    }));
  }

  /** 回合收尾：done -> turn.end -> idle */
  private finish(turnId: string, convo: Msg[]): Msg[] {
    this.setState(turnId, 'done');
    this.wire.emit({ type: 'turn.end', turnId, messages: redactMsgs(convo, this.blobs), ts: Date.now() });
    this.setState(turnId, 'idle');
    return convo;
  }

  /**
   * 被掐掉：留一句"没做完"，发事件，然后走正常收尾。
   * 不抛异常——中断是用户的正常操作，不该让调用方去 catch，也不该让历史停在半截。
   */
  private abortTurn(turnId: string, convo: Msg[], steps: number): Msg[] {
    convo.push({ role: 'assistant', content: ABORT_TEXT });
    this.wire.emit({ type: 'turn.aborted', turnId, steps, ts: Date.now() });
    return this.finish(turnId, convo);
  }

  private async executeWithApproval(turnId: string, call: ToolCall, tool: Tool | undefined): Promise<ToolResult> {
    if (!tool) {
      return { toolCallId: call.id, ok: false, content: `未知工具: ${call.name}` };
    }

    // 缺省是 confirm，**不是** safe。
    // 以前 assess 选填、不填就静默放行——那是"默认开门"：加一个新工具忘了写风险评估，
    // 它就悄悄拿到了免审批执行的权力（read_output 上一轮就这么漏过一次）。
    const assessment: RiskAssessment = tool.assess?.(call.args) ?? {
      level: 'confirm',
      summary: `调用 ${call.name}(${clip(JSON.stringify(call.args))})`,
      reason: '这个工具没声明风险等级，按"需确认"处理',
    };
    if (assessment.level !== 'safe') {
      const request: ApprovalRequest = { toolName: call.name, args: call.args, ...assessment };
      this.wire.emit({ type: 'approval.request', turnId, request, ts: Date.now() });
      // deny 是硬边界：不问人，也不受 GB_APPROVE=all 之类放行策略影响。留痕之后直接回绝
      const decision: ApprovalDecision =
        assessment.level === 'deny' ? 'deny' : toDecision(await this.approver.decide(request));
      const approved = decision !== 'deny';
      this.wire.emit({ type: 'approval.decision', turnId, request, approved, decision, ts: Date.now() });
      if (!approved) {
        const why = assessment.reason ? `${assessment.summary}；${assessment.reason}` : assessment.summary;
        return { toolCallId: call.id, ok: false, content: `操作被拒绝：${call.name}（${why}）` };
      }
    }

    const out = await tool.run(call.args);
    return { toolCallId: call.id, ...out };
  }
}

/** 缺省审批摘要里的参数别铺满整屏（write_file 的 content 能有几千字） */
function clip(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
