import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { loadPlugins } from '../src/engine/plugin.ts';
import { fsPlugin } from '../src/plugins/fsPlugin.ts';
import { Activity, formatEntry, formatSummary } from '../src/activity/activity.ts';
import type { WireEvent } from '../src/engine/types.ts';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-act-'));
}

/** 手工把一次工具调用的两个事件打到总线上（不经过 Loop，聚焦 Activity 本身） */
async function fire(
  wire: Wire,
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  id = `c_${Math.random()}`,
): Promise<void> {
  const tool = tools.get(name)!;
  wire.emit({ type: 'tool.call', turnId: 't', call: { id, name, args }, ts: Date.now() });
  const out = await tool.run(args);
  wire.emit({ type: 'tool.result', turnId: 't', result: { toolCallId: id, ...out }, ts: Date.now() });
}

test('write_file 首次写入算“创建”，再写同一文件算“修改”', async () => {
  const ws = tmpWorkspace();
  const wire = new Wire();
  const tools = new ToolRegistry();
  loadPlugins([fsPlugin()], { tools, wire, workspace: ws });
  const activity = new Activity(wire);

  await fire(wire, tools, 'write_file', { path: 'a.txt', content: 'l1\nl2\nl3\n' });
  await fire(wire, tools, 'write_file', { path: 'a.txt', content: 'l1\nl2\n' });

  const list = activity.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, 'created');
  assert.equal(list[0].added, 3);
  assert.equal(list[1].kind, 'edited');
  assert.equal(list[1].added, 2);
  assert.equal(list[1].removed, 3);

  // 同一个文件先创建后修改 -> 只算创建 1 个文件
  assert.deepEqual(activity.summary(), { created: 1, edited: 0, ran: 0, other: 0 });
  fs.rmSync(ws, { recursive: true, force: true });
});

test('edit_file 上报增删行数，且发出 activity.updated 事件', async () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, 'b.txt'), 'hello\nworld\n', 'utf8');
  const wire = new Wire();
  const tools = new ToolRegistry();
  loadPlugins([fsPlugin()], { tools, wire, workspace: ws });
  new Activity(wire);
  const updates: Extract<WireEvent, { type: 'activity.updated' }>[] = [];
  wire.subscribe((e) => {
    if (e.type === 'activity.updated') updates.push(e);
  });

  await fire(wire, tools, 'edit_file', { path: 'b.txt', old: 'world', new: 'glass\nbox' });

  assert.equal(updates.length, 1);
  const entry = updates[0].entries.at(-1)!;
  assert.equal(entry.kind, 'edited');
  assert.equal(entry.detail, 'b.txt');
  assert.equal(entry.added, 2);
  assert.equal(entry.removed, 1);
  assert.equal(updates[0].summary.edited, 1);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('没有 meta 的工具不进轨迹', async () => {
  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register({ name: 'echo', description: 'x', run: () => ({ ok: true, content: 'hi' }) });
  const activity = new Activity(wire);
  await fire(wire, tools, 'echo', { text: 'hi' });
  assert.equal(activity.list().length, 0);
  assert.equal(formatSummary(activity.summary()), '暂无活动');
});

test('轨迹行渲染成 “修改 loop.ts +4 −1” 形式', () => {
  const line = formatEntry({
    kind: 'edited',
    label: '修改',
    detail: 'loop.ts',
    added: 4,
    removed: 1,
    ok: true,
    ts: 0,
  });
  assert.equal(line, '修改 loop.ts +4 −1');
  assert.equal(formatSummary({ created: 3, edited: 6, ran: 7, other: 0 }), '创建 3 · 修改 6 · 执行 7');
});
