import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractActionCommand, retryDelayMs, retryableStatus, RealLlm, resolveCheapModelConfig } from '../src/llm/realLlm.ts';
import { parseCommand } from '../src/llm/commandGrammar.ts';

/* ── 便宜模型分层：只给没有共享前缀的辅助调用用 ── */

/** 临时改一批环境变量，跑完还原（测试之间不能互相污染） */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const MAIN = {
  GLASSBOX_MODEL_BASE_URL: 'https://main.example.test/v1',
  GLASSBOX_MODEL_NAME: 'big',
  GLASSBOX_MODEL_API_KEY: 'k-main',
  MIDSCENE_MODEL_BASE_URL: undefined,
  MIDSCENE_MODEL_NAME: undefined,
  MIDSCENE_MODEL_API_KEY: undefined,
};

test('没配便宜模型就返回 undefined（不启用分层）', () => {
  withEnv({ ...MAIN, GLASSBOX_MODEL_CHEAP_NAME: undefined }, () => {
    assert.equal(resolveCheapModelConfig(), undefined);
  });
});

test('只给便宜模型名就够：base url 和 key 沿用主模型', () => {
  // 最常见的情形是同一个网关换个便宜模型名，不该要求把三项重写一遍
  withEnv({ ...MAIN, GLASSBOX_MODEL_CHEAP_NAME: 'small' }, () => {
    const cfg = resolveCheapModelConfig();
    assert.equal(cfg?.model, 'small');
    assert.equal(cfg?.baseUrl, 'https://main.example.test/v1');
    assert.equal(cfg?.apiKey, 'k-main');
  });
});

test('便宜模型可以指向另一个网关', () => {
  withEnv(
    {
      ...MAIN,
      GLASSBOX_MODEL_CHEAP_NAME: 'small',
      GLASSBOX_MODEL_CHEAP_BASE_URL: 'https://cheap.example.test/v1',
      GLASSBOX_MODEL_CHEAP_API_KEY: 'k-cheap',
    },
    () => {
      const cfg = resolveCheapModelConfig();
      assert.equal(cfg?.baseUrl, 'https://cheap.example.test/v1');
      assert.equal(cfg?.apiKey, 'k-cheap');
    },
  );
});

test('主模型凭证都没有时不启用分层（沿用不到 base url/key）', () => {
  withEnv(
    {
      GLASSBOX_MODEL_BASE_URL: undefined,
      GLASSBOX_MODEL_NAME: undefined,
      GLASSBOX_MODEL_API_KEY: undefined,
      MIDSCENE_MODEL_BASE_URL: undefined,
      MIDSCENE_MODEL_NAME: undefined,
      MIDSCENE_MODEL_API_KEY: undefined,
      GLASSBOX_MODEL_CHEAP_NAME: 'small',
    },
    () => {
      assert.equal(resolveCheapModelConfig(), undefined, '不能凭空造出一个没有凭证的模型');
    },
  );
});

test('抽取普通 ACTION 行', () => {
  assert.equal(extractActionCommand('ACTION: grep TurnState'), 'grep TurnState');
});

test('容忍代码块包裹', () => {
  assert.equal(extractActionCommand('```\nACTION: read package.json\n```'), 'read package.json');
  assert.equal(extractActionCommand('```text\nACTION: grep Wire\n```'), 'grep Wire');
});

test('容忍前置解释文字与中文冒号', () => {
  assert.equal(extractActionCommand('好的，我来搜索一下。\nACTION：grep foo'), 'grep foo');
});

test('纯文本回复返回 null', () => {
  assert.equal(extractActionCommand('这是对你问题的普通回答，没有工具调用。'), null);
});

test('抽取结果能被指令解析器识别', () => {
  const line = extractActionCommand('```\nACTION: edit a.txt ||| x ||| y\n```');
  assert.ok(line);
  const cmd = parseCommand(line!);
  assert.equal(cmd?.name, 'edit_file');
});

test('同一行粘了第二条 ACTION 时只取第一条', () => {
  // 实测过的脏输出：模型自我纠正，把两条指令挤在一行，整行当参数会污染工具
  assert.equal(
    extractActionCommand('ACTION: glob **/*StreamGate*ACTION: glob **/*streamgate*'),
    'glob **/*StreamGate*',
  );
});

test('模型自己编造【工具结果】续写时，参数被截断到干净处', () => {
  // 实测过的脏输出：path 里带着模型预测的下一轮内容
  assert.equal(
    extractActionCommand('ACTION: read src/engine/types.ts【工具结果】`src/engine/types.ts` 内容如下：'),
    'read src/engine/types.ts',
  );
  // 变体：模型不带方括号，直接写「工具结果：」
  assert.equal(
    extractActionCommand('ACTION: grep TurnState in *工具结果：src/engine/types.ts:12: export type TurnState'),
    'grep TurnState in *',
  );
});

test('正常搜索“工具结果”四个字不会被误截', () => {
  assert.equal(extractActionCommand('ACTION: grep 工具结果'), 'grep 工具结果');
});

test('去掉指令尾部残留的反引号与空白', () => {
  assert.equal(extractActionCommand('ACTION: read src/llm/streamGate.ts` '), 'read src/llm/streamGate.ts');
});

/* ── 限流与退避重试 ── */
const cfg = { baseUrl: 'http://x/v1', model: 'm', apiKey: 'k', contextWindow: 8000 };

/** 组一个只带 get 的最小 Headers 替身 */
const headersOf = (h: Record<string, string>) =>
  ({ get: (k: string) => h[k.toLowerCase()] ?? null }) as unknown as Headers;

/**
 * 按顺序返回预设响应的 fetch 替身。
 * 每个元素要么是 `{ status }`（错误响应），要么是 SSE 分片数组，要么是非流式 JSON。
 */
type Reply = { status: number; retryAfter?: string } | { sse: string[] } | { json: unknown };

function stubReplies(replies: Reply[]): { restore: () => void; calls: () => number } {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    const r = replies[Math.min(n, replies.length - 1)];
    n += 1;
    if ('status' in r) {
      return {
        ok: false,
        status: r.status,
        headers: headersOf(r.retryAfter ? { 'retry-after': r.retryAfter } : {}),
        text: async () => 'rate limited',
      } as unknown as Response;
    }
    if ('sse' in r) {
      const enc = new TextEncoder();
      let i = 0;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              i < r.sse.length ? { done: false, value: enc.encode(r.sse[i++]) } : { done: true, value: undefined },
          }),
        },
      } as unknown as Response;
    }
    return { ok: true, json: async () => r.json, text: async () => '' } as unknown as Response;
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = orig;
    },
    calls: () => n,
  };
}

test('retryableStatus：429 与 5xx 可重试，其它 4xx 重试只是白等', () => {
  assert.equal(retryableStatus(429), true);
  assert.equal(retryableStatus(500), true);
  assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(400), false);
  assert.equal(retryableStatus(401), false);
  assert.equal(retryableStatus(404), false);
});

test('retryDelayMs 优先听服务端的 Retry-After，秒数与 HTTP 日期两种写法都认', () => {
  assert.equal(retryDelayMs(headersOf({ 'retry-after': '2' }), 1), 2000);
  assert.equal(retryDelayMs(headersOf({ 'retry-after': '0' }), 1), 0);
  // 再长也不能真的挂那么久：截到 20s 上限
  assert.equal(retryDelayMs(headersOf({ 'retry-after': '600' }), 1), 20_000);
  const date = new Date(Date.now() + 3000).toUTCString();
  const byDate = retryDelayMs(headersOf({ 'retry-after': date }), 1);
  assert.ok(byDate > 1000 && byDate <= 3000, `按日期算出来是 ${byDate}`);
  // 过去的时间点：等 0，不能是负数
  assert.equal(retryDelayMs(headersOf({ 'retry-after': new Date(Date.now() - 5000).toUTCString() }), 1), 0);
});

test('没有 Retry-After 时指数退避 + 抖动，且随尝试次数增长', () => {
  process.env.GLASSBOX_RETRY_BASE_MS = '1000';
  try {
    // 抖动区间是 [0.5, 1] 倍，所以只能断言范围
    for (const [attempt, full] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      for (let i = 0; i < 20; i++) {
        const d = retryDelayMs(undefined, attempt);
        assert.ok(d >= full / 2 && d <= full, `attempt=${attempt} 得到 ${d}`);
      }
    }
  } finally {
    delete process.env.GLASSBOX_RETRY_BASE_MS;
  }
});

test('流式撞上 429 时退避后重放——原先这里直接把整个回合判失败', async () => {
  process.env.GLASSBOX_RETRY_BASE_MS = '1';
  const stub = stubReplies([
    { status: 429, retryAfter: '0' },
    { sse: ['data: {"choices":[{"delta":{"content":"限流之后补上的回答"}}]}\n', 'data: [DONE]\n'] },
  ]);
  const out: string[] = [];
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], (t) => out.push(t));
    assert.equal(resp.text, '限流之后补上的回答');
    assert.equal(stub.calls(), 2, '应该重试一次');
    // 第一次一个字都没吐，所以重放不会让内容出现两遍
    assert.equal(out.join(''), '限流之后补上的回答');
  } finally {
    delete process.env.GLASSBOX_RETRY_BASE_MS;
    stub.restore();
  }
});

test('已经吐出内容后断流：不重放，但那半句要留在回复里', async () => {
  process.env.GLASSBOX_RETRY_BASE_MS = '1';
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const enc = new TextEncoder();
    let i = 0;
    // 带换行，StreamGate 会立刻判定并吐出去——这一段是真的上了屏
    const chunks = ['data: {"choices":[{"delta":{"content":"前半句\\n"}}]}\n'];
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
            throw new Error('连接被重置');
          },
        }),
      },
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  const out: string[] = [];
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], (t) => out.push(t));
    assert.equal(calls, 1, '吐过字之后不能再请求一次');
    // 屏幕上出现过的那半句必须回到历史里，而不是被换成一句"调用失败"
    assert.match(resp.text ?? '', /^前半句/);
    assert.match(resp.text ?? '', /没说完/);
    assert.equal(out.join(''), '前半句\n');
  } finally {
    delete process.env.GLASSBOX_RETRY_BASE_MS;
    globalThis.fetch = orig;
  }
});

test('非流式撞上 429 也退避重试（原先只有 5xx 会重试）', async () => {
  process.env.GLASSBOX_RETRY_BASE_MS = '1';
  const stub = stubReplies([
    { status: 429, retryAfter: '0' },
    { json: { choices: [{ message: { content: '第二次成功了' } }] } },
  ]);
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }]);
    assert.equal(resp.text, '第二次成功了');
    assert.equal(stub.calls(), 2);
  } finally {
    delete process.env.GLASSBOX_RETRY_BASE_MS;
    stub.restore();
  }
});

test('用户中断时，抛出的错误上挂着已经吐出的那半句', async () => {
  const orig = globalThis.fetch;
  const ctrl = new AbortController();
  globalThis.fetch = (async () => {
    const enc = new TextEncoder();
    let i = 0;
    const chunks = ['data: {"choices":[{"delta":{"content":"我先看一下这个文件，\\n"}}]}\n'];
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
            // 模拟用户按停：连接被掐断
            ctrl.abort();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          },
        }),
      },
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => new RealLlm(cfg).complete([{ role: 'user', content: 'go' }], () => {}, undefined, ctrl.signal),
      (e: unknown) => {
        assert.equal((e as Error).message, '用户中断');
        // Loop 靠这个字段把半句写进历史（engine/types.ts 的 partialOf）
        assert.equal((e as { partial?: string }).partial, '我先看一下这个文件，\n');
        return true;
      },
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test('400 这类请求自身的错误不重试，立刻如实报错', async () => {
  const stub = stubReplies([{ status: 401 }]);
  try {
    const resp = await new RealLlm(cfg).complete([{ role: 'user', content: 'go' }]);
    assert.match(resp.text ?? '', /HTTP 401/);
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
  }
});

