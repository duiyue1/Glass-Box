import path from 'node:path';
import { Wire } from './engine/wire.ts';
import { ToolRegistry } from './engine/toolRegistry.ts';
import { Loop } from './engine/loop.ts';
import { Session } from './engine/session.ts';
import { Compactor } from './engine/compact.ts';
import { llmSummarizer } from './engine/summarize.ts';
import { loadPlugins } from './engine/plugin.ts';
import type { Approver } from './engine/types.ts';
import { AutoApprover, RememberingApprover, rememberedFrom } from './engine/approval.ts';
import { PolicyApprover, readPolicy } from './engine/policy.ts';
import { FakeLlm } from './llm/fakeLlm.ts';
import { RealLlm, resolveModelConfig, resolveCheapModelConfig, DEFAULT_CONTEXT_WINDOW } from './llm/realLlm.ts';
import type { Llm } from './engine/loop.ts';
import { echoTool } from './tools/echo.ts';
import { fsPlugin } from './plugins/fsPlugin.ts';
import { searchPlugin } from './plugins/searchPlugin.ts';
import { shellPlugin } from './plugins/shellPlugin.ts';
import { kbPlugin } from './plugins/kbPlugin.ts';
import { subagentPlugin } from './plugins/subagentPlugin.ts';
import { webPlugin } from './plugins/webPlugin.ts';
import { skillPlugin } from './plugins/skillPlugin.ts';
import { SkillRegistry, DEFAULT_DESC_CHARS } from './skills/registry.ts';
import { skillProvider } from './skills/provider.ts';
import { Memory } from './memory/memory.ts';
import { KbStore, type KbDocMeta } from './kb/store.ts';
import { kbProvider } from './kb/provider.ts';
import { Verifier } from './verify/verifier.ts';
import { PlanStore, formatPlan } from './plan/plan.ts';
import { planProvider } from './plan/planProvider.ts';
import { planPlugin } from './plugins/planPlugin.ts';
import { distillDoc } from './kb/distill.ts';
import { contextualizeDoc } from './kb/context.ts';
import { WikiStore, type WikiTree } from './kb/wikiStore.ts';
import { wikiProvider } from './kb/wikiProvider.ts';
import { needsSummary, summarizePage } from './kb/wikiSummary.ts';
import { buildDocWiki, staleRebuildJobs } from './kb/wikiBuild.ts';
import { auditWiki, pointOf, reviewSample, type AuditPoint, type AuditReport } from './kb/wikiAudit.ts';
import { formatSourceRef, hashSources, parseSourceRef, type WikiPage } from './kb/wiki.ts';
import { buildWikiGraph, wikiImpact, type WikiGraph, type WikiImpactItem } from './kb/wikiGraph.ts';
import { Activity } from './activity/activity.ts';
import { FileBlobStore } from './engine/blobs.ts';
import { Journal, lastSeq, newSessionId, readEvents, type JournalRecord } from './engine/journal.ts';
import { rebuildHistory, rebuildInfo } from './engine/rebuild.ts';
import { connectMcp, type McpStatus } from './mcp/register.ts';

export interface ForkResult {
  sessionId: string;
  /** 分叉点实际落在哪个 seq（目标 seq 之前最后一个完整回合） */
  atSeq: number;
  turns: number;
  messages: number;
}

export interface App {
  wire: Wire;
  session: Session;
  /** 资料库：Web UI 的导入页直接操作它 */
  kb: KbStore;
  /** 当前活动的会话日志（分叉后会指向新的那一份） */
  readonly journal: Journal;
  /** 图片仓库：事件流里只留 blob 引用，原图存这里 */
  blobs: FileBlobStore;
  /**
   * 从某个会话的某一步分叉出新会话，并把当前进程的活动会话切过去。
   * 原会话文件只读不改——这是 append-only 日志的意义。
   */
  fork(fromSessionId: string, seq?: number): ForkResult;
  /**
   * 开一个全新会话：清空对话历史，事件流切到一个新日志文件。
   * 与 fork 的区别是不继承任何上下文，也不站在任何分叉线上。
   */
  newSession(): { sessionId: string; path: string };
  /**
   * 给资料库补蒸馏块（摘要 + 别名）。不传 docId 就把还没蒸馏过的都补上。
   * 需要模型，所以放在 App 上而不是 KbStore 里——store 保持零依赖、可单测。
   */
  distill(docId?: string): Promise<{ done: { id: string; title: string; aliases: number }[]; failed: string[] }>;
  /**
   * 给资料的每一块补「一句话上下文 + 状态」。不传 docId 就把还有块没补的都补上。
   * 一篇一次模型调用（状态判断需要看到全篇），所以也挂在 App 上。
   */
  contextualize(docId?: string): Promise<{
    done: { id: string; title: string; chunks: number; rejected: number; missing: number }[];
    failed: string[];
  }>;
  /** wiki 条目的存储（纯文件，人可读可改） */
  wiki: WikiStore;
  /**
   * 把资料编译成 wiki 条目。不传 docId 就编译全部启用中的资料。
   * `staleOnly` 只重建依据原文已改动的条目（自愈的执行端）。
   * 同样需要模型，所以挂在 App 上。
   */
  buildWiki(
    docId?: string,
    opts?: { staleOnly?: boolean },
  ): Promise<{ pages: { ref: string; title: string; verified: boolean }[]; unverified: number; failed: string[] }>;
  /** 现在有几条条目已过期（面板决定要不要露出「重建过期条目」） */
  staleWikiCount(): number;
  /** 面板用的条目树，stale 判定要拿当前原文块的哈希比，所以由 App 组装 */
  wikiTree(): WikiTree;
  /** 从 Markdown 页面派生统一的页面/来源关系图和完整性问题 */
  wikiGraph(): WikiGraph;
  wikiImpact(start: string, maxDepth?: number): WikiImpactItem[];
  wikiVersions(): import('./kb/wikiStore.ts').WikiVersion[];
  wikiDiff(versionId: number): import('./kb/wikiStore.ts').WikiVersionDiff[];
  wikiRollback(versionId: number): import('./kb/wikiStore.ts').WikiVersion | undefined;
  /**
   * 给条目补摘要 + 别名（模型经常漏写这两样）。不传 ref 就补所有不齐的。
   * 只改这两个字段，不重新生成正文——正文重生成更贵，还可能把已通过校验的换成没通过的。
   */
  summarizeWiki(ref?: string): Promise<{ done: { ref: string; aliases: number }[]; failed: string[] }>;
  /**
   * 质检：五维机械分 + 可选模型抽检（`sample` 条，0 = 不调模型）。
   * 每次都往 `quality.jsonl` 追加一个趋势点。
   */
  auditWiki(opts?: { sample?: number }): Promise<AuditReport>;
  /** 质检历史（默认最近 30 天），趋势图用 */
  wikiQuality(days?: number): AuditPoint[];
  /** 执行插件加载 / skills 广播等“会发事件”的初始化。调用方应先订阅事件再调它。 */
  init(): void;
  /**
   * 连上 `.glassbox/mcp.json` 里声明的外部工具服务器（MCP）。
   *
   * 单独一步而不是塞进 `init()`：MCP 要先握手再 `tools/list` 才知道有哪些工具，
   * 而 `init()` 是同步契约。没有配置文件就立刻返回空数组，零成本。
   * `GB_MCP=0` 整体关掉。
   */
  initMcp(): Promise<McpStatus[]>;
}

/**
 * 沿着分叉链推导记忆屏蔽窗口。
 *
 * 每个分叉出来的会话，它的第一条 session.started 里记着
 * 「从哪个会话的哪一步（ts）分叉」+「分叉发生在什么时候（事件自身的 ts）」，
 * 两者正好圈出「该丢掉的那段时间」。所以窗口不用另外存——从只追加的日志里就能算回来，
 * --resume 一个分叉会话时也能恢复同样的屏蔽效果。
 */
export function forkHiddenRanges(dir: string, sessionId: string, maxDepth = 8): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let id: string | undefined = sessionId;
  for (let i = 0; i < maxDepth && id; i++) {
    const records: JournalRecord[] = readEvents(dir, id);
    const started = records.find((r) => r.ev.type === 'session.started');
    if (!started || started.ev.type !== 'session.started') break;
    const from: { sessionId: string; seq: number; ts?: number } | undefined = started.ev.forkedFrom;
    if (!from?.ts) break;
    out.push({ from: from.ts, to: started.ev.ts });
    id = from.sessionId;
  }
  return out;
}

/** 会话日志与图片仓库的位置（都在 .glassbox 下，已 gitignore） */
export function sessionsDir(workspace: string): string {
  // GB_SESSIONS_DIR：把日志写到别处。评测要跑几十个会话，
  // 混进正常会话里会把侧边栏和轨迹页刷爆，所以给它一个独立目录。
  const override = process.env.GB_SESSIONS_DIR?.trim();
  if (override) return path.isAbsolute(override) ? override : path.join(workspace, override);
  return path.join(workspace, '.glassbox', 'sessions');
}
export function blobsDir(workspace: string): string {
  return path.join(workspace, '.glassbox', 'blobs');
}
/**
 * 任务计划的追加日志目录。
 * **不能放进 sessions 目录**：那里的 *.jsonl 被 listSessions 当成会话枚举，
 * `<id>.plan.jsonl` 会被解析成非法会话 id 并抛错（实测把 Web 服务整个搞挂过）。
 */
export function plansDir(workspace: string): string {
  return path.join(workspace, '.glassbox', 'plans');
}
export function planFile(workspace: string, sessionId: string): string {
  return path.join(plansDir(workspace), `${sessionId}.jsonl`);
}

// 尝试加载工作区下的 .env（存放模型凭证），失败则忽略
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  // 没有 .env 就用现有环境变量
}

/**
 * 选择模型实现：
 * - GB_LLM=fake         -> 强制假模型（零凭证演示）
 * - GB_LLM=real 或配了 key -> 真实模型（RealLlm，OpenAI 兼容）
 * - 否则默认假模型
 * 换模型只影响这里；引擎 / 工具 / 审批 / 记忆均不改动。
 */
export function pickLlm(): { llm: Llm; label: string } {
  const mode = process.env.GB_LLM;
  const cfg = resolveModelConfig();
  if (mode !== 'fake' && (mode === 'real' || cfg.apiKey)) {
    if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
      console.error('[Glass-Box] 缺少模型配置（baseUrl/model/apiKey），回退到 FakeLlm');
      return { llm: new FakeLlm(), label: 'FakeLlm' };
    }
    return { llm: new RealLlm(cfg), label: `RealLlm(${cfg.model})` };
  }
  return { llm: new FakeLlm(), label: 'FakeLlm' };
}

/**
 * 便宜模型：只给「没有共享前缀可吃」的辅助调用用（目前是资料库检索改写）。
 *
 * 没配 `GLASSBOX_MODEL_CHEAP_NAME` 就原样返回主模型 —— 调用点因此不需要写任何
 * 分支判断，也就不会出现"忘了处理没配的情况"。
 * 主模型是 FakeLlm 时也不切：那是零凭证演示，切过去等于凭空要求凭证。
 *
 * 刻意**不**用在对话压缩上，原因见 `resolveCheapModelConfig` 的注释
 * （压缩是故意复用主模型来命中前缀缓存的，换模型反而更贵）。
 */
export function pickCheapLlm(main: Llm): { llm: Llm; label?: string } {
  if (main instanceof FakeLlm) return { llm: main };
  const cfg = resolveCheapModelConfig();
  if (!cfg) return { llm: main };
  return { llm: new RealLlm(cfg), label: `RealLlm(${cfg.model})` };
}

/** 窗口用到这个比例就压缩（对齐 dsh 的 thresholdRatio 默认值） */
const DEFAULT_COMPACT_RATIO = 0.8;
/** 保留最近这么大一段原样不动（对齐 dsh 的 retainRatio 默认值） */
const DEFAULT_RETAIN_RATIO = 0.16;

export interface BudgetSpec {
  /** 超过它就压缩 */
  budget: number;
  /** 压缩时按 token 保留最近多少；绝对值模式下不给，退回按条数保留 */
  retainTokens?: number;
  /**
   * 保留区占「可用空间」的比例 = `GB_RETAIN_RATIO / GB_COMPACT_RATIO`。
   * 压缩器用它而不是用绝对 token：回合内可用空间要减掉系统提示与注入，是变的。
   */
  retainRatio?: number;
  /** 这个预算是怎么算出来的，打给使用者看 */
  source: string;
}

/**
 * 解析上下文预算。两种模式：
 * - **比例模式（默认）**：阈值 = 模型窗口 × `GB_COMPACT_RATIO`，保留 = 窗口 × `GB_RETAIN_RATIO`。
 *   绝对值写死没法跟着模型走：同一个数字对 8k 窗口是"永不压缩"，对 200k 窗口是"每回合都压"。
 * - **绝对值模式**：显式给了 `GB_BUDGET` 就用它，并退回按条数保留。演示要的就是这个——
 *   真窗口下压缩几天也不发生一次，面板上那格永远空着。
 *
 * @param llm 提供窗口大小的模型实现
 * @param override 调用方写死的预算（测试与评测脚本用），优先级最高
 */
export function resolveBudget(llm: Llm, override?: number): BudgetSpec {
  if (override !== undefined) return { budget: override, source: `调用方指定 ${override}` };

  const explicit = process.env.GB_BUDGET?.trim();
  if (explicit) {
    const n = Number(explicit);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`GB_BUDGET 必须是正数，收到 "${explicit}"`);
    return { budget: n, source: `GB_BUDGET=${n}（绝对值模式，保留最近 2 条）` };
  }

  const window = llm.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const ratio = ratioOf('GB_COMPACT_RATIO', DEFAULT_COMPACT_RATIO);
  const retainRatio = ratioOf('GB_RETAIN_RATIO', DEFAULT_RETAIN_RATIO);
  // 保留区不能大于等于阈值，否则切点永远算成 0，历史只增不减，一路涨到窗口溢出
  if (retainRatio >= ratio) {
    throw new Error(`GB_RETAIN_RATIO (${retainRatio}) 必须小于 GB_COMPACT_RATIO (${ratio})，否则永远压不动`);
  }
  const budget = Math.floor(window * ratio);
  const retainTokens = Math.floor(window * retainRatio);
  return {
    budget,
    retainTokens,
    // 保留区占可用空间的比例。没有固定开销时 budget × 这个比例 == 窗口 × retainRatio
    retainRatio: retainRatio / ratio,
    source: `窗口 ${window} × ${ratio} = ${budget}，保留最近 ${retainTokens} tok`,
  };
}

/** 读一个 (0, 1] 区间的比例环境变量 */
function ratioOf(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`${name} 必须是 (0, 1] 之间的数，收到 "${raw}"`);
  return n;
}

/** 读一个可选的正整数环境变量，没设或不合法就当没给 */
function numOrUndefined(raw: string | undefined): number | undefined {
  const n = Number(raw?.trim());
  return raw && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 注入总共最多占预算的多少 */
const DEFAULT_INJECT_RATIO = 0.25;
/** 各路注入在注入总配额里的份额。最后一路不受份额限制，前面省下的都归它 */
const INJECT_SHARES = { memory: 0.1, wiki: 0.25 };
/** 各路注入的上限，也就是没有窗口约束时的取值（这三个数字是过去写死的默认值） */
const INJECT_CAPS = { memory: 40, wiki: 240, kb: 800 };

export interface InjectBudget {
  /** 记忆最多注入多少 token */
  memory: number;
  /** 知识目录最多注入多少 token */
  wiki: number;
  /** 资料库正文最多注入多少 token */
  kb: number;
  /** 分配结果说明，打给使用者看 */
  source: string;
}

/**
 * 把注入配额从总预算里分出来。
 *
 * 这三个数字过去是写死的绝对值（40 / 240 / 800），跟窗口毫无关系：窗口 4000 时
 * 它们吃掉四分之一预算，窗口 20 万时又只占千分之五。把系统开销一起过秤之后，
 * 这个问题直接表现成"固定开销已超预算，压对话解决不了"。
 *
 * 比例**只用来往下收紧，不往上放宽**：那三个默认值是调过的、已知够用的，
 * 放大它们没有依据。所以每一路取「按份额分下来的」和「上限」中的小者——
 * 窗口大的时候行为跟以前一字不差，窗口小的时候自动收紧。
 *
 * 领用顺序 = 丢了损失多大 + 能不能靠工具补回来：记忆丢了会重复踩同一个坑；
 * 知识目录是指针，模型得先知道有什么才会去查；资料库正文最贵，而且是唯一能被
 * `kb_search` 主动检索替代的，所以排最后（也因此吃掉前面省下的额度）。
 * 任务计划不参与分配——它由 plan 自己的条数与字数上限兜住，也最不该被挤掉。
 *
 * @param budget 上下文总预算
 * @param byRatio 是否按比例分配。绝对值模式（显式给了 `GB_BUDGET`）下直接用上限：
 * 那条路是给演示用的，预算被故意调得极小，按比例分会把注入压到装不下一块
 */
export function resolveInjectBudget(budget: number, byRatio = true): InjectBudget {
  if (!byRatio) {
    const { memory, wiki, kb } = INJECT_CAPS;
    return { memory, wiki, kb, source: `绝对值模式，用上限：记忆 ${memory} / 目录 ${wiki} / 资料库 ${kb}` };
  }
  const total = Math.floor(budget * ratioOf('GB_INJECT_RATIO', DEFAULT_INJECT_RATIO));
  let left = total;
  const take = (key: 'memory' | 'wiki', env: string): number => {
    const cap = numOrUndefined(process.env[env]) ?? INJECT_CAPS[key];
    const got = Math.max(0, Math.min(cap, Math.floor(total * INJECT_SHARES[key]), left));
    left -= got;
    return got;
  };
  const memory = take('memory', 'GB_MEM_TOKENS');
  const wiki = take('wiki', 'GB_WIKI_TOKENS');
  const kb = Math.max(0, Math.min(numOrUndefined(process.env.GB_KB_TOKENS) ?? INJECT_CAPS.kb, left));
  return {
    memory,
    wiki,
    kb,
    source: `总额 ${total}（预算的 ${(total / budget).toFixed(2)}）→ 记忆 ${memory} / 目录 ${wiki} / 资料库 ${kb}`,
  };
}

/** 技能正文的 token 上限（没有窗口约束时的取值）。目录里只有摘要，正文是按需才取的，所以可以比注入宽 */
const DEFAULT_SKILL_TOKENS = 1500;

/**
 * 技能怎么进上下文。
 * - `catalog`（默认）：只把摘要目录挂进 `skill` 工具的说明，模型判断相关了才调它取正文
 * - `inject`：旧行为，触发词命中就把整篇正文注入本回合（A/B 的对照组）
 * - `off`：既不注册 `skill` 工具也不注入
 */
function resolveSkillMode(): 'catalog' | 'inject' | 'off' {
  const raw = (process.env.GB_SKILL_MODE ?? 'catalog').trim().toLowerCase();
  return raw === 'inject' || raw === 'off' ? raw : 'catalog';
}

/**
 * buildApp：把引擎、插件、skills、审批、会话组装成一个完整应用。
 * 构造阶段不发任何 wire 事件；所有会发事件的初始化都放进返回的 init()，
 * 这样 index.ts（实时订阅）能保证「先订阅、后触发」，事件不丢。
 */
export function buildApp(opts: {
  workspace: string;
  approver?: Approver;
  budget?: number;
  /** 续跑已有会话：日志追加到同一个文件（不传则新建一个会话） */
  resumeSessionId?: string;
  /** 从某个会话的某一步分叉出的新会话 */
  forkedFrom?: { sessionId: string; seq: number; ts?: number };
}): App {
  const workspace = opts.workspace;

  const wire = new Wire();
  const tools = new ToolRegistry();
  tools.register(echoTool);

  // 会话日志 + 图片仓库：先订阅，后面 init() 里第一条事件就是 session.started
  const blobs = new FileBlobStore(blobsDir(workspace));
  const sdir = sessionsDir(workspace);
  const resumed = Boolean(opts.resumeSessionId);
  const sessionId = opts.resumeSessionId ?? newSessionId();
  const journal = new Journal(sdir, sessionId, resumed ? lastSeq(sdir, sessionId) : 0, { lazy: true });
  // 保留取消订阅函数：分叉时要把日志从旧文件切到新文件
  let current = journal;
  let detachJournal = current.attach(wire);

  const skills = new SkillRegistry(path.join(workspace, 'skills'));
  skills.load();

  // 模型和预算要先定下来：注入配额是从总预算里分的，而总预算跟着模型窗口走
  const { llm, label } = pickLlm();
  const { llm: cheapLlm, label: cheapLabel } = pickCheapLlm(llm);
  const { budget, retainRatio, source: budgetSource } = resolveBudget(llm, opts.budget);
  const inject = resolveInjectBudget(budget, retainRatio !== undefined);
  if (process.env.GB_LLM_QUIET !== '1') {
    console.error(`[Glass-Box] 使用模型: ${label}`);
    // 只有真的分层了才提，否则一行"便宜模型 = 主模型"是噪音
    if (cheapLabel) console.error(`[Glass-Box] 辅助调用用便宜模型: ${cheapLabel}（检索改写）`);
    console.error(`[Glass-Box] 上下文预算: ${budgetSource}`);
    console.error(`[Glass-Box] 注入配额: ${inject.source}`);
  }

  // 记忆子系统：挂在事件总线上（监听 turn.start/turn.end 做蒸馏），并作为 ContextProvider 注入
  const persistPath =
    process.env.GB_MEM_PERSIST === '0' ? undefined : path.join(workspace, '.glassbox', 'memory.json');
  const memory = new Memory(
    wire,
    {
      maxItems: Number(process.env.GB_MEM_ITEMS ?? 3),
      maxTokens: inject.memory,
    },
    persistPath,
  );

  // 活动轨迹：同样是纯订阅者，把工具调用聚合成「创建/修改/执行」清单
  new Activity(wire);

  // 资料库：用户从 Web UI 导入的资料，按 Markdown 结构分块 + BM25 检索后按需注入
  const kbDir = path.join(workspace, '.glassbox', 'kb');
  // GB_KB_CTX=0：关掉块级上下文（不进索引、不注入），A/B 时的对照组。
  // GB_KB_CTX_INDEX=1：那句上下文额外进 BM25 语料（默认不进，实测零收益且会扰动排序）
  const kb = new KbStore(kbDir, {
    useContext: process.env.GB_KB_CTX !== '0',
    indexContext: process.env.GB_KB_CTX_INDEX === '1',
  });
  // wiki 是资料库之上的一层：条目按普通 .md 存在 kb/wiki/ 下，不进 index.json
  const wiki = new WikiStore(path.join(kbDir, 'wiki'));

  /**
   * 条目的 stale 判定：拿它声明的依据块，现算一次哈希，跟 frontmatter 里存的比。
   * 原文改过（version+1 会重新切块）→ 哈希不一致 → 条目在说过期的话。
   *
   * 定义在这么前面是因为**注入路径也要用它**（wikiBudget.isStale）：
   * 过期以前只影响质检报告和面板红点，注入照旧当权威给模型。
   */
  const sourceHashNow = (refs: readonly string[]): string | undefined => {
    const texts: string[] = [];
    for (const r of refs) {
      const sr = parseSourceRef(r);
      if (!sr) return undefined;
      const chunk = kb.chunksOf(sr.docId).find((c) => c.index === sr.index);
      if (!chunk) return undefined;
      texts.push(chunk.text);
    }
    return hashSources(texts);
  };
  /** 没记哈希的老条目不算过期（无从判断）；依据块被删到解析不出来算过期 */
  const isStalePage = (p: WikiPage): boolean =>
    Boolean(p.sourceHash) && sourceHashNow(p.sources) !== p.sourceHash;

  // GB_KB=0：一键关掉资料库（既不注入，也不注册 kb_* 工具）。
  // 这是 A/B 评测的对照组开关——「有资料库 / 没资料库」必须是同一份代码的两种跑法，
  // 否则比出来的差异说不清是资料库带来的还是别的改动带来的。
  const kbOn = process.env.GB_KB !== '0';
  const kbBudget = {
    maxItems: Number(process.env.GB_KB_ITEMS ?? 6),
    maxTokens: inject.kb,
    // 一篇文档最多贡献 3 块，免得长文档把预算吃光
    perDoc: Number(process.env.GB_KB_PER_DOC ?? 3),
    // 低于最高分 30% 的命中当作没命中（BM25 沾一个词就 >0）
    minScoreRatio: Number(process.env.GB_KB_MIN_RATIO ?? 0.3),
    withNeighbor: process.env.GB_KB_NEIGHBOR !== '0',
    // 蒸馏桥：digest（摘要+别名）命中时给同文档正文块加分。GB_KB_DIGEST=0 关掉当对照组
    digestBoost: process.env.GB_KB_DIGEST === '0' ? 0 : Number(process.env.GB_KB_DIGEST_BOOST ?? 0.6),
  };
  // 知识目录：每回合注入一份「有哪些条目」的清单（不检索，给指针）。
  // GB_WIKI=0 关掉——和 GB_KB 一样是对照组开关。资料库关了它也没有意义，所以跟着 kbOn。
  const wikiOn = kbOn && process.env.GB_WIKI !== '0';
  const wikiBudget = {
    maxItems: Number(process.env.GB_WIKI_ITEMS ?? 20),
    maxTokens: inject.wiki,
    isStale: isStalePage,
  };

  // 任务计划：模型自己维护的"分几步、做到第几步"清单，建了之后每回合注入。
  // 不强制——短任务不建计划就零成本。GB_PLAN=0 关掉（对照组：只剩 maxSteps 这个刹车）。
  // 日志按会话存（放在 plans/，不能混进 sessions/：那里的 *.jsonl 会被当成会话枚举）：
  // 续跑同一个会话能接着用，分叉出的新会话不继承旧计划（换了条线就该重新规划）。
  const planOn = process.env.GB_PLAN !== '0';
  const plan = new PlanStore(planFile(workspace, sessionId));

  // 技能：目录只有摘要，正文按需加载（见 skills/registry.ts 顶上的说明）。
  // 正文上限同时受绝对值和预算比例约束——"绝对值与窗口无关"这个病 opt-32/33 已经修过两次了，
  // 别在技能这里再种一遍。
  const skillMode = resolveSkillMode();
  const skillTokens = Math.max(
    1,
    Math.min(
      numOrUndefined(process.env.GB_SKILL_TOKENS) ?? DEFAULT_SKILL_TOKENS,
      Math.floor(budget * ratioOf('GB_SKILL_RATIO', 0.3)),
    ),
  );
  const skillDescChars = numOrUndefined(process.env.GB_SKILL_DESC_CHARS) ?? DEFAULT_DESC_CHARS;

  // 「始终允许」记忆：包在调用方给的审批者外面。
  // 续跑 / 分叉时从会话日志里把记忆还原回来——`approval.decision` 事件本来就带着当时的
  // 完整 request，不需要另存一份记忆文件（见 engine/approval.ts 的 rememberedFrom）。
  const baseApprover =
    opts.approver ?? new AutoApprover({ approveConfirm: true, approveDangerous: false });
  const rememberedKeys = opts.resumeSessionId
    ? rememberedFrom(readEvents(sdir, opts.resumeSessionId))
    : opts.forkedFrom
      ? rememberedFrom(readEvents(sdir, opts.forkedFrom.sessionId, opts.forkedFrom.seq))
      : [];
  if (rememberedKeys.length && process.env.GB_LLM_QUIET !== '1') {
    console.error(`[Glass-Box] 恢复审批记忆 ${rememberedKeys.length} 条：${rememberedKeys.join(', ')}`);
  }
  const approver = new RememberingApprover(baseApprover, rememberedKeys);
  /**
   * 预先允许（`.glassbox/policy.json`）包在最外面：
   * 策略是"事先声明的"，会话记忆是"临时答出来的"，前者先判。
   *
   * 读取错误一定要打印出来。一条写错的安全规则静默失效，比根本没有配置更危险——
   * 用户以为自己声明了边界，实际什么都没生效（或者反过来，以为没生效其实生效了）。
   */
  const policy = readPolicy(workspace);
  for (const err of policy.errors) console.error(`[Glass-Box] policy.json: ${err}`);
  if (policy.rules.length && process.env.GB_LLM_QUIET !== '1') {
    console.error(`[Glass-Box] 预先允许 ${policy.rules.length} 条（.glassbox/policy.json）`);
  }
  // 审批发生在某个回合内，但 Approver 的接口只有 request，拿不到 turnId。
  // 跟着事件流记一下最近的回合号：够用，且不用为一条审计事件去改 Approver 接口。
  let lastTurnId = '';
  wire.subscribe((e) => {
    if (e.type === 'turn.start') lastTurnId = e.turnId;
  });
  const gatedApprover = policy.rules.length
    ? new PolicyApprover(approver, policy.rules, (rule, request) => {
        wire.emit({ type: 'approval.policy', turnId: lastTurnId, request, rule, ts: Date.now() });
      })
    : approver;
  // 压缩器由 Loop 和 Session 共用：同一套保留规则，两个入口
  // （Loop 在发请求前压，那里才看得见注入与系统开销；Session 在回合之间压）
  const compactor = new Compactor(wire, {
    // 比例模式下按「可用空间的百分之多少」保留；绝对值模式（演示）不给，退回保留最近 2 条
    retainRatio,
    keepRecent: 2,
    // 压缩时把计划一起带进摘要：否则"干到哪儿了"会被压掉，下一回合模型只能重新摸索
    planSnapshot: planOn ? () => formatPlan(plan.list()) : undefined,
    // 压缩第一级：工具输出超过这么多字就掐掉中间。GB_PRUNE=0 关掉（对照组）
    pruneChars: process.env.GB_PRUNE === '0' ? null : numOrUndefined(process.env.GB_PRUNE_CHARS),
    // 摘要交给模型写（结构化八段）。**默认不开**：实测每次压缩多花 20~50 秒，
    // 而且八段摘要本身很长，压缩比反而从 -55% 掉到 -13%。GB_SUMMARY=1 打开
    summarizer: process.env.GB_SUMMARY === '1' ? llmSummarizer(llm) : undefined,
  });
  const loop = new Loop(wire, tools, llm, gatedApprover, {
    providers: [
      ...(skillMode === 'off'
        ? []
        : [skillProvider(skills, { mode: skillMode, maxTokens: skillTokens, wire })]),
      memory.provider(),
      ...(kbOn
        ? [
            kbProvider(kb, wire, kbBudget, {
              // 检索改写要调模型。这里用便宜模型（配了才有，否则就是主模型）：
              // 改写自带系统提示、输入只有几百 token，和主对话没有共同前缀，
              // 没有前缀缓存可损失，换便宜模型基本等于白省。
              llm: cheapLlm,
              maxRewrites: Number(process.env.GB_KB_REWRITE ?? 1),
              minTop1: Number(process.env.GB_KB_MIN_TOP1 ?? 0),
            }),
          ]
        : []),
      ...(wikiOn ? [wikiProvider(wiki, wire, wikiBudget)] : []),
      ...(planOn ? [planProvider(plan)] : []),
    ],
    budget,
    blobs,
    compactor,
    // 自动验证：本回合动过文件就在收尾前跑一次项目自己的检查（npm run test/typecheck…）。
    // 命令从 package.json / .glassbox/verify.json 探测，**不由模型指定**。GB_VERIFY=0 关掉
    verifier: process.env.GB_VERIFY === '0' ? undefined : new Verifier(workspace, wire),
  });
  const session = new Session(loop, wire, budget, 2, { compactor });

  const init = () => {
    const startedAt = Date.now();
    wire.emit({
      type: 'session.started',
      sessionId: current.sessionId,
      path: current.path,
      resumed,
      forkedFrom: opts.forkedFrom,
      ts: startedAt,
    });
    loadPlugins(
      [
        fsPlugin(),
        searchPlugin(),
        shellPlugin(),
        webPlugin(),
        // 技能：只有目录模式才注册 `skill` 工具（inject 模式靠注入，off 模式什么都不给）
        ...(skillMode === 'catalog'
          ? [skillPlugin(skills, { descChars: skillDescChars, maxTokens: skillTokens })]
          : []),
        // 资料库既被动注入，也作为工具让模型主动查（kb_search / kb_read / kb_answer）
        ...(kbOn ? [kbPlugin(kb, kbBudget, llm, wikiOn ? wiki : undefined)] : []),
        ...(planOn
          ? [
              planPlugin(plan, (op, res) =>
                wire.emit({
                  type: 'plan.updated',
                  op,
                  ok: res.ok,
                  message: res.message,
                  items: res.items,
                  ts: Date.now(),
                }),
              ),
            ]
          : []),
        subagentPlugin(workspace, llm, gatedApprover),
      ],
      { tools, wire, workspace },
    );
    wire.emit({ type: 'skill.available', skills: skills.list().map((s) => s.name), ts: Date.now() });
    // 续跑同一个会话时把上次的计划读回来（新会话没有这个文件，load 直接返回）
    if (planOn && resumed) plan.load();
    memory.init();
    // B+ 规则：分叉丢掉的那段时间里产生的 fact/event 不再注入，
    // preference/constraint（说话偏好、禁令）永久生效。
    if (opts.forkedFrom?.ts) memory.hideRange(opts.forkedFrom.ts, startedAt);
    else if (resumed) for (const r of forkHiddenRanges(sdir, sessionId)) memory.hideRange(r.from, r.to);
    if (!kbOn) return;
    kb.load();
    wire.emit({ type: 'kb.loaded', docs: kb.docCount(), chunks: kb.chunkCount(), path: kbDir, ts: Date.now() });
  };

  /**
   * 接上外部 MCP 服务器。一台连不上不影响其他台，失败原因照实打出来
   * （连不上时服务器的 stderr 往往是唯一线索）。
   */
  const initMcp = async (): Promise<McpStatus[]> => {
    if (process.env.GB_MCP === '0') return [];
    let status: McpStatus[];
    let close: () => void;
    try {
      ({ status, close } = await connectMcp({ workspace, tools, wire }));
    } catch (e) {
      console.error(`[Glass-Box] MCP 配置有问题：${(e as Error).message}`);
      return [];
    }
    if (status.length) process.once('exit', close);
    for (const s of status) {
      if (s.ok) {
        if (process.env.GB_LLM_QUIET !== '1') {
          console.error(`[Glass-Box] MCP ${s.server}: 接入 ${s.tools.length} 个工具`);
        }
      } else {
        console.error(
          `[Glass-Box] MCP ${s.server} 接不上：${s.error}` + (s.stderr ? `\n  服务器说: ${s.stderr}` : ''),
        );
      }
    }
    return status;
  };

  /**
   * 分叉：读到目标 seq、重建那一刻的对话，然后把事件流切到一个新的日志文件。
   * 原会话一个字节都不动，所以「从中间岔一条线试试别的问法」不会破坏原始记录。
   */  const fork = (fromSessionId: string, seq?: number): ForkResult => {
    const records = readEvents(sdir, fromSessionId, seq);
    if (!records.length) throw new Error(`读不到会话 ${fromSessionId}`);
    const info = rebuildInfo(records);
    const history = rebuildHistory(records, blobs);

    detachJournal();
    current = new Journal(sdir, newSessionId(), 0, { lazy: true });
    detachJournal = current.attach(wire);
    session.restore(history);
    // 计划跟着对话一起回到分叉那一刻：不这样做的话，分叉出来的会话看着有 22 条历史、
    // 却是个空计划，模型只能推倒重建一份新清单，原来干完的步骤全白干（实测踩过）。
    // 用 atTs 切片，取的是"那一刻"的计划，不是原会话后来又推进过的样子。
    if (planOn) {
      plan.loadFrom(planFile(workspace, fromSessionId), info.atTs);
      plan.switchLog(planFile(workspace, current.sessionId));
      if (plan.list().length) {
        wire.emit({
          type: 'plan.updated',
          op: 'fork',
          ok: true,
          message: `计划继承自 ${fromSessionId}`,
          items: plan.list(),
          ts: Date.now(),
        });
      }
    }
    // 分叉点之后才知道的事实/事件不该再被记忆带回来（说话偏好不受影响）
    const forkedAt = Date.now();
    memory.hideRange(info.atTs, forkedAt);

    wire.emit({
      type: 'session.started',
      sessionId: current.sessionId,
      path: current.path,
      forkedFrom: { sessionId: fromSessionId, seq: info.atSeq, ts: info.atTs },
      ts: forkedAt,
    });
    return { sessionId: current.sessionId, atSeq: info.atSeq, turns: info.turns, messages: history.length };
  };

  /**
   * 新建会话：和分叉共用「切日志」这套动作，只是历史清空、屏蔽窗口也清掉。
   * 记忆本身不清——L1 原子是跨会话资产；清掉的只是分叉带来的时间屏蔽。
   */
  const newSession = (): { sessionId: string; path: string } => {
    detachJournal();
    current = new Journal(sdir, newSessionId(), 0, { lazy: true });
    detachJournal = current.attach(wire);
    session.restore([]);
    memory.clearHidden();
    wire.emit({ type: 'session.started', sessionId: current.sessionId, path: current.path, ts: Date.now() });
    return { sessionId: current.sessionId, path: current.path };
  };

  /**
   * 蒸馏：让模型给每篇资料写一段摘要 + 一串「别人可能怎么问」的别名，
   * 存成一个只参与打分、永不注入的 digest 块。
   * 目的很具体：中文里「抢锁失败」和「获取锁超时」一个共同的 2-gram 都没有，
   * BM25 直接判零分；有了别名当桥，问法对不上也能把真正写着数字的段落拉出来。
   */
  const distill = async (docId?: string) => {
    const targets = docId ? [kb.find(docId)].filter(Boolean) : kb.needsDigest();
    const done: { id: string; title: string; aliases: number }[] = [];
    const failed: string[] = [];
    for (const doc of targets as { id: string; title: string }[]) {
      const text = kb.raw(doc.id);
      if (text === undefined) {
        failed.push(`${doc.title}（读不到原文）`);
        continue;
      }
      try {
        const digest = await distillDoc(llm, doc.title, text);
        kb.setDigest(doc.id, digest);
        done.push({ id: doc.id, title: doc.title, aliases: digest.aliases.length });
      } catch (e) {
        failed.push(`${doc.title}（${(e as Error).message}）`);
      }
    }
    if (done.length) {
      wire.emit({ type: 'kb.loaded', docs: kb.docCount(), chunks: kb.chunkCount(), path: kbDir, ts: Date.now() });
    }
    return { done, failed };
  };

  /**
   * 块级上下文：一篇一次调用，给每块补一句「这段在讲什么」+ 一个状态。
   * 被机械闸拦下的（一句话里编了数字）和模型漏给的都如实报出来，不静默补空值。
   */
  const contextualize = async (docId?: string) => {
    const targets = docId ? [kb.find(docId)].filter(Boolean) : kb.needsContext();
    const done: { id: string; title: string; chunks: number; rejected: number; missing: number }[] = [];
    const failed: string[] = [];
    for (const doc of targets as KbDocMeta[]) {
      const chunks = kb.chunksOf(doc.id);
      if (!chunks.length) {
        failed.push(`${doc.title}（没有可用的分块）`);
        continue;
      }
      try {
        const r = await contextualizeDoc(llm, doc, chunks);
        const n = kb.setContexts(doc.id, r.entries);
        done.push({
          id: doc.id,
          title: doc.title,
          chunks: n,
          rejected: r.rejected.length,
          missing: r.missing.length,
        });
      } catch (e) {
        failed.push(`${doc.title}（${(e as Error).message}）`);
      }
    }
    wire.emit({
      type: 'kb.contextualized',
      docs: done.map((d) => ({ title: d.title, chunks: d.chunks, rejected: d.rejected, missing: d.missing })),
      failed,
      total: kb.contextCount(),
      ts: Date.now(),
    });
    return { done, failed };
  };

  /**
   * 编译 wiki。
   *
   * `staleOnly`：只重建**已过期**的条目（依据原文改过），是自愈的执行端。
   * 过去只有"重建这一页"和"全部重编译"两档：前者要人一页页点，
   * 后者会把没受影响的条目也重新花钱生成一遍。
   *
   * 实现上按「过期条目属于哪篇资料」分组，每篇只重建那几个 ref
   * （`buildDocWiki` 的 `only`）。代价是**结构规划照样要调一次模型**——
   * 页面清单是模型给的，不重新规划就不知道 ref 还在不在。
   */
  const buildWiki = async (docId?: string, opts: { staleOnly?: boolean } = {}) => {
    const activeIds = docId
      ? [kb.find(docId)].filter(Boolean).map((d) => d!.id)
      : kb.list().filter((d) => d.status === 'active').map((d) => d.id);
    const pages: { ref: string; title: string; verified: boolean }[] = [];
    const failed: string[] = [];
    /** 要跑哪几篇、每篇只重建哪几个 ref（不给 only 就是整篇重编译） */
    let jobs: { docId: string; only?: string[] }[];
    if (opts.staleOnly) {
      const r = staleRebuildJobs(wiki.list(), isStalePage, activeIds);
      jobs = r.jobs;
      // 来源资料被归档 / 删掉 / 这次不在范围里：不能悄悄跳过，它仍然在被注入
      for (const ref of r.orphans) failed.push(`${ref}（找不到启用中的来源资料，只能手动处理）`);
    } else {
      jobs = activeIds.map((id) => ({ docId: id }));
    }
    for (const job of jobs) {
      try {
        const r = await buildDocWiki(llm, kb, wiki, job.docId, job.only ? { only: job.only } : {});
        for (const p of r.pages) pages.push({ ref: p.ref, title: p.title, verified: p.verified });
        failed.push(...r.failed);
        // 点名要重建、却既没生成也没报错的：新的页面结构里已经没有这一页了。
        // 这种条目会一直过期下去，必须说出来（按"标注不删"的规矩，不自动删）
        if (job.only) {
          const got = new Set(r.pages.map((p) => p.ref));
          for (const ref of job.only) {
            if (got.has(ref) || r.failed.some((f) => f.startsWith(ref))) continue;
            failed.push(`${ref}（新的页面结构里没有这一页，要整篇重编译或手动删）`);
          }
        }
      } catch (e) {
        failed.push(`${job.docId}（${(e as Error).message}）`);
      }
    }
    const all = wiki.list();
    wiki.snapshot(`${opts.staleOnly ? 'rebuild-stale' : 'build'}: ${pages.length} pages`);
    wiki.writeIndex(all);
    const unverified = pages.filter((p) => !p.verified).length;
    wiki.appendLog(
      `${opts.staleOnly ? '重建过期条目' : '生成'} ${pages.length} 条（未通过校验 ${unverified}）` +
        (failed.length ? `，失败 ${failed.length}：${failed.join('；')}` : '') +
        `，来源 ${jobs.length} 篇`,
    );
    wire.emit({
      type: 'wiki.built',
      pages: pages.map((p) => ({
        ref: p.ref,
        title: p.title,
        type: p.ref.split('/')[0],
        sources: all.find((x) => x.ref === p.ref)?.sources.length ?? 0,
        verified: p.verified,
      })),
      unverified,
      failed,
      docs: jobs.length,
      ts: Date.now(),
    });
    return { pages, unverified, failed };
  };

  /** 现在有几条条目已过期（面板/CLI 决定要不要提示"重建过期条目"） */
  const staleWikiCount = (): number => wiki.list().filter(isStalePage).length;

  /**
   * 一条条目的依据原文块正文。校验和补摘要都要用它，
   * 取不到的块直接跳过（原文被删过）——宁可少给语料，不要拿空串当原文。
   */
  const sourceTextsOf = (refs: readonly string[]): string[] => {
    const out: string[] = [];
    for (const r of refs) {
      const sr = parseSourceRef(r);
      if (!sr) continue;
      const chunk = kb.chunksOf(sr.docId).find((c) => c.index === sr.index);
      if (chunk) out.push(chunk.text);
    }
    return out;
  };

  const summarizeWiki = async (ref?: string) => {
    const all = wiki.list();
    const targets = ref ? all.filter((p) => p.ref === ref) : all.filter(needsSummary);
    if (ref && !targets.length) throw new Error(`没有这条条目: ${ref}`);
    const done: { ref: string; summary: string; aliases: number }[] = [];
    const failed: string[] = [];
    for (const p of targets) {
      try {
        const draft = await summarizePage(llm, p, sourceTextsOf(p.sources));
        // 别名给少了就保留原有的：宁可不动，也不要用更差的一份把已有的覆盖掉
        const aliases = draft.aliases.length >= p.aliases.length ? draft.aliases : p.aliases;
        wiki.write({ ...p, summary: draft.summary, aliases });
        done.push({ ref: p.ref, summary: draft.summary, aliases: aliases.length });
      } catch (e) {
        failed.push(`${p.ref}（${(e as Error).message}）`);
      }
    }
    if (done.length) {
      wiki.snapshot(`summarize: ${done.length} pages`);
      wiki.writeIndex(wiki.list());
    }
    wiki.appendLog(
      `补摘要 ${done.length} 条` + (failed.length ? `，失败 ${failed.length}：${failed.join('；')}` : ''),
    );
    wire.emit({
      type: 'wiki.summarized',
      pages: done.map((d) => ({ ref: d.ref, summary: d.summary, aliases: d.aliases })),
      failed,
      ts: Date.now(),
    });
    return { done: done.map((d) => ({ ref: d.ref, aliases: d.aliases })), failed };
  };

  /**
   * 质检：五维机械分（确定性）+ 可选的模型抽检（会花钱、会抖）。
   * 只有机械分进历史文件和趋势线——抽检分抖动太大，混进趋势会让曲线失真。
   */
  const auditWikiNow = async (opts: { sample?: number } = {}) => {
    const pages = wiki.list();
    // 覆盖率的分母：启用中资料的全部块。归档的资料不该拖低分数
    const allChunks: string[] = [];
    for (const d of kb.list().filter((x) => x.status === 'active')) {
      for (const c of kb.chunksOf(d.id)) allChunks.push(formatSourceRef(d.id, c.index));
    }
    const report = auditWiki(pages, allChunks, isStalePage);
    const n = opts.sample ?? 0;
    if (n > 0 && pages.length) {
      report.sample = await reviewSample(llm, pages, (p) => sourceTextsOf(p.sources), n);
    }
    wiki.appendQuality(pointOf(report));
    wiki.appendLog(
      `质检 综合分 ${report.score}（${report.dims.map((d) => `${d.label} ${d.score}`).join('、')}）` +
        (report.sample ? `；模型抽检 ${report.sample.n} 条均分 ${report.sample.avg}/2` : ''),
    );
    wire.emit({
      type: 'wiki.audited',
      score: report.score,
      pages: report.pages,
      dims: report.dims.map((d) => ({ key: d.key, label: d.label, score: d.score, issues: d.issues.length })),
      sampled: report.sample?.n ?? 0,
      ts: report.ts,
    });
    return report;
  };

  return {
    wire,
    session,
    kb,
    wiki,
    buildWiki,
    staleWikiCount,
    summarizeWiki,
    auditWiki: auditWikiNow,
    wikiQuality: (days?: number) => wiki.qualityHistory(days),
    wikiTree: () => wiki.tree(sourceHashNow),
    wikiGraph: () => buildWikiGraph(wiki.list(), isStalePage),
    wikiImpact: (start: string, maxDepth = 2) => wikiImpact(buildWikiGraph(wiki.list(), isStalePage), start, maxDepth),
    wikiVersions: () => wiki.versions(),
    wikiDiff: (versionId: number) => wiki.diff(versionId),
    wikiRollback: (versionId: number) => wiki.rollback(versionId),
    blobs,
    fork,
    newSession,
    distill,
    contextualize,
    init,
    initMcp,
    get journal() {
      return current;
    },
  };
}

/** 把 "a ;; b ;; c" 拆成多个回合输入 */
export function parseTurns(input: string): string[] {
  return input
    .split(';;')
    .map((s) => s.trim())
    .filter(Boolean);
}
