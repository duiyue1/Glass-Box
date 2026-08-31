import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WireEvent } from '../src/engine/types.ts';
import {
  cellOf,
  citesSource,
  countHits,
  judgeCellOf,
  looksRefused,
  metricsOf,
  parseJudge,
  questionOf,
  summarize,
  turnsOf,
  type EvalCase,
  type RunMetrics,
} from '../src/eval/core.ts';

/**
 * 评测框架自己也得能被测——不然「资料库有没有用」这个结论就是拿一把没校准的尺子量出来的。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-eval-'));
}

test('countHits 大小写不敏感，按关键词逐个计数', () => {
  assert.equal(countHits('租约 30 秒，续租 10 秒', ['30', '10']), 2);
  assert.equal(countHits('租约 30 秒', ['30', '10']), 1);
  assert.equal(countHits('TTL is 30s', ['ttl']), 1);
  assert.equal(countHits('什么都没说', ['30']), 0);
});

test('countHits 数字按边界匹配，不被更长的数字蹭中', () => {
  // 实测踩过的坑：对照组答「常见是 100、128、160 之类」，子串匹配下 10 和 160 都算命中，
  // 一个明确答错的回答拿了满分
  const wrong = '没有统一固定值，常见配置是 100、128、160 之类';
  assert.equal(countHits(wrong, ['160']), 1, '160 确实出现了');
  assert.equal(countHits(wrong, ['10']), 0, '10 只是 100 的一部分，不算命中');
  assert.equal(countHits('退回 10 次', ['10']), 1);
});

test('countHits 忽略中文与数字之间的空格', () => {
  assert.equal(countHits('偏移超过 5 秒', ['5 秒']), 1);
  assert.equal(countHits('偏移超过5秒', ['5 秒']), 1);
  assert.equal(countHits('偏移超过 500 毫秒', ['5 秒']), 0);
});

test('looksRefused 认得各种「资料里没有」的说法，不误伤正常回答', () => {
  for (const s of [
    '资料库里没有和熔断相关的内容',
    '文档未提及手机号',
    '这份资料里查不到熔断配置',
    '联系人不在本文档维护',
    '没有找到相关内容',
    // 实测漏判过这一条：模型说的是「没写」而不是「没有写」
    '文档里没写值班同学的手机号。',
    'not specified in the document',
  ]) {
    assert.ok(looksRefused(s), `应判为拒答: ${s}`);
  }
  for (const s of ['熔断阈值配置在 config/circuit.yaml 里', '租约 30 秒，续租周期 10 秒']) {
    assert.ok(!looksRefused(s), `不该判为拒答: ${s}`);
  }
});

test('citesSource 认出来源标注', () => {
  assert.ok(citesSource('租约 30 秒。来源：调度服务 SDD > 3. 分布式锁'));
  assert.ok(citesSource('见《调度服务 SDD》第 3 节'));
  assert.ok(!citesSource('租约是 30 秒。'));
});

test('metricsOf 从事件流里算出注入量、kb 工具次数、首 token 延迟与真实 token', () => {
  const events: WireEvent[] = [
    { type: 'turn.start', turnId: 't1', userText: '问题', ts: 1000 },
    {
      type: 'kb.injected',
      items: [
        { title: 'A', headingPath: 'A > 1', score: 3, tokens: 100 },
        { title: 'A', headingPath: 'A > 1', score: 3, tokens: 50, neighbor: true },
      ],
      usedTokens: 150,
      budget: 800,
      dropped: 0,
      considered: 5,
      ts: 1010,
    },
    { type: 'llm.delta', turnId: 't1', text: '租', ts: 1300 },
    { type: 'llm.delta', turnId: 't1', text: '约', ts: 1310 },
    {
      type: 'llm.response',
      turnId: 't1',
      response: { toolCalls: [{ id: 'c1', name: 'kb_search', args: { query: '锁' } }], usage: { prompt: 700, completion: 20, total: 720 } },
      ts: 1400,
    },
    { type: 'tool.call', turnId: 't1', call: { id: 'c1', name: 'kb_search', args: { query: '锁' } }, ts: 1410 },
    { type: 'tool.call', turnId: 't1', call: { id: 'c2', name: 'read_file', args: { path: 'a.md' } }, ts: 1420 },
    {
      type: 'llm.response',
      turnId: 't1',
      response: { text: '租约 30 秒', usage: { prompt: 900, completion: 40, total: 940 } },
      ts: 1800,
    },
    { type: 'turn.end', turnId: 't1', messages: [], ts: 1900 },
  ];

  const m = metricsOf(events);
  assert.equal(m.injectedItems, 2);
  assert.equal(m.injectedTokens, 150);
  assert.equal(m.kbToolCalls, 1, 'read_file 不该算进 kb 工具');
  assert.equal(m.steps, 2);
  assert.equal(m.ttftMs, 300);
  assert.equal(m.wallMs, 900);
  // 一个回合里多次请求，token 要累加，否则多步任务的成本会被少算
  assert.equal(m.promptTokens, 1600);
  assert.equal(m.completionTokens, 60);
});

test('metricsOf 没有 usage 的网关不编造 token', () => {
  const m = metricsOf([
    { type: 'turn.start', turnId: 't1', userText: 'x', ts: 0 },
    { type: 'llm.response', turnId: 't1', response: { text: 'ok' }, ts: 10 },
    { type: 'turn.end', turnId: 't1', messages: [], ts: 20 },
  ]);
  assert.equal(m.promptTokens, undefined);
  assert.equal(m.completionTokens, undefined);
  assert.equal(m.ttftMs, undefined, '没有 llm.delta 就没有首 token 延迟');
});

test('summarize 分开算正例命中率与负例拒答率', () => {
  const cases: EvalCase[] = [
    { id: 'F1', dimension: '事实', question: 'q1', expectKeywords: ['30', '10'] },
    { id: 'F2', dimension: '事实', question: 'q2', expectKeywords: ['3'] },
    { id: 'N1', dimension: '没有', question: 'q3', negative: true },
  ];
  const base: Omit<RunMetrics, 'answer' | 'citedSource' | 'sessionId'> = {
    injectedItems: 0,
    injectedTokens: 100,
    kbToolCalls: 1,
    steps: 1,
    wallMs: 1000,
  };
  const runs = new Map<string, RunMetrics[]>([
    ['F1:kb', [{ answer: '', citedSource: true, sessionId: 's1', hits: 2, total: 2, judgeScore: 2, ...base }]],
    ['F2:kb', [{ answer: '', citedSource: false, sessionId: 's2', hits: 0, total: 1, judgeScore: 0, ...base }]],
    ['N1:kb', [{ answer: '', citedSource: false, sessionId: 's3', refused: true, judgeScore: 2, ...base }]],
  ]);

  const s = summarize(cases, runs, 'kb');
  assert.equal(s.keywordRate, 2 / 3, '按关键词总数算，不是按用例数');
  assert.equal(s.fullHitRate, 0.5, '两条正例里一条全中');
  assert.equal(s.refusalRate, 1);
  assert.equal(Math.round((s.citedRate ?? 0) * 100), 33);
  assert.equal(s.judgeAvg, (2 + 0 + 2) / 3);
  assert.equal(s.avgInjectedTokens, 100);
  assert.equal(s.kbToolCalls, 3);
  assert.equal(s.runCount, 3);
  assert.equal(s.judgeSpread, undefined, '每条只跑一次，谈不上波动');
});

test('summarize 在 --repeat 下按次统计，并报出评分波动', () => {
  const cases: EvalCase[] = [
    { id: 'F1', dimension: '事实', question: 'q1', expectKeywords: ['30'] },
    { id: 'N1', dimension: '没有', question: 'q2', negative: true },
  ];
  const base: Omit<RunMetrics, 'answer' | 'citedSource' | 'sessionId'> = {
    injectedItems: 0,
    injectedTokens: 50,
    kbToolCalls: 0,
    steps: 0,
    wallMs: 500,
  };
  const mk = (over: Partial<RunMetrics>): RunMetrics => ({
    answer: '',
    citedSource: false,
    sessionId: 's',
    ...base,
    ...over,
  });
  const runs = new Map<string, RunMetrics[]>([
    // 同一条题：一次全中一次没中 —— 均值 50%，且评分波动 2
    ['F1:kb', [mk({ hits: 1, total: 1, judgeScore: 2 }), mk({ hits: 0, total: 1, judgeScore: 0 })]],
    ['N1:kb', [mk({ refused: true, judgeScore: 2 }), mk({ refused: false, judgeScore: 1 })]],
  ]);

  const s = summarize(cases, runs, 'kb');
  assert.equal(s.runCount, 4);
  assert.equal(s.keywordRate, 0.5);
  assert.equal(s.fullHitRate, 0.5, '按运行次数算全中率，不是按用例数');
  assert.equal(s.refusalRate, 0.5);
  assert.equal(s.judgeAvg, (2 + 0 + 2 + 1) / 4);
  assert.equal(s.judgeSpread, (2 + 1) / 2, '两条题的 max-min 分别是 2 和 1');
});

test('summarize 对缺失的那一组不炸，只是全是 0', () => {
  const cases: EvalCase[] = [{ id: 'F1', dimension: '事实', question: 'q', expectKeywords: ['30'] }];
  const s = summarize(cases, new Map(), 'nokb');
  assert.equal(s.keywordRate, 0);
  assert.equal(s.judgeAvg, undefined);
  assert.equal(s.avgWallMs, 0);
  assert.equal(s.runCount, 0);
});

test('turnsOf / questionOf 支持单轮与多轮，缺两者时报错', () => {
  assert.deepEqual(turnsOf({ id: 'a', dimension: 'd', question: '锁租约多久' }), ['锁租约多久']);
  assert.deepEqual(turnsOf({ id: 'b', dimension: 'd', turns: ['锁租约多久', '它的续租周期呢'] }), [
    '锁租约多久',
    '它的续租周期呢',
  ]);
  // 评分模型必须看到前几轮，否则「它的续租周期呢」根本没法评
  assert.match(questionOf({ id: 'b', dimension: 'd', turns: ['锁租约多久', '它的续租周期呢'] }), /第1轮.*第2轮/s);
  assert.equal(questionOf({ id: 'a', dimension: 'd', question: '锁租约多久' }), '锁租约多久');
  assert.throws(() => turnsOf({ id: 'c', dimension: 'd' }), /既没有 question 也没有 turns/);
});

test('cellOf / judgeCellOf 把多次运行压成一格', () => {
  const mk = (over: Partial<RunMetrics>): RunMetrics => ({
    answer: '',
    citedSource: false,
    sessionId: 's',
    injectedItems: 0,
    injectedTokens: 0,
    kbToolCalls: 0,
    steps: 0,
    wallMs: 0,
    ...over,
  });
  const pos: EvalCase = { id: 'F1', dimension: 'd', question: 'q', expectKeywords: ['30'] };
  const neg: EvalCase = { id: 'N1', dimension: 'd', question: 'q', negative: true };

  assert.equal(cellOf(pos, [mk({ hits: 1, total: 1 })]), '1/1');
  assert.equal(cellOf(pos, [mk({ hits: 1, total: 1 }), mk({ hits: 0, total: 1 })]), '1/1~0/1');
  assert.equal(cellOf(neg, [mk({ refused: true })]), '拒答✓');
  assert.equal(cellOf(neg, [mk({ refused: true }), mk({ refused: false })]), '拒答 1/2');
  assert.equal(cellOf(pos, []), '—');

  assert.equal(judgeCellOf([mk({ judgeScore: 2 })]), '2分');
  assert.equal(judgeCellOf([mk({ judgeScore: 2 }), mk({ judgeScore: 0 })]), '1.0分(0~2)');
  assert.equal(judgeCellOf([mk({ judgeScore: 2 }), mk({ judgeScore: 2 })]), '2.0分');
  assert.equal(judgeCellOf([mk({})]), '');
});

test('parseJudge 解析「分数|理由」，格式不对时报解析失败而不是给 0 分', () => {
  assert.deepEqual(parseJudge('2|要点齐全'), { score: 2, reason: '要点齐全' });
  assert.deepEqual(parseJudge(' 1｜部分正确 '), { score: 1, reason: '部分正确' });
  assert.equal(parseJudge('0：编造了配置路径').score, 0);
  const bad = parseJudge('我觉得这个回答还不错');
  assert.equal(bad.score, undefined, '解析不出来就别当 0 分，否则会把评分拉低');
  assert.match(bad.reason ?? '', /解析失败/);
});

/* ── GB_KB=0 的对照组必须是真的什么都没有 ── */

async function runTurnWith(kb: '0' | '1', workspace: string): Promise<WireEvent[]> {
  const prev = { kb: process.env.GB_KB, sess: process.env.GB_SESSIONS_DIR, llm: process.env.GB_LLM };
  process.env.GB_KB = kb;
  process.env.GB_SESSIONS_DIR = path.join(workspace, 'sess');
  process.env.GB_LLM = 'fake';
  process.env.GB_LLM_QUIET = '1';
  process.env.GB_MEM_PERSIST = '0';
  try {
    const { buildApp } = await import('../src/app.ts');
    const app = buildApp({ workspace });
    const events: WireEvent[] = [];
    app.wire.subscribe((ev) => events.push(ev));
    app.init();
    await app.session.ask('分布式锁的租约是多久');
    return events;
  } finally {
    if (prev.kb === undefined) delete process.env.GB_KB;
    else process.env.GB_KB = prev.kb;
    if (prev.sess === undefined) delete process.env.GB_SESSIONS_DIR;
    else process.env.GB_SESSIONS_DIR = prev.sess;
    if (prev.llm === undefined) delete process.env.GB_LLM;
    else process.env.GB_LLM = prev.llm;
  }
}

async function seed(workspace: string): Promise<void> {
  const { KbStore } = await import('../src/kb/store.ts');
  const store = new KbStore(path.join(workspace, '.glassbox', 'kb'));
  store.import({
    text: '# 调度服务\n\n## 分布式锁\n\n锁的租约是 30 秒，续租周期 10 秒，抢锁失败等 3 秒重试。',
    title: '调度服务',
  });
}

test('GB_KB=1：资料库加载、kb 插件注册、命中时注入', async () => {
  const ws = tmpDir();
  await seed(ws);
  const events = await runTurnWith('1', ws);
  const loaded = events.find((e) => e.type === 'kb.loaded');
  assert.ok(loaded, '应该有 kb.loaded');
  const plugin = events.find((e) => e.type === 'plugin.loaded' && e.name === 'kb');
  assert.ok(plugin, 'kb 插件应该注册');
  assert.deepEqual(
    plugin?.type === 'plugin.loaded' ? plugin.tools.filter((t) => t.startsWith('kb_')).sort() : [],
    ['kb_answer', 'kb_read', 'kb_search'],
  );
  assert.ok(
    events.some((e) => e.type === 'kb.injected' && e.items.length > 0),
    '这个问题该命中资料',
  );
});

test('GB_KB=0：不加载、不注册、不注入——对照组是干净的', async () => {
  const ws = tmpDir();
  await seed(ws);
  const events = await runTurnWith('0', ws);
  assert.equal(events.some((e) => e.type === 'kb.loaded'), false);
  assert.equal(events.some((e) => e.type === 'kb.injected'), false);
  assert.equal(events.some((e) => e.type === 'plugin.loaded' && e.name === 'kb'), false);
  // 回合本身照样跑完，不能因为关了资料库就把链路弄挂
  assert.ok(events.some((e) => e.type === 'turn.end'));
});

test('GB_SESSIONS_DIR 生效：评测日志不落到 .glassbox/sessions', async () => {
  const ws = tmpDir();
  await seed(ws);
  await runTurnWith('1', ws);
  assert.ok(fs.existsSync(path.join(ws, 'sess')), '日志应该写到指定目录');
  assert.equal(fs.existsSync(path.join(ws, '.glassbox', 'sessions')), false);
});

test('蒸馏失败时报回失败清单，而不是把整个流程抛掉', async () => {
  const ws = tmpDir();
  await seed(ws);
  const prev = { llm: process.env.GB_LLM, sess: process.env.GB_SESSIONS_DIR };
  process.env.GB_LLM = 'fake';
  process.env.GB_LLM_QUIET = '1';
  process.env.GB_MEM_PERSIST = '0';
  process.env.GB_SESSIONS_DIR = path.join(ws, 'sess');
  try {
    const { buildApp } = await import('../src/app.ts');
    const app = buildApp({ workspace: ws });
    app.init();
    assert.equal(app.kb.needsDigest().length, 1);
    // FakeLlm 不会吐 JSON —— 这就是「模型给了废话」的真实情形
    const r = await app.distill();
    assert.equal(r.done.length, 0);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0], /蒸馏/);
    // 失败不该留下半个 digest 块
    assert.equal(app.kb.digestCount(), 0);
  } finally {
    if (prev.llm === undefined) delete process.env.GB_LLM;
    else process.env.GB_LLM = prev.llm;
    if (prev.sess === undefined) delete process.env.GB_SESSIONS_DIR;
    else process.env.GB_SESSIONS_DIR = prev.sess;
  }
});

test('评测集文件本身是合法的：id 唯一、正例有关键词、负例有参考答案', () => {
  const raw = fs.readFileSync(path.join(import.meta.dirname, '..', 'eval', 'kb-cases.json'), 'utf8');
  const set = JSON.parse(raw) as { name: string; cases: EvalCase[] };
  assert.ok(set.cases.length >= 10, '用例太少，比出来的差异说明不了什么');
  assert.equal(new Set(set.cases.map((c) => c.id)).size, set.cases.length, 'id 有重复');
  for (const c of set.cases) {
    assert.ok(c.dimension, `${c.id} 缺 dimension`);
    assert.ok(c.reference, `${c.id} 缺 reference（评分模型要用）`);
    // question 与 turns 只能有一个，且至少有一个
    assert.notEqual(Boolean(c.question), Boolean(c.turns?.length), `${c.id} 的 question / turns 必须二选一`);
    assert.doesNotThrow(() => turnsOf(c), `${c.id} 取不出要问的话`);
    if (c.negative) assert.equal(c.expectKeywords, undefined, `${c.id} 是负例，不该有关键词`);
    else assert.ok((c.expectKeywords ?? []).length > 0, `${c.id} 是正例，必须有关键词`);
  }
  assert.ok(
    set.cases.some((c) => c.negative),
    '必须有负例，否则测不出「资料里没有时会不会编」',
  );
  // 第 0 批加的难例：没有它们，评测集会顶在天花板上，无法给检索参数调参
  for (const d of ['同义表述', '多轮指代', '跨文档冲突', '长尾细节', '干扰负例']) {
    assert.ok(
      set.cases.some((c) => c.dimension === d),
      `缺少「${d}」维度的难例`,
    );
  }
  assert.ok(
    set.cases.some((c) => (c.turns?.length ?? 0) > 1),
    '必须有多轮用例，否则指代兜底没被测到',
  );
});
