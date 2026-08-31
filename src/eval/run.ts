import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoApprover } from '../engine/approval.ts';
import type { WireEvent } from '../engine/types.ts';
import type { Llm } from '../engine/loop.ts';
import {
  cellOf,
  citesSource,
  countHits,
  judgeCellOf,
  looksRefused,
  metricsOf,
  num,
  parseJudge,
  pct,
  questionOf,
  summarize,
  turnsOf,
  type Arm,
  type CaseSet,
  type EvalCase,
  type RunMetrics,
} from './core.ts';

/**
 * 资料库 A/B 评测（opt-21）。
 *
 * 要回答的只有一个问题：**资料库到底有没有用，代价多大。**
 * 在这之前所有检索参数（perDoc / 相对阈值 / 上文补全 / 预算）都是拍出来的，
 * 改完只能凭感觉说「好像准了」。这个 runner 给出数字。
 *
 * 做法：同一批问题、同一份代码，跑两遍——
 *   实验组 kb  ：正常跑（资料库注入 + kb_* 工具可用）
 *   对照组 nokb：GB_KB=0，资料库整体关掉
 * 只有这一个变量不同，差值就是资料库的贡献。
 *
 * 记忆被关掉（GB_MEM_PERSIST=0，不加载任何历史原子）：
 * 否则「以后叫我主人」「数据库问题用英文」这类记忆会同时影响两组，把信号搅浑。
 * 会话日志写到 .glassbox/eval-sessions/，不混进正常会话。
 *
 * 用法：
 *   npm run eval -- --isolate               # 主实验：干净工作区
 *   npm run eval -- --isolate --model GLM-5.2   # 换模型跑同一套用例
 *   npm run eval -- --isolate --repeat 3    # 同题跑 3 次，看评分波动
 *   npm run eval -- --only F1,P1            # 挑几条
 *   npm run eval -- --judge 0               # 不叫模型评分，省一半调用
 *
 * 为什么需要 --isolate：不隔离时对照组会用 grep/read_file 在仓库里翻到
 * .glassbox/kb/raw/ 下的原文，于是「没有资料库」也能答对，测出来的就不是知识有无，
 * 而是「注入 vs 自己翻文件」。两种跑法各有意义，但要分清在测什么。
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 干净工作区：临时目录 + 一份资料库拷贝，别的什么都没有 */
function isolatedWorkspace(from: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-eval-ws-'));
  const src = path.join(from, '.glassbox', 'kb');
  if (!fs.existsSync(src)) throw new Error(`${src} 不存在，隔离模式没有资料可测`);
  fs.mkdirSync(path.join(ws, '.glassbox'), { recursive: true });
  fs.cpSync(src, path.join(ws, '.glassbox', 'kb'), { recursive: true });
  return ws;
}

// 这些必须在 buildApp 之前设好——app.ts 在构造时读环境变量
process.env.GB_MEM_PERSIST = '0';
process.env.GB_SESSIONS_DIR ??= path.join('.glassbox', 'eval-sessions');
process.env.GB_LLM_QUIET = '1';
process.env.GB_APPROVE = 'none';

const { buildApp, pickLlm } = await import('../app.ts');

const isolate = has('isolate');
const WORKSPACE = isolate ? isolatedWorkspace(process.cwd()) : process.cwd();


/** 跑一条用例的一个臂：起一个干净的 app，问一句，收指标 */
async function runOne(c: EvalCase, arm: Arm): Promise<RunMetrics> {
  process.env.GB_KB = arm === 'kb' ? '1' : '0';
  const app = buildApp({
    workspace: WORKSPACE,
    approver: new AutoApprover({ approveConfirm: false, approveDangerous: false }),
  });
  const events: WireEvent[] = [];
  app.wire.subscribe((ev) => events.push(ev));
  app.init();

  // 多轮用例按顺序问完，只对最后一轮打分——前几轮是为了给指代句铺上下文
  let answer = '';
  for (const t of turnsOf(c)) {
    const messages = await app.session.ask(t);
    answer = String(messages.at(-1)?.content ?? '');
  }
  const kw = c.expectKeywords ?? [];

  return {
    answer,
    ...metricsOf(events),
    ...(kw.length ? { hits: countHits(answer, kw), total: kw.length } : {}),
    ...(c.negative ? { refused: looksRefused(answer) } : {}),
    citedSource: citesSource(answer),
    sessionId: app.journal.sessionId,
  };
}

const JUDGE_SYSTEM = [
  '你是评分器。给定【问题】【参考答案】【待评回答】，只评「待评回答有没有答到参考答案的要点」。',
  '参考答案是**要点清单，不是上限**：待评回答比它更详细、多给了正确的相关细节，不扣分。',
  '评分：2 = 要点齐全且没有与参考答案矛盾的内容；1 = 部分正确、含糊、或要点不全；',
  '0 = 要点错误、答非所问、或凭空发明了与参考答案冲突的具体数值/名称。',
  '如果参考答案说明「资料里没有」，那么明确表示不知道 / 资料未提及应得 2 分，硬编出具体内容得 0 分。',
  '措辞、语言、详略、格式都不影响分数。',
  '只输出一行，格式严格为：分数|一句话理由',
].join('\n');

async function judge(llm: Llm, c: EvalCase, answer: string): Promise<{ score?: number; reason?: string }> {
  if (!answer.trim()) return { score: 0, reason: '空回答' };
  const out = await llm.complete([
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: `【问题】${questionOf(c)}\n【参考答案】${c.reference ?? '(无)'}\n【待评回答】${answer.slice(0, 4000)}`,
    },
  ]);
  return parseJudge(out.text ?? '');
}

const setPath = arg('cases') ?? path.join('eval', 'kb-cases.json');
const set = JSON.parse(fs.readFileSync(setPath, 'utf8')) as CaseSet;
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const cases = only?.length ? set.cases.filter((c) => only.includes(c.id)) : set.cases;
if (!cases.length) {
  console.error(`没有可跑的用例（--only ${only?.join(',')} 没匹配上任何 id）`);
  process.exit(1);
}
const wantJudge = arg('judge') !== '0';
const repeat = Math.max(1, Number(arg('repeat') ?? 1));
// --model 覆盖模型名（凭证与 baseUrl 仍走 .env 的回退链），方便换模型跑同一套用例
const wantModel = arg('model');
if (wantModel) process.env.GLASSBOX_MODEL_NAME = wantModel;
const { llm, label } = pickLlm();

console.log(
  `评测集 ${set.name} · ${cases.length} 条 × 2 组${repeat > 1 ? ` × ${repeat} 次` : ''} · 模型 ${label} · 评分${wantJudge ? '开' : '关'}`,
);
console.log(`工作区: ${WORKSPACE}${isolate ? '（隔离：只有一份资料库拷贝）' : '（当前仓库：对照组能 grep 到原文）'}`);
console.log(`会话日志目录: ${process.env.GB_SESSIONS_DIR}\n`);

const runs = new Map<string, RunMetrics[]>();
const push = (key: string, r: RunMetrics): void => {
  const list = runs.get(key) ?? [];
  list.push(r);
  runs.set(key, list);
};

for (const c of cases) {
  process.stdout.write(`[${c.id}] ${c.dimension} … `);
  for (let i = 0; i < repeat; i++) {
    // 两组必须分别构造 app（GB_KB 在构造时读），构造是同步的所以不会串环境；
    // 构造完再并发问，省一半墙上时间
    const kbRunP = runOne(c, 'kb');
    const noKbRunP = runOne(c, 'nokb');
    const [kbRun, noKbRun] = await Promise.all([kbRunP, noKbRunP]);

    if (wantJudge) {
      const [jk, jn] = await Promise.all([judge(llm, c, kbRun.answer), judge(llm, c, noKbRun.answer)]);
      kbRun.judgeScore = jk.score;
      kbRun.judgeReason = jk.reason;
      noKbRun.judgeScore = jn.score;
      noKbRun.judgeReason = jn.reason;
    }
    push(`${c.id}:kb`, kbRun);
    push(`${c.id}:nokb`, noKbRun);
  }

  const kbList = runs.get(`${c.id}:kb`) ?? [];
  const noList = runs.get(`${c.id}:nokb`) ?? [];
  console.log(
    `kb=${cellOf(c, kbList)}${judgeCellOf(kbList) && ' ' + judgeCellOf(kbList)}` +
      ` nokb=${cellOf(c, noList)}${judgeCellOf(noList) && ' ' + judgeCellOf(noList)}`,
  );
}

const sumKb = summarize(cases, runs, 'kb');
const sumNo = summarize(cases, runs, 'nokb');

console.log('\n## 逐条明细\n');
console.log('| 用例 | 维度 | 有资料库 | 无资料库 | 注入tok | kb工具 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const c of cases) {
  const a = runs.get(`${c.id}:kb`) ?? [];
  const b = runs.get(`${c.id}:nokb`) ?? [];
  const cell = (list: RunMetrics[]): string => {
    const core = cellOf(c, list);
    const j = judgeCellOf(list);
    return j ? `${core} · ${j}` : core;
  };
  const injected = a.length ? Math.round(a.reduce((n, r) => n + r.injectedTokens, 0) / a.length) : 0;
  const kbTools = a.reduce((n, r) => n + r.kbToolCalls, 0);
  console.log(`| ${c.id} | ${c.dimension} | ${cell(a)} | ${cell(b)} | ${injected} | ${kbTools} |`);
}

console.log('\n## 汇总\n');
console.log('| 指标 | 有资料库 | 无资料库 |');
console.log('| --- | --- | --- |');
console.log(`| 关键词命中率 | ${pct(sumKb.keywordRate)} | ${pct(sumNo.keywordRate)} |`);
console.log(`| 关键词全中率 | ${pct(sumKb.fullHitRate)} | ${pct(sumNo.fullHitRate)} |`);
console.log(`| 负例拒答正确率 | ${pct(sumKb.refusalRate)} | ${pct(sumNo.refusalRate)} |`);
console.log(`| 模型评分均值(0~2) | ${num(sumKb.judgeAvg, 2)} | ${num(sumNo.judgeAvg, 2)} |`);
console.log(`| 评分波动(同题max-min均值) | ${num(sumKb.judgeSpread, 2)} | ${num(sumNo.judgeSpread, 2)} |`);
console.log(`| 标注来源比例 | ${pct(sumKb.citedRate)} | ${pct(sumNo.citedRate)} |`);
console.log(`| 平均注入 token | ${num(sumKb.avgInjectedTokens)} | ${num(sumNo.avgInjectedTokens)} |`);
console.log(`| 平均 prompt token | ${num(sumKb.avgPromptTokens)} | ${num(sumNo.avgPromptTokens)} |`);
console.log(`| 平均 completion token | ${num(sumKb.avgCompletionTokens)} | ${num(sumNo.avgCompletionTokens)} |`);
console.log(`| 平均首 token 延迟 ms | ${num(sumKb.avgTtftMs)} | ${num(sumNo.avgTtftMs)} |`);
console.log(`| 平均回合耗时 ms | ${num(sumKb.avgWallMs)} | ${num(sumNo.avgWallMs)} |`);
console.log(`| kb_* 工具调用次数 | ${sumKb.kbToolCalls} | ${sumNo.kbToolCalls} |`);
console.log(`| 统计运行数 | ${sumKb.runCount} | ${sumNo.runCount} |`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join('eval', 'runs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${stamp}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      set: set.name,
      model: label,
      isolate,
      repeat,
      workspace: WORKSPACE,
      ts: Date.now(),
      judge: wantJudge,
      summary: { kb: sumKb, nokb: sumNo },
      cases: cases.map((c) => ({ ...c, kb: runs.get(`${c.id}:kb`), nokb: runs.get(`${c.id}:nokb`) })),
    },
    null,
    2,
  ),
);
console.log(`\n明细（含完整回答）已写入 ${outFile}`);
