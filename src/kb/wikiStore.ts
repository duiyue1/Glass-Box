import fs from 'node:fs';
import path from 'node:path';
import { estimateText } from '../engine/tokens.ts';
import type { AuditPoint } from './wikiAudit.ts';
import {
  WIKI_TYPES,
  WIKI_TYPE_LABEL,
  backlinksOf,
  hashSources,
  isValidRef,
  pageFromMarkdown,
  pageToMarkdown,
  type WikiPage,
  type WikiPageType,
} from './wiki.ts';

/**
 * WikiStore：wiki 条目的磁盘存储。
 *
 * 落盘就是**普通 Markdown 文件**，不进 index.json：
 *   wiki/AGENTS.md          生成规则（人可改，改完影响下次生成）
 *   wiki/index.md           分类目录（也是注入给模型的那一份）
 *   wiki/log.md             操作日志（每次生成记一行）
 *   wiki/source/<slug>.md   一篇原文一页
 *   wiki/concept/<slug>.md  一个机制/约定一页
 *
 * 为什么用文件而不是塞进 index.json：条目是**人要读、要改**的东西。
 * 纯文件意味着可以用编辑器直接改、可以 git 管、可以 grep——
 * Wiki.js 的核心卖点就是 Git-backed 纯 Markdown，这一点零成本就能拿到。
 */
export interface WikiVersion {
  id: number;
  ts: number;
  message: string;
  pages: number;
}

export interface WikiVersionDiff {
  ref: string;
  status: 'added' | 'updated' | 'deleted' | 'unchanged';
  before?: string;
  after?: string;
}

export class WikiStore {
  readonly dir: string;
  private readonly agentsDefault: string;

  private historyDir(): string {
    return path.join(this.dir, '.history');
  }

  private historyMetaPath(id: number): string {
    return path.join(this.historyDir(), `${id}.json`);
  }

  private historyPageDir(id: number): string {
    return path.join(this.historyDir(), String(id));
  }

  constructor(dir: string) {
    this.dir = dir;
    // 版本控制里的默认规则模板，首次生成时复制过去
    this.agentsDefault = path.join(import.meta.dirname, 'AGENTS.default.md');
  }

  private typeDir(type: WikiPageType): string {
    return path.join(this.dir, type);
  }

  /** ref → 文件路径，顺带挡路径穿越 */
  pathOf(ref: string): string | undefined {
    if (!isValidRef(ref)) return undefined;
    const base = path.resolve(this.dir);
    const resolved = path.resolve(base, `${ref}.md`);
    return resolved.startsWith(base + path.sep) ? resolved : undefined;
  }

  /**
   * 规则文件：不存在就从仓库里的默认模板复制一份。
   * 之后只读用户那一份——**他的修改不会被覆盖**。
   */
  rules(): string {
    const p = path.join(this.dir, 'AGENTS.md');
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      // 复制默认模板；连模板都读不到就返回空串（生成时会退化成内置的最小规则）
      try {
        const text = fs.readFileSync(this.agentsDefault, 'utf8');
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(p, text);
        return text;
      } catch {
        return '';
      }
    }
  }

  list(): WikiPage[] {
    const out: WikiPage[] = [];
    for (const type of WIKI_TYPES) {
      let names: string[];
      try {
        names = fs.readdirSync(this.typeDir(type));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const ref = `${type}/${name.slice(0, -3)}`;
        const p = this.pathOf(ref);
        if (!p) continue;
        try {
          out.push(pageFromMarkdown(ref, fs.readFileSync(p, 'utf8')));
        } catch {
          // 单个条目坏了不该让整棵树读不出来
        }
      }
    }
    return out.sort((a, b) => a.ref.localeCompare(b.ref));
  }

  read(ref: string): WikiPage | undefined {
    const p = this.pathOf(ref);
    if (!p) return undefined;
    try {
      return pageFromMarkdown(ref, fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
  }

  write(page: WikiPage): void {
    const p = this.pathOf(page.ref);
    if (!p) throw new Error(`非法的 ref: ${page.ref}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, pageToMarkdown(page));
  }

  remove(ref: string): boolean {
    const p = this.pathOf(ref);
    if (!p) return false;
    try {
      fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  }

  count(): number {
    return this.list().length;
  }

  /** 保存当前 wiki 页面快照。历史只追加，AGENTS/index/log 等附属文件不纳入回滚。 */
  snapshot(message: string): WikiVersion {
    const ids = fs.existsSync(this.historyDir())
      ? fs.readdirSync(this.historyDir()).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number(name.slice(0, -5)))
      : [];
    const id = Math.max(0, ...ids) + 1;
    const pages = this.list();
    const pageDir = this.historyPageDir(id);
    fs.mkdirSync(pageDir, { recursive: true });
    for (const page of pages) {
      const file = path.join(pageDir, `${page.ref}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pageToMarkdown(page));
    }
    const version: WikiVersion = { id, ts: Date.now(), message, pages: pages.length };
    fs.mkdirSync(this.historyDir(), { recursive: true });
    fs.writeFileSync(this.historyMetaPath(id), JSON.stringify(version, null, 2));
    return version;
  }

  versions(): WikiVersion[] {
    let names: string[];
    try { names = fs.readdirSync(this.historyDir()); } catch { return []; }
    return names.filter((name) => /^\d+\.json$/.test(name)).map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(this.historyDir(), name), 'utf8')) as WikiVersion; } catch { return undefined; }
    }).filter((version): version is WikiVersion => Boolean(version)).sort((a, b) => b.id - a.id);
  }

  private snapshotPages(id: number): Map<string, string> {
    const out = new Map<string, string>();
    const root = this.historyPageDir(id);
    const walk = (dir: string): void => {
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) walk(file);
        else if (name.endsWith('.md')) out.set(path.relative(root, file).slice(0, -3), fs.readFileSync(file, 'utf8'));
      }
    };
    walk(root);
    return out;
  }

  diff(versionId: number): WikiVersionDiff[] {
    const before = this.snapshotPages(versionId);
    const after = new Map(this.list().map((page) => [page.ref, pageToMarkdown(page)]));
    const refs = new Set([...before.keys(), ...after.keys()]);
    return [...refs].sort().map((ref) => {
      const oldText = before.get(ref);
      const newText = after.get(ref);
      const status = oldText === undefined ? 'added' : newText === undefined ? 'deleted' : oldText === newText ? 'unchanged' : 'updated';
      return { ref, status, ...(oldText === undefined ? {} : { before: oldText }), ...(newText === undefined ? {} : { after: newText }) };
    });
  }

  rollback(versionId: number, message = `restore: wiki to v${versionId}`): WikiVersion | undefined {
    const pages = this.snapshotPages(versionId);
    if (!pages.size && !this.versions().some((version) => version.id === versionId && version.pages === 0)) return undefined;
    this.snapshot(`before ${message}`);
    for (const page of this.list()) this.remove(page.ref);
    for (const [ref, text] of pages) {
      const parsed = pageFromMarkdown(ref, text);
      this.write(parsed);
    }
    this.writeIndex(this.list());
    return this.snapshot(message);
  }

  /** 读一个附属文件（index.md / log.md / AGENTS.md），面板上也能点开看 */
  readFile(name: 'index' | 'log' | 'AGENTS'): string | undefined {
    try {
      return fs.readFileSync(path.join(this.dir, `${name}.md`), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** 操作日志：只追加。生成过程也要可查，这是玻璃盒的一部分 */
  appendLog(line: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(path.join(this.dir, 'log.md'), `- ${stamp} ${line}\n`);
  }

  /**
   * 质检历史：`quality.jsonl`，一次一行、只追加。
   * 用 jsonl 不用 json 是为了「只追加」——中断也不会毁掉历史，
   * 跟会话日志一个套路。趋势图要的就是这个文件。
   */
  appendQuality(point: unknown): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, 'quality.jsonl'), `${JSON.stringify(point)}\n`);
  }

  /** 读质检历史，默认只要最近 30 天。坏行跳过，不让一行坏 JSON 毁掉整张趋势图 */
  qualityHistory(days = 30): AuditPoint[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir, 'quality.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const since = Date.now() - days * 86400_000;
    const out: AuditPoint[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as AuditPoint;
        if (typeof p?.ts === 'number' && p.ts >= since) out.push(p);
      } catch {
        // 坏行跳过
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /**
   * 目录页：既给人看，也是**注入给模型的那份索引**。
   * 只有 ref + 一句话摘要——让模型知道"有什么"，正文按需再拉。
   * 这就是 deepwiki 那套 llms.txt 的作用，也是 WeKnora 的 index.md。
   */
  writeIndex(pages: readonly WikiPage[]): string {
    const text = indexMarkdown(pages);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'index.md'), text);
    return text;
  }

  /**
   * 面板用的树：按类型分组 + 计数，每条带校验/时效状态。
   * stale 需要「当前原文块的哈希」，由调用方给一个解析函数——
   * WikiStore 不该知道 KbStore 的存在。
   */
  tree(resolve?: (sourceRefs: readonly string[]) => string | undefined): WikiTree {
    const pages = this.list();
    const back = backlinksOf(pages);
    const groups = WIKI_TYPES.map((type) => ({
      type,
      label: WIKI_TYPE_LABEL[type],
      pages: pages
        .filter((p) => p.type === type)
        .map((p) => ({
          ref: p.ref,
          title: p.title,
          summary: p.summary,
          verified: p.verified,
          unverified: p.unverified ?? [],
          sources: p.sources.length,
          related: p.related,
          backlinks: back.get(p.ref) ?? [],
          ts: p.ts,
          // 依据块的内容变了 → 条目该重建。解析不出来（原文被删）也算 stale
          stale: Boolean(p.sourceHash) && resolve ? resolve(p.sources) !== p.sourceHash : false,
        })),
    })).filter((g) => g.pages.length > 0);
    return {
      groups,
      total: pages.length,
      unverified: pages.filter((p) => !p.verified).length,
      files: (['index', 'AGENTS', 'log'] as const).filter((n) => this.readFile(n) !== undefined),
    };
  }
}

export interface WikiTreeItem {
  ref: string;
  title: string;
  summary: string;
  verified: boolean;
  unverified: string[];
  sources: number;
  related: string[];
  backlinks: string[];
  ts: number;
  stale: boolean;
}

export interface WikiTree {
  groups: { type: WikiPageType; label: string; pages: WikiTreeItem[] }[];
  total: number;
  unverified: number;
  files: string[];
}

/** 目录页正文。抽成纯函数，方便单测和「注入前先看看长什么样」 */
export function indexMarkdown(pages: readonly WikiPage[]): string {
  const lines = ['# 知识目录', ''];
  for (const type of WIKI_TYPES) {
    const mine = pages.filter((p) => p.type === type);
    if (!mine.length) continue;
    lines.push(`## ${type} · ${WIKI_TYPE_LABEL[type]}（${mine.length}）`, '');
    for (const p of mine) {
      const flag = p.verified ? '' : ' ⚠未通过溯源校验';
      lines.push(`- [[${p.ref}]] — ${p.summary || p.title}${flag}`);
    }
    lines.push('');
  }
  if (pages.length === 0) lines.push('（还没有条目，导入资料后执行 npm run kb:wiki 生成）');
  return lines.join('\n');
}

/** 注入给模型的目录（比 index.md 更紧凑：不带校验标记、不带空行） */
export function catalogForPrompt(pages: readonly WikiPage[], opts: CatalogOpts = {}): string {
  return pickCatalog(pages, opts).text;
}

export interface CatalogOpts {
  /** 最多列几条 */
  maxItems?: number;
  /** 目录整体的 token 上限（超了从尾部砍） */
  maxTokens?: number;
  /**
   * 这条条目是否已过期（依据原文改过、条目没重新编译）。
   * WikiStore 不认识 KbStore，所以判定由调用方给——跟 `tree()` 一个套路。
   *
   * 过期条目**不排除，只降权 + 标记**。排除是更简单的实现，但更坏：
   * 模型会彻底看不见这块知识（连"有这么一页"都不知道），
   * 而标了过期的指针至少让它知道该去核对原文。
   * 参考 Graphiti 的做法——矛盾/失效的边是打 `invalid_at` 而不是删掉。
   */
  isStale?: (p: WikiPage) => boolean;
}

export interface CatalogPick {
  /** 真正进了目录的条目 */
  pages: WikiPage[];
  /** 拼好的目录文本（没有可用条目时是空串） */
  text: string;
  tokens: number;
  /** 没进目录的条目 + 原因。面板上要能回答「为什么这页没进目录」 */
  skipped: { ref: string; why: string }[];
  /** 进了目录但已过期的 ref。面板要能回答「这回合注入了几条过期知识」 */
  stale: string[];
}

const CATALOG_HEAD = '【知识目录】已整理好的条目如下，需要细节时用 kb_read 读条目（page=ref）或读原文：';
/** source 页压成一行时的前缀 */
const SOURCE_LINE = '- 原文摘要页（每篇资料一页，讲这篇资料整体写了什么）：';
/** source 那一行里有过期页时补的说明（source 页压成一行，没地方逐条标）。
 *  写得极短是因为它要从 source 那一行的子预算里出（默认只有 60 tok），
 *  一句完整的话（实测 20 tok）会直接挤掉一个 ref。 */
const STALE_LEGEND = '（*=已过期）';
/** concept 页的过期标记，跟在摘要后面 */
const STALE_MARK = '（已过期，以原文为准）';
/** 留给 source 清单那一行的预算比例。剩下的都给 concept 页 */
const SOURCE_BUDGET_RATIO = 0.25;

/**
 * 选出能进目录的条目，并把落选原因一并带出来。
 *
 * 两道硬门槛：
 * - **没通过溯源校验**的不进。它可能带着编造的数字，目录是给模型看的"可信清单"。
 * - **没有摘要**的不进。只有 ref 的一行等于让模型猜这页写了什么，
 *   实测生成时约三分之一的页会漏写 summary（opt-24），拿标题凑数只是噪声。
 *
 * source 页（每篇资料一页的原文摘要页）**压成一行只列 ref**，不逐条给摘要。
 * 这是资料涨到 6 篇之后改的：原来 source 和 concept 一起按行排、concept 优先，
 * 结果 22 条条目撞上 240 tok 预算时**5 个 source 页全被砍**——
 * 而 source 页恰恰是"这个库里有哪几篇资料"的地图，砍掉它模型就不知道库里有什么了。
 * 压成一行之后 5 篇只花 ~40 tok，且不会再被挤出去。
 *
 * 过期条目（`opts.isStale`）排在同类的最后并标记：预算不够时**先挤掉过期的**，
 * 挤不掉就至少让模型知道这页可能不作数。过期判定以前只到质检报告为止，
 * 注入路径完全不看——等于体检报告写了"这页过期"，处方却没人执行。
 */
export function pickCatalog(pages: readonly WikiPage[], opts: CatalogOpts = {}): CatalogPick {
  const maxItems = opts.maxItems ?? 20;
  const maxTokens = opts.maxTokens ?? 240;
  const skipped: { ref: string; why: string }[] = [];
  const usable: WikiPage[] = [];
  for (const p of pages) {
    if (!p.verified) skipped.push({ ref: p.ref, why: '未通过溯源校验' });
    else if (!p.summary.trim()) skipped.push({ ref: p.ref, why: '缺摘要' });
    else usable.push(p);
  }
  // 过期判定可能要读原文算哈希，每页只算一次
  const staleRefs = new Set(usable.filter((p) => opts.isStale?.(p)).map((p) => p.ref));
  // 新鲜的在前、过期的在后，同组内按 ref。砍尾时天然先砍过期的
  const order = (a: WikiPage, b: WikiPage): number =>
    (staleRefs.has(a.ref) ? 1 : 0) - (staleRefs.has(b.ref) ? 1 : 0) || a.ref.localeCompare(b.ref);
  const sources = usable.filter((p) => p.type === 'source').sort(order);
  const concepts = usable.filter((p) => p.type !== 'source').sort(order);

  const taken: WikiPage[] = [];
  const lines = [CATALOG_HEAD];
  let tokens = estimateText(CATALOG_HEAD);

  // ── source 清单：一行，先占坑（有预算上限，太多就截断）──
  const sourceBudget = Math.floor(maxTokens * SOURCE_BUDGET_RATIO);
  if (sources.length) {
    const inLine: WikiPage[] = [];
    // 说明那一段的开销**先扣掉再排**：等排完再加会有超预算的风险，
    // 而多扣的结果只是少列一页，方向是安全的
    const legendCost = sources.some((p) => staleRefs.has(p.ref)) ? estimateText(STALE_LEGEND) : 0;
    let lineTokens = estimateText(SOURCE_LINE) + legendCost;
    for (const p of sources) {
      // 连 `*` 一起估：单独估一个字符会被最小档位罚成 3 tok
      const shown = staleRefs.has(p.ref) ? `${p.ref}*` : p.ref;
      const cost = estimateText(`${shown}、`);
      if (lineTokens + cost > sourceBudget) {
        skipped.push({ ref: p.ref, why: `超出原文摘要页那一行的预算 ${sourceBudget}` });
        continue;
      }
      lineTokens += cost;
      inLine.push(p);
    }
    if (inLine.length) {
      const listed = inLine.map((p) => (staleRefs.has(p.ref) ? `${p.ref}*` : p.ref)).join('、');
      const legend = inLine.some((p) => staleRefs.has(p.ref)) ? STALE_LEGEND : '';
      lines.push(SOURCE_LINE + listed + legend);
      tokens += lineTokens;
      taken.push(...inLine);
    }
  }

  // ── concept 页：逐条给摘要。maxItems 只管这批（source 压成一行，不占条数）──
  let listed = 0;
  for (const p of concepts) {
    if (listed >= maxItems) {
      skipped.push({ ref: p.ref, why: `超出条数上限 ${maxItems}` });
      continue;
    }
    const line = `- ${p.ref} — ${p.summary.trim()}${staleRefs.has(p.ref) ? STALE_MARK : ''}`;
    const cost = estimateText(line);
    if (tokens + cost > maxTokens) {
      skipped.push({ ref: p.ref, why: `超出目录 token 预算 ${maxTokens}` });
      continue;
    }
    tokens += cost;
    lines.push(line);
    taken.push(p);
    listed++;
  }
  const stale = taken.filter((p) => staleRefs.has(p.ref)).map((p) => p.ref);
  if (!taken.length) return { pages: [], text: '', tokens: 0, skipped, stale };
  return { pages: taken, text: lines.join('\n'), tokens, skipped, stale };
}

export { hashSources };
