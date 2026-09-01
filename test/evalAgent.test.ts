import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WireEvent } from '../src/engine/types.ts';
import {
  cachedTokensOf,
  freezePrints,
  frozenViolations,
  materialize,
  parseSweep,
  passCell,
  revealHidden,
  runTask,
  runVerify,
  summarizeTasks,
  turnMetricsOf,
  type AgentTask,
  type TaskRun,
  type TaskSet,
} from '../src/eval/agentCore.ts';

/**
 * 评测本身也要能被测——不然「通过率 62%」就是拿一把没校准的尺子量出来的。
 * 这里全部不需要模型：`ask` 是注入进来的，用一个假的假装 agent 干了活。
 */

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-agent-eval-t-')));

const TASK: AgentTask = {
  id: 'X1',
  title: '修 off-by-one',
  dimension: '修 bug',
  prompt: '修好它',
  verify: 'node --test check.test.js',
  frozen: ['check.test.js'],
  files: {
    'package.json': '{"name":"x","type":"module"}\n',
    'sum.js': 'export function sum(xs) {\n  let t = 0;\n  for (let i = 0; i < xs.length - 1; i++) t += xs[i];\n  return t;\n}\n',
    'check.test.js':
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\ntest('sum', () => {\n  assert.equal(sum([1, 2, 3]), 6);\n});\n",
  },
};

const FIXED = 'export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';

/** 假 agent：按给定的动作改工作区，返回一份固定指标 */
const fakeAsk =
  (act: (dir: string) => void) =>
  async (dir: string): Promise<ReturnType<typeof turnMetricsOf>> => {
    act(dir);
    return { steps: 3, wallMs: 1200, promptTokens: 5000, completionTokens: 300, cachedTokens: 4000 };
  };

test('materialize 铺出夹具，夹具原样跑判定必须是「不通过」', () => {
  const dir = tmp();
  try {
    materialize(dir, TASK);
    assert.ok(fs.existsSync(path.join(dir, 'sum.js')));
    const v = runVerify(dir, TASK);
    assert.equal(v.ok, false, '一开始就通过的任务是废任务，测不出任何东西');
    assert.ok(v.detail.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materialize 会建中间目录，src/a.js 这种嵌套路径也铺得出来', () => {
  const dir = tmp();
  try {
    materialize(dir, { ...TASK, files: { 'src/deep/a.js': 'export const a = 1;\n' } });
    assert.equal(fs.readFileSync(path.join(dir, 'src/deep/a.js'), 'utf8'), 'export const a = 1;\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('改对之后判定通过', async () => {
  const root = tmp();
  try {
    const r = await runTask(TASK, {
      root,
      ask: fakeAsk((dir) => fs.writeFileSync(path.join(dir, 'sum.js'), FIXED)),
    });
    assert.equal(r.passed, true);
    assert.equal(r.failure, undefined);
    // agent 侧的指标要如实带出来，不能被判定环节吃掉
    assert.equal(r.steps, 3);
    assert.equal(r.promptTokens, 5000);
    assert.equal(r.cachedTokens, 4000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('什么都不做 -> 判定失败，失败原因是 verify', async () => {
  const root = tmp();
  try {
    const r = await runTask(TASK, { root, ask: fakeAsk(() => {}) });
    assert.equal(r.passed, false);
    assert.equal(r.failure, 'verify');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('删掉断言让测试变绿 -> 判定「通过」但整条任务算失败', async () => {
  // 这是必须堵住的作弊路径：判定命令自己看不出测试文件被改了
  const root = tmp();
  try {
    const r = await runTask(TASK, {
      root,
      ask: fakeAsk((dir) => {
        fs.writeFileSync(path.join(dir, 'check.test.js'), "import { test } from 'node:test';\ntest('sum', () => {});\n");
      }),
    });
    assert.equal(r.passed, false);
    assert.equal(r.failure, 'frozen');
    assert.match(r.detail ?? '', /check\.test\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ask 自己抛错时如实记成 error，不当成「未通过」', async () => {
  const root = tmp();
  try {
    const r = await runTask(TASK, {
      root,
      ask: async () => {
        throw new Error('模型调用失败');
      },
    });
    assert.equal(r.passed, false);
    assert.equal(r.failure, 'error');
    assert.match(r.detail ?? '', /模型调用失败/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('freezePrints / frozenViolations 只报真的被改过的文件', () => {
  const dir = tmp();
  try {
    materialize(dir, TASK);
    const before = freezePrints(dir, TASK);
    assert.deepEqual(frozenViolations(dir, before), []);
    // 改别的文件不算违规
    fs.writeFileSync(path.join(dir, 'sum.js'), FIXED);
    assert.deepEqual(frozenViolations(dir, before), []);
    // 原样重写也不算——比的是内容，不是修改时间
    fs.writeFileSync(path.join(dir, 'check.test.js'), TASK.files['check.test.js']);
    assert.deepEqual(frozenViolations(dir, before), []);
    fs.writeFileSync(path.join(dir, 'check.test.js'), '// 没了\n');
    assert.deepEqual(frozenViolations(dir, before), ['check.test.js']);
    // 删掉也算改动
    fs.rmSync(path.join(dir, 'check.test.js'));
    assert.deepEqual(frozenViolations(dir, before), ['check.test.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedTokensOf 累加各步的缓存命中，网关没报就不编造', () => {
  const evs: WireEvent[] = [
    { type: 'llm.response', turnId: 't1', response: { text: 'a', usage: { prompt: 100, completion: 10, total: 110, cached: 80 } }, ts: 1 },
    { type: 'llm.response', turnId: 't1', response: { text: 'b', usage: { prompt: 200, completion: 20, total: 220, cached: 150 } }, ts: 2 },
  ];
  assert.equal(cachedTokensOf(evs), 230);
  assert.equal(
    cachedTokensOf([{ type: 'llm.response', turnId: 't1', response: { text: 'a', usage: { prompt: 1, completion: 1, total: 2 } }, ts: 1 }]),
    undefined,
  );
  assert.equal(cachedTokensOf([]), undefined);
});

test('turnMetricsOf 复用 metricsOf 的步数与 token，再补上缓存命中', () => {
  const evs: WireEvent[] = [
    { type: 'turn.start', turnId: 't1', userText: 'x', ts: 1000 },
    { type: 'tool.call', turnId: 't1', call: { id: 'c1', name: 'edit_file', args: {} }, ts: 1100 },
    { type: 'tool.call', turnId: 't1', call: { id: 'c2', name: 'run_command', args: {} }, ts: 1200 },
    { type: 'llm.response', turnId: 't1', response: { text: 'ok', usage: { prompt: 900, completion: 40, total: 940, cached: 700 } }, ts: 1300 },
    { type: 'turn.end', turnId: 't1', messages: [], ts: 1500 },
  ];
  const m = turnMetricsOf(evs, 's-1');
  assert.equal(m.steps, 2);
  assert.equal(m.wallMs, 500);
  assert.equal(m.promptTokens, 900);
  assert.equal(m.cachedTokens, 700);
  assert.equal(m.sessionId, 's-1');
});

test('summarizeTasks 分开报通过率、不稳定任务数与冻结违规数', () => {
  const tasks: AgentTask[] = [
    { ...TASK, id: 'A' },
    { ...TASK, id: 'B' },
    { ...TASK, id: 'C' },
  ];
  const run = (over: Partial<TaskRun>): TaskRun => ({ taskId: 'A', passed: true, steps: 4, wallMs: 100, ...over });
  const runs = new Map<string, TaskRun[]>([
    ['A', [run({ passed: true, promptTokens: 1000, cachedTokens: 800 }), run({ passed: true })]],
    ['B', [run({ passed: false, failure: 'verify' }), run({ passed: true })]],
    ['C', [run({ passed: false, failure: 'frozen' }), run({ passed: false, failure: 'frozen' })]],
  ]);
  const s = summarizeTasks(tasks, runs);
  assert.equal(s.runCount, 6);
  assert.equal(s.passRate, 3 / 6);
  assert.equal(s.alwaysPass, 1, 'A 每次都过');
  assert.equal(s.neverPass, 1, 'C 每次都不过');
  assert.equal(s.frozenFails, 2);
  assert.equal(s.avgSteps, 4);
  // 只有一次运行报了 token，均值按有数据的那些算，不能把没报的当 0
  assert.equal(s.avgPromptTokens, 1000);
  assert.equal(s.cacheHitRate, 0.8);
});

test('passCell 区分单次与多次，也区分「未通过」和「改了冻结文件」', () => {
  assert.equal(passCell([]), '—');
  assert.equal(passCell([{ taskId: 'A', passed: true, steps: 1, wallMs: 1 }]), '通过');
  assert.equal(passCell([{ taskId: 'A', passed: false, failure: 'verify', steps: 1, wallMs: 1 }]), '未通过');
  assert.equal(passCell([{ taskId: 'A', passed: false, failure: 'frozen', steps: 1, wallMs: 1 }]), '改了冻结文件');
  assert.equal(
    passCell([
      { taskId: 'A', passed: true, steps: 1, wallMs: 1 },
      { taskId: 'A', passed: false, steps: 1, wallMs: 1 },
      { taskId: 'A', passed: true, steps: 1, wallMs: 1 },
    ]),
    '2/3 通过',
  );
});

// ---------- 多轮与早期约束 ----------

test('多轮任务把 prompt 和 turns 依次交给同一个 ask', async () => {
  const root = tmp();
  const seen: string[][] = [];
  try {
    await runTask({ ...TASK, turns: ['第二轮', '第三轮'] }, {
      root,
      ask: async (dir, prompts) => {
        seen.push([...prompts]);
        fs.writeFileSync(path.join(dir, 'sum.js'), FIXED);
        return { steps: 1, wallMs: 1 };
      },
    });
    assert.deepEqual(seen, [['修好它', '第二轮', '第三轮']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('早期约束单独判：功能过了但约束丢了，要能分开看出来', async () => {
  const root = tmp();
  const task: AgentTask = {
    ...TASK,
    frozen: [],
    constraintVerify: 'node -e "const s=require(\'fs\').readFileSync(\'sum.js\',\'utf8\');process.exit(s.includes(\'/**\')?0:1)"',
  };
  try {
    // 改对了功能，但没写 JSDoc
    const lost = await runTask(task, { root, ask: fakeAsk((dir) => fs.writeFileSync(path.join(dir, 'sum.js'), FIXED)) });
    assert.equal(lost.passed, true, '功能是过的');
    assert.equal(lost.constraintOk, false, '约束没守住');
    assert.match(lost.detail ?? '', /早期约束丢了/);

    // 两者都做到
    const kept = await runTask(task, {
      root,
      ask: fakeAsk((dir) => fs.writeFileSync(path.join(dir, 'sum.js'), `/** 求和 */\n${FIXED}`)),
    });
    assert.equal(kept.passed, true);
    assert.equal(kept.constraintOk, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没声明 constraintVerify 的任务不该凭空多出一个约束存活率', async () => {
  const root = tmp();
  try {
    const r = await runTask(TASK, { root, ask: fakeAsk(() => {}) });
    assert.equal(r.constraintOk, undefined);
    const s = summarizeTasks([TASK], new Map([[TASK.id, [r]]]));
    assert.equal(s.constraintRate, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('summarizeTasks 的约束存活率只统计声明了约束的运行', () => {
  const tasks: AgentTask[] = [{ ...TASK, id: 'A' }, { ...TASK, id: 'B' }];
  const run = (over: Partial<TaskRun>): TaskRun => ({ taskId: 'A', passed: true, steps: 1, wallMs: 1, ...over });
  const s = summarizeTasks(
    tasks,
    new Map([
      ['A', [run({ constraintOk: true }), run({ constraintOk: false })]],
      ['B', [run({}), run({})]], // 没有约束的任务不参与
    ]),
  );
  assert.equal(s.constraintRate, 0.5);
  assert.equal(s.passRate, 1);
});

test('parseSweep 解析 --sweep KEY=v1,v2，格式不对就当没扫描', () => {  assert.deepEqual(parseSweep('GB_VERIFY_RETRY=0,1,2'), { key: 'GB_VERIFY_RETRY', values: ['0', '1', '2'] });
  assert.deepEqual(parseSweep(' GB_PRUNE = 0 , 1 '), { key: 'GB_PRUNE', values: ['0', '1'] });
  assert.deepEqual(parseSweep('GB_X=1'), { key: 'GB_X', values: ['1'] }, '一个值也算一组');
  // 参数写错不该让整个跑批崩掉
  assert.equal(parseSweep(undefined), undefined);
  assert.equal(parseSweep(''), undefined);
  assert.equal(parseSweep('GB_X'), undefined, '没有 =');
  assert.equal(parseSweep('=1,2'), undefined, '没有键名');
  assert.equal(parseSweep('GB_X='), undefined, '没有值');
  assert.equal(parseSweep('GB_X=,,'), undefined);
});

test('随包发布的任务集：每条都得是「一开始就跑不过」，且冻结文件确实存在', () => {
  // 这条测试是防夹具腐烂的。JSON 里一个转义写错，任务就可能一开始就是绿的，
  // 于是通过率虚高、还没人看得出来
  for (const [file, min] of [
    ['eval/agent-tasks.json', 5],
    ['eval/agent-tasks-hard.json', 5],
    ['eval/agent-tasks-hidden.json', 3],
    ['eval/longsession-tasks.json', 1],
  ] as const) {
    const set = JSON.parse(fs.readFileSync(file, 'utf8')) as TaskSet;
    assert.ok(set.tasks.length >= min, `${file} 任务太少，通过率的分辨率会低到没意义`);
    assert.equal([...new Set(set.tasks.map((t) => t.id))].length, set.tasks.length, `${file} id 有重复`);

    for (const t of set.tasks) {
      for (const f of t.frozen ?? []) {
        assert.ok(t.files[f] !== undefined, `${t.id} 冻结了一个夹具里没有的文件: ${f}`);
      }
      // 隐藏文件不能和可见文件撞名，否则 agent 会看见本该藏起来的验收测试
      for (const f of Object.keys(t.hidden ?? {})) {
        assert.equal(t.files[f], undefined, `${t.id} 的隐藏文件 ${f} 同时出现在 files 里，等于没藏`);
      }
      const dir = tmp();
      try {
        materialize(dir, t);
        // 判定要在隐藏测试也铺好之后才有意义
        revealHidden(dir, t);
        assert.equal(runVerify(dir, t).ok, false, `${t.id} 的夹具一开始就通过了，这条任务没有意义`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test('隐藏的验收测试在 agent 干活期间不存在，跑完才铺进去', async () => {
  const root = tmp();
  const task: AgentTask = {
    id: 'HID',
    title: '隐藏验收',
    dimension: '自己推边界',
    prompt: '实现 sum',
    verify: 'node --test check.test.js',
    files: {
      'package.json': '{"name":"h","type":"module"}\n',
      'sum.js': 'export function sum(xs) {\n  return 0;\n}\n',
    },
    hidden: {
      'check.test.js':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\ntest('sum', () => {\n  assert.equal(sum([1, 2]), 3);\n});\n",
    },
  };
  try {
    let sawTest = true;
    const r = await runTask(task, {
      root,
      ask: async (dir) => {
        // agent 眼里不该有 check.test.js
        sawTest = fs.existsSync(path.join(dir, 'check.test.js'));
        fs.writeFileSync(path.join(dir, 'sum.js'), FIXED);
        return { steps: 1, wallMs: 1 };
      },
    });
    assert.equal(sawTest, false, '验收测试在干活阶段就可见，等于没隐藏');
    assert.equal(r.passed, true, '隐藏测试要在判定前铺好');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
