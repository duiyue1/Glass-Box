import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backlinksOf,
  claimsOf,
  extractLinks,
  hashSources,
  isValidRef,
  pageFromMarkdown,
  pageToMarkdown,
  parseFrontmatter,
  parseSourceRef,
  verifyBody,
  wikiSlug,
  type WikiPage,
} from '../src/kb/wiki.ts';
import { WikiStore, catalogForPrompt, indexMarkdown, pickCatalog } from '../src/kb/wikiStore.ts';
import { buildWikiGraph, wikiImpact } from '../src/kb/wikiGraph.ts';
import { wikiProvider } from '../src/kb/wikiProvider.ts';
import { needsSummary, normalizeDraft, summarizePage } from '../src/kb/wikiSummary.ts';
import { compilePage, normalizePlan, outlineOf, salvageFrontmatter, staleRebuildJobs } from '../src/kb/wikiBuild.ts';
import { KbStore } from '../src/kb/store.ts';
import { Wire } from '../src/engine/wire.ts';
import type { Llm } from '../src/engine/loop.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-wiki-'));
}

const page = (over: Partial<WikiPage> = {}): WikiPage => ({
  ref: 'concept/分布式锁',
  title: '分布式锁',
  type: 'concept',
  summary: '讲锁与续租约定',
  aliases: ['抢锁失败'],
  sources: ['调度服务-sdd#2'],
  related: [],
  verified: true,
  sourceHash: 'abc',
  ts: 1_700_000_000_000,
  body: '## 结论\n\n锁的 TTL 是 30 秒。[调度服务-sdd#2]',
  ...over,
});

/* ── frontmatter ── */

test('frontmatter：标量与数组都能读，没有 frontmatter 时整体当正文', () => {
  const { data, body } = parseFrontmatter('---\nref: concept/a\naliases: [x, y]\n---\n\n正文');
  assert.equal(data.ref, 'concept/a');
  assert.deepEqual(data.aliases, ['x', 'y']);
  assert.equal(body, '正文');
  // 没有 frontmatter：不该把第一行吃掉
  assert.equal(parseFrontmatter('# 标题\n正文').body, '# 标题\n正文');
  // 只有开头没有结尾：当成没有 frontmatter，而不是把全文吞掉
  assert.equal(parseFrontmatter('---\nref: x\n还没写完').body.includes('还没写完'), true);
});

test('frontmatter：块状列表与折叠标量也认（模型会这么写）', () => {
  const { data, body } = parseFrontmatter(
    [
      '---',
      'summary: >',
      '  调度服务用 Redis 租约锁，',
      '  含续租与抢锁失败约定。',
      'aliases:',
      '  - 获取锁超时',
      '  - 拿不到锁',
      '---',
      '',
      '正文',
    ].join('\n'),
  );
  assert.equal(data.summary, '调度服务用 Redis 租约锁， 含续租与抢锁失败约定。');
  assert.deepEqual(data.aliases, ['获取锁超时', '拿不到锁']);
  assert.equal(body, '正文');
});

test('pageToMarkdown / pageFromMarkdown 往返不丢字段', () => {
  const p = page({ related: ['concept/续租'], verified: false, unverified: ['99'] });
  const back = pageFromMarkdown(p.ref, pageToMarkdown(p));
  assert.equal(back.title, p.title);
  assert.equal(back.summary, p.summary);
  assert.deepEqual(back.aliases, p.aliases);
  assert.deepEqual(back.sources, p.sources);
  assert.deepEqual(back.related, p.related);
  assert.equal(back.verified, false);
  assert.deepEqual(back.unverified, ['99']);
  assert.equal(back.sourceHash, p.sourceHash);
  assert.equal(back.body, p.body);
});

test('ref 与 slug：挡住路径穿越和未知类型', () => {
  assert.ok(isValidRef('concept/分布式锁'));
  assert.ok(!isValidRef('concept/a/b'), '斜杠会变成子目录，不允许');
  assert.ok(!isValidRef('../etc/passwd'));
  assert.ok(!isValidRef('unknown/x'), '类型必须是已知的几种');
  assert.ok(!isValidRef('concept/.hidden'));
  assert.equal(wikiSlug('调度服务 / SDD'), '调度服务-SDD');
  assert.equal(wikiSlug('../../etc'), 'etc');
});

test('parseSourceRef 解析块引用', () => {
  assert.deepEqual(parseSourceRef('调度服务-sdd#2'), { docId: '调度服务-sdd', index: 2 });
  assert.equal(parseSourceRef('没有井号'), undefined);
  assert.equal(parseSourceRef('doc#abc'), undefined);
});

/* ── 交叉引用 ── */

test('extractLinks / backlinksOf：谁引用了我', () => {
  assert.deepEqual(extractLinks('见 [[concept/续租]] 和 [[bad ref]] 与 [[concept/续租]]'), ['concept/续租']);
  const pages = [
    page({ ref: 'concept/a', body: '见 [[concept/b]]' }),
    page({ ref: 'concept/b', body: '无' }),
    page({ ref: 'concept/c', related: ['concept/b'], body: '无' }),
  ];
  const back = backlinksOf(pages);
  assert.deepEqual(back.get('concept/b'), ['concept/a', 'concept/c']);
  assert.equal(back.get('concept/a'), undefined);
});

test('buildWikiGraph：统一生成显式链接、来源支撑、同源和断链关系', () => {
  const pages = [
    page({ ref: 'concept/a', sources: ['doc#1'], related: ['concept/b'], body: '见 [[concept/b]]' }),
    page({ ref: 'concept/b', sources: ['doc#1'], body: '无' }),
    page({ ref: 'concept/c', sources: ['doc#2'], related: ['concept/missing'], body: '无' }),
  ];
  const graph = buildWikiGraph(pages);
  assert.equal(graph.metadata.pageCount, 3);
  assert.equal(graph.metadata.sourceChunkCount, 2);
  assert.equal(graph.metadata.danglingCount, 1);
  assert.equal(graph.metadata.isolatedCount, 0);
  assert.ok(graph.edges.some((e) => e.source === 'concept/a' && e.target === 'concept/b' && e.type === 'wiki_link'));
  assert.ok(graph.edges.some((e) => e.source === 'concept/a' && e.target === 'source_chunk:doc#1' && e.type === 'supports'));
  assert.ok(graph.edges.some((e) => e.source === 'concept/a' && e.target === 'concept/b' && e.type === 'same_source'));
  assert.ok(graph.edges.some((e) => e.source === 'concept/c' && e.target === 'concept/missing' && e.type === 'dangling'));
  assert.equal(graph.nodes.find((n) => n.id === 'concept/b')?.backlinks?.[0], 'concept/a');
});

test('wikiImpact：页面和来源块都能展开上下游，忽略断链', () => {
  const graph = buildWikiGraph([
    page({ ref: 'concept/a', sources: ['doc#1'], related: ['concept/b'], body: '[[concept/b]]' }),
    page({ ref: 'concept/b', sources: ['doc#2'], body: '无' }),
  ]);
  const pageImpact = wikiImpact(graph, 'concept/a', 1);
  assert.ok(pageImpact.some((item) => item.id === 'concept/b' && item.direction === 'outgoing' && item.via === 'wiki_link'));
  assert.ok(pageImpact.some((item) => item.id === 'source_chunk:doc#1' && item.via === 'supports'));
  const sourceImpact = wikiImpact(graph, 'source_chunk:doc#1', 2);
  assert.ok(sourceImpact.some((item) => item.id === 'concept/a' && item.direction === 'incoming'));
});

test('buildWikiGraph：没有链接和来源的非 source 页面报告孤立问题', () => {
  const graph = buildWikiGraph([page({ ref: 'concept/孤立', sources: [], related: [], body: '无' }), page({ ref: 'concept/另一个', sources: [], related: [], body: '无' })]);
  assert.equal(graph.metadata.isolatedCount, 2);
  assert.deepEqual(graph.issues.filter((i) => i.code === 'isolated_page').map((i) => i.ref), ['concept/孤立', 'concept/另一个']);
});

/* ── 溯源校验（这一层的安全闸）── */

test('claimsOf 抽数字与标识符，但不把块引用里的编号当内容', () => {
  const c = claimsOf('锁 TTL 是 30 秒，用 SETNX 抢锁。[调度服务-sdd#2] 见 [[concept/续租]]');
  assert.ok(c.numbers.includes('30'));
  assert.ok(!c.numbers.includes('2'), '块引用里的 #2 是出处，不是条目内容');
  assert.ok(c.identifiers.includes('SETNX'));
});

test('claimsOf 不把 Markdown 排版序号当声明', () => {
  // 真实误报：一段「被否决的三个方案」用有序列表写，1/2 被送去校验，原文里没有独立的 1/2
  const c = claimsOf(['## 3. 被否决的方案', '', '1. MySQL 行锁：压测到 QPS 200 退化。', '- 2) ZooKeeper：无现成集群。'].join('\n'));
  assert.deepEqual(c.numbers.sort(), ['200'], '只剩真正的内容数字');
});

test('verifyBody：数字对不上就报出来，空格与大小写差异不算编造', () => {
  const src = ['抢锁用 redis SETNX，锁的 TTL 是 30 秒，续租周期 10 秒。'];
  assert.deepEqual(verifyBody('TTL 是 30 秒，续租 10 秒。', src), { ok: true, missing: [] });
  // 「30秒」没空格，原文有空格 —— 不该算编造
  assert.ok(verifyBody('TTL 30秒', src).ok);
  // 大小写不同的标识符不算编造
  assert.ok(verifyBody('用 setnx 抢锁', src).ok);
  // 真编了一个数
  const bad = verifyBody('TTL 是 45 秒', src);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['45']);
  // 编了一个原文没有的标识符
  assert.ok(verifyBody('返回 LOCK_BUSY', src).missing.includes('LOCK_BUSY'));
});

test('verifyBody 不做数字前缀误判：原文有 100 不能让 10 过关', () => {
  // 这是 opt-22 在评测指标上踩过的同一个坑：子串匹配会让错答案得分
  const r = verifyBody('阈值是 10', ['常见配置是 100']);
  assert.equal(r.ok, false, '100 里的 10 不算出处');
});

/* ── 存储 ── */

test('WikiStore：写读删、按类型分组、非法 ref 拒绝落盘', () => {
  const dir = tmpDir();
  const wiki = new WikiStore(path.join(dir, 'wiki'));
  wiki.write(page());
  wiki.write(page({ ref: 'source/调度服务-sdd', type: 'source', title: '调度服务 SDD', sources: [] }));
  assert.equal(wiki.count(), 2);
  assert.equal(wiki.read('concept/分布式锁')?.title, '分布式锁');
  // 条目就是普通 .md 文件，可以直接用编辑器打开
  assert.ok(fs.existsSync(path.join(dir, 'wiki', 'concept', '分布式锁.md')));
  const tree = wiki.tree();
  assert.deepEqual(tree.groups.map((g) => g.type), ['source', 'concept']);
  assert.equal(tree.total, 2);
  assert.throws(() => wiki.write(page({ ref: '../escape' })), /非法的 ref/);
  assert.equal(wiki.remove('concept/分布式锁'), true);
  assert.equal(wiki.count(), 1);
});

test('WikiStore 版本：快照、diff、回滚只追加历史', () => {
  const dir = tmpDir();
  const wiki = new WikiStore(path.join(dir, 'wiki'));
  wiki.write(page({ summary: '旧摘要' }));
  const v1 = wiki.snapshot('initial');
  wiki.write(page({ summary: '新摘要' }));
  const diff = wiki.diff(v1.id);
  assert.equal(diff.find((item) => item.ref === 'concept/分布式锁')?.status, 'updated');
  const v2 = wiki.rollback(v1.id);
  assert.ok(v2);
  assert.equal(wiki.read('concept/分布式锁')?.summary, '旧摘要');
  assert.equal(wiki.versions().length, 3);
  assert.match(wiki.versions()[0].message, /restore/);
});

test('WikiStore.tree：校验没过 / 原文改过都要标出来', () => {
  const dir = tmpDir();
  const wiki = new WikiStore(path.join(dir, 'wiki'));
  wiki.write(page({ sourceHash: hashSources(['原来的正文']), verified: false, unverified: ['45'] }));
  // 解析函数返回不同的哈希 = 原文改过
  const stale = wiki.tree(() => hashSources(['改过的正文'])).groups[0].pages[0];
  assert.equal(stale.stale, true);
  assert.equal(stale.verified, false);
  assert.deepEqual(stale.unverified, ['45']);
  // 哈希一致就不是 stale
  assert.equal(wiki.tree(() => hashSources(['原来的正文'])).groups[0].pages[0].stale, false);
  assert.equal(wiki.tree().unverified, 1);
});

test('rules()：首次读取会把仓库里的默认模板复制到工作区', () => {
  const dir = tmpDir();
  const wiki = new WikiStore(path.join(dir, 'wiki'));
  const text = wiki.rules();
  assert.match(text, /wiki 生成规则/);
  const copied = path.join(dir, 'wiki', 'AGENTS.md');
  assert.ok(fs.existsSync(copied), '应该复制到工作区，之后只读用户那一份');
  // 用户改过之后不会被覆盖
  fs.writeFileSync(copied, '我自己的规则');
  assert.equal(new WikiStore(path.join(dir, 'wiki')).rules(), '我自己的规则');
});

test('indexMarkdown / catalogForPrompt：目录给人看，注入版只给通过校验的', () => {
  const pages = [page(), page({ ref: 'concept/续租', title: '续租', summary: '续租周期', verified: false })];
  const idx = indexMarkdown(pages);
  assert.match(idx, /\[\[concept\/分布式锁\]\]/);
  assert.match(idx, /未通过溯源校验/);
  const prompt = catalogForPrompt(pages);
  assert.match(prompt, /concept\/分布式锁/);
  assert.ok(!prompt.includes('concept/续租'), '没通过校验的条目不进注入目录');
  assert.equal(catalogForPrompt([]), '');
});

test('pickCatalog：缺摘要和没通过校验的都落选，并说清原因', () => {
  const pages = [
    page(),
    page({ ref: 'concept/续租', title: '续租', verified: false }),
    page({ ref: 'concept/重试', title: '重试', summary: '  ' }),
  ];
  const pick = pickCatalog(pages);
  assert.deepEqual(pick.pages.map((p) => p.ref), ['concept/分布式锁']);
  assert.deepEqual(
    pick.skipped,
    [
      { ref: 'concept/续租', why: '未通过溯源校验' },
      { ref: 'concept/重试', why: '缺摘要' },
    ],
  );
  assert.match(pick.text, /- concept\/分布式锁 — 讲锁与续租约定/);
  assert.ok(pick.tokens > 0);
});

test('pickCatalog：source 页压成一行不占条数上限，concept 页逐条给摘要', () => {
  const pages = [
    page({ ref: 'source/调度服务-SDD', title: '调度服务 SDD', type: 'source', summary: '这篇资料讲什么' }),
    page({ ref: 'source/网关服务-SDD', title: '网关服务 SDD', type: 'source', summary: '这篇也讲什么' }),
    page({ ref: 'concept/分布式锁' }),
  ];
  const pick = pickCatalog(pages, { maxItems: 1 });
  // maxItems=1 只限制 concept 那批；两个 source 仍然在（它们是"库里有什么"的地图）
  assert.deepEqual(new Set(pick.pages.map((p) => p.ref)), new Set([
    'concept/分布式锁',
    'source/调度服务-SDD',
    'source/网关服务-SDD',
  ]));
  assert.match(pick.text, /原文摘要页.*source\/网关服务-SDD、source\/调度服务-SDD/);
  assert.match(pick.text, /- concept\/分布式锁 — 讲锁与续租约定/);
  assert.deepEqual(pick.skipped, []);
});

test('pickCatalog：concept 条数超上限时才落选，source 不受它影响', () => {
  const pages = [
    page({ ref: 'source/调度服务-SDD', title: '调度服务 SDD', type: 'source', summary: '这篇资料讲什么' }),
    page({ ref: 'concept/分布式锁' }),
    page({ ref: 'concept/续租', title: '续租', summary: '续租周期与失败处理' }),
  ];
  const pick = pickCatalog(pages, { maxItems: 1 });
  assert.deepEqual(pick.skipped, [{ ref: 'concept/续租', why: '超出条数上限 1' }]);
  assert.ok(pick.text.includes('source/调度服务-SDD'));
});

test('pickCatalog：token 预算装不下就不进目录，而不是超预算', () => {
  const pages = [page(), page({ ref: 'concept/续租', title: '续租', summary: '续租周期与失败处理' })];
  // 60 是"一条装得下、两条装不下"的中间值（一条 56 tok、两条 73 tok，按 CJK 分档计数）
  const pick = pickCatalog(pages, { maxTokens: 60 });
  assert.equal(pick.pages.length, 1);
  assert.ok(pick.tokens <= 60, `目录 ${pick.tokens} tok 不该超过 60`);
  assert.match(pick.skipped[0].why, /token 预算/);
  // 一条都装不下时给空串（provider 会因此完全不注入）
  assert.equal(catalogForPrompt(pages, { maxTokens: 5 }), '');
});

test('pickCatalog：过期条目照旧进目录，但要标出来并记进 stale', () => {
  const pages = [page(), page({ ref: 'concept/续租', title: '续租', summary: '续租周期与失败处理' })];
  const pick = pickCatalog(pages, { isStale: (p) => p.ref === 'concept/续租' });
  // 不排除：模型至少要知道有这页，否则连"去核对原文"的机会都没有
  assert.equal(pick.pages.length, 2);
  assert.deepEqual(pick.stale, ['concept/续租']);
  assert.match(pick.text, /concept\/续租 — 续租周期与失败处理（已过期，以原文为准）/);
  assert.ok(!pick.text.includes('分布式锁 — 讲锁与续租约定（已过期'), '新鲜条目不该被标');
  // 没给 isStale 时行为与以前一字不差
  assert.deepEqual(pickCatalog(pages).stale, []);
});

test('pickCatalog：预算不够时先挤掉过期条目', () => {
  const pages = [
    page({ ref: 'concept/aa', title: 'aa', summary: '甲乙丙丁戊己庚辛' }),
    page({ ref: 'concept/bb', title: 'bb', summary: '甲乙丙丁戊己庚辛' }),
  ];
  // 按 ref 排序 aa 在前，但 aa 过期 → 排到后面 → 装不下的是 aa
  const pick = pickCatalog(pages, { maxTokens: 60, isStale: (p) => p.ref === 'concept/aa' });
  assert.deepEqual(pick.pages.map((p) => p.ref), ['concept/bb']);
  assert.equal(pick.stale.length, 0, '被挤掉的过期条目不算"注入了过期知识"');
  assert.match(pick.skipped[0].ref, /concept\/aa/);
});

test('pickCatalog：source 页那一行用 * 标过期，且不超预算', () => {
  const pages = [
    page({ ref: 'source/调度服务-SDD', title: '调度服务 SDD', type: 'source', summary: '这篇资料讲什么' }),
    page({ ref: 'source/网关服务-SDD', title: '网关服务 SDD', type: 'source', summary: '这篇也讲什么' }),
  ];
  const pick = pickCatalog(pages, { isStale: (p) => p.ref === 'source/调度服务-SDD' });
  assert.match(pick.text, /source\/调度服务-SDD\*/);
  assert.match(pick.text, /（\*=已过期）/);
  assert.deepEqual(pick.stale, ['source/调度服务-SDD']);
  assert.ok(pick.tokens <= 240, `目录 ${pick.tokens} tok 不该超过默认预算`);
});

test('staleRebuildJobs：过期条目按来源资料分组，来源不在了就挑出来', () => {
  const pages = [
    page({ ref: 'concept/锁', sources: ['调度服务-sdd#0'] }),
    page({ ref: 'concept/重试', sources: ['调度服务-sdd#1', '调度服务-sdd#2'] }),
    page({ ref: 'concept/网关', sources: ['网关服务-sdd#0'] }),
    page({ ref: 'concept/没出处', sources: [] }),
    page({ ref: 'concept/来源已归档', sources: ['已归档-sdd#0'] }),
  ];
  const r = staleRebuildJobs(pages, (p) => p.ref !== 'concept/网关', ['调度服务-sdd', '网关服务-sdd']);
  // 只有过期的进 jobs，同一篇资料的合成一条任务
  assert.deepEqual(r.jobs, [{ docId: '调度服务-sdd', only: ['concept/锁', 'concept/重试'] }]);
  assert.deepEqual(r.orphans, ['concept/没出处', 'concept/来源已归档']);
});

test('wikiProvider：注入目录并发 wiki.injected；没有可用条目就不注入', () => {
  const dir = tmpDir();
  const wiki = new WikiStore(path.join(dir, 'wiki'));
  const wire = new Wire();
  const seen: { items: number; skipped: number }[] = [];
  wire.subscribe((ev) => {
    if (ev.type === 'wiki.injected') seen.push({ items: ev.items.length, skipped: ev.skipped.length });
  });
  const provider = wikiProvider(wiki, wire, { maxItems: 20, maxTokens: 240 });

  // 还没有条目：不注入，但事件照发（"这一轮目录是空的"本身是要能看见的）
  assert.deepEqual(provider.provide('锁怎么续租'), []);
  assert.deepEqual(seen, [{ items: 0, skipped: 0 }]);

  wiki.write(page());
  wiki.write(page({ ref: 'concept/续租', title: '续租', verified: false }));
  const parts = provider.provide('锁怎么续租') as { source: string; content: string }[];
  assert.equal(parts.length, 1);
  assert.equal(parts[0].source, 'wiki');
  assert.match(parts[0].content, /concept\/分布式锁/);
  assert.ok(!parts[0].content.includes('concept/续租'), '没通过校验的不进目录');
  assert.deepEqual(seen.at(-1), { items: 1, skipped: 1 });
});

test('wikiProvider 不检索：问的问题和条目无关也照样给目录（目录是地图，不是答案）', () => {
  const wiki = new WikiStore(path.join(tmpDir(), 'wiki'));
  wiki.write(page());
  const provider = wikiProvider(wiki, new Wire(), { maxItems: 20, maxTokens: 240 });
  const parts = provider.provide('今天天气怎么样') as { content: string }[];
  assert.match(parts[0].content, /concept\/分布式锁/);
});

/* ── 补摘要与别名 ── */

test('needsSummary：缺摘要或别名不到 3 个都要补', () => {
  assert.equal(needsSummary(page({ aliases: ['a', 'b', 'c'] })), false);
  assert.equal(needsSummary(page({ summary: '' })), true);
  assert.equal(needsSummary(page({ aliases: ['a'] })), true);
});

test('normalizeDraft：去重、去掉和标题一样的别名、没摘要就算不可用', () => {
  const d = normalizeDraft({ summary: ' 锁的 约定 ', aliases: ['抢锁失败', '抢锁失败', '分布式锁', ''] }, '分布式锁');
  assert.equal(d?.summary, '锁的 约定');
  assert.deepEqual(d?.aliases, ['抢锁失败']);
  assert.equal(normalizeDraft({ aliases: ['x'] }, '分布式锁'), undefined);
});

test('summarizePage：摘要里编了原文没有的数字就拒收，别名不受溯源约束', async () => {
  const p = page({ summary: '', aliases: [] });
  const sources = ['抢锁用 redis SETNX，锁的 TTL 是 30 秒。'];

  // 别名是"原文里没有的说法"——它的价值就在这儿，不能拿溯源去卡
  const ok: Llm = {
    async complete() {
      return { text: '{"summary":"锁与续租的约定","aliases":["抢锁失败","拿不到锁","锁没了"]}' };
    },
  };
  const draft = await summarizePage(ok, p, sources);
  assert.equal(draft.summary, '锁与续租的约定');
  assert.equal(draft.aliases.length, 3);

  const liar: Llm = {
    async complete() {
      return { text: '{"summary":"锁的 TTL 是 99 秒","aliases":["抢锁失败"]}' };
    },
  };
  await assert.rejects(() => summarizePage(liar, p, sources), /99/);

  const junk: Llm = { async complete() { return { text: '我不知道' }; } };
  await assert.rejects(() => summarizePage(junk, p, sources), /没给出可用的摘要/);
});

test('log 只追加，不覆盖', () => {  const dir = tmpDir();
  const wiki = new WikiStore(path.join(dir, 'wiki'));
  wiki.appendLog('第一次');
  wiki.appendLog('第二次');
  const log = wiki.readFile('log') ?? '';
  assert.ok(log.includes('第一次') && log.includes('第二次'));
});

/* ── 生成管线 ── */

function seed(store: KbStore) {
  store.import({
    text: [
      '# 调度服务 SDD',
      '',
      '## 3. 分布式锁',
      '',
      '抢锁用 redis SETNX，锁的 TTL 是 30 秒，续租周期 10 秒。',
      '',
      '## 4. 重试策略',
      '',
      '失败重试 3 次，指数退避，基准 200ms。',
    ].join('\n'),
    title: '调度服务 SDD',
  });
}

test('outlineOf 只给序号、标题路径和首句（结构决策不需要全文）', () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const outline = outlineOf(store.chunksOf(store.list()[0].id));
  assert.match(outline, /^#0 \[/m);
  assert.match(outline, /分布式锁/);
  assert.ok(outline.length < 600, '不该把全文塞进来');
});

test('normalizePlan：块互斥分配、越界丢弃、缺 source 页补上', () => {
  const doc = { id: '调度服务-sdd', title: '调度服务 SDD' };
  const plans = normalizePlan(
    {
      pages: [
        { ref: 'concept/分布式锁', title: '分布式锁', type: 'concept', chunks: [1, 2] },
        // 抢同一个块 + 一个越界块
        { ref: 'concept/重试', title: '重试', type: 'concept', chunks: [2, 99] },
        // 一个块都分不到 → 丢掉
        { ref: 'concept/空的', title: '空的', type: 'concept', chunks: [] },
      ],
    },
    doc,
    3,
  );
  const byRef = new Map(plans.map((p) => [p.ref, p]));
  assert.deepEqual(byRef.get('concept/分布式锁')?.chunks, [1, 2]);
  assert.deepEqual(byRef.get('concept/重试')?.chunks, undefined, '抢不到块的页面要丢掉');
  assert.ok(!byRef.has('concept/空的'));
  // 模型没给 source 页，得补一个
  assert.ok(plans.some((p) => p.type === 'source'));
});

test('normalizePlan：source 页的 ref 由文档定死，模型给的 slug 不作数', () => {
  const plans = normalizePlan(
    { pages: [{ ref: 'source/调度服务SDD', title: '调度服务SDD', type: 'source', chunks: [] }] },
    { id: '调度服务-sdd', title: '调度服务 SDD' },
    2,
  );
  // 否则每轮重建都会多出一个 slug 不同的孤儿摘要页
  assert.equal(plans.find((p) => p.type === 'source')?.ref, 'source/调度服务-SDD');
});

test('normalizePlan：非法 ref 用标题重造，未知类型归为 concept', () => {
  const plans = normalizePlan(
    { pages: [{ ref: '不合法的 ref', title: '分布式 锁', type: 'entity', chunks: [0] }] },
    { id: 'd', title: 'D' },
    2,
  );
  const c = plans.find((p) => p.type === 'concept');
  assert.equal(c?.ref, 'concept/分布式-锁');
});

test('compilePage：来源以模型声明为准，编了数字就标成未通过校验', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);
  const lockChunk = chunks.find((c) => c.text.includes('SETNX'))!;

  const good: Llm = {
    async complete() {
      return {
        text: [
          '---',
          'ref: concept/分布式锁',
          'title: 分布式锁',
          'summary: 锁与续租约定',
          `sources: [${doc.id}#${lockChunk.index}]`,
          '---',
          '',
          `锁的 TTL 是 30 秒，续租周期 10 秒。[${doc.id}#${lockChunk.index}]`,
        ].join('\n'),
      };
    },
  };
  const p = await compilePage(good, '规则', doc, { ref: 'concept/分布式锁', title: '分布式锁', type: 'concept', chunks: [lockChunk.index] }, chunks);
  assert.equal(p.verified, true);
  assert.deepEqual(p.sources, [`${doc.id}#${lockChunk.index}`]);
  assert.ok(p.sourceHash);

  const liar: Llm = {
    async complete() {
      return { text: `---\ntitle: 分布式锁\n---\n\n锁的 TTL 是 45 秒。[${doc.id}#${lockChunk.index}]` };
    },
  };
  const bad = await compilePage(liar, '规则', doc, { ref: 'concept/分布式锁', title: '分布式锁', type: 'concept', chunks: [lockChunk.index] }, chunks);
  assert.equal(bad.verified, false);
  assert.deepEqual(bad.unverified, ['45']);
});

test('compilePage：模型把输出包在 ``` 里也能解析；没正文要报错', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);
  const fenced: Llm = {
    async complete() {
      return { text: '```markdown\n---\ntitle: 概览\n---\n\n这篇讲调度服务。\n```' };
    },
  };
  const p = await compilePage(fenced, '规则', doc, { ref: 'source/x', title: 'x', type: 'source', chunks: [] }, chunks);
  assert.match(p.body, /这篇讲调度服务/);

  const empty: Llm = { async complete() { return { text: '好的，我不知道' }; } };
  await assert.rejects(
    () => compilePage(empty, '规则', doc, { ref: 'concept/y', title: 'y', type: 'concept', chunks: [0] }, chunks),
    /缺 frontmatter/,
  );
});

test('compilePage：前面多一句解释也能剥掉；失败时报错带模型原话', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);

  // 真实跑出来的形态：先寒暄一句，再套 ```markdown
  const chatty: Llm = {
    async complete() {
      return { text: '好的，以下是该条目：\n\n```markdown\n---\ntitle: 概览\n---\n\n这篇讲调度服务。\n```\n' };
    },
  };
  const p = await compilePage(chatty, '规则', doc, { ref: 'source/x', title: 'x', type: 'source', chunks: [] }, chunks);
  assert.match(p.body, /这篇讲调度服务/);
  assert.ok(!p.body.includes('以下是该条目'), '寒暄不该进正文');

  const refuse: Llm = { async complete() { return { text: '抱歉，给的原文块里没有关于归档编号的内容。' }; } };
  await assert.rejects(
    () => compilePage(refuse, '规则', doc, { ref: 'concept/y', title: 'y', type: 'concept', chunks: [0] }, chunks),
    /没有关于归档编号的内容/,
    '报错要把模型原话带上，否则无从判断是拒答还是格式跑偏',
  );
});

test('salvageFrontmatter：字段都在只缺分隔符时补上，是闲聊就不动', () => {
  // 真实跑出来的形态：ref/title/type 都写了，`---` 一个没写
  const got = salvageFrontmatter(['ref: concept/分布式锁', 'title: 分布式锁', 'type: concept', '## 结论', '', '租约 30 秒。'].join('\n'));
  assert.match(got, /^---\nref: concept\/分布式锁/);
  const { data, body } = parseFrontmatter(got);
  assert.equal(data.title, '分布式锁');
  assert.match(body, /^## 结论/);
  assert.match(body, /租约 30 秒。/);

  // 不是字段的开头一律不碰，免得把模型的拒答包装成条目
  const chat = '抱歉，原文里没有这部分内容。';
  assert.equal(salvageFrontmatter(chat), chat);
  // 只有字段没有正文（正文被塞进 body: 字段）也不救，交给重发
  assert.match(salvageFrontmatter('ref: concept/x\nbody: |\n  正文'), /^ref: concept\/x/);
});

test('compilePage：格式跑偏会纠正重发一次，两次都不行才算失败', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);
  const plan = { ref: 'concept/锁', title: '锁', type: 'concept' as const, chunks: [1] };

  // 第一次给 ```yaml + body: | 这种没有分隔符的形态（真实跑出来的），第二次才对
  let calls = 0;
  const flaky: Llm = {
    async complete(messages) {
      calls++;
      if (calls === 1) return { text: '```yaml\nref: concept/锁\ntitle: 锁\nbody: |\n  TTL 是 30 秒。\n```' };
      assert.equal(messages.at(-2)?.role, 'assistant', '重试要把原输出退回给模型');
      assert.match(messages.at(-1)?.content ?? '', /只改格式|缺少 frontmatter/);
      return { text: '---\ntitle: 锁\n---\n\nTTL 是 30 秒。' };
    },
  };
  const p = await compilePage(flaky, '规则', doc, plan, chunks);
  assert.equal(calls, 2);
  assert.match(p.body, /TTL 是 30 秒/);

  let n = 0;
  const stubborn: Llm = {
    async complete() {
      n++;
      return { text: '```yaml\nref: concept/锁\nbody: | TTL 30 秒\n```' };
    },
  };
  await assert.rejects(() => compilePage(stubborn, '规则', doc, plan, chunks), /缺 frontmatter/);
  assert.equal(n, 2, '只重试一次，不无限重发');
});

test('compilePage：正文引了但 frontmatter 忘列的块要算进依据；引没分给它的块不算', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);
  const lock = chunks.find((c) => c.text.includes('SETNX'))!;
  const retry = chunks.find((c) => c.text.includes('指数退避'))!;

  // 两块都分给它了，但 frontmatter 只列了一块 —— 这是记账不一致，不是编造
  const sloppy: Llm = {
    async complete() {
      return {
        text: `---\ntitle: 锁\nsources: [${doc.id}#${lock.index}]\n---\n\nTTL 30 秒。[${doc.id}#${lock.index}]\n重试 3 次，基准 200ms。[${doc.id}#${retry.index}]`,
      };
    },
  };
  const ok = await compilePage(sloppy, '规则', doc, { ref: 'concept/锁', title: '锁', type: 'concept', chunks: [lock.index, retry.index] }, chunks);
  assert.equal(ok.verified, true);
  assert.deepEqual(ok.sources, [`${doc.id}#${lock.index}`, `${doc.id}#${retry.index}`]);

  // 只分了 lock 块，却引用并抄了 retry 块的内容 —— 跨页泄漏，必须判未通过
  const leaky: Llm = {
    async complete() {
      return { text: `---\ntitle: 锁\n---\n\nTTL 30 秒。[${doc.id}#${lock.index}]\n重试基准 200ms。[${doc.id}#${retry.index}]` };
    },
  };
  const bad = await compilePage(leaky, '规则', doc, { ref: 'concept/锁', title: '锁', type: 'concept', chunks: [lock.index] }, chunks);
  assert.equal(bad.verified, false);
  assert.ok(bad.unverified?.includes('200'), '没给它的块里的数字不该被认');
  assert.deepEqual(bad.sources, [`${doc.id}#${lock.index}`]);
});

test('compilePage：文档标题里的词不算编造', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0]; // 标题「调度服务 SDD」
  const chunks = store.chunksOf(doc.id);
  const lock = chunks.find((c) => c.text.includes('SETNX'))!;
  const llm: Llm = {
    async complete() {
      return { text: `---\ntitle: 分布式锁\n---\n\n本页出自 SDD 的锁章节，TTL 30 秒。[${doc.id}#${lock.index}]` };
    },
  };
  const p = await compilePage(llm, '规则', doc, { ref: 'concept/锁', title: '锁', type: 'concept', chunks: [lock.index] }, chunks);
  assert.equal(p.verified, true, 'SDD 只在文档标题里，但标题也给了模型看');
});

test('compilePage：related = frontmatter 声明的 ∪ 正文里实际写的 [[...]]', async () => {
  const store = new KbStore(tmpDir());
  seed(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);
  const lock = chunks.find((c) => c.text.includes('SETNX'))!;
  // frontmatter 只列了续租，正文里还写了重试；另外自己引自己要去掉
  const llm: Llm = {
    async complete() {
      return {
        text:
          `---\ntitle: 锁\nrelated: [concept/续租]\n---\n\n` +
          `TTL 30 秒。[${doc.id}#${lock.index}] 另见 [[concept/重试]] 和 [[concept/锁]]，以及 [[非法 ref]]。`,
      };
    },
  };
  const p = await compilePage(llm, '规则', doc, { ref: 'concept/锁', title: '锁', type: 'concept', chunks: [lock.index] }, chunks);
  assert.deepEqual(p.related, ['concept/续租', 'concept/重试'], '并集、去自引用、丢非法 ref');
});
