import fs from 'node:fs';
import path from 'node:path';
import type { Wire } from '../engine/wire.ts';
import type { ContextProvider } from '../engine/types.ts';
import { MemoryStore, makeAtom, type Atom, type HiddenRange, type RetrieveBudget } from './store.ts';

/**
 * distill：把一句用户输入蒸馏成 L1 原子（规则版，零凭证）。
 * 真实系统会用 LLM 抽取；这里用简单模式识别偏好/事实/约束，兜底记成 event。
 */
function distill(userText: string): Atom[] {
  const atoms: Atom[] = [];
  const text = userText.trim();

  let m: RegExpMatchArray | null;
  if ((m = text.match(/(?:记住|请记住|注意)[:：]?\s*(.+)/))) atoms.push(makeAtom('fact', m[1].trim()));
  if ((m = text.match(/我(?:喜欢|偏好|倾向于?|想用|习惯用)\s*(.+)/))) atoms.push(makeAtom('preference', m[1].trim()));
  // 约束要连否定词一起留下：只取「不要」后面那半句，存进去会变成
  // 「用中文回答」——意思正好反了，模型照着做就错了。
  if ((m = text.match(/(?:不要|别|禁止|不准)\s*(.+)/))) atoms.push(makeAtom('constraint', m[0].trim()));

  if (atoms.length === 0) atoms.push(makeAtom('event', text));
  return atoms;
}

/**
 * Memory：记忆子系统。像 renderer 一样「挂在事件总线上」：
 * - 监听 turn.start：记住本回合用户输入
 * - 监听 turn.end：把它写入 L0 并蒸馏成 L1 原子（相当于“回合结束后异步蒸馏”）
 * 同时对外提供一个 ContextProvider：下一回合按查询预算封顶地检索并注入相关记忆。
 */
export class Memory {
  private readonly store = new MemoryStore();
  private readonly wire: Wire;
  private readonly budget: RetrieveBudget;
  private readonly persistPath?: string;
  private pendingUser = '';
  /** 分叉屏蔽窗口：这些时间段里产生的 fact/event 不再注入（preference/constraint 不受影响） */
  private hidden: HiddenRange[] = [];

  constructor(wire: Wire, budget: RetrieveBudget, persistPath?: string) {
    this.wire = wire;
    this.budget = budget;
    this.persistPath = persistPath;
    this.wire.subscribe((ev) => {
      if (ev.type === 'turn.start') this.pendingUser = ev.userText;
      else if (ev.type === 'turn.end') this.onTurnEnd();
    });
  }

  /** 从磁盘加载历史记忆（若配置了持久化路径），并广播加载结果。应在订阅事件后调用。 */
  init(): void {
    if (this.persistPath) {
      try {
        const raw = fs.readFileSync(this.persistPath, 'utf8');
        this.store.loadJSON(JSON.parse(raw));
      } catch {
        // 文件不存在或损坏：从空开始
      }
    }
    this.wire.emit({ type: 'memory.loaded', count: this.store.atomCount(), path: this.persistPath ?? '', ts: Date.now() });
  }

  /** 供测试/观测用 */
  atomCount(): number {
    return this.store.atomCount();
  }

  /**
   * 分叉时调用：屏蔽 (cutoffTs, forkedAtTs) 这段时间里产生的 fact/event。
   * 屏蔽窗口是可累加的（可以从不同点反复分叉），而且完全能从会话日志推导出来，
   * 所以 --resume 一个分叉出来的会话时能重新算出同样的窗口。
   */
  hideRange(cutoffTs: number, forkedAtTs: number): void {
    if (!(forkedAtTs > cutoffTs)) return;
    this.hidden.push({ from: cutoffTs, to: forkedAtTs });
  }

  hiddenRanges(): readonly HiddenRange[] {
    return this.hidden;
  }

  /** 开一个全新会话时调用：不再站在任何分叉线上，屏蔽窗口全部清掉 */
  clearHidden(): void {
    this.hidden = [];
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.store.toJSON(), null, 2));
    } catch {
      // 落盘失败不影响运行
    }
  }

  private onTurnEnd(): void {
    const text = this.pendingUser;
    this.pendingUser = '';
    if (!text) return;
    this.store.appendL0({ ts: Date.now(), role: 'user', text });
    const atoms = distill(text);
    this.store.upsertAtoms(atoms);
    this.save();
    this.wire.emit({
      type: 'memory.distilled',
      atoms: atoms.map((a) => ({ kind: a.kind, text: a.text })),
      total: this.store.atomCount(),
      ts: Date.now(),
    });
  }

  /** 作为 ContextProvider 接入 Loop：检索相关记忆并注入本回合 */
  provider(): ContextProvider {
    return {
      name: 'memory',
      provide: (userText) => {
        const res = this.store.retrieve(userText, this.budget, this.hidden);
        this.wire.emit({
          type: 'memory.injected',
          items: res.items.map((i) => ({ kind: i.atom.kind, text: i.atom.text, score: i.score })),
          usedTokens: res.usedTokens,
          budget: this.budget.maxTokens,
          dropped: res.dropped,
          hiddenByFork: res.hiddenByFork,
          ts: Date.now(),
        });
        if (res.items.length === 0) return [];
        const content =
          '【相关记忆】\n' + res.items.map((i) => `- (${i.atom.kind}) ${i.atom.text}`).join('\n');
        return [{ source: 'memory', content, tokensEst: res.usedTokens }];
      },
    };
  }
}
