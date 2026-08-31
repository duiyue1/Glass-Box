import type { Llm } from '../engine/loop.ts';
import { backlinksOf, extractLinks, firstJson, type WikiPage } from './wiki.ts';

/**
 * wiki 质检：给这一层知识打一个分，并把分数按次落盘，好看趋势。
 *
 * 为什么要有它：wiki 是 LLM 编译出来的，**质量会随生成轮次抖动**
 * （opt-24 实测：同一份提示词同一份资料，几轮之间格式失败数在 0~4 之间跳，
 * 有几轮模型压根不写 summary/aliases）。没有一个能重复计算的分数，
 * 「改了 AGENTS.md 之后是变好还是变坏」只能靠印象。
 *
 * 六个维度**全部机械计算、不调模型**，所以同一份 wiki 反复跑分数完全一样，
 * 趋势线上的每个变化都对应一次真实改动，而不是采样抖动。
 * 这是 opt-22 量到 judgeSpread=0.70 之后定下的规矩：
 * **要进趋势线的数字，必须是确定性的。**
 *
 * ⚠️ 口径变更（opt-38）：加了第六维「链接完整」，可检索 0.15→0.1、精炼去重 0.2→0.15。
 * 所以 `quality.jsonl` 里 opt-38 之前的综合分**与之后不可直接比**，
 * 单个维度的分仍然可比。
 *
 * 模型只做一件事：抽几条条目评「写得好不好」（`reviewSample`）。
 * 它的结果**单独显示、不并入综合分、不进趋势线**——它会抖，混进去会让趋势失真。
 */

/** 一个维度的得分。weight 之和为 1 */
export interface AuditDim {
  key: 'provenance' | 'freshness' | 'coverage' | 'retrievable' | 'distinct' | 'links';
  label: string;
  /** 0~100 */
  score: number;
  weight: number;
  /** 一句话说清这个分是怎么来的 */
  detail: string;
  /** 具体扣分项，面板上可点跳到条目 */
  issues: string[];
}

/** 模型抽检一条条目的结果 */
export interface AuditSampleItem {
  ref: string;
  /** 0~2，跟评测那套量表一致 */
  score: number;
  note: string;
}

export interface AuditSample {
  n: number;
  avg: number;
  items: AuditSampleItem[];
  failed: string[];
}

export interface AuditReport {
  ts: number;
  pages: number;
  /** 五维加权，0~100，确定性 */
  score: number;
  dims: AuditDim[];
  /** 模型抽检，可能没有（没接模型 / 只读上次结果） */
  sample?: AuditSample;
}

/** 趋势线上的一个点：只留数字，不留问题清单 */
export interface AuditPoint {
  ts: number;
  score: number;
  pages: number;
  dims: Record<string, number>;
}

const pct = (a: number, b: number): number => (b <= 0 ? 0 : Math.round((a / b) * 1000) / 10);

/**
 * 把正文切成「可比对的句子」：去掉出处标记、条目链接、Markdown 记号和所有空白。
 * 只留够长的句子——短句（「结论」「不做无限重试」）在多页里重复是正常的，
 * 拿它算重复度会把分数压得毫无意义。
 */
export function sentencesOf(body: string, minChars = 14): string[] {
  const clean = body
    .replace(/\[[^\]]*#\d+\]/g, '')
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/^[ \t>]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*`>]/g, '');
  return clean
    .split(/[。！？\n]+/)
    .map((s) => s.replace(/\s+/g, ''))
    .filter((s) => s.length >= minChars);
}

/**
 * 六维机械打分。
 *
 * @param pages     全部条目
 * @param allChunks 启用中资料的全部块引用（`docId#序号`），用来算原文覆盖和「无主条目」
 * @param isStale   条目是否已失效（依据块内容变了）——由调用方给，这个模块不认识 KbStore
 */
export function auditWiki(
  pages: readonly WikiPage[],
  allChunks: readonly string[],
  isStale: (p: WikiPage) => boolean,
): AuditReport {
  const total = pages.length;
  const dims: AuditDim[] = [];

  /* 1. 溯源可信：条目里的数字/标识符能不能在它引用的原文里字面找到。
        权重最高——过不了这一关的条目根本不该拿去回答问题。 */
  const bad = pages.filter((p) => !p.verified);
  dims.push({
    key: 'provenance',
    label: '溯源可信',
    score: pct(total - bad.length, total),
    weight: 0.3,
    detail: `${total - bad.length}/${total} 条通过溯源校验`,
    issues: bad.map((p) => `${p.ref} — 找不到出处的字面：${(p.unverified ?? []).join('、') || '未记录'}`),
  });

  /* 2. 时效新鲜：原文改过、条目没重编译 = 这页在说过期的话。
        这是开源 wiki 普遍没有的一项（BookStack / Wiki.js / Outline
        都不知道一篇文章什么时候不再成立）。 */
  const stale = pages.filter((p) => isStale(p));
  dims.push({
    key: 'freshness',
    label: '时效新鲜',
    score: pct(total - stale.length, total),
    weight: 0.15,
    detail: `${stale.length} 条的依据原文已改动，需要重新编译`,
    issues: stale.map((p) => `${p.ref} — 依据原文已改动`),
  });

  /* 3. 原文覆盖：只算 concept 页。
        source 页天生引用全篇，把它算进来覆盖率永远接近 100%，这个维度就废了。
        没被任何 concept 页引用的块 = 原文里有结论但没编译进知识。 */
  const cited = new Set<string>();
  for (const p of pages) {
    if (p.type !== 'concept') continue;
    for (const s of p.sources) cited.add(s);
  }
  const uncovered = allChunks.filter((c) => !cited.has(c));
  dims.push({
    key: 'coverage',
    label: '原文覆盖',
    score: pct(allChunks.length - uncovered.length, allChunks.length),
    weight: 0.2,
    detail: `${allChunks.length - uncovered.length}/${allChunks.length} 个原文块被概念条目引用`,
    issues: uncovered.slice(0, 12).map((c) => `${c} — 没有任何概念条目引用它`),
  });

  /* 4. 可检索：摘要和别名齐不齐。
        摘要进目录索引（决定模型要不要点开这页），别名决定用户换个说法还能不能命中。
        这两样空着，条目写得再好也召不回来——真实跑出来 8 页里有 3 页两样全空。 */
  let ready = 0;
  const notReady: string[] = [];
  for (const p of pages) {
    const hasSummary = p.summary.trim().length > 0;
    const hasAliases = p.aliases.length >= 3;
    ready += (hasSummary ? 0.5 : 0) + (hasAliases ? 0.5 : 0);
    if (hasSummary && hasAliases) continue;
    const why = [!hasSummary ? '缺摘要' : '', !hasAliases ? `别名只有 ${p.aliases.length} 个（要 ≥3）` : '']
      .filter(Boolean)
      .join('、');
    notReady.push(`${p.ref} — ${why}`);
  }
  dims.push({
    key: 'retrievable',
    label: '可检索',
    score: pct(ready, total),
    weight: 0.1,
    detail: `按「有摘要」「别名 ≥3」各半分算，${notReady.length} 条不齐`,
    issues: notReady,
  });

  /* 5. 精炼去重：条目之间不该重复。
        deepwiki-open 公开承认的缺陷就是每页独立生成导致跨页大量重复，
        我们用「原文块互斥分配」对治，这一维是检查它到底有没有生效。
        重复条目在检索时互相挤占注入预算，比缺页更坏。 */
  const owner = new Map<string, string[]>();
  let sentences = 0;
  for (const p of pages) {
    for (const s of sentencesOf(p.body)) {
      sentences++;
      const list = owner.get(s) ?? [];
      if (!list.includes(p.ref)) list.push(p.ref);
      owner.set(s, list);
    }
  }
  const dupes = [...owner.entries()].filter(([, refs]) => refs.length > 1);
  const dupSentences = dupes.reduce((n, [, refs]) => n + refs.length, 0);
  dims.push({
    key: 'distinct',
    label: '精炼去重',
    score: sentences ? pct(sentences - dupSentences, sentences) : 100,
    weight: 0.15,
    detail: sentences ? `${dupes.length} 句出现在多个条目里（共 ${sentences} 句）` : '还没有可比对的正文',
    issues: dupes.slice(0, 12).map(([s, refs]) => `${refs.join(' / ')} — 重复：${s.slice(0, 40)}…`),
  });

  /* 6. 链接完整：条目之间的图有没有断。三类问题，都是机械可判的：
        - **坏链**：`[[...]]` 指向不存在的条目。Dendron 的 Doctor 有 findBrokenLinks、
          Obsidian 靠社区插件找断链，这类检查在成熟 wiki 里是例行体检项，我们过去零检查。
        - **孤岛**：既没人引用它、它也不引用别人。这种页只能靠目录直接命中，
          图上完全孤立——模型顺着一页摸不到它。source 页不算（它本来就是入口）。
        - **无主**：它引用的原文块**全都不在启用中的资料里**了。
          `buildDocWiki` 只写不删，改版后旧 ref 的 .md 会留在盘上，
          而它照样被 `list()` 读出来、照样进目录。

        权重只给 0.1：断链影响的是"顺着链摸下去"的体验，比编造和过期轻。 */
  const known = new Set(pages.map((p) => p.ref));
  const back = backlinksOf(pages);
  const chunkSet = new Set(allChunks);
  const issues: string[] = [];
  const badRefs = new Set<string>();
  for (const p of pages) {
    const out = new Set([...p.related, ...extractLinks(p.body)].filter((r) => r !== p.ref));
    const dangling = [...out].filter((r) => !known.has(r));
    if (dangling.length) {
      badRefs.add(p.ref);
      issues.push(`${p.ref} — 坏链，指向不存在的条目：${dangling.join('、')}`);
    }
    const linked = out.size > 0 || (back.get(p.ref) ?? []).length > 0;
    // 只有一条条目时不判孤岛：没有别的页可连，"孤立"不是缺陷
    if (!linked && p.type !== 'source' && total > 1) {
      badRefs.add(p.ref);
      issues.push(`${p.ref} — 孤岛，没有任何条目引用它，它也不引用别人`);
    }
    // 一条依据都不在启用中资料里 = 它的原文没了。没声明依据的不算（无从判断）
    if (p.sources.length && !p.sources.some((s) => chunkSet.has(s))) {
      badRefs.add(p.ref);
      issues.push(`${p.ref} — 无主，它引用的原文块都不在启用中的资料里了`);
    }
  }
  dims.push({
    key: 'links',
    label: '链接完整',
    score: pct(total - badRefs.size, total),
    weight: 0.1,
    detail: `${badRefs.size}/${total} 条有链接问题（坏链 / 孤岛 / 无主）`,
    issues: issues.slice(0, 12),
  });

  const score = Math.round(dims.reduce((sum, d) => sum + d.score * d.weight, 0) * 10) / 10;
  return { ts: Date.now(), pages: total, score, dims };
}

/* ── 模型抽检（会花钱、会抖，所以不进综合分）────────────────── */

const REVIEW_SYSTEM = [
  '你在抽检一个中文知识库的条目质量。给你一条条目的正文和它引用的原文块。',
  '按四条判断（每条只看合格 / 不合格）：',
  '1. 结论先行：第一句就是答案，不是背景铺垫',
  '2. 出处齐全：每条带具体数字的结论后面都有 [文档id#块号]',
  '3. 状态标记：被否决 / 历史的方案有没有标出来（漏标是严重问题，会让人把废弃结论当现行）',
  '4. 忠实：说法与原文一致，没有换算单位、改写术语、补充原文没有的内容',
  '',
  '打分：2 = 四条都合格；1 = 有一条不合格；0 = 两条以上不合格，或出现了原文里没有的内容。',
  '只输出 JSON：{"score":2,"note":"一句话说清最主要的问题，没问题就写「无明显问题」"}',
].join('\n');

/**
 * 均匀抽 n 条（按 ref 排序后等距取），不是随机——
 * 同一份 wiki 抽到的是同一批条目，两次抽检结果之间才可比。
 * 优先抽 concept 页：source 页是导航，本来就不该有数字和状态标记。
 */
export function pickSample<T extends { ref: string; type: string }>(pages: readonly T[], n: number): T[] {
  const pool = pages.filter((p) => p.type === 'concept').sort((a, b) => a.ref.localeCompare(b.ref));
  const src = pool.length ? pool : [...pages].sort((a, b) => a.ref.localeCompare(b.ref));
  if (src.length <= n) return src;
  const step = src.length / n;
  return Array.from({ length: n }, (_, i) => src[Math.floor(i * step)]);
}

/**
 * 抽检：每条一次模型调用。单条失败只记进 failed，不影响别的条目和机械分。
 * @param sourcesOf 给一条条目的依据块正文（调用方从 KbStore 取）
 */
export async function reviewSample(
  llm: Llm,
  pages: readonly WikiPage[],
  sourcesOf: (p: WikiPage) => string[],
  n = 3,
): Promise<AuditSample> {
  const picked = pickSample(pages, n);
  const items: AuditSampleItem[] = [];
  const failed: string[] = [];
  for (const p of picked) {
    try {
      const out = await llm.complete([
        { role: 'system', content: REVIEW_SYSTEM },
        {
          role: 'user',
          content: [
            `【条目】${p.ref}`,
            `【摘要】${p.summary || '（空）'}`,
            '【正文】',
            p.body,
            '【它引用的原文块】',
            sourcesOf(p).join('\n---\n') || '（取不到原文）',
          ].join('\n'),
        },
      ]);
      const o = firstJson(out.text ?? '') as { score?: unknown; note?: unknown } | undefined;
      const s = Number(o?.score);
      if (!Number.isFinite(s)) throw new Error('模型没给出可用的分数');
      items.push({
        ref: p.ref,
        score: Math.max(0, Math.min(2, Math.round(s))),
        note: typeof o?.note === 'string' ? o.note : '',
      });
    } catch (e) {
      failed.push(`${p.ref}（${(e as Error).message}）`);
    }
  }
  const avg = items.length ? Math.round((items.reduce((a, i) => a + i.score, 0) / items.length) * 100) / 100 : 0;
  return { n: items.length, avg, items, failed };
}

/** 报告 → 趋势点（丢掉问题清单，只留数字，历史文件才不会越滚越大） */
export function pointOf(r: AuditReport): AuditPoint {
  const dims: Record<string, number> = {};
  for (const d of r.dims) dims[d.key] = d.score;
  return { ts: r.ts, score: r.score, pages: r.pages, dims };
}
