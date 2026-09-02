import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { connectMcp, mcpToolName, readMcpConfig } from '../src/mcp/register.ts';
import { restoreArgs, toToolSchema } from '../src/mcp/client.ts';

/**
 * 删临时工作目录，删不掉就等一会儿再试。
 *
 * Windows 上 `close()` 只是 SIGTERM，子进程刚被杀、系统还短暂持有它的工作目录句柄，
 * 这时 rmdir 报 EBUSY。`fs.rmSync` 的 `maxRetries` 帮不上：Node 的 rimraf 只在
 * unlink / ENOTEMPTY 那条路上重试，**最后那次 rmdir 的 EBUSY 是直接抛出来的**
 * （实测加了 `maxRetries: 20` 之后耗时仍是 117ms，一次都没重试过）。
 *
 * 等不到就放过：拆卸失败不该把测试判红，临时目录交给系统清理。
 */
function rmTemp(dir: string): void {
  const sleep = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  for (let i = 0; i < 30; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      sleep(100);
    }
  }
}

/** 一个最小的 stdio MCP 服务器，够用来验证握手 / 列表 / 调用 / 报错四条路 */
const FAKE_SERVER = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const send = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      send({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
    } else if (msg.method === 'tools/list') {
      send({ tools: [
        { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'sum', description: '求和', inputSchema: { type: 'object', properties: { nums: { type: 'array' } }, required: ['nums'] } },
        { name: 'boom', description: '总是报错', inputSchema: { type: 'object', properties: {} } },
      ] });
    } else if (msg.method === 'tools/call') {
      const a = msg.params.arguments || {};
      if (msg.params.name === 'echo') send({ content: [{ type: 'text', text: 'echo: ' + a.text }] });
      else if (msg.params.name === 'sum') {
        const arr = Array.isArray(a.nums);
        send({ content: [{ type: 'text', text: 'isArray=' + arr + ' sum=' + (arr ? a.nums.reduce((x, y) => x + y, 0) : 'n/a') }] });
      } else send({ content: [{ type: 'text', text: '炸了' }], isError: true });
    }
  }
});
`;

function setup(servers: Record<string, unknown>, withServer = true) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mcp-'));
  if (withServer) fs.writeFileSync(path.join(ws, 'server.js'), FAKE_SERVER);
  fs.mkdirSync(path.join(ws, '.glassbox'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.glassbox', 'mcp.json'), JSON.stringify({ servers }));
  const wire = new Wire();
  const tools = new ToolRegistry();
  return {
    ws,
    tools,
    wire,
    connect: () => connectMcp({ workspace: ws, tools, wire, timeoutMs: 8000 }),
    cleanup: () => rmTemp(ws),
  };
}

const fakeEntry = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: ['server.js'],
  ...extra,
});

test('接上 MCP 服务器：握手、列工具、按 mcp__服务器__工具 注册', async () => {
  const { tools, wire, connect, cleanup } = setup({ fake: fakeEntry() });
  const events: string[] = [];
  wire.subscribe((e) => {
    if (e.type === 'plugin.loaded') events.push(e.name);
  });
  const { status, close } = await connect();

  assert.equal(status.length, 1);
  assert.equal(status[0].ok, true, status[0].error);
  assert.deepEqual(status[0].tools, ['mcp__fake__echo', 'mcp__fake__sum', 'mcp__fake__boom']);
  assert.ok(tools.get('mcp__fake__echo'), '工具要真的进注册表');
  assert.deepEqual(events, ['mcp:fake'], '接入了什么必须在事件流里看得见');

  close();
  cleanup();
});

test('调用 MCP 工具：文本内容原样带回', async () => {
  const { tools, connect, cleanup } = setup({ fake: fakeEntry() });
  const { close } = await connect();

  const out = await tools.get('mcp__fake__echo')!.run({ text: '你好' });
  assert.equal(out.ok, true);
  assert.equal(out.content, 'echo: 你好');

  close();
  cleanup();
});

test('array 这类参数降级成字符串，调用前还原成结构', async () => {
  const { tools, connect, cleanup } = setup({ fake: fakeEntry() });
  const { close } = await connect();

  const sum = tools.get('mcp__fake__sum')!;
  // 引擎的 ToolSchema 只认扁平标量，所以 array 声明成 string 并在说明里写清楚
  assert.equal(sum.parameters?.properties.nums.type, 'string');
  assert.match(sum.parameters!.properties.nums.description!, /JSON 字符串/);

  const out = await sum.run({ nums: '[1,2,3]' });
  assert.match(out.content, /isArray=true/, '服务器收到的必须是真数组');
  assert.match(out.content, /sum=6/);

  close();
  cleanup();
});

test('服务器说 isError，工具结果就是失败', async () => {
  const { tools, connect, cleanup } = setup({ fake: fakeEntry() });
  const { close } = await connect();

  const out = await tools.get('mcp__fake__boom')!.run({});
  assert.equal(out.ok, false);
  assert.match(out.content, /炸了/);

  close();
  cleanup();
});

test('MCP 工具默认要审批；trust=true 才免审批', async () => {
  const a = setup({ fake: fakeEntry() });
  const ra = await a.connect();
  const guarded = a.tools.get('mcp__fake__echo')!.assess?.({ text: 'x' });
  assert.equal(guarded?.level, 'confirm', '外部进程能做什么由它自己决定，默认必须问人');
  assert.match(guarded!.reason!, /外部进程/);
  ra.close();
  a.cleanup();

  const b = setup({ fake: fakeEntry({ trust: true }) });
  const rb = await b.connect();
  // trust 必须显式标 safe：assess 缺省是 confirm，留空会让 trust 静默失效
  assert.equal(b.tools.get('mcp__fake__echo')!.assess?.({ text: 'x' })?.level, 'safe');
  rb.close();
  b.cleanup();
});

test('服务器起不来：如实报告，不影响别的服务器', async () => {
  const { connect, cleanup } = setup(
    { broken: { command: process.execPath, args: ['nope.js'] }, ok: fakeEntry() },
    true,
  );
  const { status, close } = await connect();

  const broken = status.find((s) => s.server === 'broken')!;
  assert.equal(broken.ok, false);
  assert.ok(broken.error, '必须给出原因');
  assert.equal(status.find((s) => s.server === 'ok')!.ok, true, '一台坏了不该拖累其他台');

  close();
  cleanup();
});

test('disabled 的服务器不启动；缺 command 的如实报错', async () => {
  const { connect, cleanup } = setup({
    off: fakeEntry({ disabled: true }),
    bad: { args: ['x'] },
  });
  const { status, close } = await connect();

  assert.equal(status.length, 1);
  assert.equal(status[0].server, 'bad');
  assert.match(status[0].error!, /缺少 command/);

  close();
  cleanup();
});

test('没有 mcp.json 就是没配：零成本返回空', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mcp-'));
  assert.equal(readMcpConfig(ws), undefined);
  const { status } = await connectMcp({ workspace: ws, tools: new ToolRegistry(), wire: new Wire() });
  assert.deepEqual(status, []);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('mcp.json 坏了要报出来，不能静默当成没配', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mcp-'));
  fs.mkdirSync(path.join(ws, '.glassbox'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.glassbox', 'mcp.json'), '{ 不是 JSON');
  assert.throws(() => readMcpConfig(ws), /不是合法 JSON/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('工具名清洗非法字符并截断到 64', () => {
  assert.equal(mcpToolName('my server', 'read/file'), 'mcp__my_server__read_file');
  assert.ok(mcpToolName('x'.repeat(40), 'y'.repeat(40)).length <= 64);
});

test('schema 转换：标量直传，其他类型降级并记下要还原', () => {
  const { schema, coerce } = toToolSchema({
    type: 'object',
    properties: {
      name: { type: 'string', description: '名字' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      items: { type: 'array', description: '一串东西' },
      mode: { type: 'string', enum: ['a', 'b'] },
      maybe: { type: ['string', 'null'] },
    },
    required: ['name', 'items', 'nonexistent'],
  });

  assert.equal(schema.properties.name.type, 'string');
  assert.equal(schema.properties.count.type, 'number');
  assert.equal(schema.properties.flag.type, 'boolean');
  assert.equal(schema.properties.items.type, 'string');
  assert.deepEqual(schema.properties.mode.enum, ['a', 'b']);
  assert.equal(schema.properties.maybe.type, 'string');
  assert.deepEqual(coerce, { items: true }, '只有真被降级的才需要还原');
  assert.deepEqual(schema.required, ['name', 'items'], '声明里不存在的必填项要丢掉');
});

test('降级是有损的，所以丢掉的结构必须写进 description——模型看到的签名得和服务器要的对得上', () => {
  const { schema, coerce } = toToolSchema({
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        description: '过滤条件',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
      tags: { type: 'array', items: { type: 'string' } },
      nested: {
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
      },
    },
  });

  const filter = schema.properties.filter!;
  assert.equal(filter.type, 'string');
  assert.ok(filter.description, '降级过的参数必须有 description');
  const desc = filter.description!;
  assert.match(desc, /过滤条件/, '服务器给的 description 要保住');
  assert.match(desc, /JSON 字符串/, '要明说是降级成了字符串');
  // 形状示意里要能看出：哪些字段、什么类型、哪个必填
  assert.match(desc, /query: string/, '必填不带 ?');
  assert.match(desc, /limit\?: number/, '可选带 ?');

  assert.match(schema.properties.tags!.description!, /每项是 string/);
  assert.match(schema.properties.nested!.description!, /a\?: \{ b\?: string \}/, '嵌套也要能示意出来');

  // 描述里示意了 JSON 形状，还得真的能把模型传回来的 JSON 还原
  assert.deepEqual(coerce, { filter: true, tags: true, nested: true });
  const back = restoreArgs({ filter: '{"query":"a"}' }, coerce);
  assert.deepEqual(back.filter, { query: 'a' });
});

test('还原参数：能解析就解析，解析不了原样传给服务器报错', () => {
  const out = restoreArgs({ a: '[1,2]', b: '不是JSON', c: 3 }, { a: true, b: true });
  assert.deepEqual(out.a, [1, 2]);
  assert.equal(out.b, '不是JSON');
  assert.equal(out.c, 3);
});
