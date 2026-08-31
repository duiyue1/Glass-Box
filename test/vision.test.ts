import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { loadPlugins } from '../src/engine/plugin.ts';
import { Loop } from '../src/engine/loop.ts';
import { fsPlugin } from '../src/plugins/fsPlugin.ts';
import { redactImages } from '../src/engine/redact.ts';
import { estimateTokens, IMAGE_TOKENS } from '../src/engine/tokens.ts';
import type { Llm } from '../src/engine/loop.ts';
import type { Msg, LlmResponse, WireEvent } from '../src/engine/types.ts';

/** 1x1 的合法 PNG（base64） */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function fixture(): { ws: string; outside: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-vision-'));
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'in.txt'), 'inside\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
  fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from(PNG_1PX, 'base64'));
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
  fs.writeFileSync(path.join(ws, '.env'), 'MIDSCENE_MODEL_API_KEY=sk-secret\n');
  return { ws, outside: root };
}

function tools(ws: string): ToolRegistry {
  const reg = new ToolRegistry();
  loadPlugins([fsPlugin()], { tools: reg, wire: new Wire(), workspace: ws });
  return reg;
}

test('工作区内读取是 safe，工作区外读取升级为 dangerous', () => {
  const { ws, outside } = fixture();
  const read = tools(ws).get('read_file')!;
  // 断言 level 而不是"返回了 undefined"：安全缺省翻转成 confirm 之后，
  // undefined 恰好等于"每次读文件都弹审批"，只认哨兵值的断言不会报警
  assert.equal(read.assess!({ path: 'in.txt' }).level, 'safe');
  const out = read.assess!({ path: path.join(outside, 'outside.txt') });
  assert.equal(out?.level, 'dangerous');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('审批放行后能读到工作区外的文件', async () => {
  const { ws, outside } = fixture();
  const read = tools(ws).get('read_file')!;
  const r = await read.run({ path: path.join(outside, 'outside.txt') });
  assert.equal(r.ok, true);
  assert.equal(r.content, 'outside\n');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('凭证类文件即使被放行也读不到', async () => {
  const { ws, outside } = fixture();
  const read = tools(ws).get('read_file')!;
  for (const p of [path.join(outside, '.ssh', 'id_rsa'), '.env']) {
    const r = await read.run({ path: p });
    assert.equal(r.ok, false, `${p} 应被拒绝`);
    assert.match(r.content, /凭证类文件/);
    assert.ok(!r.content.includes('sk-secret'), '不能把密钥内容带出来');
  }
  fs.rmSync(outside, { recursive: true, force: true });
});

test('读图片返回 data URL，而不是乱码文本', async () => {
  const { ws, outside } = fixture();
  const read = tools(ws).get('read_file')!;
  const r = await read.run({ path: path.join(outside, 'shot.png') });
  assert.equal(r.ok, true);
  assert.equal(r.images?.length, 1);
  assert.match(r.images![0], /^data:image\/png;base64,/);
  assert.match(r.content, /已读取图片 shot\.png/);
  assert.equal(r.meta?.images, 1);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('图片超过体积上限时拒绝而非硬塞给模型', async () => {
  const { ws, outside } = fixture();
  fs.writeFileSync(path.join(outside, 'big.png'), Buffer.alloc(200 * 1024));
  const prev = process.env.GB_MAX_IMAGE_MB;
  process.env.GB_MAX_IMAGE_MB = '0.1';
  const r = await tools(ws).get('read_file')!.run({ path: path.join(outside, 'big.png') });
  if (prev === undefined) delete process.env.GB_MAX_IMAGE_MB;
  else process.env.GB_MAX_IMAGE_MB = prev;
  assert.equal(r.ok, false);
  assert.match(r.content, /图片过大/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('图片会进对话消息，但事件流里只留占位描述', async () => {
  const { ws, outside } = fixture();
  const imgPath = path.join(outside, 'shot.png');
  const wire = new Wire();
  const reg = new ToolRegistry();
  loadPlugins([fsPlugin()], { tools: reg, wire, workspace: ws });

  // 第一轮要求读图，第二轮给出文本结论
  let round = 0;
  const llm: Llm = {
    async complete(_msgs: Msg[]): Promise<LlmResponse> {
      return round++ === 0
        ? { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: imgPath } }] }
        : { text: '看到一张 1x1 的图' };
    },
  };
  const events: WireEvent[] = [];
  wire.subscribe((e) => events.push(e));
  const loop = new Loop(wire, reg, llm, { decide: async () => true });
  const convo = await loop.runTurn('看看这张图');

  const toolMsg = convo.find((m) => m.role === 'tool')!;
  assert.match(toolMsg.images![0], /^data:image\/png;base64,/, '真数据要留在对话里给模型');

  const emitted = events.find((e) => e.type === 'tool.result');
  assert.ok(emitted && emitted.type === 'tool.result');
  assert.match(emitted.result.images![0], /^\[image image\/png/, '事件流里必须是占位描述');
  assert.ok(!JSON.stringify(events).includes(PNG_1PX.slice(0, 40)), '黑匣子里不该出现 base64 原文');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('redactImages 换成带体积的占位串', () => {
  const out = redactImages([`data:image/jpeg;base64,${'A'.repeat(4096)}`])!;
  assert.equal(out[0], '[image image/jpeg ~3KB]');
  assert.equal(redactImages(undefined), undefined);
});

test('token 估算把图片按固定成本计入', () => {
  const base = estimateTokens([{ role: 'user', content: 'hi' }]);
  const withImg = estimateTokens([{ role: 'user', content: 'hi', images: ['data:image/png;base64,AA'] }]);
  assert.equal(withImg - base, IMAGE_TOKENS);
});
