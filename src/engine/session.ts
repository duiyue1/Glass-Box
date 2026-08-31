import type { Msg } from './types.ts';
import type { Wire } from './wire.ts';
import type { Loop } from './loop.ts';
import { ContextOverflowError } from './loop.ts';
import { Compactor } from './compact.ts';

/**
 * Session：跨多个回合的会话。它持有对话历史，并在历史过长时做「上下文压缩」。
 * - 单个回合的机制在 Loop 里；
 * - 跨回合的历史管理、压缩在这里。
 */
export class Session {
  private history: Msg[] = [];
  private readonly loop: Loop;
  private readonly budget: number;
  private readonly compactor: Compactor;

  constructor(
    loop: Loop,
    wire: Wire,
    budget: number,
    keepRecent = 2,
    opts: { planSnapshot?: () => string; retainRatio?: number; compactor?: Compactor } = {},
  ) {
    this.loop = loop;
    this.budget = budget;
    // 正常组装时 Loop 和 Session 共用同一个 Compactor（同一套保留规则）；
    // 不给就按旧参数自建一个，测试里直接 new Session 仍然能用
    this.compactor =
      opts.compactor ??
      new Compactor(wire, { keepRecent, retainRatio: opts.retainRatio, planSnapshot: opts.planSnapshot });
  }

  async ask(userText: string, signal?: AbortSignal): Promise<Msg[]> {
    await this.compactor.compact(this.history, this.budget);
    try {
      this.history = await this.loop.runTurn(userText, this.history, signal);
    } catch (e) {
      // 网关说超窗口了：主动阈值没拦住（估算偏低、或系统提示与工具声明本身就很大）。
      // 压掉一段再原样重试一次。压不动就没救了，照实抛出去。
      // 代价：如果溢出发生在回合中段，重试会把前面那几步工具重跑一遍。
      // 只重试一次，且比整个回合报废划算。
      if (!(e instanceof ContextOverflowError) || !(await this.forceCompact())) throw e;
      if (process.env.GB_LLM_QUIET !== '1') {
        console.error('[Glass-Box] 网关报上下文溢出，已压缩历史并重试一次');
      }
      this.history = await this.loop.runTurn(userText, this.history, signal);
    }
    return this.history;
  }

  /** 从会话日志重建出的历史恢复现场（--resume / 分叉时用） */
  restore(history: Msg[]): void {
    this.history = history;
  }

  /** 供观测/测试：当前有多少条历史消息 */
  size(): number {
    return this.history.length;
  }

  /** 不管预算够不够都压一次（溢出兜底用）。返回是否真的压了 */
  private forceCompact(): Promise<boolean> {
    return this.compactor.compact(this.history, 0);
  }
}
