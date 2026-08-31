import type { WireEvent } from './types.ts';

export type WireListener = (ev: WireEvent) => void;

/** 内存里保留多少条事件。落盘由 Journal 负责，内存只需够 Web UI 回放最近的进度。 */
const DEFAULT_KEEP = Math.max(50, Number(process.env.GB_WIRE_KEEP ?? 2000));

/**
 * Wire：引擎的“事件总线 + 黑匣子”。
 * - emit：把一件事广播给所有订阅者，同时记进 history（内存里的近期日志）
 * - subscribe：任何人（比如 TUI 面板、记忆插件、会话日志）都能来听事件
 * 这是玻璃盒的核心：引擎不藏事，所有内部动作都从这里流出来。
 *
 * 内存日志是环形的（有上限）：长会话 + 读图会让它无限膨胀。
 * 需要完整历史的场景请读 .glassbox/sessions/<id>.jsonl（Journal 负责追加）。
 */
export class Wire {
  private listeners = new Set<WireListener>();
  private log: WireEvent[] = [];
  private readonly keep: number;

  constructor(keep = DEFAULT_KEEP) {
    this.keep = Math.max(1, keep);
  }

  emit(ev: WireEvent): void {
    this.log.push(ev);
    if (this.log.length > this.keep) this.log.splice(0, this.log.length - this.keep);
    for (const listener of this.listeners) listener(ev);
  }

  subscribe(listener: WireListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 黑匣子回放：拿到内存里保留的近期事件（上限 keep 条） */
  history(): readonly WireEvent[] {
    return this.log;
  }
}
