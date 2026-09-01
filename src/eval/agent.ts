import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoApprover } from '../engine/approval.ts';
import type { WireEvent } from '../engine/types.ts';
import {
  parseSweep,
  passCell,
  runTask,
  summarizeTasks,
  turnMetricsOf,
  type AgentTask,
  type TaskRun,
  type TaskSet,
} from './agentCore.ts';
import { num, pct } from './core.ts';

/**
 * agent 端到端任务评测（`npm run eval:agent`）。
 *
 * 要回答的问题：**这个 agent 干活到底行不行，代价多大。**
 * 在这之前项目里唯一的数字是"资料库有没有用"（`eval/run.ts`），
 * 而"换个模型强了还是弱了""上下文压缩是正收益还是负收益""verifier 值不值那几步"
 * 全靠感觉——这些恰恰是最该有数字的地方。
 *
 * 每条任务 = 一个跑不过的临时工作区 + 一句话。判定跑测试，客观且不花钱。
 * 三个核心指标：**通过率 / 平均步数 / token 成本**。
 * 步数和 token 要跟通过率一起看：一个通过率高但步数翻倍的改动很可能是负收益。
 *
 * 用法：
 *   npm run eval:agent                    # 全跑一遍
 *   npm run eval:agent -- --only T1,T3    # 挑几条
 *   npm run eval:agent -- --repeat 3      # 同题跑 3 次，看稳定性（agent 的方差很大）
 *   npm run eval:agent -- --model GLM-5.2 # 换模型跑同一套任务
 *   npm run eval:agent -- --keep          # 保留失败任务的工作区，用来复查它到底改了什么
 *
 *   # 只差一个开关跑两组，差值就是这个开关的收益。孤立的"通过率 62%"说明不了任何设计选择：
 *   npm run eval:agent -- --sweep GB_VERIFY_RETRY=0,1,2 --repeat 3
 *   npm run eval:agent -- --sweep GB_PRUNE=0,1          # 削工具输出到底是正收益还是负收益
 *
 * 审批：confirm 自动放行，**dangerous 不放行**。评测里没有人在旁边点确认，
 * 但也不能把 `GB_APPROVE=all` 当默认——那样评测出来的就是"没有安全边界的 agent"，
 * 跟实际交付给用户的不是同一个东西。
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// 这些必须在 buildApp 之前设好——app.ts 在构造时读环境变量
process.env.GB_MEM_PERSIST = '0';
process.env.GB_KB = '0';
process.env.GB_LLM_QUIET = '1';
// 会话日志集中放到仓库里，不散落在临时工作区（跑完就删，日志会跟着没）
process.env.GB_SESSIONS_DIR ??= path.resolve('eval', 'agent-sessions');

const wantModel = arg('model');
if (wantModel) process.env.GLASSBOX_MODEL_NAME = wantModel;

const { buildApp, pickLlm } = await import('../app.ts');

const setPath = arg('tasks') ?? path.join('eval', 'agent-tasks.json');
const set = JSON.parse(fs.readFileSync(setPath, 'utf8')) as TaskSet;
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const tasks: AgentTask[] = only?.length ? set.tasks.filter((t) => only.includes(t.id)) : set.tasks;
if (!tasks.length) {
  console.error(`没有可跑的任务（--only ${only?.join(',')} 没匹配上任何 id）`);
  process.exit(1);
}
const repeat = Math.max(1, Number(arg('repeat') ?? 1));
const keep = has('keep');
const sweep = parseSweep(arg('sweep'));
/** 要跑几组。没有 --sweep 就是一组，标签 base */
const arms: { label: string; env?: [string, string] }[] = sweep
  ? sweep.values.map((v) => ({ label: `${sweep.key}=${v}`, env: [sweep.key, v] as [string, string] }))
  : [{ label: 'base' }];
const { label } = pickLlm();

/** 在任务工作区里把这些话依次说完，收指标。多轮共用一个 session，历史才会累积 */
async function ask(workspace: string, prompts: readonly string[]): Promise<ReturnType<typeof turnMetricsOf>> {
  const app = buildApp({
    workspace,
    // confirm 放行（要写文件、要跑测试），dangerous 不放行
    approver: new AutoApprover({ approveConfirm: true, approveDangerous: false }),
  });
  const events: WireEvent[] = [];
  app.wire.subscribe((ev) => events.push(ev));
  app.init();
  for (const p of prompts) await app.session.ask(p);
  return turnMetricsOf(events, app.journal.sessionId);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-agent-eval-'));

console.log(
  `任务集 ${set.name} · ${tasks.length} 条${repeat > 1 ? ` × ${repeat} 次` : ''}` +
    `${arms.length > 1 ? ` × ${arms.length} 组` : ''} · 模型 ${label}`,
);
if (sweep) console.log(`扫描: ${arms.map((a) => a.label).join(' / ')}（只差这一个开关）`);
console.log(`任务工作区根目录: ${root}${keep ? '（--keep：失败的不删）' : ''}`);
console.log(`会话日志目录: ${process.env.GB_SESSIONS_DIR}\n`);

/** 每组一张 taskId -> 多次运行 的表 */
const byArm = new Map<string, Map<string, TaskRun[]>>();

for (const armDef of arms) {
  // 开关要在 buildApp 之前设好：Loop / Compactor 都是在构造时读环境变量的
  if (armDef.env) process.env[armDef.env[0]] = armDef.env[1];
  if (arms.length > 1) console.log(`## 组 ${armDef.label}`);
  const runs = new Map<string, TaskRun[]>();
  for (const t of tasks) {
    process.stdout.write(`[${t.id}] ${t.title} … `);
    const list: TaskRun[] = [];
    for (let i = 0; i < repeat; i++) list.push(await runTask(t, { root, ask }));
    runs.set(t.id, list);
    const steps = Math.round(list.reduce((n, r) => n + r.steps, 0) / list.length);
    console.log(`${passCell(list)} · ${steps} 步`);
    const failed = list.find((r) => !r.passed);
    if (failed?.detail) console.log(`      ${failed.detail.split('\n').slice(-3).join(' / ')}`);
  }
  byArm.set(armDef.label, runs);
  if (arms.length > 1) console.log('');
}

const summaries = arms.map((a) => ({ label: a.label, sum: summarizeTasks(tasks, byArm.get(a.label)!) }));

console.log('\n## 逐条明细\n');
for (const t of tasks) {
  const cells = summaries.map(({ label: l }) => {
    const list = byArm.get(l)!.get(t.id) ?? [];
    const steps = list.length ? (list.reduce((n, r) => n + r.steps, 0) / list.length).toFixed(1) : '—';
    return arms.length > 1 ? `${l}: ${passCell(list)}/${steps}步` : `${passCell(list)} · 平均 ${steps} 步`;
  });
  console.log(`- ${t.id} ${t.title}（${t.dimension}）: ${cells.join(' | ')}`);
}

console.log('\n## 汇总\n');
for (const { label: l, sum } of summaries) {
  console.log(arms.length > 1 ? `### 组 ${l}` : '');
  console.log(`- 通过率: ${pct(sum.passRate)}（${sum.runCount} 次运行）`);
  if (sum.constraintRate !== undefined) {
    console.log(`- 早期约束存活率: ${pct(sum.constraintRate)}（多轮任务；它掉下来就是压缩把早期规矩吃了）`);
  }
  console.log(`- 每次都过 / 每次都不过: ${sum.alwaysPass} / ${sum.neverPass}（中间那些是不稳定的）`);
  console.log(`- 改了冻结文件而失败: ${sum.frozenFails} 次`);
  console.log(`- 平均步数: ${num(sum.avgSteps, 1)}`);
  console.log(`- 平均耗时: ${num(sum.avgWallMs)} ms`);
  console.log(`- 平均 prompt / completion token: ${num(sum.avgPromptTokens)} / ${num(sum.avgCompletionTokens)}`);
  console.log(`- 前缀缓存命中: ${num(sum.avgCachedTokens)} tok，命中率 ${pct(sum.cacheHitRate)}`);
}

// 多组时把差值直接算出来：读者要的是"第二轮值不值那些 token"，不该自己拿计算器减
if (summaries.length > 1) {
  const base = summaries[0];
  console.log(`\n## 相对 ${base.label} 的差值\n`);
  for (const { label: l, sum } of summaries.slice(1)) {
    const dPass = (sum.passRate - base.sum.passRate) * 100;
    const dSteps = sum.avgSteps - base.sum.avgSteps;
    const dPrompt = (sum.avgPromptTokens ?? 0) - (base.sum.avgPromptTokens ?? 0);
    const sign = (n: number, digits = 1): string => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
    const dCon =
      sum.constraintRate !== undefined && base.sum.constraintRate !== undefined
        ? ` · 约束存活 ${sign((sum.constraintRate - base.sum.constraintRate) * 100)} 个百分点`
        : '';
    console.log(
      `- ${l}: 通过率 ${sign(dPass)} 个百分点${dCon} · 步数 ${sign(dSteps)} · prompt token ${sign(dPrompt, 0)}`,
    );
  }
  console.log('\n注意：通过率涨一点而步数/token 明显上升，很可能是负收益。样本小时先加 --repeat 再看结论。');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('eval', 'agent-runs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${stamp}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      set: set.name,
      model: label,
      repeat,
      ts: Date.now(),
      ...(sweep ? { sweep } : {}),
      arms: summaries.map(({ label: l, sum }) => ({
        arm: l,
        summary: sum,
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, runs: byArm.get(l)!.get(t.id) })),
      })),
    },
    null,
    2,
  ),
);
console.log(`\n明细已写入 ${outFile}`);

// 全过的工作区没有复查价值，删掉；--keep 时整个根目录都留着
if (!keep) fs.rmSync(root, { recursive: true, force: true });
else console.log(`任务工作区保留在 ${root}`);
