import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanStore, formatPlan, parseSteps, MAX_ITEMS, MAX_TEXT } from '../src/plan/plan.ts';
import { planProvider } from '../src/plan/planProvider.ts';
import { planPlugin } from '../src/plugins/planPlugin.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Wire } from '../src/engine/wire.ts';
import type { PlanResult } from '../src/plan/plan.ts';
import type { Tool } from '../src/engine/types.ts';

/** 装一个 task_plan 工具出来，顺带收集回调 */
function toolWith(store: PlanStore) {
  const tools = new ToolRegistry();
  const wire = new Wire();
  const seen: { op: string; res: PlanResult }[] = [];
  planPlugin(store, (op, res) => seen.push({ op, res })).setup({ tools, wire, workspace: '/tmp' });
  return { tool: tools.get('task_plan') as Tool, seen };
}

test('parseSteps：一行一步，去行首记号、去空行、去重复、卡上限', () => {
  const steps = parseSteps('1. 读现状\n- 改 loop\n\n改 loop\n  * 补测试  ');
  assert.deepEqual(steps, ['读现状', '改 loop', '补测试'], '记号要剥掉，重复的"改 loop"只留一条');

  const many = parseSteps(Array.from({ length: MAX_ITEMS + 5 }, (_, i) => `第 ${i} 步`).join('\n'));
  assert.equal(many.length, MAX_ITEMS);

  const long = parseSteps('x'.repeat(MAX_TEXT + 50));
  assert.equal(long[0].length, MAX_TEXT);
});

test('没有计划就不注入（不是注入一句"暂无计划"）', () => {
  const store = new PlanStore();
  assert.equal(formatPlan(store.list()), '');
  assert.deepEqual(planProvider(store).provide(''), []);
});

test('注入内容带进度和当前步，且很便宜', () => {
  const store = new PlanStore();
  store.setSteps('读现状\n改 loop\n补测试');
  store.mark(1, 'done');
  store.mark(2, 'doing');
  const got = planProvider(store).provide('') as { content: string; tokensEst: number }[];
  assert.equal(got.length, 1);
  assert.match(got[0].content, /1\/3 完成/);
  assert.match(got[0].content, /当前第 2 步/);
  assert.match(got[0].content, /1 ✔ 读现状/);
  assert.match(got[0].content, /3 ○ 补测试/);
  assert.ok(got[0].tokensEst < 60, `三步的计划应该很便宜，实际 ${got[0].tokensEst}`);
});

test('机械约束：同时只能有一步 doing', () => {
  const store = new PlanStore();
  store.setSteps('A\nB\nC');
  assert.equal(store.mark(1, 'doing').ok, true);
  const rejected = store.mark(2, 'doing');
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /第 1 步还在进行中/);
  assert.equal(store.list().filter((i) => i.status === 'doing').length, 1);
  // 先收尾就放行
  store.mark(1, 'done');
  assert.equal(store.mark(2, 'doing').ok, true);
});

test('机械约束：done 不能回退，未知步骤会说清现有步骤', () => {
  const store = new PlanStore();
  store.setSteps('A\nB');
  store.mark(1, 'done');
  const back = store.mark(1, 'doing');
  assert.equal(back.ok, false);
  assert.match(back.message, /已完成，不能回退/);

  const ghost = store.mark(9, 'done');
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /没有第 9 步/);
  assert.match(ghost.message, /1\/2/, '要告诉它现有哪些步骤，否则它只能瞎猜');
});

test('重复标记同一状态：算成功但 changed=false（别刷一堆无意义事件）', () => {
  const store = new PlanStore();
  store.setSteps('A');
  store.mark(1, 'done');
  const again = store.mark(1, 'done');
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('pending 可以直接 done：有些步骤干到一半发现不用做了', () => {
  const store = new PlanStore();
  store.setSteps('A\nB');
  assert.equal(store.mark(2, 'done').ok, true);
});

test('重新规划：同样文本的步骤保留状态，且不会留下两个 doing', () => {
  const store = new PlanStore();
  store.setSteps('A\nB\nC');
  store.mark(1, 'done');
  store.mark(2, 'doing');
  store.setSteps('A\nB\nD\nE');
  const items = store.list();
  assert.equal(items.find((i) => i.text === 'A')!.status, 'done', '干完的活不能被重排变回没干');
  assert.equal(items.find((i) => i.text === 'B')!.status, 'doing');
  assert.equal(items.find((i) => i.text === 'D')!.status, 'pending');
  assert.equal(items.filter((i) => i.status === 'doing').length, 1);
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3, 4], 'id 要按新顺序重排');
});

test('空计划被拒', () => {
  const store = new PlanStore();
  const res = store.setSteps('  \n\n ');
  assert.equal(res.ok, false);
  assert.equal(store.list().length, 0);
});

test('持久化：每次变更追加一行，重开能恢复最后状态，坏行跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-plan-'));
  const p = path.join(dir, 's1.plan.jsonl');
  const store = new PlanStore(p);
  store.setSteps('A\nB');
  store.mark(1, 'done');
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'setSteps 一行 + mark 一行');

  fs.appendFileSync(p, '{坏行\n');
  const revived = new PlanStore(p);
  revived.load();
  assert.equal(revived.list().find((i) => i.id === 1)!.status, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('分叉继承：按时间切片取"那一刻"的计划，并写进新会话的日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-plan-fork-'));
  const src = path.join(dir, 'a.jsonl');
  const dst = path.join(dir, 'b.jsonl');

  // 手写三条记录，时间戳递增：1000 建计划、2000 第 1 步完成、3000 第 2 步完成
  const items = (n: number) => [
    { id: 1, text: 'A', status: n >= 2 ? 'done' : 'pending' },
    { id: 2, text: 'B', status: n >= 3 ? 'done' : 'pending' },
  ];
  fs.writeFileSync(
    src,
    [1, 2, 3].map((n) => JSON.stringify({ ts: n * 1000, op: 'x', items: items(n) })).join('\n') + '\n',
  );

  // 从 ts=2500 那一刻分叉：应该看到"第 1 步完成、第 2 步还没"
  const forked = new PlanStore();
  forked.loadFrom(src, 2500);
  assert.equal(forked.list().find((i) => i.id === 1)!.status, 'done');
  assert.equal(forked.list().find((i) => i.id === 2)!.status, 'pending', '分叉点之后的进展不该带过来');

  forked.switchLog(dst);
  assert.ok(fs.existsSync(dst), '新会话的日志要有个起点，否则下次 load 又是空的');
  const revived = new PlanStore(dst);
  revived.load();
  assert.equal(revived.list().length, 2);
  assert.equal(fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).length, 3, '原会话的日志一个字节都不该动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('task_plan 工具：steps 和 done 不能一起给，缺参数时告诉它当前计划', () => {
  const store = new PlanStore();
  const { tool, seen } = toolWith(store);

  const empty = tool.run({}) as { ok: boolean; content: string };
  assert.equal(empty.ok, false);
  assert.match(empty.content, /还没有计划/);

  const both = tool.run({ steps: 'A\nB', done: 1 }) as { ok: boolean; content: string };
  assert.equal(both.ok, false);
  assert.match(both.content, /steps 和 done 不要一起给/);
  assert.equal(store.list().length, 0, '被拒的调用不能有副作用');

  const ok = tool.run({ steps: 'A\nB' }) as { ok: boolean; content: string };
  assert.equal(ok.ok, true);
  assert.match(ok.content, /共 2 步/);
  assert.match(ok.content, /1 ○ A/, '返回里要带完整清单，省得它自己记');
  assert.deepEqual(seen.map((s) => s.op), ['steps']);
});

test('task_plan 工具：done + doing 一起给（干完一步接着下一步，模型最常这么用）', () => {
  const store = new PlanStore();
  const { tool, seen } = toolWith(store);
  tool.run({ steps: 'A\nB\nC', doing: 1 });
  const res = tool.run({ done: 1, doing: 2 }) as { ok: boolean; content: string };
  assert.equal(res.ok, true, '先收尾第 1 步再开工第 2 步，不该被"只能一个 doing"误伤');
  assert.equal(store.list().find((i) => i.id === 1)!.status, 'done');
  assert.equal(store.list().find((i) => i.id === 2)!.status, 'doing');
  assert.deepEqual(seen.map((s) => s.op), ['steps', 'doing', 'done', 'doing']);
});

test('task_plan 工具：steps 可以带 doing 一起给（建完计划顺手开工，省一次往返）', () => {
  const store = new PlanStore();
  const { tool, seen } = toolWith(store);
  const res = tool.run({ steps: 'A\nB\nC', doing: 2 }) as { ok: boolean; content: string };
  assert.equal(res.ok, true);
  assert.equal(store.list().find((i) => i.id === 2)!.status, 'doing');
  assert.match(res.content, /2 ▶ B/);
  assert.deepEqual(seen.map((s) => s.op), ['steps', 'doing'], '两件事都要发事件');
});

test('task_plan 是 free 工具：不占回合步数上限', () => {
  const { tool } = toolWith(new PlanStore());
  assert.equal(tool.free, true);
});

test('task_plan 工具：doing/done 走同一套约束，被拒时 ok=false', () => {
  const store = new PlanStore();
  const { tool, seen } = toolWith(store);
  tool.run({ steps: 'A\nB' });
  assert.equal((tool.run({ doing: 1 }) as { ok: boolean }).ok, true);
  const rejected = tool.run({ doing: 2 }) as { ok: boolean; content: string };
  assert.equal(rejected.ok, false);
  assert.match(rejected.content, /先把第 1 步标成 done/);
  assert.equal((tool.run({ done: 1.5 }) as { ok: boolean }).ok, false, '小数不是步骤序号');
  assert.deepEqual(seen.map((s) => s.op), ['steps', 'doing', 'doing']);
});

test('task_plan 是 safe 工具：不需要审批', () => {
  const { tool } = toolWith(new PlanStore());
  // 显式声明，不是靠"没写 assess"——缺省是 confirm
  assert.equal(tool.assess?.({})?.level, 'safe');
});
