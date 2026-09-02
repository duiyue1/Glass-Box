import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, makeAtom, terms } from '../src/memory/store.ts';

/* ── 矛盾消解：新结论必须赢，旧结论要留痕 ────────────────────────────── */

test('近重复的记忆合并成一条，旧的标为已推翻但不删除', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('preference', '我喜欢用中文回答问题', 1000)]);
  s.upsertAtoms([makeAtom('preference', '我喜欢用中文回答的问题', 2000)]);

  assert.equal(s.atomCount(), 1, '说的是同一件事，只该有一条生效');
  assert.equal(s.totalCount(), 2, '旧的要留着——agent 记错时得能查"它为什么以为是这样"');
  const dead = s.allAtoms().find((a) => a.supersededBy !== undefined);
  assert.ok(dead, '旧那条应带上推翻标记');
  assert.equal(s.retrieve('中文', { maxItems: 5, maxTokens: 999 }).items.length, 1, '被推翻的不参与召回');
});

test('用户明说"改用"时，同主题的旧结论让位', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '这个项目用 npm 装依赖', 1000)]);
  s.upsertAtoms([makeAtom('fact', '这个项目改用 pnpm 装依赖', 2000)]);

  const live = s.allAtoms().filter((a) => a.supersededBy === undefined);
  assert.equal(live.length, 1);
  assert.match(live[0].text, /pnpm/, '生效的必须是新结论');
});

test('推翻记录能取走一次，供上层发事件', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '部署在 A 机房', 1000)]);
  s.upsertAtoms([makeAtom('fact', '部署改成 B 机房', 2000)]);

  const first = s.takeSupersedes();
  assert.equal(first.length, 1);
  assert.equal(first[0].why, 'override');
  assert.equal(s.takeSupersedes().length, 0, '取过就清空，不该重复发事件');
});

test('不同主题不会被误合并（这是规则判定，宁可留两条）', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '数据库是 PostgreSQL', 1000)]);
  s.upsertAtoms([makeAtom('fact', '缓存用 Redis', 2000)]);
  assert.equal(s.atomCount(), 2);
});

test('没有"改用"这类词时，不同取值仍并存——能力边界要说清楚', () => {
  // 语义蕴含判断做不到（会依赖模型，而记忆要在零凭证下也能跑）。
  // 这条测试把边界钉住：将来真上了语义判定，它会红，那时候是该改的。
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '端口 8080', 1000)]);
  s.upsertAtoms([makeAtom('fact', '端口 9090', 2000)]);
  assert.equal(s.atomCount(), 2);
});

test('改写认不出来——2-gram Jaccard 的硬边界，别让文档吹过头', () => {
  // "偏好中文回答" 和 "希望用中文回复" 是同一件事，但 2-gram 相似度只有 0.25。
  // 近重复规则只能收掉复述，收不掉改写。把这条写成测试，是为了让 README 里
  // 那句"能力边界"永远和代码对得上，而不是靠人记得。
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('preference', '用户偏好中文回答', 1000)]);
  s.upsertAtoms([makeAtom('preference', '用户希望用中文回复', 2000)]);
  assert.equal(s.atomCount(), 2, '认不出改写：这是已知边界，不是 bug');
});

test('推翻者本身被分叉丢掉时，旧结论要复活', () => {
  // 矛盾消解和分叉屏蔽会互相影响：分叉的语义是"回到那一刻"，如果推翻发生在
  // 被丢弃的那段时间里，那么在这条时间线上它根本没发生过，旧结论必须还在。
  // 否则分叉回到过去却丢了当时明明成立的事实，分叉就不干净了。
  const s = new MemoryStore();
  const old = makeAtom('fact', '数据库用 MySQL', 50);
  const killer = makeAtom('fact', '数据库换成 PostgreSQL', 150);
  s.upsertAtoms([old]);
  s.upsertAtoms([killer]);

  // 没有分叉窗口：新结论生效，旧的被盖住
  const normal = s.retrieve('数据库', { maxItems: 9, maxTokens: 999 }).items.map((i) => i.atom.text);
  assert.deepEqual(normal, ['数据库换成 PostgreSQL']);

  // 分叉点 100、执行分叉 200：推翻者产生在这段里 -> 这次推翻不算，旧结论复活
  const forked = s
    .retrieve('数据库', { maxItems: 9, maxTokens: 999 }, [{ from: 100, to: 200 }])
    .items.map((i) => i.atom.text);
  assert.deepEqual(forked, ['数据库用 MySQL']);
});

/* ── BM25：idf + 词频 + 长度归一 ──────────────────────────────────────── */

test('retrieve 按关键词命中打分', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '这个项目用 Gurobi 求解器'), makeAtom('preference', '用 TypeScript')]);
  const r = s.retrieve('Gurobi 怎么配置', { maxItems: 3, maxTokens: 100 });
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].atom.text.includes('Gurobi'));
});

test('罕见词比常见词值钱（idf）', () => {
  const s = new MemoryStore();
  // "项目"在每条里都有 -> idf 低；"Gurobi" 只有一条 -> idf 高
  s.upsertAtoms([
    makeAtom('fact', '项目 A 的说明', 1000),
    makeAtom('fact', '项目 B 的说明', 1001),
    makeAtom('fact', '项目 C 的说明', 1002),
    makeAtom('fact', '项目 用 Gurobi', 1003),
  ]);
  const r = s.retrieve('项目 Gurobi', { maxItems: 4, maxTokens: 999 });
  assert.match(r.items[0].atom.text, /Gurobi/, '含罕见词的那条要排第一');
});

test('长条目不再因为"装得下更多词"而占优（长度归一）', () => {
  const s = new MemoryStore();
  const short = makeAtom('fact', 'Gurobi 许可证', 1000);
  const long = makeAtom('fact', `Gurobi ${'无关内容 '.repeat(40)}`, 1001);
  s.upsertAtoms([short, long]);
  const r = s.retrieve('Gurobi 许可证', { maxItems: 2, maxTokens: 9999 });
  assert.equal(r.items[0].atom.id, short.id, '短而切题的应该赢');
});

test('英文按整词匹配，不再子串误命中', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', '配置写在 npmrc 里', 1000)]);
  const r = s.retrieve('npm', { maxItems: 3, maxTokens: 999 });
  assert.equal(r.items.length, 0, 'npm 不该命中 npmrc');
});

test('分词保留词频，不去重（tf 是 BM25 的输入）', () => {
  assert.deepEqual(terms('npm npm'), ['npm', 'npm']);
});

test('retrieve 条数预算封顶并计丢弃数', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', 'Gurobi 求解器'), makeAtom('fact', 'Gurobi 版本 11'), makeAtom('fact', 'Gurobi 许可证')]);
  const r = s.retrieve('Gurobi', { maxItems: 1, maxTokens: 100 });
  assert.equal(r.items.length, 1);
  assert.ok(r.dropped >= 1);
});

test('retrieve token 预算封顶', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('fact', 'Gurobi ' + 'x'.repeat(400))]);
  const r = s.retrieve('Gurobi', { maxItems: 5, maxTokens: 5 });
  assert.equal(r.items.length, 0);
  assert.ok(r.dropped >= 1);
});

test('upsertAtoms 对相同内容去重', () => {
  const s = new MemoryStore();
  s.upsertAtoms([makeAtom('preference', '用 TypeScript')]);
  s.upsertAtoms([makeAtom('preference', '用 TypeScript')]);
  assert.equal(s.atomCount(), 1);
});

/* ── 上限与淘汰 ──────────────────────────────────────────────────────── */

test('L0 滚动丢最老的，不影响召回（retrieve 只看 L1）', () => {
  const s = new MemoryStore({ maxL0: 2 });
  s.appendL0({ ts: 1, role: 'user', text: '一' });
  s.appendL0({ ts: 2, role: 'user', text: '二' });
  s.appendL0({ ts: 3, role: 'user', text: '三' });
  assert.equal(s.l0Count(), 2);
  assert.equal(s.takePrune().l0Dropped, 1);
});

test('原子超上限时先淘汰已被推翻的', () => {
  const s = new MemoryStore({ maxAtoms: 2 });
  s.upsertAtoms([makeAtom('fact', '部署在 A 机房', 1000)]);
  s.upsertAtoms([makeAtom('fact', '部署改成 B 机房', 2000)]); // 推翻上一条，此时共 2 条
  s.upsertAtoms([makeAtom('fact', '完全无关的另一件事', 3000)]); // 超了 -> 该丢被推翻的那条

  assert.equal(s.totalCount(), 2);
  assert.equal(s.allAtoms().some((a) => a.text.includes('A 机房')), false, '已推翻的先走');
  assert.equal(s.atomCount(), 2, '两条生效的都还在');
});

test('命中过的记忆比没人用过的更耐淘汰', () => {
  const s = new MemoryStore({ maxAtoms: 2 });
  s.upsertAtoms([makeAtom('fact', 'Gurobi 许可证在这里', 1000)]);
  s.upsertAtoms([makeAtom('fact', '一条从来没人问过的事', 1001)]);
  // 只命中第一条
  s.retrieve('Gurobi', { maxItems: 5, maxTokens: 999 });

  s.upsertAtoms([makeAtom('fact', '再来一条把上限撑破', 2000)]);

  const texts = s.allAtoms().map((a) => a.text);
  assert.ok(texts.some((t) => t.includes('Gurobi')), '被用过的应该留下');
  assert.equal(texts.some((t) => t.includes('从来没人问过')), false, '没人用过的先走');
});

test('淘汰统计取走一次就清零', () => {
  const s = new MemoryStore({ maxL0: 1 });
  s.appendL0({ ts: 1, role: 'user', text: '一' });
  s.appendL0({ ts: 2, role: 'user', text: '二' });
  assert.equal(s.takePrune().l0Dropped, 1);
  assert.deepEqual(s.takePrune(), { l0Dropped: 0, atomsDropped: 0 });
});

test('限制传 undefined 时用默认值，不能把上限变成"无上限"', () => {
  // `{...DEFAULT, ...{maxL0: undefined}}` 会把默认值覆盖成 undefined。
  // 上限静默失效是最难查的一类 bug，所以专门钉一条。
  const s = new MemoryStore({ maxL0: undefined, maxAtoms: undefined });
  for (let i = 0; i < 600; i++) s.appendL0({ ts: i, role: 'user', text: `第 ${i} 句` });
  assert.equal(s.l0Count(), 500, '应落回默认上限 500');
});

test('老的持久化文件没有新字段也能读（向后兼容）', () => {
  const s = new MemoryStore();
  s.loadJSON({
    l0: [{ ts: 1, role: 'user', text: '旧记录' }],
    atoms: [{ id: 'a1', kind: 'fact', text: '旧原子 Gurobi', ts: 1, tokens: 5, visibility: 'shared' }],
  });
  assert.equal(s.atomCount(), 1, '没有 supersededBy 就是生效状态');
  assert.equal(s.retrieve('Gurobi', { maxItems: 3, maxTokens: 999 }).items.length, 1);
});
