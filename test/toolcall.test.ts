import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { Loop, type Llm } from '../src/engine/loop.ts';
import type { Msg, LlmResponse, Tool, ToolSpec } from '../src/engine/types.ts';
import { RealLlm, mapMessages, parseToolArgs, toOpenAiTools } from '../src/llm/realLlm.ts';

const cfg = {
  baseUrl: 'https://example.test/v1',
  model: 'm',
  apiKey: 'k',
  contextWindow: 4000,
};

const readSpec: ToolSpec = {
  name: 'read_file',
  description: '读文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

/** 替换 global fetch，记录请求体并返回预设响应 */
function stubFetch(reply: unknown, sent: { body?: Record<string, unknown> }) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.body = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: true, json: async () => reply, text: async () => '' } as unknown as Response;
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

/** 用 SSE 文本流替换 global fetch */
function stubStream(chunks: string[], sent: { body?: Record<string, unknown> }) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.body = JSON.parse(init.body) as Record<string, unknown>;
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
        }),
      },
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

/* ── 参数解析 ── */

test('parseToolArgs 解析正常 JSON', () => {
  assert.deepEqual(parseToolArgs('{"path":"a.ts"}'), { path: 'a.ts' });
});

test('parseToolArgs 能从外面裹了解释文字的输出里救回 JSON', () => {
  assert.deepEqual(parseToolArgs('我要读这个文件 {"path":"a.ts"} 然后继续'), { path: 'a.ts' });
});

test('parseToolArgs 实在解析不出时返回空对象，不抛异常', () => {
  assert.deepEqual(parseToolArgs('完全不是 JSON'), {});
  assert.deepEqual(parseToolArgs(undefined), {});
});

/* ── 消息映射 ── */

test('原生模式：assistant 带 tool_calls，tool 消息带 tool_call_id', () => {
  const msgs: Msg[] = [
    { role: 'user', content: '看下 a.ts' },
    { role: 'assistant', content: '[调用工具 read_file]', toolCalls: [{ id: 'x1', name: 'read_file', args: { path: 'a.ts' } }] },
    { role: 'tool', content: 'file body', toolCallId: 'x1' },
  ];
  const out = mapMessages(msgs, true) as Record<string, unknown>[];
  assert.equal(out.length, 3);
  const calls = out[1].tool_calls as { id: string; function: { name: string; arguments: string } }[];
  assert.equal(calls[0].id, 'x1');
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.ts' });
  assert.equal(out[2].role, 'tool');
  assert.equal(out[2].tool_call_id, 'x1');
});

test('原生模式：tool 结果里的图片拆成紧随其后的 user 消息（多数模型不收 tool 里的图）', () => {
  const msgs: Msg[] = [
    { role: 'tool', content: '读到一张图', toolCallId: 'x1', images: ['data:image/png;base64,AAA'] },
  ];
  const out = mapMessages(msgs, true) as Record<string, unknown>[];
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'tool');
  assert.equal(out[1].role, 'user');
  assert.ok(Array.isArray(out[1].content));
});

test('旧协议模式：tool 消息降级成带前缀的 user 消息', () => {
  const out = mapMessages([{ role: 'tool', content: 'r', toolCallId: 'x1' }], false) as Record<string, unknown>[];
  assert.equal(out[0].role, 'user');
  assert.ok(String(out[0].content).startsWith('【工具结果】'));
});

test('toOpenAiTools 输出 function 声明并带上 schema', () => {
  const out = toOpenAiTools([readSpec]) as { type: string; function: { name: string; parameters: unknown } }[];
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'read_file');
  assert.deepEqual(out[0].function.parameters, readSpec.parameters);
});

/* ── RealLlm ── */

test('原生模式：请求体带 tools、不带 stop；能解析 message.tool_calls', async () => {
  const sent: { body?: Record<string, unknown> } = {};
  const restore = stubFetch(
    {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }],
          },
        },
      ],
    },
    sent,
  );
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], undefined, [readSpec]);
    assert.equal(resp.toolCalls?.length, 1);
    assert.equal(resp.toolCalls?.[0].name, 'read_file');
    assert.deepEqual(resp.toolCalls?.[0].args, { path: 'src/app.ts' });
    assert.ok(Array.isArray(sent.body?.tools));
    assert.equal(sent.body?.tool_choice, 'auto');
    assert.equal(sent.body?.stop, undefined);
  } finally {
    restore();
  }
});

test('GB_TOOLCALL=0 时退回旧协议：不发 tools，改发 stop，靠 ACTION 解析', async () => {
  const sent: { body?: Record<string, unknown> } = {};
  const restore = stubFetch({ choices: [{ message: { content: 'ACTION: read a.ts' } }] }, sent);
  process.env.GB_TOOLCALL = '0';
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], undefined, [readSpec]);
    assert.equal(resp.toolCalls?.[0].name, 'read_file');
    assert.equal(sent.body?.tools, undefined);
    assert.ok(Array.isArray(sent.body?.stop));
  } finally {
    delete process.env.GB_TOOLCALL;
    restore();
  }
});

test('网关忽略 tools、只回文本时，ACTION 兜底仍然生效', async () => {
  const sent: { body?: Record<string, unknown> } = {};
  const restore = stubFetch({ choices: [{ message: { content: '好的。\nACTION: glob **/*.ts' } }] }, sent);
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], undefined, [readSpec]);
    assert.equal(resp.toolCalls?.[0].name, 'glob');
  } finally {
    restore();
  }
});

test('没有工具调用时返回纯文本', async () => {
  const restore = stubFetch({ choices: [{ message: { content: '这是普通回答' } }] }, {});
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], undefined, [readSpec]);
    assert.equal(resp.text, '这是普通回答');
    assert.equal(resp.toolCalls, undefined);
  } finally {
    restore();
  }
});

test('流式：分片到达的 tool_calls 按 index 拼回一个完整调用', async () => {
  const sent: { body?: Record<string, unknown> } = {};
  const restore = stubStream(
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"grep","arguments":"{\\"pat"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tern\\":\\"Wire\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ],
    sent,
  );
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], () => {}, [readSpec]);
    assert.equal(resp.toolCalls?.length, 1);
    assert.equal(resp.toolCalls?.[0].id, 'call_9');
    assert.equal(resp.toolCalls?.[0].name, 'grep');
    assert.deepEqual(resp.toolCalls?.[0].args, { pattern: 'Wire' });
    assert.equal(sent.body?.stream, true);
  } finally {
    restore();
  }
});

test('流式：最后一行没有换行结尾时也不能丢内容', async () => {
  // 实测过的坑：网关把整段回复放在一个 data: 行里、末尾不带换行。
  // 只按 \n 切行就会把它整段丢掉，于是流式返回空、非流式却正常。
  const restore = stubStream(['data: {"choices":[{"delta":{"content":"完整回复"}}]}'], {});
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], () => {}, [readSpec]);
    assert.equal(resp.text, '完整回复');
  } finally {
    restore();
  }
});

test('流式返回空内容时回退到非流式，而不是报“模型返回为空”', async () => {
  const sent: { body?: Record<string, unknown> } = {};
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls++;
    const body = JSON.parse(init.body) as { stream?: boolean };
    sent.body = body as Record<string, unknown>;
    if (body.stream) {
      // 流式：只有一个空 delta，什么都没吐出来
      const enc = new TextEncoder();
      let i = 0;
      const chunks = ['data: {"choices":[{"delta":{}}]}\n', 'data: [DONE]\n'];
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined },
          }),
        },
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '非流式补上的回答' } }] }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], () => {}, [readSpec]);
    assert.equal(resp.text, '非流式补上的回答');
    assert.equal(calls, 2, '应该先流式、再回退非流式');
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ── Loop 侧 ── */

test('Loop 把注册表里的工具声明传给模型，缺 schema 的按无参数处理', async () => {
  let got: ToolSpec[] | undefined;
  class Spy implements Llm {
    async complete(_m: Msg[], _t?: (s: string) => void, tools?: ToolSpec[]): Promise<LlmResponse> {
      got = tools;
      return { text: 'ok' };
    }
  }
  const tools = new ToolRegistry();
  tools.register({ name: 'withSchema', description: 'd', parameters: readSpec.parameters, run: () => ({ ok: true, content: '' }) });
  tools.register({ name: 'noSchema', description: 'd', run: () => ({ ok: true, content: '' }) });
  await new Loop(new Wire(), tools, new Spy(), { decide: async () => true }).runTurn('go');
  assert.equal(got?.length, 2);
  assert.deepEqual(got?.find((s) => s.name === 'noSchema')?.parameters, { type: 'object', properties: {} });
});

test('Loop 在对话历史里把 tool_calls 挂到 assistant 消息上（原生协议要求成对）', async () => {
  class ToolThenText implements Llm {
    private i = 0;
    async complete(): Promise<LlmResponse> {
      if (this.i++ === 0) return { toolCalls: [{ id: 'tc1', name: 'echoish', args: { text: 'hi' } }] };
      return { text: 'done' };
    }
  }
  const echoish: Tool = { name: 'echoish', description: 'd', run: (a) => ({ ok: true, content: String(a.text) }) };
  const tools = new ToolRegistry();
  tools.register(echoish);
  const msgs = await new Loop(new Wire(), tools, new ToolThenText(), { decide: async () => true }).runTurn('go');
  const assistant = msgs.find((m) => m.role === 'assistant' && m.toolCalls?.length);
  assert.ok(assistant, 'assistant 消息应带 toolCalls');
  assert.equal(assistant?.toolCalls?.[0].id, 'tc1');
  const toolMsg = msgs.find((m) => m.role === 'tool');
  assert.equal(toolMsg?.toolCallId, 'tc1');
});
