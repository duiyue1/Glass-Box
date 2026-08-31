import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Loop, type Llm } from '../src/engine/loop.ts';
import { loadPlugins } from '../src/engine/plugin.ts';
import { subagentPlugin } from '../src/plugins/subagentPlugin.ts';
import type { Msg, LlmResponse, Tool, WireEvent } from '../src/engine/types.ts';
import { safeAssess } from '../src/engine/types.ts';

/** 永远要求调用同一个工具的模型——模拟"卡在反复 grep"的真实故障 */
class AlwaysToolLlm implements Llm {
  calls = 0;
  async complete(_msgs: Msg[]): Promise<LlmResponse> {
    this.calls++;
    return { toolCalls: [{ id: `c${this.calls}`, name: 'noop', args: {} }] };
  }
}

const noop: Tool = { name: 'noop', description: '什么都不做', run: () => ({ ok: true, content: 'ok' }) };

function setup(maxSteps: number) {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register(noop);
  const llm = new AlwaysToolLlm();
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps });
  return { loop, events, llm };
}

test('死循环的模型会被步数上限刹住，回合正常结束', async () => {
  const { loop, events } = setup(3);
  const convo = await loop.runTurn('go');

  const executed = events.filter((e) => e.type === 'tool.call').length;
  assert.equal(executed, 3, '真正执行的工具调用不该超过上限');

  const limit = events.find((e) => e.type === 'turn.limit');
  assert.ok(limit && limit.type === 'turn.limit' && limit.maxSteps === 3);

  assert.ok(events.some((e) => e.type === 'turn.end'), '必须正常收尾而不是挂死');
  assert.match(convo.at(-1)!.content, /步数上限/);
});

test('步数用尽时先把“未执行”作为工具结果喂回模型', async () => {
  const { loop, events } = setup(2);
  await loop.runTurn('go');

  const results = events.filter(
    (e): e is Extract<WireEvent, { type: 'tool.result' }> => e.type === 'tool.result',
  );
  const refused = results.at(-1)!;
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.content, /步数已用尽/);
  assert.match(refused.result.content, /未执行 noop/);
});

test('模型收到提醒后给出文本，就正常结束（不触发硬停）', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register(noop);
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      return round <= 2
        ? { toolCalls: [{ id: `c${round}`, name: 'noop', args: {} }] }
        : { text: '基于已有信息，结论是 X' };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 1 });
  const convo = await loop.runTurn('go');

  assert.ok(events.some((e) => e.type === 'turn.limit'));
  assert.equal(convo.at(-1)!.content, '基于已有信息，结论是 X');
});

test('连续原封不动重试同一个失败调用会被挡回去，不再真正执行', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  let runs = 0;
  tools.register({
    name: 'bad',
    description: '总是失败',
    run: () => {
      runs++;
      return { ok: false, content: '失败了' };
    },
  });
  // 模型固执地用完全相同的参数重试三次，最后才给文本
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      return round <= 3
        ? { toolCalls: [{ id: `c${round}`, name: 'bad', args: { path: 'x' } }] }
        : { text: '放弃了' };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 10 });
  await loop.runTurn('go');

  assert.equal(runs, 1, '相同参数的失败调用只该真正执行一次');
  const results = events.filter(
    (e): e is Extract<WireEvent, { type: 'tool.result' }> => e.type === 'tool.result',
  );
  assert.equal(results.length, 3);
  assert.match(results[1].result.content, /上一步刚失败过/);
});

test('free 工具不占步数：记账不该挤掉干活的调用', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  let noteRuns = 0;
  let workRuns = 0;
  tools.register({
    name: 'note',
    description: '纯记账',
    free: true,
    run: () => {
      noteRuns++;
      return { ok: true, content: '记下了' };
    },
  });
  tools.register({
    name: 'work',
    description: '真干活',
    run: () => {
      workRuns++;
      return { ok: true, content: '干完了' };
    },
  });

  // 模型交替调 note / work：上限 2 只该拦住 work
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      if (round > 6) return { text: '收尾' };
      return { toolCalls: [{ id: `c${round}`, name: round % 2 === 1 ? 'note' : 'work', args: {} }] };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 2 });
  await loop.runTurn('go');

  assert.equal(workRuns, 2, 'work 受上限约束');
  assert.equal(noteRuns, 3, 'note 是 free 工具，不该被上限挡住');
});

test('cacheable 工具：同名同参重复调用复用结果，不重复执行也不占步数', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  let runs = 0;
  tools.register({
    name: 'glob',
    description: '假检索',
    cacheable: true,
    run: () => {
      runs++;
      return { ok: true, content: 'a.js' };
    },
  });
  // 模型连着发四次一模一样的检索，然后收尾
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      return round <= 4
        ? { toolCalls: [{ id: `c${round}`, name: 'glob', args: { pattern: 'x' } }] }
        : { text: '完事' };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  // 上限 2：如果复用也算步数，第 3 次就该被拦住
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 2 });
  await loop.runTurn('go');

  assert.equal(runs, 1, '只该真正执行一次');
  assert.ok(!events.some((e) => e.type === 'turn.limit'), '复用不占步数，不该触发上限');
  const results = events.filter(
    (e): e is Extract<WireEvent, { type: 'tool.result' }> => e.type === 'tool.result',
  );
  assert.match(results[1].result.content, /直接复用上次结果/);
  assert.match(results[1].result.content, /a\.js/, '复用也要把内容给它，不能只给一句提示');
});

test('写操作之后缓存作废：改完再读会真的重新读盘', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  let reads = 0;
  let content = '旧内容';
  tools.register({
    name: 'read_file',
    description: '假读文件',
    cacheable: true,
    run: () => {
      reads++;
      return { ok: true, content };
    },
  });
  tools.register({
    name: 'write_file',
    description: '假写文件',
    run: () => {
      content = '新内容';
      return { ok: true, content: '已写入' };
    },
  });

  const script = ['read_file', 'write_file', 'read_file'];
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      const name = script[round++];
      return name ? { toolCalls: [{ id: `c${round}`, name, args: { path: 'a.txt' } }] } : { text: '完事' };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 10 });
  await loop.runTurn('go');

  assert.equal(reads, 2, '写过之后不能再用旧缓存');
  const results = events.filter(
    (e): e is Extract<WireEvent, { type: 'tool.result' }> => e.type === 'tool.result',
  );
  assert.equal(results.at(-1)!.result.content, '新内容');
});

test('换个写法但结果一样：如实告诉模型，别让它继续换写法', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register({
    name: 'glob',
    description: '假检索：不管什么 pattern 都返回同一份结果',
    cacheable: true,
    run: () => ({ ok: true, content: 'store.js' }),
  });
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      return round <= 2
        ? { toolCalls: [{ id: `c${round}`, name: 'glob', args: { pattern: round === 1 ? 'p/*' : '**/p/*' } }] }
        : { text: '完事' };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 10 });
  await loop.runTurn('go');

  const results = events.filter(
    (e): e is Extract<WireEvent, { type: 'tool.result' }> => e.type === 'tool.result',
  );
  assert.match(results[1].result.content, /结果和本回合早前那次.*完全一样/);
});

test('快到步数上限时提醒一次"先落盘"', async () => {
  const { loop } = setup(3);
  const convo = await loop.runTurn('go');
  const notes = convo.filter((m) => m.role === 'system' && m.content.includes('步数提醒'));
  assert.equal(notes.length, 1, '只提醒一次，别每步都刷');
  assert.match(notes[0].content, /先写文件/);
});

test('free 工具不作废检索缓存：记一次计划不该让读过的文件全部重读', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  let reads = 0;
  tools.register({
    name: 'read_file',
    description: '假读文件',
    cacheable: true,
    run: () => {
      reads++;
      return { ok: true, content: '内容' };
    },
  });
  tools.register({
    name: 'task_plan',
    description: '纯记账',
    free: true,
    run: () => ({ ok: true, content: '记下了' }),
  });

  const script = ['read_file', 'task_plan', 'read_file'];
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      const name = script[round++];
      return name ? { toolCalls: [{ id: `c${round}`, name, args: { path: 'a.txt' } }] } : { text: '完事' };
    },
  };
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 10 });
  await loop.runTurn('go');

  assert.equal(reads, 1, 'task_plan 不碰工作区，缓存不该因它作废');
});

test('subagent 使用父级注入的模型，而不是内置假模型', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sub-'));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n');

  // 打了标记的模型：若子 agent 用的是它，结论里就会带上这个标记
  const marker = '我是父级注入的模型';
  const injected: Llm = {
    async complete(msgs: Msg[]): Promise<LlmResponse> {
      const last = msgs.at(-1);
      if (last?.role === 'tool') return { text: `${marker}：读到了 ${last.content.trim()}` };
      return { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] };
    },
  };

  const wire = new Wire();
  const tools = new ToolRegistry();
  loadPlugins([subagentPlugin(ws, injected)], { tools, wire, workspace: ws });
  const out = await tools.get('delegate')!.run({ task: '看看 a.txt' });

  assert.equal(out.ok, true);
  assert.ok(out.content.includes(marker), `子 agent 应使用注入的模型，实际: ${out.content}`);
  assert.ok(out.content.includes('read_file'), '并且真的用了只读工具');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('默认只读子 agent：没有 write_file / edit_file，delegate 本身是 safe', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sub-ro-'));
  try {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n');
    // 让子 agent 去试着写：应该拿不到这个工具
    const llm: Llm = {
      async complete(msgs: Msg[]): Promise<LlmResponse> {
        const last = msgs.at(-1);
        if (last?.role === 'tool') return { text: `工具回复：${last.content.slice(0, 40)}` };
        return { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'x' } }] };
      },
    };
    const tools = new ToolRegistry();
    loadPlugins([subagentPlugin(ws, llm)], { tools, wire: new Wire(), workspace: ws });
    const delegate = tools.get('delegate')!;

    assert.equal(delegate.assess!({ task: 'x' }).level, 'safe');
    const out = await delegate.run({ task: '把 a.txt 改掉' });
    assert.equal(out.ok, true);
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hello\n', '只读子 agent 不该改到文件');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('write:true 的子 agent 能改文件，但每次写入都过父级审批', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sub-rw-'));
  try {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n');
    const llm: Llm = {
      async complete(msgs: Msg[]): Promise<LlmResponse> {
        const last = msgs.at(-1);
        if (last?.role === 'tool') return { text: `写完了：${last.content.slice(0, 40)}` };
        return { toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.txt', old: 'hello', new: 'bye' } }] };
      },
    };

    // 父级审批者：记录被问了几次
    const asked: string[] = [];
    const parent = {
      decide: async (req: { toolName: string }) => {
        asked.push(req.toolName);
        return true;
      },
    };

    const tools = new ToolRegistry();
    loadPlugins([subagentPlugin(ws, llm, parent)], { tools, wire: new Wire(), workspace: ws });
    const delegate = tools.get('delegate')!;

    // 派一个可写子 agent 出去，这件事本身值得让人看一眼
    assert.equal(delegate.assess!({ task: 'x', write: true }).level, 'confirm');

    const out = await delegate.run({ task: '把 hello 改成 bye', write: true });
    assert.equal(out.ok, true);
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'bye\n');
    assert.deepEqual(asked, ['edit_file'], '子 agent 的写入必须问到父级审批者，否则 delegate 就是一条绕过审批的通道');
    assert.match(out.content, /改动的文件/, '改了哪些文件要冒泡回主 agent');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('可写子 agent 的写入被父级拒绝时，文件一个字节都不动', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sub-deny-'));
  try {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n');
    const llm: Llm = {
      async complete(msgs: Msg[]): Promise<LlmResponse> {
        const last = msgs.at(-1);
        if (last?.role === 'tool') return { text: `被拒了：${last.content.slice(0, 30)}` };
        return { toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.txt', old: 'hello', new: 'bye' } }] };
      },
    };
    const tools = new ToolRegistry();
    loadPlugins([subagentPlugin(ws, llm, { decide: async () => false })], {
      tools,
      wire: new Wire(),
      workspace: ws,
    });
    await tools.get('delegate')!.run({ task: '改掉它', write: true });
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hello\n');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---- 只读工具批次并行 ----

interface Probe {
  max: number;
  inFlight: number;
  runs: number;
}

/** 记录「同一时刻最多几个在跑」的探针工具。比计时可靠，不会在慢机器上抖 */
function probe(name: string, stat: Probe, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: '并发探针',
    cacheable: true,
    async run(args) {
      stat.runs++;
      stat.inFlight++;
      stat.max = Math.max(stat.max, stat.inFlight);
      await new Promise((r) => setTimeout(r, Number(args.delay ?? 20)));
      stat.inFlight--;
      return { ok: true, content: `done:${JSON.stringify(args)}` };
    },
    ...extra,
  };
}

/** 第一轮一次性返回这些调用，第二轮收尾 */
function batchLlm(calls: { id: string; name: string; args: Record<string, unknown> }[]): Llm {
  let round = 0;
  return {
    async complete(): Promise<LlmResponse> {
      return round++ === 0 ? { toolCalls: calls } : { text: '完事' };
    },
  };
}

function runBatch(
  tools: ToolRegistry,
  calls: { id: string; name: string; args: Record<string, unknown> }[],
  parallelReads?: boolean,
) {
  const wire = new Wire();
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, batchLlm(calls), { decide: async () => true }, {
    maxSteps: 10,
    parallelReads,
  });
  return { events, run: () => loop.runTurn('go') };
}

test('一次返回多个只读检索：同时跑，不再排队', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  tools.register(probe('grep', stat));
  const { events, run } = runBatch(tools, [
    { id: 'c1', name: 'grep', args: { pattern: 'a' } },
    { id: 'c2', name: 'grep', args: { pattern: 'b' } },
    { id: 'c3', name: 'grep', args: { pattern: 'c' } },
  ]);
  await run();

  assert.equal(stat.runs, 3);
  assert.equal(stat.max, 3, '三个只读调用应该同时在跑');
  const first = events.find((e) => e.type === 'tool.call');
  assert.ok(first && first.type === 'tool.call' && first.parallel === 3, '并发这件事必须在事件流里看得见');
});

test('parallelSafe 让有副作用但彼此独立的工具也能并行（delegate 就靠它）', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  // 不是 cacheable（子 agent 有自己的副作用，结果也不该复用），但彼此独立
  tools.register(probe('delegate', stat, { cacheable: false, parallelSafe: true, assess: safeAssess }));
  const { run } = runBatch(tools, [
    { id: 'c1', name: 'delegate', args: { task: 'a' } },
    { id: 'c2', name: 'delegate', args: { task: 'b' } },
    { id: 'c3', name: 'delegate', args: { task: 'c' } },
  ]);
  await run();

  assert.equal(stat.runs, 3, '不是 cacheable，所以三个都要真跑（不会被复用掉）');
  assert.equal(stat.max, 3, '三个子任务应该同时在跑');
});

test('需要审批的 parallelSafe 工具不并行——可写子 agent 走的就是这条路', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  tools.register(
    probe('delegate', stat, {
      cacheable: false,
      parallelSafe: true,
      assess: () => ({ level: 'confirm' as const, summary: '派一个可写子 agent' }),
    }),
  );
  const { run } = runBatch(tools, [
    { id: 'c1', name: 'delegate', args: { task: 'a', write: true } },
    { id: 'c2', name: 'delegate', args: { task: 'b', write: true } },
  ]);
  await run();

  assert.equal(stat.runs, 2);
  assert.equal(stat.max, 1, '要审批就得排队，否则几个弹窗同时冒出来人不知道在批哪个');
});

test('并行的结果仍按模型给的顺序入账，不按谁先跑完', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  tools.register(probe('grep', stat));
  // 故意让第一个最慢：完成顺序是 c3, c2, c1
  const { run } = runBatch(tools, [
    { id: 'c1', name: 'grep', args: { pattern: 'a', delay: 60 } },
    { id: 'c2', name: 'grep', args: { pattern: 'b', delay: 30 } },
    { id: 'c3', name: 'grep', args: { pattern: 'c', delay: 1 } },
  ]);
  const convo = await run();

  const ids = convo.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  assert.deepEqual(ids, ['c1', 'c2', 'c3'], '顺序必须稳定可回放，否则同一份日志放两次不一样');
});

test('需要审批的只读调用不并行：弹窗不能同时冒出来两个', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  tools.register(
    probe('read_file', stat, {
      assess: () => ({ level: 'confirm' as const, summary: '读工作区外的文件' }),
    }),
  );
  const { run } = runBatch(tools, [
    { id: 'c1', name: 'read_file', args: { path: 'a' } },
    { id: 'c2', name: 'read_file', args: { path: 'b' } },
  ]);
  await run();

  assert.equal(stat.runs, 2);
  assert.equal(stat.max, 1, '要人点确认的调用必须一个一个来');
});

test('读写混在一批里不并行：写操作的顺序语义不能被打乱', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  tools.register(probe('grep', stat));
  tools.register(probe('write_file', stat, { cacheable: false }));
  const { run } = runBatch(tools, [
    { id: 'c1', name: 'grep', args: { pattern: 'a' } },
    { id: 'c2', name: 'write_file', args: { path: 'x' } },
  ]);
  await run();

  assert.equal(stat.runs, 2);
  assert.equal(stat.max, 1, '一批里只要有非只读工具，整批都退回串行');
});

test('parallelReads=false 关掉并行（A/B 对照组）', async () => {
  const stat: Probe = { max: 0, inFlight: 0, runs: 0 };
  const tools = new ToolRegistry();
  tools.register(probe('grep', stat));
  const { events, run } = runBatch(
    tools,
    [
      { id: 'c1', name: 'grep', args: { pattern: 'a' } },
      { id: 'c2', name: 'grep', args: { pattern: 'b' } },
    ],
    false,
  );
  await run();

  assert.equal(stat.max, 1);
  const first = events.find((e) => e.type === 'tool.call');
  assert.ok(first && first.type === 'tool.call' && first.parallel === undefined);
});

// ---- 中断 ----

test('中断：回合正常收尾，剩下的工具不再执行，历史仍然合法', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  const ctrl = new AbortController();
  let runs = 0;
  tools.register({
    name: 'work',
    description: '干活',
    run: () => {
      runs++;
      return { ok: true, content: '干完一步' };
    },
  });
  // 模型没完没了地要工具；第二轮时我们掐掉
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      if (round === 2) ctrl.abort();
      return { toolCalls: [{ id: `c${round}`, name: 'work', args: { i: round } }] };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, { maxSteps: 50 });
  const convo = await loop.runTurn('go', [], ctrl.signal);

  assert.equal(runs, 1, '中断之后不该再真的执行工具');
  const aborted = events.find((e) => e.type === 'turn.aborted');
  assert.ok(aborted && aborted.type === 'turn.aborted' && aborted.steps === 1);
  assert.ok(events.some((e) => e.type === 'turn.end'), '中断也要走正常收尾');
  assert.match(convo.at(-1)!.content, /中断/);
  assert.match(convo.at(-1)!.content, /没有做完/, '下一回合的模型必须知道上面没干完');

  // 协议要求 assistant(tool_calls) 和 tool 消息成对，否则下一回合直接被网关拒
  const asks = convo.filter((m) => m.role === 'assistant' && m.toolCalls?.length).length;
  const rets = convo.filter((m) => m.role === 'tool').length;
  assert.equal(asks, rets, '每个 tool_calls 都必须有对应的 tool 结果');
});

test('模型请求被中断抛错时，也走中断收尾而不是把异常丢给调用方', async () => {
  const wire = new Wire();
  const ctrl = new AbortController();
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      ctrl.abort();
      throw new Error('The operation was aborted');
    },
  };
  const loop = new Loop(wire, new ToolRegistry(), llm, { decide: async () => true });
  const convo = await loop.runTurn('go', [], ctrl.signal);

  assert.match(convo.at(-1)!.content, /中断/);
});

test('普通异常仍然抛出，不被当成中断吞掉', async () => {
  const wire = new Wire();
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      throw new Error('网络炸了');
    },
  };
  const loop = new Loop(wire, new ToolRegistry(), llm, { decide: async () => true });

  await assert.rejects(() => loop.runTurn('go', [], new AbortController().signal), /网络炸了/);
});

test('被中断时不跑自动验证：人已经喊停了，别再花两分钟跑测试', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register({ name: 'write_file', description: '假写', run: () => ({ ok: true, content: '已写入' }) });
  const ctrl = new AbortController();
  let round = 0;
  const llm: Llm = {
    async complete(): Promise<LlmResponse> {
      round++;
      if (round === 1) return { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a' } }] };
      ctrl.abort();
      return { text: '改好了' };
    },
  };
  let verifyRuns = 0;
  const loop = new Loop(wire, tools, llm, { decide: async () => true }, {
    verifier: {
      needed: () => true,
      run: async () => {
        verifyRuns++;
        return undefined;
      },
    },
  });
  await loop.runTurn('go', [], ctrl.signal);

  assert.equal(verifyRuns, 0);
});

