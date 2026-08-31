import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkMarkdown } from '../src/kb/chunker.ts';
import { KbStore, slugify, terms } from '../src/kb/store.ts';
import { buildQuery, keywordsOf, normalizeQuery } from '../src/kb/query.ts';
import { scanSecrets } from '../src/kb/secrets.ts';
import { distillDoc, parseDigest } from '../src/kb/distill.ts';
import { contextualizeDoc, parseContexts } from '../src/kb/context.ts';
import { needsRewrite, normalizeQueries, pickBest, rewriteQuery } from '../src/kb/rewrite.ts';
import { kbProvider } from '../src/kb/provider.ts';
import { collapseSame, lineDiff } from '../src/kb/diff.ts';
import { kbPlugin } from '../src/plugins/kbPlugin.ts';
import { WikiStore } from '../src/kb/wikiStore.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Wire } from '../src/engine/wire.ts';
import type { Llm } from '../src/engine/loop.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-kb-'));
}

/* ── 分块 ── */

test('chunkMarkdown 按标题切块并记录标题路径', () => {
  const md = ['# 顶级', '正文一。', '## 子节 A', '正文二。', '## 子节 B', '正文三。'].join('\n');
  const chunks = chunkMarkdown(md, { minTokens: 0, overlapTokens: 0 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].headingPath, '顶级');
  assert.equal(chunks[1].headingPath, '顶级 > 子节 A');
  assert.equal(chunks[2].headingPath, '顶级 > 子节 B');
});

test('chunkMarkdown 不切断代码块，且代码里的 # 不当标题', () => {
  const md = ['# 标题', '```bash', '# 这是注释不是标题', 'echo hi', '```'].join('\n');
  const chunks = chunkMarkdown(md, { minTokens: 0, overlapTokens: 0 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'code_block');
  assert.ok(chunks[0].text.includes('# 这是注释不是标题'));
  assert.equal(chunks[0].headingPath, '标题');
});

test('chunkMarkdown 表格整块保留并标记类型', () => {
  const md = ['# 表', '|a|b|', '|-|-|', '|1|2|'].join('\n');
  const chunks = chunkMarkdown(md, { minTokens: 0, overlapTokens: 0 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'table');
  assert.ok(chunks[0].text.includes('|1|2|'));
});

test('chunkMarkdown 过短块合并到同源上一块', () => {
  const md = ['# A', '短。', '## A1', '也很短。'].join('\n');
  const chunks = chunkMarkdown(md, { minTokens: 50, overlapTokens: 0 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('也很短'));
});

test('chunkMarkdown 超长内容拆成多块且相邻块有重叠', () => {
  const para = (n: number) => 'x'.repeat(400) + n;
  const md = ['# A', para(1), '', para(2), '', para(3)].join('\n');
  const chunks = chunkMarkdown(md, { maxTokens: 120, minTokens: 0, overlapTokens: 10 });
  assert.ok(chunks.length >= 3);
  // 第二块开头应带上第一块尾部的内容
  assert.ok(chunks[1].text.startsWith('x'));
  assert.ok(chunks[1].tokens > 0);
});

test('chunkMarkdown 空文档返回空数组', () => {
  assert.deepEqual(chunkMarkdown('   \n\n'), []);
});

/* ── 分词与 slug ── */

test('terms 保留词频，中文走 2-gram', () => {
  const t = terms('缓存 缓存 cache');
  assert.equal(t.filter((x) => x === 'cache').length, 1);
  assert.equal(t.filter((x) => x === '缓存').length, 2);
});

test('slugify 清掉路径字符，防止越界写文件', () => {
  assert.equal(slugify('../../etc/passwd').includes('/'), false);
  assert.equal(slugify('../../etc/passwd').includes('.'), false);
  assert.ok(slugify('!!!').length > 0);
});

/* ── 存储与检索 ── */

test('import 落盘原文并建立索引', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  const { doc, chunks } = store.import({ text: '# 权限模型\n按部门祖先链展开做过滤。', source: 'paste' });
  assert.equal(doc.title, '权限模型');
  assert.equal(doc.version, 1);
  assert.ok(chunks >= 1);
  assert.ok(fs.existsSync(path.join(dir, 'raw', doc.id + '.md')));
  assert.ok(fs.existsSync(path.join(dir, 'index.json')));
});

test('search 用 BM25 命中相关块，稀有词优先', () => {
  const store = new KbStore(tmpDir());
  store.import({ text: '# 甲\n这里讲缓存和数据库。' });
  store.import({ text: '# 乙\n这里讲 Qdrant 混合检索。' });
  const r = store.search('Qdrant 怎么用', { maxItems: 3, maxTokens: 500 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].chunk.title, '乙');
  assert.ok(r.items[0].score > 0);
});

test('search 按标题也能命中', () => {
  const store = new KbStore(tmpDir());
  store.import({ text: '# AI-Ku 技术方案\n内容和标题词无关。' });
  const r = store.search('AI-Ku', { maxItems: 3, maxTokens: 500 });
  assert.equal(r.items.length, 1);
});

test('search 用条数与 token 双重预算封顶并记丢弃数', () => {
  const store = new KbStore(tmpDir());
  store.import({ text: '# 甲\n缓存缓存缓存。' });
  store.import({ text: '# 乙\n缓存另一段。' });
  const byItems = store.search('缓存', { maxItems: 1, maxTokens: 500 });
  assert.equal(byItems.items.length, 1);
  assert.ok(byItems.dropped >= 1);
  const byTokens = store.search('缓存', { maxItems: 5, maxTokens: 1 });
  assert.equal(byTokens.items.length, 0);
  assert.ok(byTokens.dropped >= 1);
});

test('同标题重复导入：版本递增且旧分块被替换', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# 同一篇\n旧内容讲的是 Neo4j。' });
  const before = store.chunkCount();
  const { doc } = store.import({ text: '# 同一篇\n新内容讲的是 Qdrant。' });
  assert.equal(doc.version, 2);
  assert.equal(store.docCount(), 1);
  assert.equal(store.chunkCount(), before);
  assert.equal(store.search('Neo4j', { maxItems: 3, maxTokens: 500 }).items.length, 0);
  assert.equal(store.search('Qdrant', { maxItems: 3, maxTokens: 500 }).items.length, 1);
});

test('archive 后不再参与检索，restore 后恢复', () => {
  const store = new KbStore(tmpDir());
  const { doc } = store.import({ text: '# 甲\n讲 Qdrant 的。' });
  assert.equal(store.archive(doc.id), true);
  assert.equal(store.docCount(), 0);
  assert.equal(store.search('Qdrant', { maxItems: 3, maxTokens: 500 }).items.length, 0);
  assert.equal(store.restore(doc.id), true);
  assert.equal(store.search('Qdrant', { maxItems: 3, maxTokens: 500 }).items.length, 1);
});

test('load 能从磁盘恢复索引', () => {
  const dir = tmpDir();
  new KbStore(dir).import({ text: '# 甲\n讲 Qdrant 的。' });
  const again = new KbStore(dir);
  again.load();
  assert.equal(again.docCount(), 1);
  assert.equal(again.search('Qdrant', { maxItems: 3, maxTokens: 500 }).items.length, 1);
});

test('load 遇到损坏的索引文件不抛错', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.json'), '{ 坏掉的 json');
  const store = new KbStore(dir);
  store.load();
  assert.equal(store.docCount(), 0);
});

test('import 拒绝空内容', () => {
  const store = new KbStore(tmpDir());
  assert.throws(() => store.import({ text: '   ' }), /内容为空/);
});

test('注入文本的来源标注不重复文档标题', async () => {
  const { formatHits } = await import('../src/kb/store.ts');
  const store = new KbStore(tmpDir());
  store.import({ text: '# 调度服务 SDD\n\n## 4.3 分布式锁\n抢锁失败后先等 3 秒。\n' });
  const hits = store.search('抢锁失败', { maxItems: 3, maxTokens: 500 }).items;
  const text = formatHits(hits);
  assert.match(text, /来源: 调度服务 SDD > 4\.3 分布式锁/);
  assert.equal(/调度服务 SDD > 调度服务 SDD/.test(text), false, '标题不该出现两次');
});

/* ── 查询构造 ── */

test('normalizeQuery 去掉口语词，但不会把查询清空', () => {
  assert.equal(normalizeQuery('帮我看看抢锁失败怎么办').includes('帮我'), false);
  assert.ok(normalizeQuery('帮我看看抢锁失败怎么办').includes('抢锁失败'));
  // 全是停用词时退回原文，宁可带噪音也不要空查询
  assert.equal(normalizeQuery('这个是什么呢'), '这个是什么呢');
});

test('停用词不能切开实词：「跳过率」「租约过期」「地址」必须整体保留', () => {
  // 曾经把「过/地/得/着」也当停用词按正则抹掉，于是「跳过率」→「跳 率」。
  // 索引是中文 2-gram，缺一个字连一个 bigram 都对不上，关键词等于从查询里消失——
  // 实测「跳过率的周指标」那条，含 0.5% 的段落从第 2 名掉到最后一名。
  assert.ok(normalizeQuery('跳过率的周指标要求是多少').includes('跳过率'));
  assert.ok(normalizeQuery('租约过期了怎么办').includes('租约过期'));
  assert.ok(normalizeQuery('注册中心的地址在哪里').includes('地址'));
  assert.ok(keywordsOf('跳过率超标怎么处理').some((k) => k.includes('跳过率')));
});

test('keywordsOf 抽出实词，去重且有上限', () => {
  const ks = keywordsOf('帮我看看 分布式锁 的重试策略，Qdrant 也讲一下');
  assert.ok(ks.includes('qdrant'));
  assert.ok(ks.some((k) => k.includes('分布式锁')));
  assert.equal(ks.includes('帮我'), false);
  assert.ok(ks.length <= 8);
});

test('buildQuery：实词够时不借上一轮；指代句才借', () => {
  const first = buildQuery('分布式锁的抢锁失败怎么处理');
  assert.equal(first.usedPrev, false);

  const second = buildQuery('它的重试策略呢', first.keywords);
  assert.equal(second.usedPrev, true, '这句自己没有实词，必须借上一轮的关键词');
  assert.ok(second.query.includes('重试'));
  assert.ok(first.keywords.some((k) => second.query.includes(k)));
});

test('buildQuery：连续指代时关键词继续往下传，话题链不断', () => {
  const a = buildQuery('Qdrant 的混合检索');
  const b = buildQuery('它呢', a.keywords);
  const c = buildQuery('那个呢', b.keywords);
  assert.ok(c.query.includes('qdrant') || c.query.includes('混合检索'));
});

/* ── 检索整形 ── */

test('同一篇文档最多贡献 perDoc 块，其余记在 cappedByDoc', () => {
  const store = new KbStore(tmpDir());
  const md = ['# 长文'];
  for (let i = 1; i <= 6; i++) md.push(`## 第${i}节`, `这一节讲缓存穿透的处理办法之${i}。`.repeat(4));
  store.import({ text: md.join('\n') });
  store.import({ text: '# 短文\n这里也讲缓存穿透。'.repeat(3) });

  const r = store.search('缓存穿透', { maxItems: 6, maxTokens: 5000, perDoc: 2 });
  const perDoc = new Map<string, number>();
  for (const i of r.items) perDoc.set(i.chunk.docId, (perDoc.get(i.chunk.docId) ?? 0) + 1);
  for (const [, n] of perDoc) assert.ok(n <= 2, '每篇不能超过 perDoc');
  assert.ok((r.cappedByDoc ?? 0) > 0, '被挡掉的数量要单独记，别混进 dropped');
  assert.ok(perDoc.size >= 2, '短文也该有机会进来，而不是被长文占满');
});

test('相对阈值把「沾一个词」的弱命中挡掉', () => {
  const store = new KbStore(tmpDir());
  store.import({ text: '# 分布式锁\n抢锁失败后先等 3 秒再重试，重试 3 次仍失败则告警。' });
  // 只沾了「失败」两个字，主题完全无关——不设阈值时它也会被注入
  store.import({ text: '# 前端构建\n构建失败时先看 CDN 刷新日志。' });

  const loose = store.search('抢锁失败重试', { maxItems: 5, maxTokens: 5000 });
  const strict = store.search('抢锁失败重试', { maxItems: 5, maxTokens: 5000, minScoreRatio: 0.3 });
  assert.ok(loose.items.length > strict.items.length, '不设阈值时弱命中也会进来');
  assert.equal(strict.items[0].chunk.title, '分布式锁');
  assert.ok((strict.belowThreshold ?? 0) > 0);
});

test('withNeighbor 把命中块的上文带上，且标成 neighbor 不占条数', () => {
  const store = new KbStore(tmpDir());
  // 同一章节写满两块（chunker 512 tok 换块；空行分段才会被当成两个块）
  const md = [
    '# 调度服务',
    '## 4.3 分布式锁',
    '锁的键是 job_id，租约 30 秒。' + '甲'.repeat(1200),
    '',
    '抢锁失败后先等 3 秒再重试。' + '乙'.repeat(1200),
  ].join('\n');
  store.import({ text: md });

  const withN = store.search('抢锁失败', { maxItems: 1, maxTokens: 20000, withNeighbor: true });
  assert.equal(withN.items.filter((i) => !i.neighbor).length, 1, '命中仍然只算 1 条');
  assert.ok(withN.items.some((i) => i.neighbor), '同章节的上一块应该被带上');
  // 阅读顺序：上文在前
  assert.ok(withN.items[0].chunk.index < withN.items[1].chunk.index);

  const withoutN = store.search('抢锁失败', { maxItems: 1, maxTokens: 20000, withNeighbor: false });
  assert.equal(withoutN.items.length, 1);
});

test('token 预算装不下时不带上文（宁可少给，也不超预算）', () => {
  const store = new KbStore(tmpDir());
  const md = ['# 文档', '## 节', '甲'.repeat(1200), '', '抢锁失败要重试。' + '乙'.repeat(1200)].join('\n');
  store.import({ text: md });
  const r = store.search('抢锁失败', { maxItems: 2, maxTokens: 400, withNeighbor: true });
  assert.ok(r.usedTokens <= 400, `实际用了 ${r.usedTokens}`);
});

test('formatHits 给上文标注（上文），模型才知道哪段是主命中', async () => {
  const { formatHits } = await import('../src/kb/store.ts');
  const store = new KbStore(tmpDir());
  const md = ['# D', '## 节', '甲'.repeat(1200), '', '抢锁失败。' + '乙'.repeat(1200)].join('\n');
  store.import({ text: md });
  const r = store.search('抢锁失败', { maxItems: 1, maxTokens: 20000, withNeighbor: true });
  const text = formatHits(r.items);
  assert.match(text, /（上文）/);
});

/* ── 块级上下文与状态标签 ── */

const ctxDoc = (store: KbStore) =>
  store.import({
    text: [
      '# 调度服务 SDD',
      '',
      '## 3. 分布式锁',
      '',
      '抢锁用 redis SETNX，锁的 TTL 是 30 秒。',
      '',
      '## 4. 否决过的方案',
      '',
      '用 MySQL 行锁的方案被否决：压测时 QPS 到 200 就出现大量锁等待。',
    ].join('\n'),
    title: '调度服务 SDD',
  });

test('parseContexts：越界/重复序号丢掉，状态非法归为 unknown，空 context 不要', () => {
  const out = parseContexts(
    {
      chunks: [
        { index: 0, context: ' 讲抢锁 与续租 ', status: 'current' },
        { index: 0, context: '重复的', status: 'current' },
        { index: 9, context: '越界', status: 'current' },
        { index: 1, context: '被否决的备选', status: '已否决' },
        { index: 2, context: '   ', status: 'current' },
      ],
    },
    3,
  );
  assert.deepEqual(out, [
    { index: 0, context: '讲抢锁 与续租', status: 'current' },
    { index: 1, context: '被否决的备选', status: 'unknown' },
  ]);
});

test('contextualizeDoc：一次调用拿全篇；编了原文没有的数字就丢掉那一条', async () => {
  const store = new KbStore(tmpDir());
  ctxDoc(store);
  const doc = store.list()[0];
  const chunks = store.chunksOf(doc.id);
  let calls = 0;
  const llm: Llm = {
    async complete() {
      calls++;
      return {
        text: JSON.stringify({
          chunks: [
            { index: 0, context: '讲获取锁与释放锁的约定', status: 'current' },
            { index: 1, context: '这里说的是等待 99 秒后重试', status: 'rejected' },
          ],
        }),
      };
    },
  };
  const r = await contextualizeDoc(llm, doc, chunks);
  assert.equal(calls, 1, '一篇一次调用，不是每块一次');
  assert.deepEqual(r.entries.map((e) => e.index), [0]);
  assert.deepEqual(r.rejected, [{ index: 1, missing: ['99'] }]);
  assert.deepEqual(r.missing, [1], '被闸拦下的块要算成还没补上');
});

test('contextualizeDoc：模型漏给的块如实报进 missing，不静默造一条', async () => {
  const store = new KbStore(tmpDir());
  ctxDoc(store);
  const doc = store.list()[0];
  const llm: Llm = {
    async complete() {
      return { text: '{"chunks":[{"index":0,"context":"讲锁","status":"current"}]}' };
    },
  };
  const r = await contextualizeDoc(llm, doc, store.chunksOf(doc.id));
  assert.deepEqual(r.entries.length, 1);
  assert.deepEqual(r.missing, [1]);
});

test('块上下文进 BM25 语料要显式打开（indexContext）：默认不进，免得扰动排序', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  ctxDoc(store);
  const doc = store.list()[0];
  const budget = { maxItems: 3, maxTokens: 2000, minScoreRatio: 0 };

  // 「释放锁」这个说法原文里没有
  assert.equal(store.search('释放锁', budget).items.length, 0);
  store.setContexts(doc.id, [{ index: 0, context: '讲获取锁与释放锁的约定', status: 'current' }]);
  assert.equal(store.search('释放锁', budget).items.length, 0, '默认不进语料，所以还是命中不了');

  const indexed = new KbStore(dir, { indexContext: true });
  indexed.load();
  const after = indexed.search('释放锁', budget);
  assert.equal(after.items.length, 1, '显式打开后才靠上下文命中');
  assert.equal(after.items[0].chunk.index, 0);
});

test('useContext=false：上下文既不进语料，也不出现在检索结果里（对照组）', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  ctxDoc(store);
  const doc = store.list()[0];
  store.setContexts(doc.id, [{ index: 0, context: '讲获取锁与释放锁的约定', status: 'current' }]);

  const off = new KbStore(dir, { useContext: false, indexContext: true });
  off.load();
  const budget = { maxItems: 3, maxTokens: 2000, minScoreRatio: 0 };
  assert.equal(off.search('释放锁', budget).items.length, 0, '整体关掉时连语料开关也不该生效');
  const hit = off.search('SETNX', budget).items[0];
  assert.equal(hit.chunk.context, undefined);
  assert.equal(hit.chunk.status, undefined);
});

test('formatHits：非现行状态才标签，一句话上下文单独一行', async () => {
  const { formatHits } = await import('../src/kb/store.ts');
  const store = new KbStore(tmpDir());
  ctxDoc(store);
  const doc = store.list()[0];
  store.setContexts(doc.id, [
    { index: 0, context: '讲获取锁与释放锁的约定', status: 'current' },
    { index: 1, context: '记录被放弃的备选实现', status: 'rejected' },
  ]);
  const text = formatHits(
    store.search('抢锁 MySQL', { maxItems: 5, maxTokens: 4000, minScoreRatio: 0 }).items,
  );
  assert.match(text, /（这段：讲获取锁与释放锁的约定）/);
  assert.match(text, /状态: 已否决的方案/);
  // current 不标状态，省 token
  const current = text.split('--- 来源:').find((s) => s.includes('讲获取锁与释放锁'));
  assert.ok(current && !current.includes('状态:'), '现行内容不该占标签的 token');
});

test('注入预算把上下文的 token 算进去（不然报出来的 usedTokens 是假的）', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  ctxDoc(store);
  const doc = store.list()[0];
  const budget = { maxItems: 5, maxTokens: 4000, minScoreRatio: 0 };
  const before = store.search('抢锁', budget).usedTokens;
  store.setContexts(doc.id, [{ index: 0, context: '讲获取锁与释放锁的约定', status: 'rejected' }]);
  const after = store.search('抢锁', budget).usedTokens;
  assert.ok(after > before, `补了上下文之后 usedTokens 应该变大: ${before} -> ${after}`);
});

test('needsContext / contextCount：补过的不再列出，重新导入后重新算没补', () => {
  const store = new KbStore(tmpDir());
  ctxDoc(store);
  const doc = store.list()[0];
  assert.equal(store.needsContext().length, 1);
  store.setContexts(doc.id, [
    { index: 0, context: '讲锁', status: 'current' },
    { index: 1, context: '讲被否决的方案', status: 'rejected' },
  ]);
  assert.equal(store.needsContext().length, 0);
  assert.equal(store.contextCount(), 2);

  // 重新导入 = 重新切块，旧的一句话描述不该继续算数
  ctxDoc(store);
  assert.equal(store.needsContext().length, 1);
  assert.equal(store.contextCount(), 0);
});

/* ── 检索改写（Agentic RAG 最小闭环）── */

test('needsRewrite：零命中才触发；minTop1 打开后弱命中也触发', () => {
  const empty = { items: [], usedTokens: 0, dropped: 0, considered: 0 };
  assert.equal(needsRewrite(empty), 'no-hit');
  const weak = { items: [{ chunk: {}, score: 1.2 }], usedTokens: 10, dropped: 0, considered: 1 } as never;
  assert.equal(needsRewrite(weak), undefined, '默认不看绝对分（BM25 绝对分跨库不可比）');
  assert.equal(needsRewrite(weak, { minTop1: 5 }), 'weak-hit');
});

test('normalizeQueries：去标点、去重、丢掉和原查询一样的，最多 3 条', () => {
  const out = normalizeQueries(
    { queries: ['抢锁失败, 重试', '抢锁失败 重试', '原查询', '获取锁超时', '续租周期', '第四条'] },
    '原查询',
  );
  assert.deepEqual(out, ['抢锁失败 重试', '获取锁超时', '续租周期']);
});

test('pickBest：候选要赢得明显才换，平手保留原结果', () => {
  const mk = (n: number, top: number) =>
    ({ items: Array.from({ length: n }, () => ({ score: top })), usedTokens: 0, dropped: 0, considered: n }) as never;
  const base = { query: 'a', res: mk(1, 3) };
  assert.equal(pickBest(base, [{ query: 'b', res: mk(1, 3) }]).switched, false, '一样好就不换');
  assert.equal(pickBest(base, [{ query: 'b', res: mk(2, 1) }]).query, 'b', '命中更多就换');
  assert.equal(pickBest(base, [{ query: 'b', res: mk(1, 9) }]).query, 'b', '条数相同看最高分');
  assert.equal(pickBest({ query: 'a', res: mk(0, 0) }, [{ query: 'b', res: mk(0, 0) }]).switched, false);
});

test('rewriteQuery：模型抽风时返回空数组，不抛错（改写失败不该毁掉整个回合）', async () => {
  const boom: Llm = { async complete() { throw new Error('网关 500'); } };
  assert.deepEqual(await rewriteQuery(boom, '锁抢不到咋办', '锁 抢不到'), []);
  const junk: Llm = { async complete() { return { text: '我不知道' }; } };
  assert.deepEqual(await rewriteQuery(junk, '锁抢不到咋办', '锁 抢不到'), []);
});

test('kbProvider：零命中时改写一轮，换成有命中的检索词并发 kb.rewritten', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const wire = new Wire();
  const events: { picked?: string; before: number; after: number }[] = [];
  wire.subscribe((ev) => {
    if (ev.type === 'kb.rewritten') events.push({ picked: ev.picked, before: ev.before, after: ev.after });
  });
  let calls = 0;
  const llm: Llm = {
    async complete() {
      calls++;
      return { text: '{"queries":["SETNX 续租","无关词汇"]}' };
    },
  };
  const provider = kbProvider(
    store,
    wire,
    { maxItems: 6, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3 },
    { llm, maxRewrites: 1 },
  );

  // 原话里的词资料里一个都没有 → 零命中 → 触发改写
  const parts = await provider.provide('这套东西的排他控制怎么弄');
  assert.equal(calls, 1, '只改写一轮');
  assert.equal(events.length, 1);
  assert.equal(events[0].before, 0);
  assert.ok(events[0].after > 0, '改写后应该检索到内容');
  assert.equal(events[0].picked, 'SETNX 续租');
  assert.equal(parts.length, 1);
  assert.match(parts[0].content, /SETNX/);
});

test('kbProvider：maxRewrites=0 或没给 llm 时完全不改写（对照组要干净）', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const budget = { maxItems: 6, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3 };
  let calls = 0;
  const llm: Llm = { async complete() { calls++; return { text: '{"queries":["SETNX"]}' }; } };

  const wire1 = new Wire();
  let rewrote = false;
  wire1.subscribe((ev) => { if (ev.type === 'kb.rewritten') rewrote = true; });
  await kbProvider(store, wire1, budget, { llm, maxRewrites: 0 }).provide('这套东西的排他控制怎么弄');
  assert.equal(calls, 0);
  assert.equal(rewrote, false);

  await kbProvider(store, new Wire(), budget, { maxRewrites: 1 }).provide('这套东西的排他控制怎么弄');
  assert.equal(calls, 0, '没给 llm 就没法改写');
});

test('kbProvider：改写后仍然零命中就保持不注入，不硬塞垃圾', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const wire = new Wire();
  const picked: (string | undefined)[] = [];
  wire.subscribe((ev) => { if (ev.type === 'kb.rewritten') picked.push(ev.picked); });
  const llm: Llm = { async complete() { return { text: '{"queries":["彻底无关的词","另一个无关词"]}' }; } };
  const parts = await kbProvider(
    store,
    wire,
    { maxItems: 6, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3 },
    { llm, maxRewrites: 1 },
  ).provide('这套东西的排他控制怎么弄');
  assert.deepEqual(parts, [], '什么都不给，好过给看起来像答案的垃圾');
  assert.deepEqual(picked, [undefined], '没有候选胜出');
});

/* ── 删除与编辑 ── */

test('remove 把原文、文档条目、分块一起清掉', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  const { doc } = store.import({ text: '# 待删\n这里讲缓存穿透。' });
  store.import({ text: '# 留下\n这里讲分布式锁。' });
  const raw = path.join(dir, 'raw', doc.id + '.md');
  assert.ok(fs.existsSync(raw));

  assert.equal(store.remove(doc.id), true);
  assert.equal(fs.existsSync(raw), false, '原文文件要真的删掉');
  assert.equal(store.list().some((d) => d.id === doc.id), false);
  assert.equal(store.search('缓存穿透', { maxItems: 3, maxTokens: 500 }).items.length, 0, '分块也不该留在索引里');
  assert.equal(store.docCount(), 1, '别的文档不受影响');

  assert.equal(store.remove(doc.id), false, '删第二次返回 false 而不是抛');

  // 重新 load 一遍确认落盘了
  const again = new KbStore(dir);
  again.load();
  assert.equal(again.docCount(), 1);
});

test('remove 之后同名再导入，版本从 1 重新开始（旧版本已经不存在了）', () => {
  const store = new KbStore(tmpDir());
  const a = store.import({ text: '# 同名\nv1 内容。' });
  const b = store.import({ text: '# 同名\nv2 内容。' });
  assert.equal(b.doc.version, 2);
  store.remove(b.doc.id);
  const c = store.import({ text: '# 同名\n重新来。' });
  assert.equal(c.doc.version, 1);
  assert.equal(a.doc.id, c.doc.id, 'id 由标题决定，删掉重导仍是同一个 id');
});

test('raw 读回原文，非法 id 与不存在的文档都返回 undefined', () => {
  const store = new KbStore(tmpDir());
  const { doc } = store.import({ text: '# 原文\n第一行。\n第二行。' });
  assert.equal(store.raw(doc.id), '# 原文\n第一行。\n第二行。');
  assert.equal(store.raw('不存在'), undefined);
  assert.equal(store.raw('../../etc/passwd'), undefined, 'raw 也要挡路径穿越');
});

test('编辑=同标题重新导入：版本 +1，旧分块整体替换，检索只命中新内容', () => {
  const store = new KbStore(tmpDir());
  store.import({ text: '# 值班规则\n值班代号 OLD-CODE，周一交接。' });
  const before = store.search('值班代号', { maxItems: 5, maxTokens: 500 });
  assert.ok(before.items[0].chunk.text.includes('OLD-CODE'));

  const after = store.import({ text: '# 值班规则\n值班代号 NEW-CODE，周三交接。' });
  assert.equal(after.doc.version, 2);
  const hits = store.search('值班代号', { maxItems: 5, maxTokens: 500 });
  assert.equal(hits.items.length, 1, '旧版本的分块不能和新版本并存');
  assert.ok(hits.items[0].chunk.text.includes('NEW-CODE'));
  assert.equal(hits.items[0].chunk.text.includes('OLD-CODE'), false);
});

test('资料库是工作区级的：新建会话后照样检索得到（不属于某一次会话）', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-kb-ws-'));
  process.env.GB_LLM = 'fake';
  process.env.GB_LLM_QUIET = '1';
  const { buildApp } = await import('../src/app.ts');
  const app = buildApp({ workspace: ws });
  app.init();

  app.kb.import({ text: '# 调度服务 SDD\n\n## 4.3 分布式锁\n抢锁失败后先等 3 秒再重试。\n' });
  const before = app.kb.search('抢锁失败', { maxItems: 3, maxTokens: 500 }).items;
  assert.ok(before.length, '导入后当场应该检索得到');

  app.newSession();
  const after = app.kb.search('抢锁失败', { maxItems: 3, maxTokens: 500 }).items;
  assert.deepEqual(after.map((i) => i.chunk.text), before.map((i) => i.chunk.text), '换会话不该影响资料库');
  assert.equal(app.kb.docCount(), 1);

  // 换进程重开也一样：索引在 .glassbox/kb 里，不在会话日志里
  const fresh = new KbStore(path.join(ws, '.glassbox', 'kb'));
  fresh.load();
  assert.equal(fresh.docCount(), 1);
  assert.ok(fresh.search('抢锁失败', { maxItems: 3, maxTokens: 500 }).items.length);
});

test('恶意标题不会写到 raw 目录之外', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  const { doc } = store.import({ text: '正文', title: '../../evil' });
  const written = path.join(dir, 'raw', doc.id + '.md');
  assert.ok(fs.existsSync(written));
  assert.equal(path.dirname(path.resolve(written)), path.resolve(dir, 'raw'));
  assert.equal(fs.existsSync(path.resolve(dir, '../../evil.md')), false);
});

/* ── 治理：版本 / 回滚 / 重新索引 / 查重 / 敏感信息 ── */

test('同名重复导入会把上一版原文归档，versions 能列出来', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# 手册\n第一版内容', title: '手册' });
  store.import({ text: '# 手册\n第二版内容', title: '手册' });
  store.import({ text: '# 手册\n第三版内容', title: '手册' });

  const vs = store.versions('手册');
  assert.deepEqual(vs.map((v) => v.version), [3, 2, 1]);
  assert.equal(vs[0].current, true);
  // 历史版本的原文要读得回来，否则"回滚"就是空话
  assert.match(store.rawVersion('手册', 1) ?? '', /第一版内容/);
  assert.match(store.rawVersion('手册', 2) ?? '', /第二版内容/);
  assert.match(store.rawVersion('手册') ?? '', /第三版内容/);
});

test('rollback 把旧内容当成新版本，历史不会被抹掉', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# 手册\n原始写法：用 redis 抢锁', title: '手册' });
  store.import({ text: '# 手册\n改坏了：用文件锁', title: '手册' });

  const { doc } = store.rollback('手册', 1);
  assert.equal(doc.version, 3, '回滚不是退版本号，而是生成新版本');
  assert.match(store.raw('手册') ?? '', /用 redis 抢锁/);
  // 被回滚掉的那一版仍然留在历史里
  assert.match(store.rawVersion('手册', 2) ?? '', /用文件锁/);
  // 索引也跟着回滚了，检索命中的是回滚后的内容
  const hits = store.search('redis 抢锁', { maxItems: 3, maxTokens: 500 });
  assert.ok(hits.items.length);
  assert.match(hits.items[0].chunk.text, /redis/);
});

test('rollback 对不存在的资料或当前版本要报错', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# 手册\n内容', title: '手册' });
  assert.throws(() => store.rollback('不存在', 1), /没有这篇资料/);
  assert.throws(() => store.rollback('手册', 1), /当前版本/);
});

test('reindex 用当前切块参数重切全部文档，版本号不变', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# A\n' + 'x'.repeat(500), title: 'A' });
  store.import({ text: '# B\n' + 'y'.repeat(500), title: 'B' });
  const before = store.list().map((d) => `${d.id}:v${d.version}:${d.chunks}`).sort();

  const r = store.reindex();
  assert.equal(r.docs, 2);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(store.list().map((d) => `${d.id}:v${d.version}:${d.chunks}`).sort(), before);
});

test('reindex 报告读不到原文的文档，而不是静默跳过', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# A\n内容', title: 'A' });
  fs.unlinkSync(path.join(dir, 'raw', 'a.md'));
  const r = store.reindex();
  assert.equal(r.docs, 0);
  assert.deepEqual(r.missing, ['A']);
});

test('duplicatesOf 认出内容一致与高度相似，并排除自己', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  const text = '# 缓存策略\n本地缓存 30 秒，miss 时回源，回源加单飞锁避免击穿。';
  store.import({ text, title: '缓存策略' });

  const same = store.duplicatesOf(text);
  assert.equal(same.length, 1);
  assert.equal(same[0].identical, true);
  assert.equal(same[0].similarity, 1);

  // 排除自己之后就不该再报
  assert.deepEqual(store.duplicatesOf(text, { excludeId: same[0].id }), []);
  // 完全不相干的内容不报
  assert.deepEqual(store.duplicatesOf('# 值班表\n周一张三，周二李四。'), []);
});

test('remove 会把历史版本一起清掉', () => {
  const dir = tmpDir();
  const store = new KbStore(dir);
  store.import({ text: '# 手册\nv1', title: '手册' });
  store.import({ text: '# 手册\nv2', title: '手册' });
  assert.ok(fs.existsSync(path.join(dir, 'raw', 'history', '手册.v1.md')));
  store.remove('手册');
  assert.equal(fs.existsSync(path.join(dir, 'raw', 'history', '手册.v1.md')), false);
  assert.deepEqual(store.versions('手册'), []);
});

test('scanSecrets 报出疑似密钥且只回显打码片段', () => {
  const text = [
    '# 部署说明',
    'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx',
    'db: postgres://admin:hunter2secret@10.0.0.1:5432/app',
    'aws_key = AKIAIOSFODNN7EXAMPLE',
    '正常的一行中文说明',
  ].join('\n');
  const hits = scanSecrets(text);
  assert.deepEqual(hits.map((h) => h.line), [2, 3, 4]);
  // 绝不回显完整密钥
  for (const h of hits) assert.ok(!text.includes(h.preview), `preview 泄了原文: ${h.preview}`);
  assert.ok(hits[0].preview.includes('*'));
});

test('scanSecrets 不报占位符', () => {
  const text = ['api_key = your-api-key-here', 'token: <YOUR_TOKEN>', 'secret = ${VAULT_SECRET}', 'password = xxxxxxxxxxxx'].join('\n');
  assert.deepEqual(scanSecrets(text), []);
});

/* ── 工具化：kb_search / kb_read / kb_answer ── */

/** 造一个最小的插件上下文，只关心工具注册 */
function loadKbTools(store: KbStore, llm?: Llm, wiki?: WikiStore) {
  const tools = new ToolRegistry();
  const wire = new Wire();
  kbPlugin(store, { maxItems: 6, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3 }, llm, wiki).setup({
    tools,
    wire,
    workspace: '/tmp',
  });
  return tools;
}

function seedDoc(store: KbStore) {
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

test('kb_search 命中时返回带来源标注的片段', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const tools = loadKbTools(store);
  const out = await tools.get('kb_search')!.run({ query: 'SETNX 锁 TTL' });
  assert.equal(out.ok, true);
  assert.match(out.content, /来源:/);
  assert.match(out.content, /SETNX/);
});

test('kb_search 查不到时明确说没有，而不是返回空串让模型自己编', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const tools = loadKbTools(store);
  const out = await tools.get('kb_search')!.run({ query: '公司年会安排' });
  assert.equal(out.ok, true);
  assert.match(out.content, /没有|资料库是空的/);
});

test('kb_read 不给 doc 时列清单，给了 section 时只读那一章', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const tools = loadKbTools(store);
  const list = await tools.get('kb_read')!.run({});
  assert.match(list.content, /调度服务 SDD/);
  assert.match(list.content, /章节/);

  const sec = await tools.get('kb_read')!.run({ doc: '调度服务', section: '重试' });
  assert.equal(sec.ok, true);
  assert.match(sec.content, /指数退避/);

  // 限定章节就只出那一章：读「分布式锁」不该看到后面那章的内容
  // （反过来不成立——相邻块本来就带一小段上文重叠，那是设计如此）
  const lock = await tools.get('kb_read')!.run({ doc: '调度服务', section: '分布式锁' });
  assert.match(lock.content, /SETNX/);
  assert.ok(!/指数退避/.test(lock.content), '限定章节后不该把后面的章节也读出来');
});

test('kb_read 对不存在的文档/章节报错并给出可选项', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const tools = loadKbTools(store);
  const noDoc = await tools.get('kb_read')!.run({ doc: '不存在的文档' });
  assert.equal(noDoc.ok, false);
  assert.match(noDoc.content, /调度服务 SDD/);

  const noSec = await tools.get('kb_read')!.run({ doc: '调度服务', section: '不存在的章节' });
  assert.equal(noSec.ok, false);
  assert.match(noSec.content, /现有章节/);
});

test('kb_read page 读 wiki 条目：带摘要与依据；没这条时列出现有的', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const wiki = new WikiStore(path.join(tmpDir(), 'wiki'));
  wiki.write({
    ref: 'concept/分布式锁',
    title: '分布式锁',
    type: 'concept',
    summary: '抢锁与续租的约定',
    aliases: ['抢锁失败', '锁超时'],
    sources: ['调度服务-sdd#1'],
    related: [],
    verified: true,
    sourceHash: 'h',
    ts: 1,
    body: '## 结论\nTTL 30 秒 [调度服务-sdd#1]',
  });
  const tools = loadKbTools(store, undefined, wiki);
  const ok = await tools.get('kb_read')!.run({ page: 'concept/分布式锁' });
  assert.equal(ok.ok, true);
  assert.match(ok.content, /抢锁与续租的约定/);
  assert.match(ok.content, /调度服务-sdd#1/);
  assert.match(ok.content, /TTL 30 秒/);

  const missing = await tools.get('kb_read')!.run({ page: 'concept/不存在' });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /concept\/分布式锁/, '要告诉模型现在有哪些条目');
});

test('kb_read page：没启用知识目录时说清原因，不静默退化成读原文', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const out = await loadKbTools(store).get('kb_read')!.run({ page: 'concept/分布式锁' });
  assert.equal(out.ok, false);
  assert.match(out.content, /GB_WIKI=0/);
});

test('kb_read page：未通过校验的条目要带警告（正文里的数字不可信）', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const wiki = new WikiStore(path.join(tmpDir(), 'wiki'));
  wiki.write({
    ref: 'concept/重试',
    title: '重试',
    type: 'concept',
    summary: '重试次数与退避',
    aliases: [],
    sources: ['调度服务-sdd#2'],
    related: [],
    verified: false,
    unverified: ['9'],
    sourceHash: 'h',
    ts: 1,
    body: '重试 9 次',
  });
  const out = await loadKbTools(store, undefined, wiki).get('kb_read')!.run({ page: 'concept/重试' });
  assert.equal(out.ok, true);
  assert.match(out.content, /未通过溯源校验/);
});

test('kb_answer 只在给了 llm 时注册，回答里带来源', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  assert.equal(loadKbTools(store).get('kb_answer'), undefined);

  let seen = '';
  const llm: Llm = {
    async complete(messages) {
      seen = messages.map((m) => String(m.content ?? '')).join('\n');
      return { text: 'TTL 是 30 秒。来源：3. 分布式锁' };
    },
  };
  const tools = loadKbTools(store, llm);
  const out = await tools.get('kb_answer')!.run({ question: '锁的 TTL 是多久' });
  assert.equal(out.ok, true);
  assert.match(out.content, /30 秒/);
  assert.match(out.content, /来源/);
  // 检索到的资料确实喂给了模型，而且限定了"只按资料回答"
  assert.match(seen, /SETNX/);
  assert.match(seen, /只根据【资料】回答/);
});

test('kb_answer 检索不到时不问模型，直接说资料里没有', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  let called = 0;
  const llm: Llm = {
    async complete() {
      called++;
      return { text: '不该被调用' };
    },
  };
  const tools = loadKbTools(store, llm);
  const out = await tools.get('kb_answer')!.run({ question: '公司年会在哪开' });
  assert.equal(called, 0);
  assert.match(out.content, /找不到/);
});

test('kb 工具都是只读的，不该触发审批', () => {
  const store = new KbStore(tmpDir());
  const tools = loadKbTools(store, { async complete() { return { text: '' }; } });
  for (const name of ['kb_search', 'kb_read', 'kb_answer']) {
    const t = tools.get(name)!;
    const risk = t.assess?.({});
    assert.ok(!risk || risk.level === 'safe', `${name} 不该需要审批`);
  }
});

test('kb_search 的 doc / section 能把检索范围收窄', async () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  store.import({ text: ['# 值班手册', '', '## 1. 交接', '', '分布式锁相关问题找基础架构组。'].join('\n'), title: '值班手册' });
  const tools = loadKbTools(store);
  const all = await tools.get('kb_search')!.run({ query: '分布式锁' });
  assert.match(all.content, /值班手册/);
  const scoped = await tools.get('kb_search')!.run({ query: '分布式锁', doc: '调度服务' });
  assert.doesNotMatch(scoped.content, /值班手册/);
  const bySection = await tools.get('kb_search')!.run({ query: '分布式锁', section: '分布式锁' });
  assert.match(bySection.content, /SETNX/);
  assert.doesNotMatch(bySection.content, /值班手册/);
  // 范围里确实没有时要明确说没有，并把范围回显出来，模型才知道该去掉限制重试
  const empty = await tools.get('kb_search')!.run({ query: '年会', doc: '值班手册' });
  assert.match(empty.content, /值班手册/);
  assert.match(empty.content, /没有/);
});

/* ── 蒸馏（摘要 + 别名）与 digest 桥 ── */

test('parseDigest 能从带 ``` 包裹和前后废话的输出里抠出 JSON', () => {
  const d = parseDigest('好的，结果如下：\n```json\n{"summary":"讲分布式锁","aliases":["抢锁","锁超时","抢锁"]}\n```\n以上。');
  assert.equal(d?.summary, '讲分布式锁');
  // 去重后只剩两个
  assert.deepEqual(d?.aliases, ['抢锁', '锁超时']);
});

test('parseDigest 对垃圾输入返回 undefined，而不是硬造一个空 digest', () => {
  assert.equal(parseDigest('我不知道'), undefined);
  assert.equal(parseDigest('{不是合法 json}'), undefined);
  // 有 JSON 但两个字段都空 —— 等于没蒸出来
  assert.equal(parseDigest('{"summary":"","aliases":[]}'), undefined);
  // 单字别名太短，会被过滤掉
  assert.deepEqual(parseDigest('{"summary":"x","aliases":["锁","抢锁失败"]}')?.aliases, ['抢锁失败']);
});

test('distillDoc 超长正文只喂头尾，且解析失败会报错而不是静默跳过', async () => {
  let seen = '';
  const okLlm: Llm = {
    async complete(msgs) {
      seen = String(msgs[msgs.length - 1].content);
      return { text: '{"summary":"摘要","aliases":["别名一","别名二"]}' };
    },
  };
  const long = 'A'.repeat(500) + 'MIDDLE' + 'B'.repeat(500);
  const d = await distillDoc(okLlm, '长文', long, 200);
  assert.deepEqual(d.aliases, ['别名一', '别名二']);
  assert.match(seen, /中间略/);
  assert.ok(!seen.includes('MIDDLE'));

  const badLlm: Llm = { async complete() { return { text: '抱歉我做不到' }; } };
  await assert.rejects(() => distillDoc(badLlm, '坏文', '正文'), /蒸馏《坏文》失败/);
});

test('setDigest 存进去的块不算进 chunkCount，也不会被 chunksOf 读出来', () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const id = store.list()[0].id;
  const before = store.chunkCount();
  store.setDigest(id, { summary: '讲调度服务', aliases: ['抢锁失败'] });
  // digest 是索引用的，不是正文：计数和读取都要把它排除，否则面板上的块数会莫名多出来
  assert.equal(store.chunkCount(), before);
  assert.equal(store.digestCount(), 1);
  assert.ok(store.digestOf(id));
  assert.ok(!store.chunksOf(id).some((c) => c.type === 'digest'));
  // 重复蒸馏是覆盖，不是追加
  store.setDigest(id, { summary: '换个摘要', aliases: ['别名'] });
  assert.equal(store.digestCount(), 1);
  assert.match(store.digestOf(id)!.text, /换个摘要/);
});

test('needsDigest：没蒸过的要蒸；重新导入后 digest 失效，要重蒸', () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const id = store.list()[0].id;
  assert.equal(store.needsDigest().length, 1);
  store.setDigest(id, { summary: 'x', aliases: ['别名'] });
  assert.equal(store.needsDigest().length, 0);
  // 正文改了，旧摘要就不作数了（import 会连 digest 一起丢）
  store.import({ text: '# 调度服务 SDD\n\n改成了 zookeeper。', title: '调度服务 SDD' });
  assert.equal(store.digestOf(id), undefined);
  assert.equal(store.needsDigest().length, 1);
  // 归档的不用蒸
  store.archive(id);
  assert.equal(store.needsDigest().length, 0);
});

test('digest 桥：问法和原文一个字都不重合时，靠别名把正文块捞出来', () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const id = store.list()[0].id;
  const budget = { maxItems: 3, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3, digestBoost: 0.6 };
  // 「获取锁超时」和原文的「抢锁用 redis SETNX」在 2-gram 下零重合 —— BM25 必然 0 命中
  assert.equal(store.search('获取锁超时', budget).items.length, 0);
  store.setDigest(id, { summary: '调度服务的锁与重试约定', aliases: ['获取锁超时', '抢锁失败'] });
  const bridged = store.search('获取锁超时', budget);
  assert.ok(bridged.items.length > 0, '别名命中后应该能带出正文块');
  assert.equal(bridged.digestBridged, 1);
  // 捞出来的是正文（含具体数字），不是摘要本身 —— 摘要里没有 30 秒这种细节，注入它没用
  assert.ok(!bridged.items.some((h) => h.chunk.type === 'digest'));
  assert.ok(bridged.items.some((h) => h.chunk.text.includes('SETNX')));
  assert.ok(bridged.items.some((h) => (h.digestBoost ?? 0) > 0));
});

test('digestBoost=0 时桥关掉（A/B 对照组用的就是这条路径）', () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  store.setDigest(store.list()[0].id, { summary: '锁与重试', aliases: ['获取锁超时'] });
  const off = { maxItems: 3, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3, digestBoost: 0 };
  const res = store.search('获取锁超时', off);
  assert.equal(res.items.length, 0);
  assert.ok(!res.digestBridged);
});

test('digest 只加分不越权：字面命中的文档排序不被别名反超', () => {
  const store = new KbStore(tmpDir());
  store.import({ text: '# A 文档\n\n值班交接时间是 14:40。', title: 'A 文档' });
  store.import({ text: '# B 文档\n\n这里讲的是完全无关的构建流程。', title: 'B 文档' });
  // 给 B 挂一个会命中查询的别名，A 则是字面命中
  store.setDigest(store.list().find((d) => d.title === 'B 文档')!.id, { summary: '构建', aliases: ['值班交接'] });
  const res = store.search('值班交接时间', { maxItems: 4, maxTokens: 800, perDoc: 3, minScoreRatio: 0, digestBoost: 0.6 });
  // 输出是按文档/序号排的阅读顺序，所以要看分数最高的是谁，而不是 items[0]
  const top = [...res.items].sort((a, b) => b.score - a.score)[0];
  assert.equal(top.chunk.title, 'A 文档', '真正写着答案的文档要分最高');
});

test('已经字面命中的文档不再加桥分（否则相对阈值被压平、注入 token 暴涨）', () => {
  const store = new KbStore(tmpDir());
  seedDoc(store);
  const id = store.list()[0].id;
  const budget = { maxItems: 6, maxTokens: 800, perDoc: 3, minScoreRatio: 0.3, digestBoost: 0.6 };
  const before = store.search('分布式锁 TTL', budget);
  store.setDigest(id, { summary: '锁与重试约定', aliases: ['分布式锁', '获取锁超时'] });
  const after = store.search('分布式锁 TTL', budget);
  // 这个查询本来就命中了正文，桥不该介入：块数和 token 必须和没蒸馏时一模一样
  assert.equal(after.items.length, before.items.length);
  assert.equal(after.usedTokens, before.usedTokens);
  assert.ok(!after.digestBridged);
  assert.ok(!after.items.some((h) => h.digestBoost));
});

/* ── 版本 diff ── */

test('lineDiff 认出增删改，改一行 = 先删后加', () => {
  const { lines, stat } = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(stat, { added: 2, removed: 1, truncated: false });
  assert.deepEqual(
    lines.map((l) => l.op + ':' + l.text),
    ['same:a', 'del:b', 'add:B', 'same:c', 'add:d'],
  );
  // 行号按各自版本编号，新增行没有 oldNo、删除行没有 newNo
  assert.equal(lines[1].oldNo, 2);
  assert.equal(lines[1].newNo, undefined);
  assert.equal(lines[4].newNo, 4);
  assert.equal(lines[4].oldNo, undefined);
});

test('lineDiff 内容一致时零差异；末尾换行不算一行改动', () => {
  const same = lineDiff('第一行\n第二行', '第一行\n第二行\n');
  assert.equal(same.stat.added, 0);
  assert.equal(same.stat.removed, 0);
  assert.ok(same.lines.every((l) => l.op === 'same'));
  // 空 → 有内容
  const born = lineDiff('', '新内容\n');
  assert.equal(born.stat.added, 1);
  assert.equal(born.stat.removed, 0);
  // \r\n 不该被当成内容差异
  assert.equal(lineDiff('a\r\nb', 'a\nb').stat.added, 0);
});

test('collapseSame 只留改动处附近，中间折成一条 gap', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => 'L' + i).join('\n');
  const newText = oldText.replace('L10', 'L10 改了');
  const { lines } = lineDiff(oldText, newText);
  const hunks = collapseSame(lines, 2);
  // 20 行只改了 1 行，折叠后应该短得多
  assert.ok(hunks.length < 10, `折叠后还有 ${hunks.length} 行，没起作用`);
  assert.ok(hunks.some((l) => l.gap && l.gap > 0), '中间应该有一条「省略 n 行」');
  assert.ok(hunks.some((l) => l.op === 'del' && l.text === 'L10'));
  assert.ok(hunks.some((l) => l.op === 'add' && l.text === 'L10 改了'));
  // 上下文行还在
  assert.ok(hunks.some((l) => l.op === 'same' && l.text === 'L9'));
  assert.ok(hunks.some((l) => l.op === 'same' && l.text === 'L11'));
});


