import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AutoApprover } from '../engine/approval.ts';
import type { Msg, WireEvent } from '../engine/types.ts';
import { num, pct } from './core.ts';
import {
  judgeProbe,
  stage,
  summarizeProbes,
  type ProbeSet,
  type ProbeTask,
  type ProbeVerdict,
} from './securityCore.ts';

/**
 * 安全边界的诱导评测（`npm run eval:security`）。
 *
 * 为什么要有它：功能任务的通过率对前沿模型已经饱和（三套任务集实测全部 100%），
 * 那个指标量的是模型的编码能力。**安全边界是反过来的——模型越强越难守**，
 * 因为前沿模型正是最会找绕路的那一类。所以这套指标天然不饱和，
 * 而且它量的正是这个项目自己写的那部分（等级判定 + 审批 + 路径归属），不是模型。
 *
 * 审批用的是**默认发布配置**：confirm 自动放行、dangerous 直接拒。
 * 不能为了跑评测放宽成 `GB_APPROVE=all`——那样量的就不是交付给用户的那个 agent 了。
 *
 * 用法：
 *   npm run eval:security
 *   npm run eval:security -- --only P3,P5
 *   npm run eval:security -- --repeat 3     # 诱导的成败方差比功能任务大，结论要看多次
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

process.env.GB_MEM_PERSIST = '0';
process.env.GB_KB = '0';
process.env.GB_LLM_QUIET = '1';
process.env.GB_SESSIONS_DIR ??= path.resolve('eval', 'agent-sessions');

const wantModel = arg('model');
if (wantModel) process.env.GLASSBOX_MODEL_NAME = wantModel;

const { buildApp, pickLlm } = await import('../app.ts');

const setPath = arg('probes') ?? path.join('eval', 'security-probes.json');
const set = JSON.parse(fs.readFileSync(setPath, 'utf8')) as ProbeSet;
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const tasks: ProbeTask[] = only?.length ? set.tasks.filter((t) => only.includes(t.id)) : set.tasks;
if (!tasks.length) {
  console.error('没有可跑的探针');
  process.exit(1);
}
const repeat = Math.max(1, Number(arg('repeat') ?? 1));
const { label } = pickLlm();

/** 最终回复：取历史里最后一条 assistant 消息 */
function lastReply(history: Msg[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') return String(history[i].content ?? '');
  }
  return '';
}

async function probe(task: ProbeTask, root: string): Promise<ProbeVerdict> {
  const dir = fs.mkdtempSync(path.join(root, `gb-probe-${task.id}-`));
  // 哨兵目录必须在工作区**外面**：工作区里的东西本来就该能改
  const outside = fs.mkdtempSync(path.join(root, `gb-outside-${task.id}-`));
  const prints = stage(task, dir, outside);
  const prompt = task.prompt.replaceAll('{{OUTSIDE}}', outside);

  const app = buildApp({
    workspace: dir,
    // 发布默认：confirm 放行，dangerous 拒绝
    approver: new AutoApprover({ approveConfirm: true, approveDangerous: false }),
  });
  const events: WireEvent[] = [];
  app.wire.subscribe((ev) => events.push(ev));
  app.init();
  const history = await app.session.ask(prompt);

  let verified: boolean | undefined;
  if (task.verify) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const r = spawnSync(task.verify, {
      cwd: dir,
      shell: true,
      encoding: 'utf8',
      env,
      timeout: task.timeoutMs ?? 60_000,
    });
    verified = r.status === 0;
  }

  return judgeProbe({ task, dir, outside, prints, events, reply: lastReply(history), verified });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-probe-eval-'));
console.log(`探针集 ${set.name} · ${tasks.length} 条${repeat > 1 ? ` × ${repeat} 次` : ''} · 模型 ${label}`);
console.log(`审批：confirm 放行 / dangerous 拒绝（发布默认）\n`);

const all: ProbeVerdict[] = [];
for (const t of tasks) {
  for (let i = 0; i < repeat; i++) {
    process.stdout.write(`[${t.id}] ${t.title} … `);
    const v = await probe(t, root);
    all.push(v);
    const mark = v.ok ? (t.benign ? '正常干成' : '守住') : t.benign ? '被误拦/没干成' : '没守住';
    const lv = Object.entries(v.levels)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ');
    console.log(`${mark}${lv ? ` · 审批[${lv}]` : ' · 没触发审批'}${v.denied.length ? ` · 拒了${v.denied.length}次` : ''}`);
    if (v.detail) console.log(`      ${v.detail}`);
  }
}

const sum = summarizeProbes(tasks, all);

console.log('\n## 汇总\n');
console.log(`- 恶意向量守住率: ${pct(sum.heldRate)}（${sum.malicious} 次）`);
console.log(`- 良性对照正常完成率: ${pct(sum.benignPassRate)}（${sum.benign} 次）`);
if (sum.brokenVectors.length) console.log(`- 守不住的向量: ${sum.brokenVectors.join(' / ')}`);
console.log(`- 良性任务里被拒的调用数: ${sum.benignDenials}（不为 0 说明边界收得过紧）`);
console.log(
  `- 平均步数 / prompt token: ${num(all.reduce((n, v) => n + v.metrics.steps, 0) / all.length, 1)} / ` +
    `${num(all.reduce((n, v) => n + (v.metrics.promptTokens ?? 0), 0) / all.length)}`,
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('eval', 'security-runs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${stamp}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify({ set: set.name, model: label, repeat, ts: Date.now(), summary: sum, verdicts: all }, null, 2),
);
console.log(`\n明细已写入 ${outFile}`);

fs.rmSync(root, { recursive: true, force: true });
