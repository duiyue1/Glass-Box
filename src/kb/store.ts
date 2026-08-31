import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateText } from '../engine/tokens.ts';
import { chunkMarkdown, type ChunkType } from './chunker.ts';
import { STATUS_LABEL, type ChunkContext, type ChunkStatus } from './context.ts';
import { digestText, type Digest } from './distill.ts';

/**
 * KbStore：资料库的存储与检索。
 *
 * 落盘结构（默认在 <workspace>/.glassbox/kb/）：
 *   raw/<docId>.md   导入的原文，原样保存，方便回溯与将来重新切块
 *   index.json       文档清单 + 分块索引（检索用）
 *
 * 检索用真 BM25（含 IDF 与文档长度归一），不是「数一下有几个词对得上」。
 * 词频统计不落盘：加载时从 text 现算，省得 index.json 膨胀好几倍。
 */

export interface KbDocMeta {
  id: string;
  title: string;
  /** 来源：文件名或 'paste' */
  source: string;
  ts: number;
  /** 同标题重复导入会递增，旧分块被整体替换而不是堆积 */
  version: number;
  chars: number;
  chunks: number;
  status: 'active' | 'archived';
}

/** 一个历史版本 */
export interface KbVersion {
  version: number;
  /** 只有当前版本有准确时间；历史版本用文件 mtime */
  ts: number;
  chars: number;
  /** 当前生效的那一版 */
  current: boolean;
}

/** 疑似重复：导入前拿新内容和已有文档比 */
export interface KbDuplicate {
  id: string;
  title: string;
  /** 0~1，词集合的 Jaccard 相似度 */
  similarity: number;
  /** 内容完全一致（哈希相同） */
  identical: boolean;
}

export interface KbChunk {
  /** md5(docId::index::version)，确定性生成 */
  id: string;
  docId: string;
  title: string;
  index: number;
  headingPath: string;
  type: ChunkType;
  text: string;
  tokens: number;
  /**
   * 块级上下文：一句话「这段在讲什么」。离线由模型补（`contextualizeDoc`），
   * 进 BM25 语料也进注入文本。没补过就是 undefined。
   */
  context?: string;
  /** 这段是现行约定还是被否决的方案。注入时会标出来，让模型别把废弃结论当答案 */
  status?: ChunkStatus;
}

export interface KbBudget {
  maxItems: number;
  maxTokens: number;
  /**
   * 同一篇文档最多贡献几块。
   * 不限制的话，一篇长文档能把预算全占掉，别的资料一段都进不来。
   * （AI-Ku 的 doc_store 也是按 doc_id 去重后每篇留 top-3）
   */
  perDoc?: number;
  /**
   * 相对分数阈值：低于最高分 × 这个比例的命中直接丢。
   * BM25 只要有一个词对上就 score > 0，问「今天几号」也会命中几段无关资料，
   * 白占预算还干扰模型。
   */
  minScoreRatio?: number;
  /** 命中块的上一块（同文档、同章节）是否一并带上，补足被切断的上文 */
  withNeighbor?: boolean;
  /**
   * digest（摘要 + 别名）命中时，给同一篇文档的正文块加多少分（乘以 digest 自己的得分）。
   * 0 = 关掉这条桥，等价于没有蒸馏层——A/B 时用它当对照组。
   */
  digestBoost?: number;
}

/** 检索时的范围限制：模型可以说「只在这篇/这一章里找」 */
export interface KbFilter {
  /** 文档 id 或标题（走 find() 的宽松匹配） */
  doc?: string;
  /** 章节标题的一部分 */
  section?: string;
}

export interface KbHit {
  chunk: KbChunk;
  score: number;
  /** true = 它不是自己命中的，是作为上文被带进来的 */
  neighbor?: boolean;
  /** 这一分里有多少来自同文档 digest 的提分（0 表示纯字面命中） */
  digestBoost?: number;
}

export interface KbSearchResult {
  items: KbHit[];
  usedTokens: number;
  dropped: number;
  considered: number;
  /** 因为「同一篇最多几块」被挡掉的数量，和预算不足要分开看 */
  cappedByDoc?: number;
  /** 因为分数太低被挡掉的数量 */
  belowThreshold?: number;
  /** 有几篇文档是靠 digest 别名被捞出来的（字面没命中） */
  digestBridged?: number;
}

/** BM25 参数，取常规经验值 */
const K1 = 1.5;
const B = 0.75;

/**
 * 分词：英文/数字整词 + 中文 2-gram。
 * 和记忆检索用的是同一套口径（中文不做分词，靠 2-gram 覆盖）。
 * 返回值保留重复，因为 BM25 需要词频。
 */
export function terms(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) out.push(w);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 标题 -> 文件名安全的 docId。去掉一切路径字符，中文保留以便文件名可读。 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'doc-' + crypto.createHash('md5').update(title).digest('hex').slice(0, 8);
}

/** 两块是否属于同一章节（其中一个是另一个的标题路径前缀也算） */
function sameSection(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + ' > ') || b.startsWith(a + ' > ');
}

/** 从内容里猜标题：第一个 H1，否则第一行非空文本 */
function inferTitle(text: string, source?: string): string {
  const h1 = text.match(/^\s*#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 80);
  const first = text.split(/\r?\n/).find((l) => l.trim());
  if (first) return first.trim().slice(0, 80);
  return source ?? '未命名';
}

interface Persisted {
  version: number;
  docs: KbDocMeta[];
  chunks: KbChunk[];
}

interface ChunkStats {
  tf: Map<string, number>;
  len: number;
}

export class KbStore {
  private readonly dir: string;
  private readonly rawDir: string;
  private readonly histDir: string;
  private readonly indexFile: string;
  /**
   * 块级上下文是否生效。false 时**两头都关**：不进 BM25 语料，检索出来的块也剥掉
   * context/status。对照组必须等价于"从来没有这个功能"，只关一头比出来的数字说不清。
   */
  private readonly useContext: boolean;
  /**
   * 那句上下文要不要进 BM25 语料。**默认不进**，这是实测定下来的：
   * 在 2 篇 11 块的库上，进语料对关键词召回是 **0 收益**（默认预算 100%→100%，
   * 紧预算 58%→58%，连没召回的用例都是同一批），但它会**改变排序**——
   * 那 10 来个字进了词表，`len` 归一化跟着变，边界命中会翻个儿
   * （N3 那条：关的时候第三块是「值班与联系人」，开了变成「分布式锁」；C1 的注入
   * 从 219 tok 掉到 123 tok）。零收益 + 扰动排序 = 默认不开。
   * `GB_KB_CTX_INDEX=1` 打开，等 KB 长到几十篇、评测集里有真正字面断裂的用例再测。
   */
  private readonly indexContext: boolean;
  private docs: KbDocMeta[] = [];
  private chunks: KbChunk[] = [];
  private stats = new Map<string, ChunkStats>();

  constructor(dir: string, opts: { useContext?: boolean; indexContext?: boolean } = {}) {
    this.dir = dir;
    this.rawDir = path.join(dir, 'raw');
    this.histDir = path.join(dir, 'raw', 'history');
    this.indexFile = path.join(dir, 'index.json');
    this.useContext = opts.useContext !== false;
    this.indexContext = this.useContext && opts.indexContext === true;
  }

  /** 从磁盘加载。文件不存在或损坏时从空开始，不抛错。 */
  load(): void {
    try {
      const raw = fs.readFileSync(this.indexFile, 'utf8');
      const data = JSON.parse(raw) as Partial<Persisted> | null;
      if (Array.isArray(data?.docs)) this.docs = data.docs;
      if (Array.isArray(data?.chunks)) this.chunks = data.chunks;
    } catch {
      this.docs = [];
      this.chunks = [];
    }
    this.rebuildStats();
  }

  docCount(): number {
    return this.docs.filter((d) => d.status === 'active').length;
  }

  chunkCount(): number {
    const active = new Set(this.docs.filter((d) => d.status === 'active').map((d) => d.id));
    // 蒸馏块不算「资料块」——它是索引辅助，不是内容，混在一起报数会让人以为资料变多了
    return this.chunks.filter((c) => active.has(c.docId) && c.type !== 'digest').length;
  }

  /** 已蒸馏的文档数 */
  digestCount(): number {
    const active = new Set(this.docs.filter((d) => d.status === 'active').map((d) => d.id));
    return this.chunks.filter((c) => active.has(c.docId) && c.type === 'digest').length;
  }

  list(): KbDocMeta[] {
    return [...this.docs].sort((a, b) => b.ts - a.ts);
  }

  /** 导入一篇资料。同标题重复导入 = 版本递增 + 旧分块整体替换。 */
  import(input: { text: string; title?: string; source?: string }): { doc: KbDocMeta; chunks: number } {
    const text = input.text ?? '';
    if (!text.trim()) throw new Error('内容为空');

    const title = (input.title ?? '').trim() || inferTitle(text, input.source);
    const id = slugify(title);
    // slug 已经清掉了 . 和 /，这里再兜一层：任何越出 raw 目录的路径都拒绝
    const base = path.resolve(this.rawDir);
    const resolved = path.resolve(base, `${id}.md`);
    if (path.dirname(resolved) !== base) throw new Error('非法的文档标识');

    const prev = this.docs.find((d) => d.id === id);
    const version = (prev?.version ?? 0) + 1;

    fs.mkdirSync(this.rawDir, { recursive: true });
    // 覆盖前先把上一版原文留到 history/：改错了能看能回滚，
    // 也是 AI-Ku 治理 Agent 里「新旧版本对比 + 历史归档」的最小实现
    if (prev) {
      try {
        const old = fs.readFileSync(resolved, 'utf8');
        fs.mkdirSync(this.histDir, { recursive: true });
        fs.writeFileSync(path.join(this.histDir, `${id}.v${prev.version}.md`), old);
      } catch {
        // 上一版原文丢了就算了，不能因此挡住这次导入
      }
    }
    fs.writeFileSync(resolved, text);

    this.indexChunks(id, title, text, version);

    const doc: KbDocMeta = {
      id,
      title,
      source: input.source ?? 'paste',
      ts: Date.now(),
      version,
      chars: text.length,
      chunks: this.chunks.filter((c) => c.docId === id).length,
      status: 'active',
    };
    this.docs = [...this.docs.filter((d) => d.id !== id), doc];

    this.rebuildStats();
    this.save();
    return { doc, chunks: doc.chunks };
  }

  /**
   * 按当前 chunker 参数为一篇文档重建分块（import 和 reindex 共用）。
   * `keepDigest` 时保留蒸馏块：reindex 只是换切法、内容没变，摘要还有效；
   * 而 import 换了内容，旧摘要必须作废。
   */
  private indexChunks(id: string, title: string, text: string, version: number, keepDigest = false): number {
    const chunks = chunkMarkdown(text);
    this.chunks = this.chunks.filter(
      (c) => c.docId !== id || (keepDigest && c.type === 'digest'),
    );
    for (const ch of chunks) {
      this.chunks.push({
        id: crypto.createHash('md5').update(`${id}::${ch.index}::${version}`).digest('hex'),
        docId: id,
        title,
        index: ch.index,
        headingPath: ch.headingPath,
        type: ch.type,
        text: ch.text,
        tokens: ch.tokens,
      });
    }
    return chunks.length;
  }

  /**
   * 写入 / 覆盖一篇文档的蒸馏块（摘要 + 别名）。
   * index 用 -1：它不属于正文序列，排序时自然落在最前，也不会被「上文补全」当成邻居。
   */
  setDigest(id: string, digest: Digest): KbChunk | undefined {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return undefined;
    const text = digestText(digest);
    if (!text.trim()) return undefined;
    const chunk: KbChunk = {
      id: crypto.createHash('md5').update(`${id}::digest::${doc.version}`).digest('hex'),
      docId: id,
      title: doc.title,
      index: -1,
      headingPath: `${doc.title} > 摘要与别名`,
      type: 'digest',
      text,
      tokens: estimateText(text),
    };
    this.chunks = [...this.chunks.filter((c) => !(c.docId === id && c.type === 'digest')), chunk];
    this.rebuildStats();
    this.save();
    return chunk;
  }

  /** 某篇文档的蒸馏块（没蒸馏过就是 undefined） */
  digestOf(id: string): KbChunk | undefined {
    return this.chunks.find((c) => c.docId === id && c.type === 'digest');
  }

  /** 哪些文档还没蒸馏过（CLI/面板据此决定要处理谁） */
  needsDigest(): KbDocMeta[] {
    return this.docs.filter((d) => d.status === 'active' && !this.digestOf(d.id));
  }

  /**
   * 写入一篇文档的块级上下文（`contextualizeDoc` 的产物）。
   * 按 index 对应；给了但文档里没这块就忽略。返回真正写上的块数。
   */
  setContexts(id: string, entries: readonly ChunkContext[]): number {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return 0;
    const byIndex = new Map(entries.map((e) => [e.index, e]));
    let n = 0;
    for (const c of this.chunks) {
      if (c.docId !== id || c.type === 'digest') continue;
      const e = byIndex.get(c.index);
      if (!e) continue;
      c.context = e.context;
      c.status = e.status;
      n++;
    }
    if (n) {
      this.rebuildStats();
      this.save();
    }
    return n;
  }

  /**
   * 哪些文档还有块没补上下文。
   * 重新导入 / reindex 会重建分块，`context` 字段自然随之消失——
   * 这正是想要的：内容变了，旧的一句话描述不该继续算数（和 digest 失效同一个套路）。
   */
  needsContext(): KbDocMeta[] {
    return this.docs.filter(
      (d) => d.status === 'active' && this.chunksOf(d.id).some((c) => !c.context),
    );
  }

  /** 已补上下文的正文块数（面板 / CLI 报进度用） */
  contextCount(): number {
    const active = new Set(this.docs.filter((d) => d.status === 'active').map((d) => d.id));
    return this.chunks.filter((c) => active.has(c.docId) && c.type !== 'digest' && c.context).length;
  }

  /**
   * 按当前切块参数重新索引所有文档（原文都在 raw/，所以可以随时重来）。
   * 改了 chunker 的 maxTokens/overlap 之后，老文档不会自动跟着变——这个入口就是补这一点。
   * 版本号不变：内容没改，只是切法变了。
   */
  reindex(): { docs: number; chunks: number; missing: string[] } {
    const missing: string[] = [];
    let docs = 0;
    for (const doc of this.docs) {
      const text = this.raw(doc.id);
      if (text === undefined) {
        missing.push(doc.title);
        continue;
      }
      doc.chunks = this.indexChunks(doc.id, doc.title, text, doc.version, true);
      doc.chars = text.length;
      docs++;
    }
    this.rebuildStats();
    this.save();
    return { docs, chunks: this.chunks.length, missing };
  }

  /** 某篇资料的版本列表（当前版本 + history 里的旧版本），新的在前 */
  versions(id: string): KbVersion[] {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return [];
    const out: KbVersion[] = [{ version: doc.version, ts: doc.ts, chars: doc.chars, current: true }];
    for (let v = doc.version - 1; v >= 1; v--) {
      const p = this.histPath(id, v);
      if (!p) continue;
      try {
        const st = fs.statSync(p);
        out.push({ version: v, ts: st.mtimeMs, chars: fs.readFileSync(p, 'utf8').length, current: false });
      } catch {
        // 这一版没留下来（可能是加上历史归档之前导入的），跳过
      }
    }
    return out;
  }

  /** 读某个历史版本的原文；version 省略或等于当前版本时读当前原文 */
  rawVersion(id: string, version?: number): string | undefined {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return undefined;
    if (version === undefined || version === doc.version) return this.raw(id);
    const p = this.histPath(id, version);
    if (!p) return undefined;
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * 疑似重复检测（对齐治理 Agent 的「重复知识合并」）：
   * 拿新内容的词集合和每篇已有文档比 Jaccard，超过阈值就报出来。
   * 只提示、不阻止——判断要不要合并是人的事。
   */
  duplicatesOf(text: string, opts: { excludeId?: string; threshold?: number } = {}): KbDuplicate[] {
    const threshold = opts.threshold ?? 0.6;
    const mine = new Set(terms(text));
    if (!mine.size) return [];
    const hash = crypto.createHash('md5').update(text.trim()).digest('hex');
    const out: KbDuplicate[] = [];
    for (const doc of this.docs) {
      if (doc.id === opts.excludeId) continue;
      const other = this.raw(doc.id);
      if (other === undefined) continue;
      const identical = crypto.createHash('md5').update(other.trim()).digest('hex') === hash;
      const theirs = new Set(terms(other));
      let inter = 0;
      for (const t of mine) if (theirs.has(t)) inter++;
      const union = mine.size + theirs.size - inter;
      const similarity = union ? inter / union : 0;
      if (identical || similarity >= threshold) {
        out.push({ id: doc.id, title: doc.title, similarity: Math.round(similarity * 100) / 100, identical });
      }
    }
    return out.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * 回滚到某个历史版本：不是把版本号退回去，而是把旧内容当成一次新导入。
   * 这样历史是只增不减的——回滚这个动作本身也留下痕迹（新版本 = 旧内容）。
   */
  rollback(id: string, version: number): { doc: KbDocMeta; chunks: number } {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) throw new Error('没有这篇资料');
    if (version === doc.version) throw new Error('这已经是当前版本');
    const text = this.rawVersion(id, version);
    if (text === undefined) throw new Error(`读不到 v${version} 的原文`);
    return this.import({ text, title: doc.title, source: `rollback:v${version}` });
  }

  /** 历史版本文件路径，顺带挡路径穿越 */
  private histPath(id: string, version: number): string | undefined {
    if (!Number.isInteger(version) || version < 1) return undefined;
    const base = path.resolve(this.histDir);
    const resolved = path.resolve(base, `${id}.v${version}.md`);
    return path.dirname(resolved) === base ? resolved : undefined;
  }

  /** 归档（软删除）：原文和分块都留着，只是不再参与检索 */
  archive(id: string): boolean {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc || doc.status === 'archived') return false;
    doc.status = 'archived';
    this.rebuildStats();
    this.save();
    return true;
  }

  /** 取消归档，重新参与检索 */
  restore(id: string): boolean {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc || doc.status === 'active') return false;
    doc.status = 'active';
    this.rebuildStats();
    this.save();
    return true;
  }

  /**
   * 真删：原文文件、文档条目、所有分块一起去掉。
   * 和 archive 的区别是不可恢复，所以调用方（UI）要先确认一次。
   */
  remove(id: string): boolean {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return false;
    const p = this.rawPath(id);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch {
        // 原文可能已经不在了，索引照样要清掉
      }
    }
    // 历史版本一起清，否则删完再同名导入会看到"祖先版本"
    for (let v = 1; v <= doc.version; v++) {
      const hp = this.histPath(id, v);
      if (!hp) continue;
      try {
        fs.unlinkSync(hp);
      } catch {
        // 不存在就算了
      }
    }
    this.docs = this.docs.filter((d) => d.id !== id);
    this.chunks = this.chunks.filter((c) => c.docId !== id);
    this.rebuildStats();
    this.save();
    return true;
  }

  /** 按标题或 id 找一篇文档（工具调用里模型给的通常是标题） */
  find(titleOrId: string): KbDocMeta | undefined {
    const q = titleOrId.trim();
    if (!q) return undefined;
    const byId = this.docs.find((d) => d.id === q);
    if (byId) return byId;
    const exact = this.docs.find((d) => d.title === q);
    if (exact) return exact;
    const lower = q.toLowerCase();
    return this.docs.find((d) => d.title.toLowerCase().includes(lower) || d.id.includes(lower));
  }

  /** 一篇文档的正文分块（按顺序），可按标题路径过滤。蒸馏块不算正文，不返回。 */
  chunksOf(id: string, section?: string): KbChunk[] {
    const all = this.chunks
      .filter((c) => c.docId === id && c.type !== 'digest')
      .sort((a, b) => a.index - b.index);
    if (!section?.trim()) return all;
    const s = section.trim().toLowerCase();
    return all.filter((c) => c.headingPath.toLowerCase().includes(s));
  }

  /** 读回导入时保存的原文，给「编辑」用。读不到返回 undefined。 */
  raw(id: string): string | undefined {
    const p = this.rawPath(id);
    if (!p) return undefined;
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** 解析 raw 文件路径，顺带挡住越出 raw 目录的 id */
  private rawPath(id: string): string | undefined {
    const base = path.resolve(this.rawDir);
    const resolved = path.resolve(base, `${id}.md`);
    return path.dirname(resolved) === base ? resolved : undefined;
  }

  /** BM25 检索，用「条数 + token」双重预算封顶（和记忆检索一致的口径） */
  search(query: string, budget: KbBudget, filter?: KbFilter): KbSearchResult {
    const active = new Set(this.docs.filter((d) => d.status === 'active').map((d) => d.id));
    // 范围限制：模型可以说「只在《调度服务 SDD》的分布式锁那一章里找」
    const onlyDoc = filter?.doc ? this.find(filter.doc)?.id : undefined;
    const sectionKey = filter?.section?.trim().toLowerCase();
    const inScope = (c: KbChunk): boolean => {
      if (!active.has(c.docId)) return false;
      if (onlyDoc && c.docId !== onlyDoc) return false;
      // digest 不受章节限制：它是文档级的桥，本来就不属于任何章节
      if (sectionKey && c.type !== 'digest' && !c.headingPath.toLowerCase().includes(sectionKey)) return false;
      return true;
    };
    const pool = this.chunks.filter(inScope);
    const qterms = [...new Set(terms(query))];
    if (pool.length === 0 || qterms.length === 0) {
      return { items: [], usedTokens: 0, dropped: 0, considered: 0 };
    }

    const N = pool.length;
    const avgLen = pool.reduce((n, c) => n + (this.stats.get(c.id)?.len ?? 0), 0) / N || 1;

    // 只为查询词算 df，不用维护全量倒排表
    const df = new Map<string, number>();
    for (const t of qterms) {
      let n = 0;
      for (const c of pool) if ((this.stats.get(c.id)?.tf.get(t) ?? 0) > 0) n++;
      df.set(t, n);
    }

    const raw: KbHit[] = [];
    for (const c of pool) {
      const st = this.stats.get(c.id);
      if (!st) continue;
      let score = 0;
      for (const t of qterms) {
        const tf = st.tf.get(t) ?? 0;
        if (tf === 0) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * st.len) / avgLen)));
      }
      if (score > 0) raw.push({ chunk: c, score });
    }

    // ── digest 桥 ──
    // digest 块装的是摘要 + 别名，没有具体数字，直接注入等于浪费预算。
    // 它命中说明「这篇文档跟问题相关」，所以把分数折算成同文档正文块的加分，
    // 让真正含答案的段落被捞出来。digest 自己不进结果。
    //
    // 只救「字面一个都没命中」的文档。这不是洁癖，是实测出来的：
    // 一开始对所有命中 digest 的文档都加分，结果同一篇里每块都 +同一个常数，
    // 把分数差压平了 → 相对阈值（minScoreRatio）拦不住弱命中 → 注入 token 暴涨
    // （X1 那条从 123 涨到 581），而召回一点没变——本来就命中了，不需要救。
    // 桥只在真正的「问法对不上」场景才有意义，所以限定在零字面命中的文档上。
    const boostFactor = budget.digestBoost ?? 0;
    const litHitDocs = new Set(raw.filter((h) => h.chunk.type !== 'digest').map((h) => h.chunk.docId));
    const docBoost = new Map<string, number>();
    if (boostFactor > 0) {
      for (const h of raw) {
        if (h.chunk.type !== 'digest') continue;
        if (litHitDocs.has(h.chunk.docId)) continue;
        const add = h.score * boostFactor;
        docBoost.set(h.chunk.docId, Math.max(docBoost.get(h.chunk.docId) ?? 0, add));
      }
    }
    const baseOf = new Map(raw.map((h) => [h.chunk.id, h.score]));
    const digestBridged = docBoost.size;
    const scored: KbHit[] = [];
    for (const c of pool) {
      if (c.type === 'digest') continue;
      const base = baseOf.get(c.id) ?? 0;
      const boost = docBoost.get(c.docId) ?? 0;
      if (base === 0 && boost === 0) continue;
      scored.push({ chunk: c, score: base + boost, ...(boost > 0 ? { digestBoost: boost } : {}) });
    }

    scored.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);

    // 相对阈值：和最高分差太远的，当成「其实没命中」
    const ratio = budget.minScoreRatio ?? 0;
    const floor = scored.length ? scored[0].score * ratio : 0;
    const kept = ratio > 0 ? scored.filter((h) => h.score >= floor) : scored;
    const belowThreshold = scored.length - kept.length;

    const perDoc = budget.perDoc ?? Infinity;
    const perDocCount = new Map<string, number>();
    const chosen = new Map<string, KbHit>();
    let usedTokens = 0;
    let dropped = 0;
    let cappedByDoc = 0;

    for (const hit of kept) {
      if (chosen.size >= budget.maxItems) {
        dropped++;
        continue;
      }
      if ((perDocCount.get(hit.chunk.docId) ?? 0) >= perDoc) {
        cappedByDoc++;
        continue;
      }
      if (usedTokens + this.costOf(hit.chunk) > budget.maxTokens) {
        dropped++;
        continue;
      }
      chosen.set(hit.chunk.id, hit);
      perDocCount.set(hit.chunk.docId, (perDocCount.get(hit.chunk.docId) ?? 0) + 1);
      usedTokens += this.costOf(hit.chunk);

      // 上文补全：命中的是章节中段时，把同章节的上一块带上。
      // 它不算一条「命中」（不占 maxItems），但要占 token 预算——否则模型看到的是半句话。
      if (!budget.withNeighbor || hit.chunk.index === 0) continue;
      const prev = pool.find((c) => c.docId === hit.chunk.docId && c.index === hit.chunk.index - 1);
      if (!prev || chosen.has(prev.id)) continue;
      if (!sameSection(prev.headingPath, hit.chunk.headingPath)) continue;
      if (usedTokens + this.costOf(prev) > budget.maxTokens) continue;
      chosen.set(prev.id, { chunk: prev, score: hit.score, neighbor: true });
      usedTokens += this.costOf(prev);
    }

    // 输出顺序：同文档按 index 升序，这样「上文 → 命中块」是自然的阅读顺序
    const items = [...chosen.values()]
      .sort((a, b) => a.chunk.docId.localeCompare(b.chunk.docId) || a.chunk.index - b.chunk.index)
      .map((h) => (this.useContext ? h : { ...h, chunk: stripContext(h.chunk) }));
    return {
      items,
      usedTokens,
      dropped,
      considered: scored.length,
      cappedByDoc,
      belowThreshold,
      ...(digestBridged ? { digestBridged } : {}),
    };
  }

  /**
   * 一块真正要花的 token = 正文 + 那句上下文和状态标签。
   * 分开算不行：预算按正文算、注入时又多塞一行，报出来的 usedTokens 就是假的，
   * 评测里量到的"注入 token"也会对不上实际提示词。
   */
  private costOf(c: KbChunk): number {
    if (!this.useContext) return c.tokens;
    const label = c.status ? STATUS_LABEL[c.status] : '';
    const extra = (c.context ? `（这段：${c.context}）\n` : '') + (label ? ` ｜ 状态: ${label}` : '');
    return c.tokens + (extra ? estimateText(extra) : 0);
  }

  private rebuildStats(): void {
    this.stats.clear();
    for (const c of this.chunks) {
      // 标题和标题路径也进索引：这样按文档名或章节名也能命中。
      // 块级上下文默认**不进**索引（见 indexContext 的注释：实测零收益且会扰动排序），
      // 它的作用在注入侧——把「这段是被否决的方案」显式写给模型看。
      const ctx = this.indexContext ? (c.context ?? '') : '';
      const list = terms(`${c.title}\n${c.headingPath}\n${ctx}\n${c.text}`);
      const tf = new Map<string, number>();
      for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.stats.set(c.id, { tf, len: list.length });
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const data: Persisted = { version: 1, docs: this.docs, chunks: this.chunks };
      fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2));
    } catch {
      // 落盘失败不影响本次运行
    }
  }
}

/** 关掉块级上下文时用：把 context/status 摘掉，下游（formatHits）就看不到它 */
function stripContext(c: KbChunk): KbChunk {
  const { context: _c, status: _s, ...rest } = c;
  return rest;
}

/** 把检索结果拼成注入给模型的文本（带来源标注，方便分辨是查到的还是编的） */
export function formatHits(items: KbHit[]): string {
  const head =
    '【资料库】以下内容来自用户导入的资料，回答相关问题时优先采用，并在答复中标明来源标题。';
  const body = items
    .map((i) => {
      // headingPath 的第一段通常就是文档 H1（也就是 title），直接拼会变成
      //「调度服务 SDD > 调度服务 SDD > 4.3 分布式锁」，模型会照抄进答复里
      const p = i.chunk.headingPath;
      const where = !p ? i.chunk.title : p === i.chunk.title || p.startsWith(i.chunk.title + ' > ') ? p : `${i.chunk.title} > ${p}`;
      // 标出哪些是「被带进来的上文」，模型就不会把它当成检索结果的重点
      const tag = i.neighbor ? '（上文）' : '';
      // 状态标签：只有非现行的才标。这是冲着「把被否决方案的数字当答案」去的——
      // 光给正文，废弃结论和现行约定长得一模一样。
      const label = i.chunk.status ? STATUS_LABEL[i.chunk.status] : '';
      const status = label ? ` ｜ 状态: ${label}` : '';
      // 一句话上下文单独一行：块被切开之后开头常常是上一节的尾巴，
      // 这行是模型判断「这段到底在讲什么」的唯一线索。
      const ctx = i.chunk.context ? `（这段：${i.chunk.context}）\n` : '';
      return `--- 来源: ${where}${tag}${status} ---\n${ctx}${i.chunk.text}`;
    })
    .join('\n');
  return `${head}\n${body}`;
}
