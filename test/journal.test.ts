import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Loop, type Llm } from '../src/engine/loop.ts';
import { Journal, MAX_TITLE, deleteSession, isSafeSessionId, lastSeq, listSessions, newSessionId, readEvents, renameSession, sessionFile } from '../src/engine/journal.ts';
import { rebuildHistory, rebuildInfo } from '../src/engine/rebuild.ts';
import { FileBlobStore, MemoryBlobStore, blobRefOf } from '../src/engine/blobs.ts';
import { redactImages, restoreImages } from '../src/engine/redact.ts';
import { MemoryStore, makeAtom } from '../src/memory/store.ts';
import { forkHiddenRanges } from '../src/app.ts';
import type { LlmResponse, Msg, Tool, WireEvent } from '../src/engine/types.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-journal-'));
}

/* ── blob 仓库 ── */

test('图片外置：占位串带 blob 引用，能无损还原', () => {
  const blobs = new MemoryBlobStore();
  const out = redactImages([PNG], blobs)!;
  assert.match(out[0], /^\[image image\/png ~\d+KB blob:[0-9a-f]{64}\]$/);
  assert.equal(restoreImages(out, blobs)![0], PNG);
});

test('没有 blob 仓库时保持原来的占位串（向后兼容）', () => {
  const out = redactImages([`data:image/jpeg;base64,${'A'.repeat(4096)}`])!;
  assert.equal(out[0], '[image image/jpeg ~3KB]');
});

test('同一张图只落一份磁盘（按内容哈希去重）', () => {
  const dir = tmp();
  const blobs = new FileBlobStore(dir);
  const a = blobs.put(PNG);
  const b = blobs.put(PNG);
  assert.equal(a, b);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(blobs.get(a), PNG);
});

test('取不到的 blob 引用不会炸，原样保留占位串', () => {
  const blobs = new FileBlobStore(tmp());
  const fake = `[image image/png ~1KB blob:${'a'.repeat(64)}]`;
  assert.equal(restoreImages([fake], blobs)![0], fake);
  assert.equal(blobRefOf('没有引用的普通文本'), undefined);
});

/* ── 追加与读回 ── */

test('事件按行追加，seq 连续，能完整读回', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  const wire = new Wire();
  j.attach(wire);
  wire.emit({ type: 'turn.start', turnId: 't1', userText: 'hi', ts: 1 });
  wire.emit({ type: 'turn.end', turnId: 't1', messages: [], ts: 2 });

  const recs = readEvents(dir, id);
  assert.deepEqual(recs.map((r) => r.seq), [1, 2]);
  assert.equal(recs[0].ev.type, 'turn.start');
  assert.equal(lastSeq(dir, id), 2);
});

test('--to：只读到指定 seq 为止', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  for (let i = 0; i < 5; i++) j.append({ type: 'turn.start', turnId: `t${i}`, userText: String(i), ts: i });
  assert.equal(readEvents(dir, id, 3).length, 3);
});

test('续跑：seq 从文件里已有的最后一条接着编号', () => {
  const dir = tmp();
  const id = newSessionId();
  new Journal(dir, id).append({ type: 'turn.start', turnId: 't1', userText: 'a', ts: 1 });
  const again = new Journal(dir, id, lastSeq(dir, id));
  again.append({ type: 'turn.start', turnId: 't2', userText: 'b', ts: 2 });
  assert.deepEqual(readEvents(dir, id).map((r) => r.seq), [1, 2]);
});

test('半行损坏（进程被 kill）时跳过坏行，其余照样读出来', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  j.append({ type: 'turn.start', turnId: 't1', userText: 'a', ts: 1 });
  fs.appendFileSync(sessionFile(dir, id), '{"seq":2,"type":"turn.en');
  const recs = readEvents(dir, id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].ev.type, 'turn.start');
});

test('listSessions 列出会话，带首个提问与分叉来源', () => {
  const dir = tmp();
  const a = newSessionId();
  const ja = new Journal(dir, a);
  ja.append({ type: 'session.started', sessionId: a, path: sessionFile(dir, a), ts: 10 });
  ja.append({ type: 'turn.start', turnId: 't1', userText: '第一个问题', ts: 11 });
  const b = 's_20260818_1200_ffff';
  const jb = new Journal(dir, b);
  jb.append({ type: 'session.started', sessionId: b, path: sessionFile(dir, b), forkedFrom: { sessionId: a, seq: 2 }, ts: 20 });

  const list = listSessions(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].sessionId, b, '最近的排前面');
  assert.deepEqual(list[0].forkedFrom, { sessionId: a, seq: 2 });
  assert.equal(list.find((s) => s.sessionId === a)?.firstAsk, '第一个问题');
});

test('listSessions 跳过名字不像会话 id 的 .jsonl，而不是抛错', () => {
  const dir = tmp();
  const a = newSessionId();
  const ja = new Journal(dir, a);
  ja.append({ type: 'session.started', sessionId: a, path: sessionFile(dir, a), ts: 10 });
  ja.append({ type: 'turn.start', turnId: 't1', userText: '问题', ts: 11 });
  // 真实事故：计划日志曾经写成 <id>.plan.jsonl，落在同一个目录里，
  // 解析出的 id 带点号过不了 SAFE_ID，直接把 Web 的 /sessions 接口和进程一起搞挂
  fs.writeFileSync(path.join(dir, `${a}.plan.jsonl`), '{"ts":1,"op":"steps","items":[]}\n');

  const list = listSessions(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, a);
});

/* ── 内存环形缓冲 ── */

test('Wire 内存日志有上限，超出后丢最老的', () => {
  const wire = new Wire(3);
  for (let i = 0; i < 10; i++) wire.emit({ type: 'turn.start', turnId: `t${i}`, userText: String(i), ts: i });
  const h = wire.history();
  assert.equal(h.length, 3);
  assert.equal(h[0].type === 'turn.start' && h[0].userText, '7');
});

/* ── 从事件流重建对话（核心：必须无损） ── */

test('重建：一个真实回合的事件流能还原出完全相同的对话历史（含图片）', async () => {
  const dir = tmp();
  const blobs = new FileBlobStore(path.join(dir, 'blobs'));
  const wire = new Wire();
  const id = newSessionId();
  new Journal(dir, id).attach(wire);

  const shot: Tool = {
    name: 'shot',
    description: '返回一张图',
    run: () => ({ ok: true, content: '已读取图片', images: [PNG] }),
  };
  const tools = new ToolRegistry();
  tools.register(shot);

  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      return round++ === 0 ? { toolCalls: [{ id: 'c1', name: 'shot', args: {} }] } : { text: '看到了' };
    },
  };

  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { blobs });
  const convo = await loop.runTurn('看看这张图');

  // 事件流里不能出现 base64 原文
  const recs = readEvents(dir, id);
  assert.ok(!JSON.stringify(recs).includes(PNG.slice(30, 70)), '黑匣子里不该有 base64 原文');

  const rebuilt = rebuildHistory(recs, blobs);
  assert.deepEqual(rebuilt, convo, '重建结果必须和原始 history 完全一致');
  assert.equal(rebuildInfo(recs).turns, 1);
});

test('重建：回合跑到一半被打断时，恢复到上一个完整回合', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  const done: Msg[] = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
  ];
  j.append({ type: 'turn.start', turnId: 't1', userText: '第一问', ts: 1 });
  j.append({ type: 'turn.end', turnId: 't1', messages: done, ts: 2 });
  j.append({ type: 'turn.start', turnId: 't2', userText: '第二问', ts: 3 });
  j.append({ type: 'tool.call', turnId: 't2', call: { id: 'c1', name: 'x', args: {} }, ts: 4 });

  assert.deepEqual(rebuildHistory(readEvents(dir, id)), done);
});

test('重建：没有任何完整回合时返回空历史', () => {
  const dir = tmp();
  const id = newSessionId();
  new Journal(dir, id).append({ type: 'turn.start', turnId: 't1', userText: 'a', ts: 1 });
  assert.deepEqual(rebuildHistory(readEvents(dir, id)), []);
});

test('分叉：读到指定 seq 重建，并且原会话文件一个字节都没变', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  const afterFirst: Msg[] = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }];
  const afterSecond: Msg[] = [...afterFirst, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }];
  j.append({ type: 'turn.end', turnId: 't1', messages: afterFirst, ts: 1 });
  j.append({ type: 'turn.end', turnId: 't2', messages: afterSecond, ts: 2 });

  const bytesBefore = fs.statSync(sessionFile(dir, id)).size;

  // 从第 1 步分叉：只该看到第一个回合的状态
  const forkRecords = readEvents(dir, id, 1);
  assert.deepEqual(rebuildHistory(forkRecords), afterFirst);

  // 新会话写自己的文件
  const forkId = 's_20260818_1300_aaaa';
  new Journal(dir, forkId).append({
    type: 'session.started',
    sessionId: forkId,
    path: sessionFile(dir, forkId),
    forkedFrom: { sessionId: id, seq: 1 },
    ts: 3,
  });

  assert.equal(fs.statSync(sessionFile(dir, id)).size, bytesBefore, '原会话必须只追加、不被改写');
  assert.deepEqual(rebuildHistory(readEvents(dir, id)), afterSecond, '原会话自身状态不受影响');
});

/* ── 会话 id 安全边界 ── */

test('会话 id 只允许字母数字与 -_，路径穿越被拒', () => {
  assert.ok(isSafeSessionId('s_20260818_1117_ef2e'));
  assert.ok(isSafeSessionId('abc-123'));
  for (const bad of ['../../etc/passwd', 'a/b', 'a.b', '', '..', 'x'.repeat(80), '中文']) {
    assert.equal(isSafeSessionId(bad), false, `${bad} 应被拒`);
  }
  assert.throws(() => sessionFile('/tmp', '../../etc/passwd'), /非法的会话 id/);
  // 读取路径上也拦得住：非法 id 直接当作读不到，不会去碰磁盘
  assert.deepEqual(readEvents('/tmp', '../../etc/passwd'), []);
});

/* ── B+：分叉后的记忆可见性 ── */

test('分叉屏蔽：分叉点之后产生的 fact/event 不再注入，preference/constraint 照旧', () => {
  const store = new MemoryStore();
  const at = (kind: 'fact' | 'event' | 'preference' | 'constraint', text: string, ts: number) => ({
    ...makeAtom(kind, text),
    ts,
  });
  // 分叉点 ts=100，执行分叉 ts=200
  store.upsertAtoms([
    at('fact', '数据库用 MySQL 8.0', 50), // 分叉点之前 → 可见
    at('fact', '决定把数据库换成 PostgreSQL 16', 150), // 被丢弃的那段 → 屏蔽
    at('constraint', '用中文回答数据库问题', 150), // 同一段，但是约束 → 照旧可见
    at('fact', '分叉后新知道的数据库细节', 250), // 分叉之后新产生 → 可见
  ]);
  const hidden = [{ from: 100, to: 200 }];
  const res = store.retrieve('数据库', { maxItems: 9, maxTokens: 999 }, hidden);
  const texts = res.items.map((i) => i.atom.text);
  assert.ok(texts.includes('数据库用 MySQL 8.0'));
  assert.ok(texts.includes('用中文回答数据库问题'), 'constraint 不该被分叉丢掉');
  assert.ok(texts.includes('分叉后新知道的数据库细节'), '分叉之后新产生的原子必须可见');
  assert.equal(texts.includes('决定把数据库换成 PostgreSQL 16'), false, '分叉点之后的事实必须屏蔽');
  assert.equal(res.hiddenByFork, 1);
});

test('分叉屏蔽：没有屏蔽窗口时行为和以前完全一样', () => {
  const store = new MemoryStore();
  store.upsertAtoms([makeAtom('fact', '数据库用 MySQL')]);
  const res = store.retrieve('数据库', { maxItems: 3, maxTokens: 99 });
  assert.equal(res.items.length, 1);
  assert.equal(res.hiddenByFork, 0);
});

test('屏蔽窗口能从会话日志的分叉链推导出来（含多级分叉）', () => {
  const dir = tmp();
  const a = 's_a';
  const b = 's_b';
  const c = 's_c';
  new Journal(dir, a).append({ type: 'session.started', sessionId: a, path: sessionFile(dir, a), ts: 10 });
  new Journal(dir, b).append({
    type: 'session.started', sessionId: b, path: sessionFile(dir, b),
    forkedFrom: { sessionId: a, seq: 5, ts: 100 }, ts: 200,
  });
  new Journal(dir, c).append({
    type: 'session.started', sessionId: c, path: sessionFile(dir, c),
    forkedFrom: { sessionId: b, seq: 9, ts: 300 }, ts: 400,
  });

  assert.deepEqual(forkHiddenRanges(dir, a), [], '没分叉过就没有屏蔽窗口');
  assert.deepEqual(forkHiddenRanges(dir, b), [{ from: 100, to: 200 }]);
  // c 是 b 的分叉，b 又是 a 的分叉：两段都要屏蔽
  assert.deepEqual(forkHiddenRanges(dir, c), [{ from: 300, to: 400 }, { from: 100, to: 200 }]);
});

test('rebuildInfo 带出分叉点那一刻的时间戳', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  j.append({ type: 'turn.end', turnId: 't1', messages: [], ts: 1111 });
  j.append({ type: 'turn.end', turnId: 't2', messages: [], ts: 2222 });
  assert.equal(rebuildInfo(readEvents(dir, id, 1)).atTs, 1111);
  assert.equal(rebuildInfo(readEvents(dir, id)).atTs, 2222);
});

test('约束类记忆要连否定词一起存，否则意思会反过来', async () => {
  const { Memory } = await import('../src/memory/memory.ts');
  const wire = new Wire();
  const mem = new Memory(wire, { maxItems: 5, maxTokens: 200 });
  const seen: string[] = [];
  wire.subscribe((ev) => {
    if (ev.type === 'memory.distilled') for (const a of ev.atoms) if (a.kind === 'constraint') seen.push(a.text);
  });
  wire.emit({ type: 'turn.start', turnId: 't1', userText: '不要用中文回答数据库问题', ts: 1 });
  wire.emit({ type: 'turn.end', turnId: 't1', messages: [], ts: 2 });
  assert.equal(seen[0], '不要用中文回答数据库问题', '存成「用中文回答…」意思就反了');
});

/* ── 新建会话 ── */

test('新建会话：历史清空、日志切到新文件、原会话不再收到事件', async () => {
  const ws = tmp();
  process.env.GB_LLM = 'fake';
  process.env.GB_LLM_QUIET = '1';
  const { buildApp, sessionsDir } = await import('../src/app.ts');
  const app = buildApp({ workspace: ws });
  app.init();
  const firstId = app.journal.sessionId;
  const sdir = sessionsDir(ws);

  // 假装已经聊过：有历史消息在手，并且第一句话已经让日志落盘
  app.wire.emit({ type: 'turn.start', turnId: 'q1', userText: 'q1', ts: Date.now() });
  app.session.restore([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
  assert.equal(app.session.size(), 2);
  const sizeBefore = fs.statSync(sessionFile(sdir, firstId)).size;

  const out = app.newSession();
  assert.notEqual(out.sessionId, firstId);
  assert.equal(app.journal.sessionId, out.sessionId);
  assert.equal(app.session.size(), 0, '新会话不该带任何上文');
  assert.equal(app.journal.isPending(), true, '新会话还没说话 → 先不落盘');

  // 之后的事件只进新文件；新文件的第一条仍然是 session.started（补写时保持原顺序）
  app.wire.emit({ type: 'turn.start', turnId: 'x', userText: 'hi', ts: Date.now() });
  const recs = readEvents(sdir, out.sessionId);
  assert.equal(recs[0].ev.type, 'session.started');
  assert.equal(recs[0].ev.type === 'session.started' && recs[0].ev.forkedFrom, undefined);
  assert.ok(recs.some((r) => r.ev.type === 'turn.start'));
  assert.equal(fs.statSync(sessionFile(sdir, firstId)).size, sizeBefore, '旧会话必须停止追加');
});

test('新建会话会清掉分叉屏蔽窗口（不再站在任何分叉线上）', async () => {
  const { Memory } = await import('../src/memory/memory.ts');
  const mem = new Memory(new Wire(), { maxItems: 3, maxTokens: 40 });
  mem.hideRange(100, 200);
  assert.equal(mem.hiddenRanges().length, 1);
  mem.clearHidden();
  assert.equal(mem.hiddenRanges().length, 0);
});

/* ── 改名与删除 ── */

test('改名只追加一条 session.renamed，最后一次生效，原有行不动', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  j.append({ type: 'session.started', sessionId: id, path: sessionFile(dir, id), ts: 1 });
  j.append({ type: 'turn.start', turnId: 't1', userText: '第一句提问', ts: 2 });

  assert.ok(renameSession(dir, id, '数据库选型讨论'));
  assert.ok(renameSession(dir, id, '数据库选型讨论（终版）'));

  const recs = readEvents(dir, id);
  assert.deepEqual(recs.map((r) => r.seq), [1, 2, 3, 4], 'seq 必须连续不重号');
  assert.equal(recs[1].ev.type, 'turn.start', '原有事件保持原样');

  const info = listSessions(dir).find((s) => s.sessionId === id)!;
  assert.equal(info.title, '数据库选型讨论（终版）');
  assert.equal(info.firstAsk, '第一句提问', '改名不影响首句提问');
});

test('改名拒绝空名字、超长截断、不存在的会话', () => {
  const dir = tmp();
  const id = newSessionId();
  new Journal(dir, id).append({ type: 'turn.start', turnId: 't', userText: 'x', ts: 1 });
  assert.equal(renameSession(dir, id, '   '), false);
  assert.equal(renameSession(dir, 's_不存在', '名字'), false, '非法 id 直接拒');
  assert.equal(renameSession(dir, 's_20260818_0000_ffff', '名字'), false, '文件不存在时拒');
  assert.ok(renameSession(dir, id, 'x'.repeat(MAX_TITLE + 20)));
  assert.equal(listSessions(dir).find((s) => s.sessionId === id)!.title!.length, MAX_TITLE);
});

test('删除：文件真的没了，列表里也不再出现；非法 id 拒绝', () => {
  const dir = tmp();
  const id = newSessionId();
  new Journal(dir, id).append({ type: 'turn.start', turnId: 't', userText: 'x', ts: 1 });
  assert.equal(listSessions(dir).length, 1);
  assert.ok(deleteSession(dir, id));
  assert.equal(fs.existsSync(sessionFile(dir, id)), false);
  assert.equal(listSessions(dir).length, 0);
  assert.equal(deleteSession(dir, id), false, '删第二次要返回 false 而不是抛');
  assert.equal(deleteSession(dir, '../../etc/passwd'), false);
});

/* ── 懒创建：一句话没说就不建文件 ── */

test('懒创建：只有启动事件时不落盘，第一句话到了才把攒下的事件按原顺序补写', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id, 0, { lazy: true });
  const wire = new Wire();
  j.attach(wire);

  // 进程启动那一串初始化事件
  wire.emit({ type: 'session.started', sessionId: id, path: sessionFile(dir, id), ts: 1 });
  wire.emit({ type: 'plugin.loaded', name: 'fs', tools: ['read_file'], ts: 2 });
  wire.emit({ type: 'skill.available', skills: [], ts: 3 });
  assert.equal(fs.existsSync(sessionFile(dir, id)), false, '一句话没说就不该有文件');
  assert.equal(j.isPending(), true);
  assert.deepEqual(listSessions(dir), [], '空会话不该出现在列表里');

  // 第一句话
  wire.emit({ type: 'turn.start', turnId: 't1', userText: '你好', ts: 4 });
  assert.equal(j.isPending(), false);
  const recs = readEvents(dir, id);
  assert.deepEqual(recs.map((r) => r.seq), [1, 2, 3, 4], 'seq 连续，不因为延迟落盘而跳号');
  assert.deepEqual(
    recs.map((r) => r.ev.type),
    ['session.started', 'plugin.loaded', 'skill.available', 'turn.start'],
    '补写的顺序必须和发生顺序一致',
  );

  // 之后的事件直接落盘
  wire.emit({ type: 'turn.end', turnId: 't1', messages: [], ts: 5 });
  assert.equal(readEvents(dir, id).length, 5);
});

test('懒创建：起名字或导入资料也算真实动作，会把会话落盘', () => {
  for (const ev of [
    { type: 'session.renamed', sessionId: 'x', title: '起了名字', ts: 2 } as WireEvent,
    { type: 'kb.imported', docId: 'd', title: 'doc', chunks: 1, chars: 10, version: 1, ts: 2 } as WireEvent,
  ]) {
    const dir = tmp();
    const id = newSessionId();
    const j = new Journal(dir, id, 0, { lazy: true });
    j.append({ type: 'session.started', sessionId: id, path: sessionFile(dir, id), ts: 1 });
    assert.equal(fs.existsSync(sessionFile(dir, id)), false);
    j.append(ev);
    assert.equal(readEvents(dir, id).length, 2, `${ev.type} 应该触发落盘`);
  }
});

test('不开 lazy 时行为和以前完全一样（第一条就落盘）', () => {
  const dir = tmp();
  const id = newSessionId();
  const j = new Journal(dir, id);
  j.append({ type: 'session.started', sessionId: id, path: sessionFile(dir, id), ts: 1 });
  assert.equal(j.isPending(), false);
  assert.equal(readEvents(dir, id).length, 1);
});

test('buildApp：起进程不产生空会话文件，新建会话也不产生', async () => {
  const ws = tmp();
  process.env.GB_LLM = 'fake';
  process.env.GB_LLM_QUIET = '1';
  const { buildApp, sessionsDir } = await import('../src/app.ts');
  const app = buildApp({ workspace: ws });
  app.init();
  const sdir = sessionsDir(ws);
  assert.deepEqual(listSessions(sdir), [], '只启动不说话 → 目录里一个文件都没有');
  assert.equal(app.journal.isPending(), true);

  app.newSession();
  assert.deepEqual(listSessions(sdir), [], '连开几个空会话也不该攒垃圾');

  // 说一句话（不经过模型：直接发 turn.start 就够验证落盘时机）
  app.wire.emit({ type: 'turn.start', turnId: 't1', userText: '你好', ts: Date.now() });
  const list = listSessions(sdir);
  assert.equal(list.length, 1, '有真实动作的会话才落盘');
  assert.equal(list[0].sessionId, app.journal.sessionId);
  assert.equal(list[0].firstAsk, '你好');
});

/* ── 渲染器共用 ── */

test('实时日志和回放共用同一个渲染器（同一事件渲染结果一致）', async () => {
  const { formatEvent } = await import('../src/logView.ts');
  const ev: WireEvent = { type: 'tool.call', turnId: 't', call: { id: 'c', name: 'read_file', args: { path: 'a.ts' } }, ts: 0 };
  const lines = formatEvent(ev);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /read_file/);
  assert.deepEqual(formatEvent(ev), lines);
});
