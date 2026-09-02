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

/**
 * 一个"要跑一会儿"的命令。测试要验证的是超时/终止/增量读，不是 `sleep` 本身——
 * 而拿 `sleep` / `printf` 当道具会让整个测试套件在 Windows 原生环境挂掉。
 * 用 node 自己当慢命令：哪里跑得了测试，哪里就跑得了它。
 */
const slow = (seconds: number): string => `node -e "setTimeout(()=>{},${seconds * 1000})"`;
/** 分段输出：立刻打出第一段，停一下再打第二段（验证增量读）。
 * 间隔要够大：node --test 下子进程冷启动能到几百毫秒，间隔太小的话
 * 第二次读之前两段就都落地了，"增量"就没法验证。
 * 输出串必须是命令原文里没有的：表头会回显整条命令——所以第一段打成
 * 'AA'+'A' 拼接，命令原文里就搜不到连续的 AAA */
const twoParts = (first: string, second: string, gapMs = 2500): string =>
  `node -e "console.log('${first.slice(0, -1)}'+'${first.at(-1)}');` +
  `setTimeout(()=>console.log('${second.slice(0, -1)}'+'${second.at(-1)}'),${gapMs})"`;;

function setup() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-shell-'));
  const wire = new Wire();
  const tools = new ToolRegistry();
  loadPlugins([shellPlugin()], { tools, wire, workspace: ws });
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args);
  // maxRetries 是给 Windows 的：被超时杀掉的子进程退出后，系统还会短暂持有工作目录句柄，
  // 立刻 rmdir 会 EBUSY。POSIX 上一次就成功，这个参数不影响它。
  return {
    ws,
    tools,
    call,
    cleanup: () => fs.rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  };
}

test('前台超时可配，超时后明说是超时、并指路后台', async () => {
  const { call, cleanup } = setup();
  const out = await call('run_command', { command: slow(5), timeoutMs: 1000 });

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
    command: twoParts('AAA', 'BBB'),
    background: true,
  });
  assert.equal(started.ok, true);
  assert.match(started.content, /job1/);

  // 先给 node 冷启动留时间再读第一次。直接轮询会出这种竞态：
  // 程序还没打出 AAA，第一次读就把（空的）增量消费掉了，AAA 永远读不到
  await wait(1200);
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
  await call('run_command', { command: slow(30), background: true });

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

test('命令碰到的路径也按归属判：凭证 deny、越界与 .git 升 dangerous', async () => {
  const { ws, tools, call, cleanup } = setup();
  const assess = (command: string) => tools.get('run_command')!.assess!({ command });
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.env'), 'TOKEN=abc\n');

  // 平常的开发命令不该被这套判定连累
  for (const c of ['echo hello', 'npm test', 'ls src', 'git status', 'cat README.md']) {
    assert.equal(assess(c).level, 'confirm', c);
  }

  assert.equal(assess('cat .env').level, 'deny', '凭证换成命令行也不给读');
  assert.equal(assess('cat ~/.ssh/id_rsa').level, 'deny');
  assert.equal(assess('cat $HOME/.ssh/id_rsa').level, 'deny', '变量展开不了也要按字面拦');
  assert.equal(assess('cp /etc/hosts .').level, 'dangerous');
  assert.equal(assess('cd ../.. && ls').level, 'dangerous');
  assert.equal(assess('echo x > .git/config').level, 'dangerous');

  // deny 在 run 里还有第二道闸：assess 只是给审批看的
  const out = await call('run_command', { command: 'cat .env' });
  assert.equal(out.ok, false);
  assert.match(out.content, /凭证/);
  assert.ok(!out.content.includes('TOKEN=abc'), '内容一个字都不能带出来');
  cleanup();
});
