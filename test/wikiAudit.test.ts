import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditWiki, pickSample, pointOf, reviewSample, sentencesOf } from '../src/kb/wikiAudit.ts';
import { WikiStore } from '../src/kb/wikiStore.ts';
import type { WikiPage } from '../src/kb/wiki.ts';
import type { Llm } from '../src/engine/loop.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-audit-'));
}

const page = (over: Partial<WikiPage> = {}): WikiPage => ({
  ref: 'concept/分布式锁',
  title: '分布式锁',
  type: 'concept',
  summary: '锁与续租约定',
  aliases: ['抢锁', '拿不到锁', 'redis 锁'],
  sources: ['调度服务-sdd#3'],
  related: [],
  verified: true,
  sourceHash: 'h',
  ts: 1,
  body: '锁的租约是三十秒，续租周期十秒，抢锁失败后固定等待三秒重试。',
  ...over,
});

const never = () => false;
const dimOf = (r: ReturnType<typeof auditWiki>, key: string) => r.dims.find((d) => d.key === key)!;

test('六维打分：全都合格时综合分 100', () => {
  const r = auditWiki([page()], ['调度服务-sdd#3'], never);
  assert.equal(r.score, 100);
  assert.equal(r.dims.length, 6);
  // 权重之和必须是 1，否则综合分不是百分制（浮点相加有 1e-16 级误差，取整比）
  assert.equal(Math.round(r.dims.reduce((s, d) => s + d.weight, 0) * 1e6) / 1e6, 1);
});

test('链接完整：坏链、孤岛、无主各自扣分，只有一条条目时不判孤岛', () => {
  // 单页：无处可连，不该判孤岛
  assert.equal(dimOf(auditWiki([page()], ['调度服务-sdd#3'], never), 'links').score, 100);

  const pages = [
    // 正常：互相引用
    page({ ref: 'concept/锁', body: '见 [[concept/续租]]。' }),
    page({ ref: 'concept/续租', related: ['concept/锁'] }),
    // 坏链：指向不存在的条目
    page({ ref: 'concept/重试', body: '见 [[concept/不存在]]。' }),
    // 孤岛：没人引用它，它也不引用别人
    page({ ref: 'concept/孤岛' }),
    // 无主：依据块不在启用中的资料里
    page({ ref: 'concept/无主', sources: ['已删掉-sdd#0'], related: ['concept/锁'] }),
  ];
  const d = dimOf(auditWiki(pages, ['调度服务-sdd#3'], never), 'links');
  assert.equal(d.score, 40, '5 条里 3 条有问题');
  assert.match(d.issues.join('\n'), /concept\/重试 — 坏链.*concept\/不存在/);
  assert.match(d.issues.join('\n'), /concept\/孤岛 — 孤岛/);
  assert.match(d.issues.join('\n'), /concept\/无主 — 无主/);
});

test('链接完整：source 页不判孤岛（它本来就是入口）', () => {
  const pages = [
    page({ ref: 'source/调度服务-SDD', type: 'source' }),
    page({ ref: 'concept/锁', related: ['concept/续租'] }),
    page({ ref: 'concept/续租' }),
  ];
  assert.equal(dimOf(auditWiki(pages, ['调度服务-sdd#3'], never), 'links').score, 100);
});

test('溯源维度：没通过校验的条目要扣分并列出缺的字面', () => {
  const r = auditWiki(
    [page(), page({ ref: 'concept/重试', verified: false, unverified: ['45'] })],
    ['调度服务-sdd#3'],
    never,
  );
  const d = dimOf(r, 'provenance');
  assert.equal(d.score, 50);
  assert.match(d.issues[0], /concept\/重试.*45/);
});

test('原文覆盖只算 concept 页：source 页引用全篇不该把覆盖率刷满', () => {
  const pages = [
    page({ ref: 'source/调度服务-SDD', type: 'source', sources: ['调度服务-sdd#0', '调度服务-sdd#1', '调度服务-sdd#3'] }),
    page({ sources: ['调度服务-sdd#3'] }),
  ];
  const r = auditWiki(pages, ['调度服务-sdd#0', '调度服务-sdd#1', '调度服务-sdd#3'], never);
  const d = dimOf(r, 'coverage');
  assert.equal(d.score, 33.3, 'source 页那两块不算覆盖');
  assert.equal(d.issues.length, 2);
});

test('可检索维度：缺摘要 / 别名不足各扣一半', () => {
  const r = auditWiki(
    [page({ summary: '' }), page({ ref: 'concept/b', aliases: ['只有一个'] }), page({ ref: 'concept/c' })],
    ['调度服务-sdd#3'],
    never,
  );
  const d = dimOf(r, 'retrievable');
  // 第一条只丢摘要(0.5)、第二条只丢别名(0.5)、第三条满分 → (0.5+0.5+1)/3
  assert.equal(d.score, 66.7);
  assert.equal(d.issues.length, 2);
  assert.match(d.issues[0], /缺摘要/);
  assert.match(d.issues[1], /别名只有 1 个/);
});

test('精炼去重：同一句出现在两个条目里就扣分，短句不算', () => {
  const long = '抢锁失败后先等三秒再重试，重试三次仍失败则告警并跳过本次调度。';
  const r = auditWiki(
    [page({ body: `${long}\n短句。` }), page({ ref: 'concept/b', body: `${long}\n另一句短的。` })],
    ['调度服务-sdd#3'],
    never,
  );
  const d = dimOf(r, 'distinct');
  assert.ok(d.score < 100, '重复句要扣分');
  assert.match(d.issues[0], /concept\/分布式锁 \/ concept\/b/);
  // 只有两条重复的长句被计入，短句不参与
  assert.match(d.detail, /^1 句出现在多个条目里/);
});

test('sentencesOf 去掉出处标记与排版记号，只留够长的句子', () => {
  const s = sentencesOf('## 结论\n\n- 锁的租约是三十秒，续租周期十秒。[调度服务-sdd#3]\n- 短。');
  assert.equal(s.length, 1);
  assert.equal(s[0], '锁的租约是三十秒，续租周期十秒');
});

test('时效维度：stale 判定由调用方给，命中就扣分', () => {
  const r = auditWiki([page(), page({ ref: 'concept/b' })], ['调度服务-sdd#3'], (p) => p.ref === 'concept/b');
  const d = dimOf(r, 'freshness');
  assert.equal(d.score, 50);
  assert.match(d.issues[0], /concept\/b/);
});

test('同一份 wiki 反复打分结果完全一样（趋势线的前提）', () => {
  const pages = [page(), page({ ref: 'concept/b', verified: false, unverified: ['9'] })];
  const a = auditWiki(pages, ['调度服务-sdd#3'], never);
  const b = auditWiki(pages, ['调度服务-sdd#3'], never);
  assert.equal(a.score, b.score);
  assert.deepEqual(a.dims, b.dims);
});

test('pickSample：优先概念页、等距取、同一份输入抽到同一批', () => {
  const pages = ['a', 'b', 'c', 'd'].map((x) => ({ ref: `concept/${x}`, type: 'concept' }));
  pages.push({ ref: 'source/x', type: 'source' });
  const first = pickSample(pages, 2).map((p) => p.ref);
  assert.deepEqual(first, pickSample(pages, 2).map((p) => p.ref));
  assert.ok(first.every((r) => r.startsWith('concept/')), 'source 页是导航，不抽它');
});

test('reviewSample：解析模型给的分数，单条失败只记 failed', async () => {
  const pages = [page(), page({ ref: 'concept/b' })];
  let n = 0;
  const llm: Llm = {
    async complete() {
      n++;
      return { text: n === 1 ? '```json\n{"score":2,"note":"无明显问题"}\n```' : '我不想评' };
    },
  };
  const s = await reviewSample(llm, pages, () => ['原文'], 2);
  assert.equal(s.n, 1);
  assert.equal(s.avg, 2);
  assert.equal(s.items[0].note, '无明显问题');
  assert.equal(s.failed.length, 1);
});

test('质检历史：只追加、按时间排序、超期与坏行都跳过', () => {
  const wiki = new WikiStore(path.join(tmpDir(), 'wiki'));
  const old = { ts: Date.now() - 40 * 86400_000, score: 10, pages: 1, dims: {} };
  wiki.appendQuality(old);
  wiki.appendQuality(pointOf(auditWiki([page()], ['调度服务-sdd#3'], never)));
  fs.appendFileSync(path.join(wiki.dir, 'quality.jsonl'), '这不是 JSON\n');
  const h = wiki.qualityHistory(30);
  assert.equal(h.length, 1, '40 天前的那条和坏行都不要');
  assert.equal(h[0].score, 100);
  assert.equal(h[0].dims.provenance, 100);
  // 拉长窗口能看到旧的那条，且按时间升序
  const all = wiki.qualityHistory(60);
  assert.deepEqual(all.map((p) => p.score), [10, 100]);
});
