import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { loadPlugins } from '../src/engine/plugin.ts';
import { shellPlugin } from '../src/plugins/shellPlugin.ts';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-shell-'));
  const wire = new Wire();
  const tools = new ToolRegistry();
  loadPlugins([shellPlugin()], { tools, wire, workspace: ws });
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args);
  return { ws, tools, call, cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

test('前台超时可配，超时后明说是超时、并指路后台', async () => {
  const { call, cleanup } = setup();
  const out = await call('run_command', { command: 'sleep 5', timeoutMs: 1000 });

  assert.equal(out.ok, false);
  assert.match(out.content, /上限被终止/, '要说清是超时，不是命令本身失败——否则模型会去改代码');
  assert.match(out.content, /background/, '要告诉它长命令该怎么跑');
  cleanup();
});

test('前台大输出被头尾截断，不整篇灌进上下文', async () => {
  const { call, cleanup } = setup();
  const out = await call('run_command', { command: `node -e "console.log('x'.repeat(5000))"` });

  assert.equal(out.ok, true);
  assert.match(out.content, /中间省略/);
  assert.ok(out.content.length < 5000, `截断后不该还是原长度，实际 ${out.content.length}`);
  cleanup();
});

test('后台任务立刻返回任务号，read_output 只回增量', async () => {
  const { call, cleanup } = setup();
  // 输出用 AAA/BBB 这种不会出现在命令原文里的串：表头会带命令原文，
  // 拿输出内容当断言目标时不能跟它撞车
  const started = await call('run_command', {
    command: `printf 'A%s\\n' AA; sleep 0.4; printf 'B%s\\n' BB`,
    background: true,
  });
  assert.equal(started.ok, true);
  assert.match(started.content, /job1/);

  await wait(200);
  const first = await call('read_output', { id: 'job1' });
  assert.match(first.content, /AAA/);
  assert.ok(!first.content.includes('BBB'), '还没输出的东西不该出现');
  assert.match(first.content, /运行中/);

  // 轮询到结束：慢机器上时序不稳，靠状态判断而不是靠 sleep
  let rest = '';
  let last = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const r = await call('read_output', { id: 'job1' });
    rest += r.content;
    last = r.content;
    if (/BBB/.test(rest) && !/运行中/.test(last)) break;
    await wait(50);
  }

  assert.match(rest, /BBB/);
  assert.ok(!rest.includes('AAA'), '增量读：上次给过的内容不该重复占上下文');
  assert.match(last, /退出码 0/);
  cleanup();
});

test('kill_command 能停下跑飞的后台任务', async () => {
  const { call, cleanup } = setup();
  await call('run_command', { command: 'sleep 30', background: true });

  const killed = await call('kill_command', { id: 'job1' });
  assert.equal(killed.ok, true);

  let status = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    status = (await call('read_output', { id: 'job1' })).content;
    if (!/运行中/.test(status)) break;
    await wait(50);
  }
  assert.match(status, /已终止/);
  cleanup();
});

test('读不存在的任务号：如实报错并列出现有任务', async () => {
  const { call, cleanup } = setup();
  const out = await call('read_output', { id: 'job9' });

  assert.equal(out.ok, false);
  assert.match(out.content, /没有这个后台任务/);
  assert.match(out.content, /一个都没有/);
  cleanup();
});

test('后台任务失败时退出码如实带回', async () => {
  const { call, cleanup } = setup();
  await call('run_command', { command: 'exit 3', background: true });

  let status = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    status = (await call('read_output', { id: 'job1' })).content;
    if (!/运行中/.test(status)) break;
    await wait(50);
  }
  assert.match(status, /失败（退出码 3/);
  cleanup();
});

test('会毁掉工作成果的 git 子命令算 dangerous，普通命令仍是 confirm', () => {
  const { tools, cleanup } = setup();
  const assess = (command: string) => tools.get('run_command')!.assess!({ command });

  for (const c of [
    'git config user.name x',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git checkout -- src/a.ts',
    'git checkout .',
  ]) {
    assert.equal(assess(c).level, 'dangerous', c);
    assert.ok(assess(c).reason, `${c} 要说清为什么危险`);
  }

  for (const c of ['git status', 'git diff', 'git checkout -b feat/x', 'echo hello', 'npm test']) {
    assert.equal(assess(c).level, 'confirm', c);
  }
  cleanup();
});
