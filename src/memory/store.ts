import { estimateText } from '../engine/tokens.ts';

/** L1 原子的类型：事实 / 偏好 / 约束 / 事件 */
export type AtomKind = 'fact' | 'preference' | 'constraint' | 'event';

/** L0：一条原始对话记录（存证/回溯） */
export interface L0Record {
  ts: number;
  role: string;
  text: string;
}

/** L1：从对话蒸馏出的、可精确召回的原子信息 */
export interface Atom {
  id: string;
  kind: AtomKind;
  text: string;
  ts: number;
  tokens: number;
  visibility: 'private' | 'shared';
}

export interface RetrieveBudget {
  maxItems: number;
  maxTokens: number;
}

export interface RetrievedItem {
  atom: Atom;
  score: number;
}

export interface RetrieveResult {
  items: RetrievedItem[];
  usedTokens: number;
  dropped: number;
  considered: number;
  /** 因为分叉而被屏蔽掉的原子数（本来能命中，但产生于被丢弃的那段时间里） */
  hiddenByFork: number;
}

/**
 * 分叉屏蔽窗口：`(from, to)` 这段时间里产生的「事实/事件」类原子不再注入。
 *
 * 为什么需要它：分叉的语义是「回到那一刻」，可对话历史回退了、长期记忆没回退，
 * 于是分叉点之后才知道的事又被记忆注入回来，分叉就白做了。
 * 但只按时间粗暴切会连「你说话的偏好」一起丢掉，所以只屏蔽 fact/event，
 * preference/constraint（你是个什么样的人、有什么规矩）永久生效。
 *
 * from = 分叉点那一刻，to = 执行分叉的那一刻。分叉之后新产生的原子 ts 大于 to，
 * 所以不受影响、照常生效。
 */
export interface HiddenRange {
  from: number;
  to: number;
}

/** 这类原子跟时间无关，分叉也不该丢 */
function isTimeless(kind: AtomKind): boolean {
  return kind === 'preference' || kind === 'constraint';
}

export function isHiddenByFork(atom: Atom, hidden: readonly HiddenRange[]): boolean {
  if (isTimeless(atom.kind)) return false;
  return hidden.some((r) => atom.ts > r.from && atom.ts < r.to);
}

/** 把查询拆成检索词：英文/数字整词 + 中文 2-gram（让中文也能部分匹配） */
function queryTerms(q: string): string[] {
  const out = new Set<string>();
  for (const w of q.toLowerCase().match(/[a-z0-9]+/g) ?? []) out.add(w);
  for (const run of q.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/**
 * MemoryStore：分层记忆的存储。
 * - L0：原始对话（appendL0）
 * - L1：蒸馏出的原子（upsertAtoms）
 * - retrieve：按查询词重合度打分（BM25 的极简版），并用「条数 + token」双重预算封顶。
 */
export class MemoryStore {
  private l0: L0Record[] = [];
  private atoms: Atom[] = [];

  appendL0(rec: L0Record): void {
    this.l0.push(rec);
  }

  upsertAtoms(atoms: Atom[]): void {
    for (const a of atoms) {
      // 文本完全相同的原子视为同一条，避免重复堆积
      if (!this.atoms.some((x) => x.text === a.text && x.kind === a.kind)) this.atoms.push(a);
    }
  }

  atomCount(): number {
    return this.atoms.length;
  }

  allAtoms(): readonly Atom[] {
    return this.atoms;
  }

  /** 导出为可持久化的普通对象 */
  toJSON(): { version: number; l0: L0Record[]; atoms: Atom[] } {
    return { version: 1, l0: this.l0, atoms: this.atoms };
  }

  /** 从持久化数据恢复 */
  loadJSON(data: unknown): void {
    const d = data as { l0?: L0Record[]; atoms?: Atom[] } | null;
    if (Array.isArray(d?.l0)) this.l0 = d.l0;
    if (Array.isArray(d?.atoms)) this.atoms = d.atoms;
  }

  retrieve(query: string, budget: RetrieveBudget, hidden: readonly HiddenRange[] = []): RetrieveResult {
    const terms = queryTerms(query);
    let hiddenByFork = 0;
    const scored = this.atoms
      .map((a) => {
        const lower = a.text.toLowerCase();
        const score = terms.filter((t) => lower.includes(t)).length;
        return { atom: a, score };
      })
      .filter((x) => x.score > 0)
      .filter((x) => {
        if (!isHiddenByFork(x.atom, hidden)) return true;
        hiddenByFork++;
        return false;
      })
      .sort((x, y) => y.score - x.score || y.atom.ts - x.atom.ts);

    const items: RetrievedItem[] = [];
    let usedTokens = 0;
    let dropped = 0;
    for (const s of scored) {
      if (items.length >= budget.maxItems || usedTokens + s.atom.tokens > budget.maxTokens) {
        dropped++;
        continue;
      }
      items.push(s);
      usedTokens += s.atom.tokens;
    }

    return { items, usedTokens, dropped, considered: scored.length, hiddenByFork };
  }
}

/** 造一个原子（自动估算 token） */
export function makeAtom(kind: AtomKind, text: string): Atom {
  return {
    id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    kind,
    text,
    ts: Date.now(),
    tokens: estimateText(text),
    visibility: 'shared',
  };
}
