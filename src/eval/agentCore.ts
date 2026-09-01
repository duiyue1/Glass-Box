import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WireEvent } from '../engine/types.ts';
import { metricsOf } from './core.ts';

/**
 * agent 端到端任务评测的纯计算部分。
 *
 * 为什么要有这一整套（`eval/run.ts` 已经有一个评测了）：那个测的是**资料库**有没有用，
 * 换句话说测的是"检索"这一个零件。整个 agent 干活行不行——改代码能不能让测试变绿、
 * 要绕几步、花多少 token——一个数字都没有。于是"上下文压缩到底是正收益还是负收益"
 * "换个模型强了还是弱了"只能凭感觉说。
 *
 * 判定方式刻意选了**跑测试**，不是叫模型打分：
 * 编译器和测试框架的判定是客观的、可复现的、不花钱的。
 * 模型评分那套留给"回答质量"这种没法机械判定的东西（见 `core.ts`）。
 *
 * 和 run.ts 分开的理由同 core.ts：run.ts 一加载就会真去问模型，
 * 而"夹具铺得对不对、判定准不准、汇总算得对不对"必须能不花钱单独测。
 */

export interface AgentTask {
  id: string;
  title: string;
  /** 这条任务考的是什么，写进报表方便看哪一类在退步 */
  dimension: string;
  /** 初始工作区：相对路径 -> 文件内容 */
  files: Record<string, string>;
  /**
   * **验收测试，agent 看不到**：跑完之后才写进工作区，然后才跑判定命令。
   *
   * 为什么需要它：`files` 里放验收测试时，测试本身就是一份完整到可以照抄的规格说明——
   * 前沿模型只要把断言翻译成实现就行了。实测（2026-09-01，gpt-5.5）证明了这一点：
   * 基线 6 条和加难 5 条（误导线索 / 约束改动面 / 跨文件 / 真写算法 / 边界覆盖）
   * **全是 100% 通过**。也就是说那样出题量的是"模型会不会写这段代码"，
   * 而不是"这个 agent 会不会干活"。
   *
   * 隐藏之后，规格只以自然语言给在 `prompt` 里，agent 得自己想清楚边界、自己写测试自查。
   * 这才是它和人类工程师面对的同一种局面。
   */
  hidden?: Record<string, string>;
  /** 交给 agent 的话 */
  prompt: string;
  /**
   * 后续轮次。有它就是**多轮任务**：`prompt` 是第 1 轮，这些接在后面，**共用同一个会话**。
   *
   * 为什么要多轮：单回合永远碰不到上下文压缩。项目里最大的一块代码是
   * 压缩 / 削减 / 蒸馏，而它们只在历史长起来之后才动作——单回合评测里
   * 那部分代码等于没跑过，"它到底是正收益还是负收益"也就无从谈起。
   */
  turns?: string[];
  /** 判定命令，在任务工作区里跑；退出码 0 = 通过 */
  verify: string;
  /**
   * **早期约束**的判定命令，和功能判定分开算。
   *
   * 多轮任务真正要问的不是"最后一轮做对了没"，而是"第 2 轮定下的规矩到第 10 轮还守着吗"。
   * 这两件事混进一个通过率里就看不出来了：功能全对而约束丢光，恰恰是上下文被压掉的典型症状。
   */
  constraintVerify?: string;
  /**
   * 不许被改动的文件（相对路径）。
   *
   * 这不是装饰：只要 agent 能改测试文件，"让测试通过"就有一条零成本的作弊路径——
   * 把断言删了。判定命令自己看不出这件事，所以在外面按内容哈希兜住。
   */
  frozen?: string[];
  /** 判定命令超时，默认 60s */
  timeoutMs?: number;
}

export interface TaskSet {
  name: string;
  note?: string;
  tasks: AgentTask[];
}

export interface TaskRun {
  taskId: string;
  passed: boolean;
  /** 没通过的原因：判定命令失败，还是动了不许动的文件 */
  failure?: 'verify' | 'frozen' | 'error';
  /** 早期约束还在不在。只有声明了 constraintVerify 的任务才有 */
  constraintOk?: boolean;
  steps: number;
  wallMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** 命中前缀缓存的输入 token。它决定实际花多少钱，跟 promptTokens 不是一回事 */
  cachedTokens?: number;
  /** 判定命令输出的尾部；失败时用来看是哪条断言炸了 */
  detail?: string;
  sessionId?: string;
}

/** 一个回合跑完之后，从事件流里能榨出来的东西 */
export interface TurnMetrics {
  steps: number;
  wallMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  sessionId?: string;
}

/**
 * 让 agent 在某个工作区里把这些话依次说完（多轮时**必须共用一个会话**，
 * 否则历史不累积、压缩永远不触发，多轮就白设计了）。注入进来是为了让评测的其余部分不依赖真实模型。
 */
export type AskFn = (workspace: string, prompts: readonly string[]) => Promise<TurnMetrics>;

/** 前缀缓存命中量：只有网关报了才有，各条 llm.response 累加 */
export function cachedTokensOf(events: readonly WireEvent[]): number | undefined {
  let cached: number | undefined;
  for (const ev of events) {
    if (ev.type !== 'llm.response') continue;
    const c = ev.response.usage?.cached;
    if (typeof c === 'number') cached = (cached ?? 0) + c;
  }
  return cached;
}

/** 事件流 -> 一个回合的指标。步数、token、耗时都复用 kb 评测那套提取器 */
export function turnMetricsOf(events: readonly WireEvent[], sessionId?: string): TurnMetrics {
  const m = metricsOf(events);
  const cached = cachedTokensOf(events);
  return {
    steps: m.steps,
    wallMs: m.wallMs,
    ...(m.promptTokens !== undefined ? { promptTokens: m.promptTokens } : {}),
    ...(m.completionTokens !== undefined ? { completionTokens: m.completionTokens } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** 把夹具铺进一个空目录。父目录按需创建，所以 `src/a.js` 这种嵌套路径也行 */
export function materialize(dir: string, task: AgentTask): void {
  writeAll(dir, task.files);
}

/** 把隐藏的验收测试铺进去。只在 agent 干完之后调用 */
export function revealHidden(dir: string, task: AgentTask): void {
  writeAll(dir, task.hidden ?? {});
}

function writeAll(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function digest(p: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return 'missing';
  }
}

/** 冻结文件的内容指纹，跑之前采一次、跑完对一次 */
export function freezePrints(dir: string, task: AgentTask): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of task.frozen ?? []) out.set(rel, digest(path.join(dir, rel)));
  return out;
}

/** 跑完之后哪些冻结文件被动过了 */
export function frozenViolations(dir: string, before: Map<string, string>): string[] {
  return [...before.entries()].filter(([rel, hash]) => digest(path.join(dir, rel)) !== hash).map(([rel]) => rel);
}

/** 输出留尾部：测试框架的失败摘要在末尾，只留开头等于什么都没留 */
function tail(s: string, max = 600): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

/** 跑判定命令。退出码 0 才算通过 */
export function runVerify(dir: string, task: AgentTask, command = task.verify): { ok: boolean; detail: string } {
  // 判定命令通常自己就是 `node --test`。如果把父进程的测试上下文继承下去，
  // 子进程会以为自己是某个 test runner 的一部分，改用另一套上报方式、
  // 失败也退 0——于是"任务全过"。实测踩过，必须摘干净。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;

  const r = spawnSync(command, {
    cwd: dir,
    shell: true,
    encoding: 'utf8',
    env,
    timeout: task.timeoutMs ?? 60_000,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.error) return { ok: false, detail: tail(`判定命令没跑起来: ${r.error.message}\n${out}`) };
  if (r.signal) return { ok: false, detail: tail(`判定命令被 ${r.signal} 打断（超时？）\n${out}`) };
  return { ok: r.status === 0, detail: tail(out) };
}

/**
 * 跑一条任务：铺夹具 -> 让 agent 干 -> 补上隐藏的验收测试 -> 跑判定 -> 查冻结文件。
 *
 * 顺序有讲究：判定通过但动了冻结文件，仍然算失败，且失败原因记成 `frozen`——
 * 它和"没做对"是两种完全不同的问题，混在一个通过率里就看不出来了。
 * 冻结指纹在**铺隐藏文件之前**对，否则隐藏文件自己会被算成"被改动"。
 */
export async function runTask(task: AgentTask, opts: { root: string; ask: AskFn }): Promise<TaskRun> {
  const dir = fs.mkdtempSync(path.join(opts.root, `gb-task-${task.id}-`));
  materialize(dir, task);
  const prints = freezePrints(dir, task);

  let m: TurnMetrics;
  try {
    m = await opts.ask(dir, [task.prompt, ...(task.turns ?? [])]);
  } catch (e) {
    return { taskId: task.id, passed: false, failure: 'error', steps: 0, wallMs: 0, detail: (e as Error).message };
  }

  const violated = frozenViolations(dir, prints);
  // 先查冻结、后铺隐藏测试：agent 要是自己建了个同名文件，被隐藏文件覆盖也不冤——
  // 它本来就不该知道这个文件名
  revealHidden(dir, task);
  const v = runVerify(dir, task);
  // 早期约束单独判：功能全对而约束丢光，正是上下文被压掉的典型症状，
  // 混进一个通过率里就看不见了
  const c = task.constraintVerify ? runVerify(dir, task, task.constraintVerify) : undefined;
  const passed = v.ok && violated.length === 0;
  return {
    taskId: task.id,
    passed,
    ...(passed ? {} : { failure: violated.length ? ('frozen' as const) : ('verify' as const) }),
    ...(c ? { constraintOk: c.ok } : {}),
    ...m,
    detail: violated.length
      ? `改动了不许改的文件: ${violated.join(', ')}`
      : c && !c.ok
        ? `功能${v.ok ? '通过' : '未通过'}，但早期约束丢了：${c.detail}`
        : v.detail,
  };
}

export interface TaskSummary {
  /** 通过率：通过的运行数 / 总运行数 */
  passRate: number;
  /**
   * 早期约束存活率：只统计声明了 `constraintVerify` 的运行。
   * 它和 passRate 一起看才有意义——功能全过而这个掉下来，说明压缩把早期的规矩吃掉了。
   */
  constraintRate?: number;
  /** 因为动了冻结文件而失败的运行数（作弊或顺手改坏） */
  frozenFails: number;
  avgSteps: number;
  avgWallMs: number;
  avgPromptTokens?: number;
  avgCompletionTokens?: number;
  avgCachedTokens?: number;
  /** 缓存命中率：cached / prompt。长会话里它直接等于省了多少钱 */
  cacheHitRate?: number;
  runCount: number;
  /** 每次都过的任务数 / 每次都不过的任务数 —— 中间那些就是不稳定的 */
  alwaysPass: number;
  neverPass: number;
}

function mean(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

function defined(xs: (number | undefined)[]): number[] {
  return xs.filter((n): n is number => typeof n === 'number');
}

export function summarizeTasks(tasks: readonly AgentTask[], runs: Map<string, TaskRun[]>): TaskSummary {
  const all = tasks.flatMap((t) => runs.get(t.id) ?? []);
  const prompt = defined(all.map((r) => r.promptTokens));
  const cached = defined(all.map((r) => r.cachedTokens));
  const promptSum = prompt.reduce((a, b) => a + b, 0);
  const lists = tasks.map((t) => runs.get(t.id) ?? []).filter((l) => l.length > 0);

  const avgPrompt = mean(prompt);
  const avgCompletion = mean(defined(all.map((r) => r.completionTokens)));
  const avgCached = mean(cached);
  const withConstraint = all.filter((r) => r.constraintOk !== undefined);

  return {
    passRate: all.length ? all.filter((r) => r.passed).length / all.length : 0,
    ...(withConstraint.length
      ? { constraintRate: withConstraint.filter((r) => r.constraintOk).length / withConstraint.length }
      : {}),
    frozenFails: all.filter((r) => r.failure === 'frozen').length,
    avgSteps: mean(all.map((r) => r.steps)) ?? 0,
    avgWallMs: mean(all.map((r) => r.wallMs)) ?? 0,
    ...(avgPrompt !== undefined ? { avgPromptTokens: avgPrompt } : {}),
    ...(avgCompletion !== undefined ? { avgCompletionTokens: avgCompletion } : {}),
    ...(avgCached !== undefined ? { avgCachedTokens: avgCached } : {}),
    ...(cached.length && promptSum ? { cacheHitRate: cached.reduce((a, b) => a + b, 0) / promptSum } : {}),
    runCount: all.length,
    alwaysPass: lists.filter((l) => l.every((r) => r.passed)).length,
    neverPass: lists.filter((l) => l.every((r) => !r.passed)).length,
  };
}

/** 一条任务的结果摘要：单次「通过」，多次「2/3 通过」 */
export function passCell(list: readonly TaskRun[]): string {
  if (!list.length) return '—';
  const ok = list.filter((r) => r.passed).length;
  if (list.length === 1) return ok ? '通过' : list[0].failure === 'frozen' ? '改了冻结文件' : '未通过';
  return `${ok}/${list.length} 通过`;
}

/**
 * 解析 `--sweep GB_VERIFY_RETRY=0,1,2`。
 *
 * 为什么要有扫描：单跑一遍只能得到"通过率 62%"，那是个孤立数字，说明不了任何一个设计选择划不划算。
 * 同一套任务在同一个模型上跑两组、只差一个开关，差值才是那个开关的收益——
 * 这正是资料库评测（`core.ts` 的 kb/nokb 两臂）已经证明有用的做法，这里把它推广到任意环境变量。
 *
 * 第一个该扫的就是 `GB_VERIFY_RETRY`（verifier 自修轮数，默认 2）：这个 2 是拍出来的，
 * 第二轮到底在修 bug 还是在烧 token，没有任何数字支撑。
 *
 * 格式不合法就返回 undefined（当成没扫描），不抛——评测的入口参数不该让整个跑批崩掉。
 */
export function parseSweep(spec: string | undefined): { key: string; values: string[] } | undefined {
  if (!spec) return undefined;
  const eq = spec.indexOf('=');
  if (eq <= 0) return undefined;
  const key = spec.slice(0, eq).trim();
  const values = spec
    .slice(eq + 1)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (!key || values.length === 0) return undefined;
  return { key, values };
}
