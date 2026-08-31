import type { Llm } from '../engine/loop.ts';
import type { Msg } from '../engine/types.ts';
import { formatSourceRef, firstJson, extractLinks, hashSources, isValidRef, pageFromMarkdown, parseSourceRef, verifyBody, wikiSlug, type WikiPage, type WikiPageType } from './wiki.ts';
import type { KbChunk, KbStore } from './store.ts';
import type { WikiStore } from './wikiStore.ts';

/**
 * wiki 生成管线（Ingest）：原文 → 条目。
 *
 * 三步，只有前两步调模型：
 *   1. 结构阶段：看标题树 + 每块首句，决定该拆成哪几页，并把**原文块互斥分配**给页面
 *   2. 编译阶段：每页只喂给它自己那份块，写成「结论 + 依据」
 *   3. 校验阶段（不调模型）：条目里的数字/标识符必须能在它引用的块里字面找到
 *
 * 第 1 步的「互斥分配」是照 deepwiki-open 公开承认的缺陷设计的：
 * 它每页独立生成、各自去检索上下文，结果跨页内容大量重复。
 * 在我们这儿重复的代价更直接——重复条目会在检索时互相挤占那 800 token 的注入预算。
 * 所以块的归属在结构阶段就定死，编译时模型只看得到自己那份。
 *
 * 第 3 步是 WeKnora / deepwiki 都没有的一道闸：他们的 wiki 有人管，
 * 我们是自己让 LLM 编译原文，必须有机械校验，否则 wiki 就是个更精致的幻觉放大器。
 */

/** 结构阶段的产物：一页的骨架 */
export interface PagePlan {
  ref: string;
  title: string;
  type: WikiPageType;
  /** 分配给这一页的原文块序号 */
  chunks: number[];
}

const STRUCT_SYSTEM = [
  '你在规划一个中文资料库的 wiki 结构。给你一篇资料的分块清单（序号 + 标题路径 + 首句），',
  '你决定它该被编译成哪几个条目页面，并把每个块分配给一个页面。',
  '',
  '规则：',
  '1. 必须有且只有一个 type=source 的页面，代表这篇资料本身（做导航用）。',
  '2. 其余页面 type=concept，一个「有具体数值约定的机制/约定」一页。',
  '3. 判据：有自己的数值约定（超时/周期/次数/阈值/编号格式/时间点）、',
  '   或被两处以上提到、或用户会单独提问它 —— 满足任一就单独成页。',
  '4. **一个块只能分配给一个 concept 页**（source 页不参与分配，它看全篇）。',
  '   拿不准归谁的块就不要分配，宁可少分。',
  '5. 页面别太碎：一句话就说完、没有数字的东西不要单独成页。',
  '6. ref 用 `concept/<中文原词>`，不要翻译、不要拼音、不要空格。',
  '',
  '只输出 JSON：{"pages":[{"ref":"source/xxx","title":"xxx","type":"source","chunks":[]},',
  '{"ref":"concept/分布式锁","title":"分布式锁","type":"concept","chunks":[2,3]}]}',
].join('\n');

const COMPILE_SYSTEM_TAIL = [
  '',
  '现在编译**一个**条目页面。直接输出这一页的文件内容：',
  '第一行是 `---`，接着是 frontmatter 字段，再一行 `---`，之后是 Markdown 正文。',
  '前后不要任何解释文字，不要包在代码块里。',
].join('\n');

/** 格式跑偏时的一次纠正重发。带上原输出，让模型改格式而不是重写内容 */
const REPAIR_USER = [
  '你刚才的输出不能用：缺少 frontmatter 分隔符。',
  '请把**同样的内容**重发一遍，只改格式：第一行就是 `---`，之后是 frontmatter 字段，',
  '再一行 `---`，然后是 Markdown 正文。正文不要放在 `body:` 字段里，也不要用代码块包住整页。',
].join('\n');

/** 分块清单：只给序号、标题路径、首句——结构决策不需要全文，省 token */
export function outlineOf(chunks: readonly KbChunk[], maxChars = 90): string {
  return chunks
    .map((c) => {
      const first = c.text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
      return `#${c.index} [${c.headingPath}] ${first}`;
    })
    .join('\n');
}

/**
 * 把模型给的结构清理成可用的计划：
 * 非法 ref 用标题重造、类型只认 source/concept、块序号越界丢掉、
 * 同一个块被多页抢时**先到先得**（模型经常无视互斥规则）。
 */
export function normalizePlan(raw: unknown, doc: { id: string; title: string }, chunkCount: number): PagePlan[] {
  const pages = (raw as { pages?: unknown })?.pages;
  const out: PagePlan[] = [];
  const taken = new Set<number>();
  const seenRef = new Set<string>();
  for (const item of Array.isArray(pages) ? pages : []) {
    const o = item as { ref?: unknown; title?: unknown; type?: unknown; chunks?: unknown };
    const type: WikiPageType = o.type === 'source' ? 'source' : 'concept';
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : String(o.ref ?? '').split('/').pop() ?? '';
    if (!title) continue;
    let ref = typeof o.ref === 'string' ? o.ref.trim() : '';
    // source 页的 ref 由文档定死，不听模型的。模型每轮给的 slug 会飘
    // （真实跑出来过 `调度服务 SDD` / `调度服务-SDD` / `调度服务SDD` 三个版本），
    // 一篇资料因此在 wiki 里留下三个孤儿摘要页——正是我们想避免的跨页重复。
    if (type === 'source') ref = `source/${wikiSlug(doc.title)}`;
    else if (!isValidRef(ref) || !ref.startsWith(`${type}/`)) ref = `${type}/${wikiSlug(title)}`;
    if (seenRef.has(ref)) continue;
    seenRef.add(ref);
    const chunks: number[] = [];
    if (type === 'concept') {
      for (const n of Array.isArray(o.chunks) ? o.chunks : []) {
        const i = Number(n);
        if (!Number.isInteger(i) || i < 0 || i >= chunkCount) continue;
        if (taken.has(i)) continue; // 互斥：先到先得
        taken.add(i);
        chunks.push(i);
      }
      // 一个块都没分到的 concept 页没有依据可写，直接丢掉
      if (!chunks.length) {
        seenRef.delete(ref);
        continue;
      }
    }
    out.push({ ref, title, type, chunks: chunks.sort((a, b) => a - b) });
  }
  // 兜底：模型没给 source 页就补一个
  if (!out.some((p) => p.type === 'source')) {
    out.unshift({ ref: `source/${wikiSlug(doc.title)}`, title: doc.title, type: 'source', chunks: [] });
  }
  return out;
}

/** 长文只喂头尾——source 页写的是导航，不需要读完全文 */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.floor(maxChars * 0.7))}\n…（中间略）…\n${text.slice(-Math.floor(maxChars * 0.3))}`;
}

/**
 * 把模型输出削到 frontmatter 开头。
 * 提示词里明写了"前后不要任何解释文字、不要包代码块"，但模型照旧会加
 * 「好的，以下是条目：」再套一层 ```markdown。原来只剥**行首**的围栏，
 * 一旦前面多一句话就剥不掉，整页按"缺 frontmatter"失败——
 * 真实跑一次 8 页里 3 页栽在这上面。改成直接定位第一行独立的 `---`。
 */
export function stripToFrontmatter(raw: string): string {
  const m = /(?:^|\n)---[ \t]*\n/.exec(raw);
  const text = m ? raw.slice(m.index + (raw[m.index] === '\n' ? 1 : 0)) : raw.trim();
  return text.replace(/\n[ \t]*```[ \t]*$/, '\n').trimEnd();
}

/**
 * 补回模型漏掉的 `---` 分隔符。
 *
 * 反复出现的一种形态：字段都在、正文也在，就是不写分隔符——
 *   ```
 *   ref: concept/分布式锁
 *   title: 分布式锁
 *   ## 结论
 *   …
 *   ```
 * 这不是内容问题，是它把分隔符当成了展示用的装饰。既然开头连续几行确实是
 * `key: value` 且含 ref/title/type，那么"正文从第一行不是字段的地方开始"是确定的，
 * 补分隔符不涉及任何猜测。**只补标点，不补内容**——字段值和正文一个字都不动。
 */
export function salvageFrontmatter(raw: string): string {
  if (/^---[ \t]*\n/.test(raw)) return raw;
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head: string[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    const isField = /^[A-Za-z_][\w-]*:/.test(l);
    // 块状列表项和折叠标量的续行都算前一个字段的一部分
    const isCont = head.length > 0 && /^[ \t]+\S/.test(l);
    if (!isField && !isCont) break;
    head.push(l);
  }
  if (!head.some((l) => /^(ref|title|type):/.test(l))) return raw;
  const body = lines.slice(i).join('\n').trim();
  if (!body) return raw; // `body: |` 那种把正文塞进字段的形态救不了，交给重发
  return `---\n${head.join('\n')}\n---\n\n${body}`;
}

/** 失败时留证：模型原话开头，压成一行 */
function snippet(raw: string, max = 120): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s || '（空输出）';
}

export interface BuildResult {
  pages: WikiPage[];
  failed: string[];
}

/**
 * 编译一页。喂进去的是「块编号 + 块正文」，模型引用时要写 `[docId#序号]`。
 * 校验用的原文以 page.sources 为准，从 KbStore 现取——
 * 也就是说模型说自己引用了哪块，我们就按那块去核对，它没法靠"少报来源"绕过校验。
 */
export async function compilePage(
  llm: Llm,
  rules: string,
  doc: { id: string; title: string },
  plan: PagePlan,
  chunks: readonly KbChunk[],
): Promise<WikiPage> {
  const mine = plan.type === 'source' ? chunks : chunks.filter((c) => plan.chunks.includes(c.index));
  const material =
    plan.type === 'source'
      ? clip(mine.map((c) => `【${formatSourceRef(doc.id, c.index)}】[${c.headingPath}]\n${c.text}`).join('\n\n'), 6000)
      : mine.map((c) => `【${formatSourceRef(doc.id, c.index)}】[${c.headingPath}]\n${c.text}`).join('\n\n');

  const messages: Msg[] = [
    { role: 'system', content: `${rules}${COMPILE_SYSTEM_TAIL}` },
    {
      role: 'user',
      content: [
        `【资料】《${doc.title}》（文档 id: ${doc.id}）`,
        `【要编译的条目】ref: ${plan.ref} / title: ${plan.title} / type: ${plan.type}`,
        plan.type === 'source'
          ? '【要求】这是原文摘要页：讲清这篇资料是什么、覆盖哪些主题和章节，不要搬具体数字。'
          : '【要求】这是概念页：结论先行，每条含具体数字的结论后面必须带 [文档id#块号]。',
        '【可用原文块】',
        material,
      ].join('\n'),
    },
  ];

  // 三级容错，按代价从低到高：剥围栏/前言 → 补漏掉的分隔符 → 花一次调用要求重发。
  // 真实跑出来的形态在几轮之间来回变：这次乖乖给 frontmatter，下次给 ```yaml + `body: |`，
  // 再下次字段都对但一个 `---` 都不写。靠改提示词赌不出稳定结果
  //（我试着把格式要求写得更硬，那一轮失败反而更多——n=1，说明不了因果，只说明它不稳）。
  const usable = (s: string): string | undefined => {
    const t = salvageFrontmatter(stripToFrontmatter(s));
    return /^---[ \t]*\n/.test(t) ? t : undefined;
  };

  let raw = (await llm.complete(messages)).text ?? '';
  let text = usable(raw);
  if (!text) {
    // 前两级都救不动（多半是把正文塞进了 `body:` 字段），把原话退回去要求**只改格式重发**。
    // 只在失败时多花一次调用，代价可控；解析器保持严格，不为畸形输出开后门。
    const retry = (await llm.complete([...messages, { role: 'assistant', content: raw }, { role: 'user', content: REPAIR_USER }])).text ?? '';
    const fixed = usable(retry);
    if (fixed) {
      raw = retry;
      text = fixed;
    }
  }
  // 还是不行，多半是在说"我做不到"这类话。宁可这一页失败并把原话记进 failed，
  // 也不要把一段闲聊写成条目。报错里带原话开头——不带的话面板上只看到"缺 frontmatter"，
  // 无从判断是模型拒答、输出被截断、还是格式跑偏。
  if (!text) throw new Error(`模型没按格式输出（缺 frontmatter）：${snippet(raw)}`);
  const parsed = pageFromMarkdown(plan.ref, text);
  if (!parsed.body.trim()) throw new Error('模型没给出正文');

  // 依据 = frontmatter 里声明的 ∪ 正文里真的引了的，**再与分给它的块求交**。
  //
  // 两边都要算：模型经常正文写 `[调度服务-sdd#4]`、frontmatter 里却忘了列 #4，
  // 于是校验语料缺了 #4，那句「低于 95%」被判成编造——这是记账不一致，不是幻觉，
  // 真实跑出来过两次。
  // 求交是这道闸的关键，不能省：只认**它实际被喂到的块**。
  // 模型引用一个它没看过的块，正是"跨页内容泄漏"（也真实抓到过：概念页引 #7 写 NTP），
  // 那种情况必须继续判未通过。
  const allowed = new Set(mine.map((c) => formatSourceRef(doc.id, c.index)));
  const inBody = [...parsed.body.matchAll(/\[([^\]\s]+)#(\d+)\]/g)]
    .filter((m) => m[1] === doc.id)
    .map((m) => formatSourceRef(doc.id, Number(m[2])));
  const claimed = [...new Set([...parsed.sources, ...inBody])]
    .filter((s) => allowed.has(s))
    .sort((a, b) => (parseSourceRef(a)?.index ?? 0) - (parseSourceRef(b)?.index ?? 0));
  const sources = claimed.length ? claimed : mine.map((c) => formatSourceRef(doc.id, c.index));
  const cited = sources
    .map((s) => chunks.find((c) => formatSourceRef(doc.id, c.index) === s))
    .filter((c): c is KbChunk => !!c);
  // 哈希只算块正文——app.ts 的 stale 判定是拿同一批块正文重算的，两边口径必须一致
  const sourceHash = hashSources(cited.map((c) => c.text));
  // 校验语料比哈希语料多两样：**文档标题**和**块的标题路径**。
  // 这两样都在 material 里原样给了模型（`【ref】[headingPath]`），模型引用它们是合规的，
  // 只按块正文校验会把它们判成编造（真实跑出来过：source 页写了「（SDD）」，
  // SDD 只出现在文档标题里，整页因此未通过）。
  const check = verifyBody(parsed.body, [doc.title, ...cited.map((c) => `${c.headingPath}\n${c.text}`)]);

  return {
    ...parsed,
    ref: plan.ref,
    title: parsed.title || plan.title,
    type: plan.type,
    sources,
    // related = frontmatter 里声明的 ∪ 正文里真的写了 [[...]] 的，去掉自引用。
    // 跟 sources 的记账口径一致：模型经常正文写了 [[concept/x]]、frontmatter 里忘了列，
    // 只信 frontmatter 就会在图上少一条边（面板的反向链接、质检的孤岛判定都靠这个字段）。
    // 面板上手改条目走的也是这条口径（web.ts 的 /wiki/page 保存）。
    // 指向还不存在的条目**不过滤**：条目是一页一页生成的，被引的那页可能还没编译到，
    // 按存在性过滤会让结果依赖生成顺序。坏链交给质检的「链接完整」维度报。
    related: [...new Set([...parsed.related, ...extractLinks(parsed.body)])].filter((r) => r !== plan.ref),
    verified: check.ok,
    ...(check.ok ? {} : { unverified: check.missing }),
    sourceHash,
    ts: Date.now(),
  };
}

/**
 * 哪些过期条目该重建、按来源资料分组。
 *
 * 一条条目的依据块全来自同一篇资料，所以取第一个能解析出的 docId 就是它的归属。
 * 解析不出来、或来源资料不在启用中（被归档 / 删了）的挑成 `orphans`：
 * 这种条目**仍然会被注入**，不能悄悄跳过，要报出来让人处理。
 */
export function staleRebuildJobs(
  pages: readonly WikiPage[],
  isStale: (p: WikiPage) => boolean,
  activeDocIds: readonly string[],
): { jobs: { docId: string; only: string[] }[]; orphans: string[] } {
  const byDoc = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const p of pages) {
    if (!isStale(p)) continue;
    const owner = p.sources.map((s) => parseSourceRef(s)?.docId).find((x): x is string => !!x);
    if (!owner || !activeDocIds.includes(owner)) {
      orphans.push(p.ref);
      continue;
    }
    byDoc.set(owner, [...(byDoc.get(owner) ?? []), p.ref]);
  }
  return { jobs: [...byDoc].map(([docId, only]) => ({ docId, only })), orphans };
}

/**
 * 生成一篇资料的全部条目。
 * 增量：`only` 给定时只重建那几个 ref（面板上「重建这一页」用）。
 */
export async function buildDocWiki(
  llm: Llm,
  kb: KbStore,
  wiki: WikiStore,
  docId: string,
  opts: { only?: string[] } = {},
): Promise<BuildResult> {
  const doc = kb.find(docId);
  if (!doc) throw new Error(`没有这篇资料: ${docId}`);
  const chunks = kb.chunksOf(doc.id);
  if (!chunks.length) throw new Error(`《${doc.title}》没有可用的分块`);

  const rules = wiki.rules();
  const structOut = await llm.complete([
    { role: 'system', content: STRUCT_SYSTEM },
    { role: 'user', content: `【资料】《${doc.title}》（共 ${chunks.length} 块）\n【分块清单】\n${outlineOf(chunks)}` },
  ]);
  const plans = normalizePlan(firstJson(structOut.text ?? ''), doc, chunks.length).filter(
    (p) => !opts.only?.length || opts.only.includes(p.ref),
  );

  const pages: WikiPage[] = [];
  const failed: string[] = [];
  for (const plan of plans) {
    try {
      const page = await compilePage(llm, rules, doc, plan, chunks);
      wiki.write(page);
      pages.push(page);
    } catch (e) {
      failed.push(`${plan.ref}（${(e as Error).message}）`);
    }
  }
  return { pages, failed };
}
