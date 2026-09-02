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
  /**
   * 被哪条原子推翻了（存它的 id）。有值就不再注入，但**不删**。
   *
   * 为什么保留：agent 的记忆出错时，第一个要回答的问题是"它为什么以为是这样"。
   * 悄悄删掉旧结论，这个问题就永远查不出来了。可审计地遗忘 ≠ 遗忘。
   */
  supersededBy?: string;
  /** 被检索命中过几次。淘汰时用——从没被用过的记忆先走 */
  hits?: number;
  /** 最近一次被命中的时间。同样用于淘汰 */
  lastHitTs?: number;
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

/** 一次推翻的记录，交给上层发事件用 */
export interface Supersede {
  oldText: string;
  newText: string;
  kind: AtomKind;
  /** 'near-duplicate' = 近重复合并；'override' = 用户显式说了改用/不再 */
  why: 'near-duplicate' | 'override';
}

/** 一次淘汰的统计 */
export interface Prune {
  l0Dropped: number;
  atomsDropped: number;
}

export interface StoreLimits {
  /**
   * L0 最多留多少条。L0 是**存证**，不是检索源（retrieve 只看 L1），
   * 所以滚动丢弃最老的不影响召回，只影响能回溯多远。
   */
  maxL0: number;
  /** L1 原子最多留多少条（含已推翻的）。超了先丢已推翻的，再按"没人用过"淘汰 */
  maxAtoms: number;
}

export const DEFAULT_LIMITS: StoreLimits = { maxL0: 500, maxAtoms: 2000 };

/** 这类原子跟时间无关，分叉也不该丢 */
function isTimeless(kind: AtomKind): boolean {
  return kind === 'preference' || kind === 'constraint';
}

export function isHiddenByFork(atom: Atom, hidden: readonly HiddenRange[]): boolean {
  if (isTimeless(atom.kind)) return false;
  return hidden.some((r) => atom.ts > r.from && atom.ts < r.to);
}

/**
 * 把文本拆成检索词：英文/数字整词 + 中文 2-gram（让中文也能部分匹配）。
 *
 * 返回**数组而不是集合**：BM25 要词频，去重就把 tf 抹平了。
 */
export function terms(q: string): string[] {
  const out: string[] = [];
  for (const w of q.toLowerCase().match(/[a-z0-9]+/g) ?? []) out.push(w);
  for (const run of q.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 用户显式推翻旧结论的说法。命中这些词时，同主题的旧原子要让位 */
const OVERRIDE_MARKERS = /改用|改成|换成|不再|以后用|以后改|取消|废弃|不用了|别再/;

/** Jaccard 相似度。用于"这两条说的是不是同一件事" */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 近重复的判定阈值。
 *
 * 实测几组之后定的 0.7，同时也划出了这条规则的**真实能力边界**：
 *   - "我喜欢用中文回答问题" vs "…回答的问题"（多一个字）→ 0.73，会合并；
 *   - "用户偏好中文回答" vs "用户希望用中文回复"（换一种说法）→ **0.25，不会合并**；
 *   - "端口 8080" vs "端口 9090"（不同取值）→ 0.33，不会合并。
 *
 * 也就是说：2-gram 的 Jaccard 只认**改动很小的同一句话**，认不出改写。
 * 想合并改写得靠语义，而那要调模型——记忆子系统必须在零凭证下也能跑，所以不做。
 * 换句话说真正干活的是下面那条「显式推翻」，近重复只负责收掉复述。
 */
const NEAR_DUP = 0.7;

/**
 * MemoryStore：分层记忆的存储。
 * - L0：原始对话（appendL0），滚动保留
 * - L1：蒸馏出的原子（upsertAtoms），带推翻标记与淘汰
 * - retrieve：BM25 打分（tf + idf + 长度归一），并用「条数 + token」双重预算封顶
 */
export class MemoryStore {
  private l0: L0Record[] = [];
  private atoms: Atom[] = [];
  private readonly limits: StoreLimits;
  /** 上一次 upsert/append 产生的推翻与淘汰，供上层发事件 */
  private lastSupersedes: Supersede[] = [];
  private lastPrune: Prune = { l0Dropped: 0, atomsDropped: 0 };

  constructor(limits: Partial<StoreLimits> = {}) {
    // 逐字段 `??` 而不是对象展开：`{...DEFAULT, ...{maxL0: undefined}}` 会把默认值
    // 覆盖成 undefined，上限就静默失效了——正是"没配就当没上限"这类最难查的 bug
    this.limits = {
      maxL0: limits.maxL0 ?? DEFAULT_LIMITS.maxL0,
      maxAtoms: limits.maxAtoms ?? DEFAULT_LIMITS.maxAtoms,
    };
  }

  appendL0(rec: L0Record): void {
    this.l0.push(rec);
    // 滚动丢最老的。L0 只是存证，丢了不影响召回
    let dropped = 0;
    while (this.l0.length > this.limits.maxL0) {
      this.l0.shift();
      dropped++;
    }
    this.lastPrune = { ...this.lastPrune, l0Dropped: this.lastPrune.l0Dropped + dropped };
  }

  /** 还在生效的原子（没被推翻的） */
  private active(): Atom[] {
    return this.atoms.filter((a) => a.supersededBy === undefined);
  }

  /**
   * 写入新原子，并处理**矛盾消解**。
   *
   * 原先只有「文本完全相同」才算重复，于是：
   *   - "用户偏好中文回答" 和 "用户希望用中文回复" 会两条并存，一起占注入预算；
   *   - "项目用 npm" 和 "项目改用 pnpm" 也并存，而 retrieve 排序是词命中优先、
   *     时间次之，**旧那条完全可能排在前面**——agent 拿着废弃的约定干活。
   * 后者是正确性问题，不是浪费问题。
   *
   * 这里做两件事，都是规则判定、不调模型（记忆子系统要在零凭证下也能跑）：
   *   1. **近重复合并**：同 kind、词集 Jaccard ≥ 0.7 视为复述，新的推翻旧的；
   *   2. **显式推翻**：新原子里出现「改用/不再/换成…」这类词时，同 kind 且有共同词的
   *      旧原子一并让位——用户已经明说了要改，这时激进一点才是对的。
   *
   * 能力边界要说清楚：这**不是语义蕴含判断**。2-gram Jaccard 只认改动很小的同一句话，
   * 认不出改写（"偏好中文回答" vs "希望用中文回复" 只有 0.25）。
   * 所以真正干活的是第 2 条；"用 npm" 和 "用 pnpm" 如果用户没说"改用"，两条仍会并存。
   * 想做到那一步得上模型，而那会让记忆依赖凭证。
   */
  upsertAtoms(incoming: Atom[]): void {
    this.lastSupersedes = [];
    for (const a of incoming) {
      // 文本完全相同：直接当同一条，连时间都不更新（避免刷新排序）
      if (this.atoms.some((x) => x.text === a.text && x.kind === a.kind && x.supersededBy === undefined)) continue;

      const aTerms = terms(a.text);
      const explicitOverride = OVERRIDE_MARKERS.test(a.text);
      for (const old of this.active()) {
        if (old.kind !== a.kind) continue;
        const oldTerms = terms(old.text);
        const sim = jaccard(aTerms, oldTerms);
        const sharesTerm = oldTerms.some((t) => aTerms.includes(t));
        const why: Supersede['why'] | undefined =
          sim >= NEAR_DUP ? 'near-duplicate' : explicitOverride && sharesTerm ? 'override' : undefined;
        if (!why) continue;
        old.supersededBy = a.id;
        this.lastSupersedes.push({ oldText: old.text, newText: a.text, kind: a.kind, why });
      }
      this.atoms.push(a);
    }
    this.prune();
  }

  /**
   * 超过上限时淘汰。顺序是「最不可能被需要的先走」：
   *   1. 已被推翻的（留着只为可审计，不参与召回）
   *   2. 从没被命中过的，越老越先走
   *   3. 命中过的里面，最久没被命中的先走
   *
   * 为什么需要上限：原来是纯追加。几十条时无所谓，几千条时三头受损——
   * 落盘文件无限膨胀、每次检索线性扫全量、**噪音条目变多把好条目挤出注入预算**。
   */
  private prune(): void {
    const over = this.atoms.length - this.limits.maxAtoms;
    if (over <= 0) return;
    const rank = (a: Atom): number => {
      if (a.supersededBy !== undefined) return 0;
      if (!a.hits) return 1;
      return 2;
    };
    const doomed = [...this.atoms]
      .sort(
        (x, y) =>
          rank(x) - rank(y) ||
          (x.lastHitTs ?? 0) - (y.lastHitTs ?? 0) ||
          (x.hits ?? 0) - (y.hits ?? 0) ||
          x.ts - y.ts,
      )
      .slice(0, over);
    const kill = new Set(doomed.map((a) => a.id));
    this.atoms = this.atoms.filter((a) => !kill.has(a.id));
    this.lastPrune = { ...this.lastPrune, atomsDropped: this.lastPrune.atomsDropped + doomed.length };
  }

  /** 取走并清空上一批推翻记录（上层发完事件就不再需要） */
  takeSupersedes(): Supersede[] {
    const out = this.lastSupersedes;
    this.lastSupersedes = [];
    return out;
  }

  /** 取走并清空累计的淘汰统计 */
  takePrune(): Prune {
    const out = this.lastPrune;
    this.lastPrune = { l0Dropped: 0, atomsDropped: 0 };
    return out;
  }

  /** 还在生效的原子条数。被推翻的不算——用户问"记了多少"时想知道的是这个 */
  atomCount(): number {
    return this.active().length;
  }

  /** 含已推翻的总条数（落盘规模看这个） */
  totalCount(): number {
    return this.atoms.length;
  }

  l0Count(): number {
    return this.l0.length;
  }

  allAtoms(): readonly Atom[] {
    return this.atoms;
  }

  /** 导出为可持久化的普通对象 */
  toJSON(): { version: number; l0: L0Record[]; atoms: Atom[] } {
    return { version: 1, l0: this.l0, atoms: this.atoms };
  }

  /** 从持久化数据恢复。老文件没有 supersededBy/hits 字段，读进来就是 undefined，语义正好 */
  loadJSON(data: unknown): void {
    const d = data as { l0?: L0Record[]; atoms?: Atom[] } | null;
    if (Array.isArray(d?.l0)) this.l0 = d.l0;
    if (Array.isArray(d?.atoms)) this.atoms = d.atoms;
  }

  /**
   * BM25 打分检索。
   *
   * 原来的实现是 `terms.filter((t) => text.includes(t)).length`——数命中了几个词。
   * 注释自称"BM25 的极简版"，但缺了 BM25 的全部三个要点，代价是：
   *   - **没有 idf**：「项目」这种到处都有的词和专有名词等权，噪音条目容易挤掉真答案；
   *   - **没有 tf**：一条反复在讲 Gurobi 的记忆，和只提过一次的，分数一样；
   *   - **没有长度归一**：长条目天然装得下更多词，永远占优。
   * 这里补齐三项（k1/b 用通行默认值），并且改成在**同一套分词结果**上比对，
   * 顺带修掉英文用 `includes` 造成的子串误命中（`npm` 命中 `npmrc`）。
   */
  retrieve(query: string, budget: RetrieveBudget, hidden: readonly HiddenRange[] = []): RetrieveResult {
    const qTerms = [...new Set(terms(query))];
    /**
     * 参与召回的集合要**结合分叉窗口**来算，不能直接用 active()。
     *
     * 矛盾消解和分叉屏蔽会互相影响：如果"推翻者"本身产生在被丢弃的那段时间里，
     * 那么在当前这条时间线上**这次推翻根本没发生过**，被它盖掉的旧结论应该复活。
     * 否则分叉回到过去，却丢了那时明明还成立的事实——分叉就不干净了。
     * （这条是 journal.test.ts 里那个分叉用例抓出来的：它的夹具正好含"换成"。）
     *
     * 推翻者已经被淘汰掉（查不到）时保持屏蔽：那次推翻确实发生过，不该因为
     * 存储压力就把旧结论放回来。
     */
    const byId = new Map(this.atoms.map((a) => [a.id, a]));
    const pool = this.atoms.filter((a) => {
      if (a.supersededBy === undefined) return true;
      const killer = byId.get(a.supersededBy);
      return killer !== undefined && isHiddenByFork(killer, hidden);
    });
    if (qTerms.length === 0 || pool.length === 0) {
      return { items: [], usedTokens: 0, dropped: 0, considered: 0, hiddenByFork: 0 };
    }

    const docs = pool.map((atom) => {
      const tokens = terms(atom.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { atom, tf, len: tokens.length };
    });
    const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
    const N = docs.length;
    const k1 = 1.2;
    const b = 0.75;

    let hiddenByFork = 0;
    const scored = docs
      .map((d) => {
        let score = 0;
        for (const t of qTerms) {
          const f = d.tf.get(t) ?? 0;
          if (f === 0) continue;
          const df = docs.reduce((n, x) => n + (x.tf.has(t) ? 1 : 0), 0);
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
        }
        return { atom: d.atom, score };
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
      // 记命中：淘汰时要靠它区分"一直有用"和"从来没用过"。
      // 这让 retrieve 有了副作用，是刻意的取舍——否则淘汰只能按时间，
      // 会把老而常用的偏好丢掉，那是最不该丢的一类。
      s.atom.hits = (s.atom.hits ?? 0) + 1;
      s.atom.lastHitTs = Date.now();
    }

    return { items, usedTokens, dropped, considered: scored.length, hiddenByFork };
  }
}

/** 造一个原子（自动估算 token）。ts 可传，方便测试构造确定的时间顺序 */
export function makeAtom(kind: AtomKind, text: string, ts: number = Date.now()): Atom {
  return {
    id: `a_${ts}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text,
    ts,
    tokens: estimateText(text),
    visibility: 'shared',
  };
}
