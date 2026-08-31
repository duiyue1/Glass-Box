import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { fsPlugin } from '../src/plugins/fsPlugin.ts';
import { shellPlugin } from '../src/plugins/shellPlugin.ts';
import {
  AutoApprover,
  RememberingApprover,
  memoryKey,
  rememberedFrom,
} from '../src/engine/approval.ts';
import type { ApprovalDecision, ApprovalRequest, Approver, WireEvent } from '../src/engine/types.ts';
import { memorable, toDecision } from '../src/engine/types.ts';

function setup(): { dir: string; tools: ToolRegistry } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-appr-')));
  const tools = new ToolRegistry();
  const ctx = { tools, wire: new Wire(), workspace: dir };
  fsPlugin({}).setup(ctx);
  shellPlugin({}).setup(ctx);
  return { dir, tools };
}

const req = (toolName: string, args: Record<string, unknown>, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  toolName,
  args,
  level: 'confirm',
  summary: 's',
  ...over,
});

// ---------- 硬拒绝：写 .git ----------

test('写 .git 下的文件是 deny，不是 confirm——写 hooks 等于埋一段自动执行的脚本', () => {
  const { dir, tools } = setup();
  try {
    fs.mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
    const a = tools.get('write_file')!.assess!({ path: '.git/hooks/pre-commit', content: 'x' });
    assert.equal(a.level, 'deny');
    const b = tools.get('edit_file')!.assess!({ path: '.git/config', old: 'a', new: 'b' });
    assert.equal(b.level, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('顺着软链写到工作区外是 deny，判断用真实路径', () => {
  const { dir, tools } = setup();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.writeFileSync(path.join(outside, 'a.txt'), 'x');
    fs.symlinkSync(path.join(outside, 'a.txt'), path.join(dir, 'link.txt'));
    const a = tools.get('write_file')!.assess!({ path: 'link.txt', content: 'y' });
    assert.equal(a.level, 'deny');
    assert.match(a.reason ?? '', /工作区之外/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('读凭证类文件按真实路径判断：软链绕不过黑名单', async () => {
  const { dir, tools } = setup();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.writeFileSync(path.join(outside, 'secret.pem'), 'FAKE-PRIVATE-KEY\n');
    fs.symlinkSync(path.join(outside, 'secret.pem'), path.join(dir, 'link.pem'));
    const read = tools.get('read_file')!;
    assert.equal(read.assess!({ path: 'link.pem' }).level, 'deny');
    // run 自己也要挡住：assess 只是给人看的，真正的闸门不能只在 UI 层
    const r = await read.run({ path: 'link.pem' });
    assert.equal(r.ok, false);
    assert.ok(!r.content.includes('FAKE-PRIVATE-KEY'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ---------- 关键配置文件：记忆豁免 ----------

test('关键配置文件带 noMemory：批了一次也不进记忆，下次照样问', () => {
  const { dir, tools } = setup();
  try {
    const w = tools.get('write_file')!;
    for (const p of ['package.json', 'tsconfig.json', 'AGENTS.md', '.github/workflows/ci.yml']) {
      const a = w.assess!({ path: p, content: 'x' });
      assert.equal(a.level, 'confirm', p);
      assert.equal(a.noMemory, true, p);
      assert.equal(memorable({ toolName: 'write_file', args: { path: p }, ...a }), false, p);
    }
    const plain = w.assess!({ path: 'src/a.ts', content: 'x' });
    assert.equal(plain.noMemory, undefined);
    assert.equal(memorable({ toolName: 'write_file', args: { path: 'src/a.ts' }, ...plain }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dangerous 永不进记忆：点一次头不等于永久授权', () => {
  assert.equal(memorable(req('run_command', { command: 'rm -rf x' }, { level: 'dangerous' })), false);
});

// ---------- assess 默认值 ----------

test('工具没声明风险等级时按 confirm 处理，不是静默放行', () => {
  // 语义保证写在 Loop 里；这里锁住"只读工具必须自己声明 safe"这一半
  const { dir, tools } = setup();
  try {
    for (const name of ['read_file', 'list_dir', 'read_output']) {
      const tool = tools.get(name);
      if (!tool) continue;
      assert.notEqual(tool.assess, undefined, `${name} 必须声明 assess`);
    }
    assert.equal(tools.get('read_output')!.assess!({}).level, 'safe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- memoryKey ----------

test('memoryKey 取工具名 + 首个字符串参数的前两段', () => {
  assert.equal(memoryKey(req('run_command', { command: 'npm test' })), 'run_command:npm test');
  assert.equal(
    memoryKey(req('run_command', { command: 'npm test -- --watch' })),
    'run_command:npm test',
  );
  assert.notEqual(
    memoryKey(req('run_command', { command: 'npm install lodash' })),
    memoryKey(req('run_command', { command: 'npm test' })),
  );
  assert.equal(memoryKey(req('t', {})), 't');
  assert.equal(memoryKey(req('t', { n: 1 })), 't');
  assert.equal(memoryKey(req('t', { s: '   ' })), 't');
});

// ---------- RememberingApprover ----------

class Counting implements Approver {
  calls = 0;
  private readonly answer: ApprovalDecision;
  constructor(answer: ApprovalDecision) {
    this.answer = answer;
  }
  async decide(): Promise<ApprovalDecision> {
    this.calls += 1;
    return this.answer;
  }
}

test('答 always 之后同类调用不再问，不同类仍然问', async () => {
  const inner = new Counting('always');
  const a = new RememberingApprover(inner);
  assert.equal(await a.decide(req('run_command', { command: 'npm test' })), 'always');
  assert.equal(await a.decide(req('run_command', { command: 'npm test -- -w' })), 'allow');
  assert.equal(inner.calls, 1);
  await a.decide(req('run_command', { command: 'npm install x' }));
  assert.equal(inner.calls, 2);
  assert.deepEqual(a.keys().sort(), ['run_command:npm install', 'run_command:npm test']);
});

test('答 allow（只这一次）不进记忆', async () => {
  const inner = new Counting('allow');
  const a = new RememberingApprover(inner);
  await a.decide(req('write_file', { path: 'a.ts' }));
  await a.decide(req('write_file', { path: 'a.ts' }));
  assert.equal(inner.calls, 2);
  assert.deepEqual(a.keys(), []);
});

test('noMemory 与 dangerous 的 always 不落记忆', async () => {
  const inner = new Counting('always');
  const a = new RememberingApprover(inner);
  await a.decide(req('write_file', { path: 'package.json' }, { noMemory: true }));
  await a.decide(req('run_command', { command: 'rm -rf x' }, { level: 'dangerous' }));
  assert.deepEqual(a.keys(), []);
  await a.decide(req('write_file', { path: 'package.json' }, { noMemory: true }));
  assert.equal(inner.calls, 3);
});

test('构造时传入的记忆立即生效（resume 场景）', async () => {
  const inner = new Counting('deny');
  const a = new RememberingApprover(inner, ['run_command:npm test']);
  assert.equal(await a.decide(req('run_command', { command: 'npm test' })), 'allow');
  assert.equal(inner.calls, 0);
});

// ---------- rememberedFrom ----------

const decisionEvent = (request: ApprovalRequest, decision: ApprovalDecision): { ev: WireEvent } => ({
  ev: {
    type: 'approval.decision',
    turnId: 't1',
    request,
    approved: decision !== 'deny',
    decision,
    ts: 0,
  } as WireEvent,
});

test('rememberedFrom 从日志里挑出 always 重算 key，其它决定不算', () => {
  const keys = rememberedFrom([
    decisionEvent(req('run_command', { command: 'npm test' }), 'always'),
    decisionEvent(req('write_file', { path: 'a.ts' }), 'allow'),
    decisionEvent(req('run_command', { command: 'rm -rf /' }), 'deny'),
    // 危险操作即使当时被记成 always，回放时也不恢复
    decisionEvent(req('run_command', { command: 'git clean -fd' }, { level: 'dangerous' }), 'always'),
    // 关键配置文件同理
    decisionEvent(req('write_file', { path: 'package.json' }, { noMemory: true }), 'always'),
    { ev: { type: 'turn.end', turnId: 't1', ts: 0 } as WireEvent },
  ]);
  assert.deepEqual(keys, ['run_command:npm test']);
});

// ---------- AutoApprover ----------

test('AutoApprover 的 dangerous 与 confirm 分开控制', async () => {
  const a = new AutoApprover({ approveConfirm: true, approveDangerous: false });
  assert.equal(toDecision(await a.decide(req('t', {}))), 'allow');
  assert.equal(toDecision(await a.decide(req('t', {}, { level: 'dangerous' }))), 'deny');
});
