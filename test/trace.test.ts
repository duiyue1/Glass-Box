import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrajectory } from '../src/traceView.ts';
import { parseUsage } from '../src/llm/realLlm.ts';
import type { JournalRecord } from '../src/engine/journal.ts';
import type { WireEvent } from '../src/engine/types.ts';

/** 造一段事件记录：seq 从 1 连续编号，ts 由调用方给（毫秒） */
function recs(evs: WireEvent[]): JournalRecord[] {
  return evs.map((ev, i) => ({ seq: i + 1, ev }));
}

const T = 'turn-1';

/* ── usage 解析 ── */

test('parseUsage 认 OpenAI 形状，并取出缓存命中', () => {
  const u = parseUsage({
    prompt_tokens: 1200,
    completion_tokens: 80,
    total_tokens: 1280,
    prompt_tokens_details: { cached_tokens: 1100 },
  })!;
  assert.deepEqual(u, { prompt: 1200, completion: 80, total: 1280, cached: 1100 });
});

test('parseUsage 认 DeepSeek 的 prompt_cache_hit_tokens，total 缺失时自己加', () => {
  const u = parseUsage({ prompt_tokens: 900, completion_tokens: 100, prompt_cache_hit_tokens: 640 })!;
  assert.equal(u.total, 1000);
  assert.equal(u.cached, 640);
});

test('parseUsage 对空/垃圾输入返回 undefined，不编数', () => {
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ prompt_tokens: 'many' }), undefined);
});

/* ── 轨迹派生 ── */

test('按回合分层：一个回合里的行都挂在它下面，回合外的进 between', () => {
  const t = buildTrajectory(
    recs([
      { type: 'session.started', sessionId: 's', path: 'p', ts: 100 },
      { type: 'turn.start', turnId: T, userText: '看看 README', ts: 200 },
      { type: 'llm.request', turnId: T, messages: [], ts: 210 },
      { type: 'llm.response', turnId: T, response: { text: '好的' }, ts: 400 },
      { type: 'turn.end', turnId: T, messages: [], ts: 410 },
      { type: 'memory.distilled', atoms: [{ kind: 'fact', text: 'x' }], total: 3, ts: 420 },
    ]),
  );
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].userText, '看看 README');
  assert.equal(t.turns[0].closed, true);
  assert.equal(t.turns[0].stats.wallMs, 210);
  // session.started 在第一个回合之前，memory.distilled 在它之后
  assert.deepEqual(t.between.map((b) => b.afterTurn), [0, 1]);
  assert.equal(t.between[0].rows[0].type, 'session.started');
  assert.equal(t.between[1].rows[0].type, 'memory.distilled');
});

test('耗时配对：模型 = request→response，工具 = call→result，审批单独算', () => {
  const t = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: T, userText: 'q', ts: 0 },
      { type: 'llm.request', turnId: T, messages: [], ts: 100 },
      { type: 'llm.delta', turnId: T, text: '思', ts: 250 },
      {
        type: 'llm.response',
        turnId: T,
        response: { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
        ts: 400,
      },
      { type: 'tool.call', turnId: T, call: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } }, ts: 410 },
      {
        type: 'approval.request',
        turnId: T,
        request: { toolName: 'read_file', level: 'confirm', summary: '读工作区外的文件' },
        ts: 420,
      },
      {
        type: 'approval.decision',
        turnId: T,
        request: { toolName: 'read_file', level: 'confirm', summary: '读工作区外的文件' },
        approved: true,
        ts: 1420,
      },
      { type: 'tool.result', turnId: T, result: { toolCallId: 'c1', ok: true, content: 'hello' }, ts: 1500 },
      { type: 'turn.end', turnId: T, messages: [], ts: 1510 },
    ]),
  );
  const s = t.turns[0].stats;
  assert.equal(s.llmMs, 300, '模型耗时 = 400-100');
  assert.equal(s.ttftMs, 150, '首 token = 250-100');
  assert.equal(s.toolMs, 1090, '工具耗时 = 1500-410（含等审批那段真实墙钟）');
  assert.equal(s.approvalMs, 1000, '等人审批单独算出来，不然会被当成工具慢');
  assert.equal(s.steps, 1);

  const tool = t.turns[0].rows.find((r) => r.type === 'tool.result')!;
  assert.equal(tool.ms, 1090);
  assert.equal(tool.ok, true);
});

test('token 用量按回合累加，缓存命中一起加；没有 usage 时不编总量', () => {
  const withUsage = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: T, userText: 'q', ts: 0 },
      { type: 'llm.request', turnId: T, messages: [], ts: 10 },
      {
        type: 'llm.response',
        turnId: T,
        response: { text: 'a', usage: { prompt: 1000, completion: 50, total: 1050, cached: 900 } },
        ts: 20,
      },
      { type: 'llm.request', turnId: T, messages: [], ts: 30 },
      {
        type: 'llm.response',
        turnId: T,
        response: { text: 'b', usage: { prompt: 1100, completion: 30, total: 1130, cached: 1000 } },
        ts: 40,
      },
      { type: 'turn.end', turnId: T, messages: [], ts: 50 },
    ]),
  );
  assert.deepEqual(withUsage.turns[0].stats.usage, { prompt: 2100, completion: 80, total: 2180, cached: 1900 });
  assert.equal(withUsage.summary.usageCalls, 2);
  assert.equal(withUsage.summary.llmCalls, 2);

  const without = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: T, userText: 'q', ts: 0 },
      { type: 'llm.request', turnId: T, messages: [], ts: 10 },
      { type: 'llm.response', turnId: T, response: { text: 'a' }, ts: 20 },
      { type: 'turn.end', turnId: T, messages: [], ts: 30 },
    ]),
  );
  assert.equal(without.summary.usage, undefined, '没拿到 usage 就不该有总量');
  assert.equal(without.summary.usageCalls, 0);
  assert.equal(without.summary.llmCalls, 1);
});

test('窗口里配不上对的调用不编耗时（分页时只看到后半截）', () => {
  // 只给 tool.result，没有对应的 tool.call
  const t = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: T, userText: 'q', ts: 0 },
      { type: 'tool.result', turnId: T, result: { toolCallId: 'c9', ok: false, content: '出错了' }, ts: 900 },
    ]),
  );
  const row = t.turns[0].rows.find((r) => r.type === 'tool.result')!;
  assert.equal(row.ms, undefined, '配不上对就不给耗时');
  assert.equal(row.ok, false);
  assert.equal(t.turns[0].stats.toolMs, 0);
  assert.equal(t.turns[0].closed, false, '没有 turn.end 要标成未收尾');
});

test('llm.delta / state.change 不单独占行（否则一个回合几百行）', () => {
  const t = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: T, userText: 'q', ts: 0 },
      { type: 'state.change', turnId: T, from: 'idle', to: 'thinking', ts: 1 },
      { type: 'llm.request', turnId: T, messages: [], ts: 2 },
      { type: 'llm.delta', turnId: T, text: 'a', ts: 3 },
      { type: 'llm.delta', turnId: T, text: 'b', ts: 4 },
      { type: 'llm.response', turnId: T, response: { text: 'ab' }, ts: 5 },
    ]),
  );
  assert.deepEqual(t.turns[0].rows.map((r) => r.type), ['turn.start', 'llm.response']);
});

test('行摘要带得动关键信息：工具名、注入条数、分叉屏蔽', () => {
  const t = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: T, userText: 'q', ts: 0 },
      { type: 'tool.call', turnId: T, call: { id: 'c1', name: 'grep', args: { pattern: 'StreamGate' } }, ts: 1 },
      {
        type: 'memory.injected',
        items: [{ kind: 'fact', text: 'x', score: 1 }],
        usedTokens: 8,
        budget: 40,
        dropped: 0,
        hiddenByFork: 2,
        ts: 2,
      },
      {
        type: 'kb.injected',
        items: [{ title: 'SDD', headingPath: '4.3', score: 3.2, tokens: 90 }],
        usedTokens: 90,
        budget: 400,
        dropped: 1,
        considered: 4,
        ts: 3,
      },
    ]),
  );
  const rows = t.turns[0].rows;
  assert.match(rows.find((r) => r.type === 'tool.call')!.label, /grep/);
  assert.match(rows.find((r) => r.type === 'memory.injected')!.summary, /分叉屏蔽 2/);
  assert.match(rows.find((r) => r.type === 'kb.injected')!.summary, /命中 4 丢 1/);
});

test('汇总：平均首 token、输出速度、墙钟跨度', () => {
  const t = buildTrajectory(
    recs([
      { type: 'turn.start', turnId: 't1', userText: 'q1', ts: 0 },
      { type: 'llm.request', turnId: 't1', messages: [], ts: 0 },
      { type: 'llm.delta', turnId: 't1', text: 'a', ts: 100 },
      { type: 'llm.response', turnId: 't1', response: { text: 'a', usage: { prompt: 10, completion: 200, total: 210 } }, ts: 1000 },
      { type: 'turn.end', turnId: 't1', messages: [], ts: 1000 },
      { type: 'turn.start', turnId: 't2', userText: 'q2', ts: 2000 },
      { type: 'llm.request', turnId: 't2', messages: [], ts: 2000 },
      { type: 'llm.delta', turnId: 't2', text: 'b', ts: 2300 },
      { type: 'llm.response', turnId: 't2', response: { text: 'b', usage: { prompt: 10, completion: 100, total: 110 } }, ts: 3000 },
      { type: 'turn.end', turnId: 't2', messages: [], ts: 3000 },
    ]),
  );
  assert.equal(t.summary.turns, 2);
  assert.equal(t.summary.avgTtftMs, 200, '(100 + 300) / 2');
  assert.equal(t.summary.llmMs, 2000);
  assert.equal(t.summary.wallMs, 3000);
  assert.equal(t.summary.tokPerSec, 150, '300 completion / 2s');
});

test('分页看中段：带上 openTurn 后行仍然挂在原来的回合下，编号接着往下数', () => {
  // 窗口从回合中间开始：只有 tool.result 和下一轮模型回复
  const t = buildTrajectory(
    recs([
      { type: 'tool.result', turnId: T, result: { toolCallId: 'c1', ok: true, content: 'ok' }, ts: 500 },
      { type: 'llm.request', turnId: T, messages: [], ts: 510 },
      { type: 'llm.response', turnId: T, response: { text: '结论' }, ts: 700 },
      { type: 'turn.end', turnId: T, messages: [], ts: 710 },
      { type: 'turn.start', turnId: 't-next', userText: '再问一句', ts: 800 },
    ]),
    { openTurn: { turnId: T, userText: '前一页开始的问题', startTs: 100 }, turnsBefore: 3 },
  );
  assert.equal(t.turns.length, 2);
  assert.equal(t.turns[0].index, 3, '进行中的那个回合就是第 3 个');
  assert.equal(t.turns[0].partial, true);
  assert.equal(t.turns[0].userText, '前一页开始的问题');
  assert.equal(t.turns[0].closed, true, '窗口里看到了 turn.end');
  assert.equal(t.turns[0].rows.length, 2, 'tool.result 和 llm.response 都挂在它下面，不是「回合之间」');
  assert.equal(t.turns[1].index, 4);
  assert.equal(t.between.length, 0);
});

test('空输入不炸', () => {
  const t = buildTrajectory([]);
  assert.deepEqual(t.turns, []);
  assert.deepEqual(t.between, []);
  assert.equal(t.summary.turns, 0);
  assert.equal(t.summary.wallMs, 0);
});
