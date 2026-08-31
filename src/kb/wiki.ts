import crypto from 'node:crypto';

/**
 * wiki 条目的数据结构、frontmatter 读写、以及**溯源校验**。
 *
 * 为什么要有 wiki 这一层：现在的资料库是「原文 → 检索 → 一次性答案（用完丢掉）」，
 * 每次提问都要重新在原文里翻。wiki 是「原文 → 编译成条目 → 持久保存」，
 * 结论被整理过一次之后就一直在那儿，跨文档的冲突也在编译时就标出来了。
 * 参考 Tencent/WeKnora 的 Wiki Mode 与 OpenKB 的 concepts/entities/summaries 布局。
 *
 * 这一层最关键的东西不是生成，而是 **verifyBody()**：
 * LLM 编译知识的固有风险是编造，而「条目里的数字必须能在它引用的原文块里字面找到」
 * 是可以零成本机械验证的。生成侧无论多聪明，都要过这道闸。
 */

/** 第一版只生成 source / concept；entity / analysis 预留 */
export type WikiPageType = 'source' | 'concept' | 'entity' | 'analysis';

export const WIKI_TYPES: readonly WikiPageType[] = ['source', 'concept', 'entity', 'analysis'];

/** 类型的中文名，面板上分组标题用 */
export const WIKI_TYPE_LABEL: Record<WikiPageType, string> = {
  source: '原文摘要',
  concept: '概念',
  entity: '实体',
  analysis: '分析',
};

export interface WikiPage {
  /** `<type>/<slug>`，全局唯一 */
  ref: string;
  title: string;
  type: WikiPageType;
  /** 一句话「这页讲什么」，会进目录索引；按规则不该含具体数字 */
  summary: string;
  /** 检索用的别名（同义说法、口语问法），只参与打分不进正文 */
  aliases: string[];
  /** 实际引用到的原文块，形如 `调度服务-sdd#2` */
  sources: string[];
  /** 正文里 [[...]] 提到的其它条目 */
  related: string[];
  /** 溯源校验是否通过 */
  verified: boolean;
  /** 没能在原文里找到的字面（校验不通过时的证据） */
  unverified?: string[];
  /** 依据块内容的哈希：原文一改，条目自动算 stale */
  sourceHash: string;
  ts: number;
  /** frontmatter 之后的正文 */
  body: string;
}

/** 块引用：`调度服务-sdd#2` → { docId: '调度服务-sdd', index: 2 } */
export interface SourceRef {
  docId: string;
  index: number;
}

export function parseSourceRef(s: string): SourceRef | undefined {
  const m = /^(.+)#(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  return { docId: m[1], index: Number(m[2]) };
}

export function formatSourceRef(docId: string, index: number): string {
  return `${docId}#${index}`;
}

/** 依据块内容的哈希。原文改了 → 哈希变 → 条目 stale，跟 needsDigest 一个套路 */
export function hashSources(texts: readonly string[]): string {
  return crypto.createHash('md5').update(texts.join('\n---\n')).digest('hex');
}

/** slug 清洗：中文原词保留，路径字符和空格换成 `-`（防路径穿越） */
export function wikiSlug(title: string): string {
  return (
    title
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      // `..` 一律抹掉：换成 `-` 之后 `../../etc` 会变成 `-..-etc`，仍然带着上跳语义
      .replace(/\.{2,}/g, '')
      .replace(/^[-.]+/, '')
      .replace(/-{2,}/g, '-')
      .replace(/-+$/, '')
      .slice(0, 80) || 'untitled'
  );
}

/** ref 合法性：必须是 `<已知类型>/<不含路径穿越的 slug>` */
export function isValidRef(ref: string): boolean {
  const i = ref.indexOf('/');
  if (i <= 0) return false;
  const type = ref.slice(0, i);
  const slug = ref.slice(i + 1);
  if (!WIKI_TYPES.includes(type as WikiPageType)) return false;
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.startsWith('.')) return false;
  return true;
}

/* ── frontmatter ───────────────────────────────────────────── */

/**
 * 极简 YAML frontmatter 读写：`key: 标量`、`key: [a, b]`，
 * 外加两种模型实际会输出的写法——**块状列表**和**折叠标量续行**：
 *
 *   aliases:            summary: >
 *     - 获取锁超时         调度服务用 Redis 租约锁，
 *     - 拿不到锁           含续租与抢锁失败约定。
 *
 * 提示词里给的是行内写法，但模型时不时改用这两种，结果 summary / aliases 静默变空
 * （真实跑出来过：一页正文写得很好，摘要和别名却全丢了）。
 * 仍然不引 YAML 库——字段集合是固定的，真正的 YAML 有一堆我们既不需要
 * 也不想承担的语义（锚点、类型推断、嵌套）。
 */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const norm = text.replace(/\r\n?/g, '\n');
  if (!norm.startsWith('---\n')) return { data: {}, body: norm.trim() };
  const end = norm.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: norm.trim() };
  const head = norm.slice(4, end);
  const body = norm.slice(end + 4).replace(/^\n+/, '');
  const data: Record<string, string | string[]> = {};
  const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');
  let key = '';
  for (const line of head.split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (v.startsWith('[')) {
        data[key] = v
          .replace(/^\[/, '')
          .replace(/\]$/, '')
          .split(',')
          .map(unquote)
          .filter(Boolean);
      } else {
        // `>` / `|` 及其 chomp 变体只是"下面几行是我的值"的记号，本身不是值
        data[key] = /^[>|][-+]?$/.test(v) ? '' : unquote(v);
      }
      continue;
    }
    if (!key) continue;
    const item = /^[ \t]*-[ \t]+(.+)$/.exec(line);
    if (item) {
      const cur = data[key];
      const list = Array.isArray(cur) ? cur : typeof cur === 'string' && cur ? [cur] : [];
      list.push(unquote(item[1]));
      data[key] = list;
      continue;
    }
    const cont = /^[ \t]+(\S.*)$/.exec(line);
    if (cont && typeof data[key] === 'string') {
      const cur = data[key] as string;
      data[key] = cur ? `${cur} ${unquote(cont[1])}` : unquote(cont[1]);
    }
  }
  return { data, body: body.trim() };
}

const asList = (v: string | string[] | undefined): string[] =>
  Array.isArray(v) ? v : v ? [v] : [];

/** 从磁盘上的 .md 还原成 WikiPage。ref 以文件路径为准（文件名才是唯一标识） */
export function pageFromMarkdown(ref: string, text: string): WikiPage {
  const { data, body } = parseFrontmatter(text);
  const type = (ref.split('/')[0] as WikiPageType) ?? 'concept';
  return {
    ref,
    title: typeof data.title === 'string' && data.title ? data.title : ref.split('/').slice(1).join('/'),
    type,
    summary: typeof data.summary === 'string' ? data.summary : '',
    aliases: asList(data.aliases),
    sources: asList(data.sources),
    related: asList(data.related),
    verified: data.verified !== 'false',
    ...(asList(data.unverified).length ? { unverified: asList(data.unverified) } : {}),
    sourceHash: typeof data.sourceHash === 'string' ? data.sourceHash : '',
    ts: Number(data.ts) || 0,
    body,
  };
}

/** 反过来：WikiPage → 磁盘上的 .md（字段顺序固定，diff 才干净） */
export function pageToMarkdown(p: WikiPage): string {
  const list = (xs: readonly string[]): string => `[${xs.join(', ')}]`;
  const head = [
    `ref: ${p.ref}`,
    `title: ${p.title}`,
    `type: ${p.type}`,
    `summary: ${p.summary}`,
    `aliases: ${list(p.aliases)}`,
    `sources: ${list(p.sources)}`,
    `related: ${list(p.related)}`,
    `verified: ${p.verified}`,
    ...(p.unverified?.length ? [`unverified: ${list(p.unverified)}`] : []),
    `sourceHash: ${p.sourceHash}`,
    `ts: ${p.ts}`,
  ].join('\n');
  return `---\n${head}\n---\n\n${p.body.trim()}\n`;
}

/* ── 模型输出解析 ─────────────────────────────────────────── */

/**
 * 从模型输出里抠出第一个平衡的 `{...}`。
 * 提示词写了「只输出 JSON」，模型照旧会加 ``` 围栏和前后说明——
 * 结构规划和质检抽检都要这个，所以放在这儿共用。
 */
export function firstJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth !== 0) continue;
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/* ── 交叉引用 ──────────────────────────────────────────────── */

/** 抽出正文里的 [[concept/xxx]]，去重，只保留合法 ref */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const ref = m[1].trim();
    if (isValidRef(ref)) out.add(ref);
  }
  return [...out];
}

/** 反向链接：谁引用了我 */
export function backlinksOf(pages: readonly WikiPage[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of pages) {
    for (const ref of new Set([...p.related, ...extractLinks(p.body)])) {
      if (ref === p.ref) continue;
      const list = map.get(ref) ?? [];
      if (!list.includes(p.ref)) list.push(p.ref);
      map.set(ref, list);
    }
  }
  return map;
}

/* ── 溯源校验 ──────────────────────────────────────────────── */

/**
 * 从条目正文里抽出「必须能在原文里找到」的字面。
 *
 * 抄 doarchon 那套采纳率评分的 numeric / identifier 两维：
 *   - 数字：带不带单位都算，但**排掉块引用里的编号**（`[调度服务-sdd#2]` 里的 2 不是内容）
 *   - 标识符：驼峰 / 下划线 / 连字符 + 数字的组合（`SETNX`、`LOCK_BUSY`、`TX-7031`）
 * 纯中文词不校验——同义改写在中文里太常见，卡它会全军覆没，
 * 而数字和标识符改一个字就是错，卡这两类性价比最高。
 */
export function claimsOf(body: string): { numbers: string[]; identifiers: string[] } {
  // 先把块引用整段挖掉，里面的 #2 / 文档 id 都不是条目内容
  const clean = body
    .replace(/\[[^\]]*#\d+\]/g, ' ')
    .replace(/\[\[[^\]]+\]\]/g, ' ')
    // 再挖掉行首的**排版序号**：`1. `、`- 2) `、`## 3. `。
    // 这是真实跑出来的误报：一段「被否决的三个方案」用了有序列表，
    // 1/2/3 被当成内容数字送去校验，原文里没有独立的「2」，整页就被判未通过。
    // 序号是 Markdown 排版，不是条目声明的事实。
    .replace(/^[ \t>]*(?:[-*+][ \t]+)?#{0,6}[ \t]*\d+(?:\.\d+)*[.)][ \t]+/gm, ' ');
  const numbers = new Set<string>();
  for (const m of clean.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)/g)) numbers.add(m[1]);
  const identifiers = new Set<string>();
  for (const m of clean.matchAll(/\b([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+|[A-Z]{3,}|[a-z]+[A-Z][A-Za-z0-9]*)\b/g)) {
    identifiers.add(m[1]);
  }
  return { numbers: [...numbers], identifiers: [...identifiers] };
}

/**
 * 校验：条目里的每个数字/标识符，是否都能在给它的原文里字面找到。
 * 找不到的返回在 missing 里——这就是「模型编了一个数」的证据。
 *
 * 比较时两边都去掉空白：原文写「30 秒」、条目写「30秒」不该算编造。
 * 标识符大小写不敏感（`setnx` vs `SETNX` 不是编造，只是排版）。
 */
export function verifyBody(body: string, sourceTexts: readonly string[]): { ok: boolean; missing: string[] } {
  const flat = sourceTexts.join('\n').replace(/\s+/g, '');
  const lower = flat.toLowerCase();
  const { numbers, identifiers } = claimsOf(body);
  const missing: string[] = [];
  for (const n of numbers) {
    // 两侧都要卡数字边界：原文有「100」不能让条目里的「10」蒙过去。
    // 这是 opt-22 在评测指标上踩过的同一个坑（子串匹配让错答案得了分）。
    const esc = n.replace('.', '\\.');
    if (!new RegExp(`(?<!\\d)${esc}(?!\\d)`).test(flat)) missing.push(n);
  }

  for (const id of identifiers) if (!lower.includes(id.toLowerCase())) missing.push(id);
  return { ok: missing.length === 0, missing };
}
