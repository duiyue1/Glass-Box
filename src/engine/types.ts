// 引擎的核心类型定义。整个 Glass-Box 引擎的“词汇表”都在这里。
// 目标：一眼能看懂 agent 的一个回合里都会流动哪些数据。

/** 一条消息的角色 */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** 对话里的一条消息 */
export interface Msg {
  role: Role;
  content: string;
  /** 当 role 为 'tool' 时，指明这条结果对应哪次工具调用 */
  toolCallId?: string;
  /**
   * 当 role 为 'assistant' 且这一步是在调工具时，带上结构化的调用记录。
   * 原生 tool calling 要求「assistant(带 tool_calls) → tool(带同一个 id)」成对出现，
   * 所以这个字段不是装饰，是协议的一部分。
   */
  toolCalls?: ToolCall[];
  /** 随消息一起发给模型的图片（data URL）。只有多模态模型会真正看到它们。 */
  images?: string[];
}

/** 模型要求调用某个工具 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 工具执行完的结果 */
export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  content: string;
  /** 结构化元信息，供活动轨迹统计（谁创建了什么、改了几行、跑了什么命令） */
  meta?: ToolMeta;
  /** 工具产出的图片（data URL），会随 tool 消息一起交给多模态模型 */
  images?: string[];
}

/** 工具对本次执行的结构化描述（比解析 content 字符串可靠得多） */
export interface ToolMeta {
  action?: 'created' | 'edited' | 'ran' | 'read' | 'searched' | 'delegated' | 'fetched';
  path?: string;
  command?: string;
  /** 联网类工具访问的地址 */
  url?: string;
  added?: number;
  removed?: number;
  /** 本次产出了几张图片 */
  images?: number;
}

/** 工具 run 的返回：人类可读内容 + 可选结构化元信息 */
export interface ToolOutput {
  ok: boolean;
  content: string;
  meta?: ToolMeta;
  /** 图片产出（data URL） */
  images?: string[];
}

/** 活动轨迹里的一行：像 “Created streamGate.ts +51” / “Ran npm test” */
export interface ActivityEntry {
  kind: 'created' | 'edited' | 'ran' | 'read' | 'searched' | 'delegated' | 'fetched';
  /** 中文动作名：创建 / 修改 / 执行 / 读取 / 搜索 / 委派 */
  label: string;
  /** 文件名或命令等主体信息 */
  detail: string;
  added?: number;
  removed?: number;
  ok: boolean;
  ts: number;
}

/** provider 报回来的真实 token 用量（我们自己估的 tokensEst 不是这个） */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  /** 命中前缀缓存的输入 token 数。只有 provider 给了才有——长会话里它决定实际花多少钱 */
  cached?: number;
}

/** 模型（真实的或假的）返回的东西：要么是一段文本，要么是若干工具调用 */
export interface LlmResponse {
  text?: string;
  toolCalls?: ToolCall[];
  /** 这次请求的真实 token 用量（FakeLlm / 不给 usage 的网关就没有） */
  usage?: TokenUsage;
  /**
   * 网关说上下文超过窗口了。这不是普通的调用失败：历史压一段就能继续，
   * 所以要跟别的错误区分开，让会话层去压缩重试，而不是把"失败"当成一句回答。
   */
  overflow?: boolean;
}

/**
 * 操作的风险等级。
 *
 * `deny` 与 `dangerous` 的区别是**能不能被放行**：dangerous 是"很危险，问人"，
 * `GB_APPROVE=all` 或人点"允许"都能过；deny 是"不给过"，不问人、也不受任何放行策略影响。
 * 写 `.git/**`、读凭证文件这类没有任何正当理由的操作走 deny。
 */
export type RiskLevel = 'safe' | 'confirm' | 'dangerous' | 'deny';

/** 对一次工具调用的风险评估结果 */
export interface RiskAssessment {
  level: RiskLevel;
  summary: string;
  reason?: string;
  /** 可选的变更预览（如 edit_file 的 diff），供审批者展示给人看 */
  preview?: string;
  /**
   * 记忆旁路：这次操作即使人答过「始终允许」，也照旧每次重问。
   *
   * 给关键配置文件用（package.json / tsconfig.json / AGENTS.md / .github/ …）：
   * 改它们会改变构建与测试的门槛，或者改变 agent 自己的行为。
   * 尤其是 `package.json`——自动验证的命令就是从它的 scripts 里探测的，
   * 一旦被记进"始终允许"，模型改掉 scripts.test 就等于拿到一条免审批的执行通道。
   */
  noMemory?: boolean;
}

/** 引擎向审批者发出的审批请求（在风险评估基础上补上工具名与参数） */
export interface ApprovalRequest extends RiskAssessment {
  toolName: string;
  /**
   * 本次调用的参数。会话记忆按「工具名 + 首个字符串参数的前两段」记账，所以必须带上；
   * 也让审批日志能回答"当时到底批准了什么"。
   */
  args?: Record<string, unknown>;
}

/**
 * 审批结论。
 * - `allow`  放行这一次
 * - `always` 放行，并且本会话内同类调用不再问（记忆由 RememberingApprover 负责）
 * - `deny`   拒绝
 */
export type ApprovalDecision = 'allow' | 'always' | 'deny';

/**
 * 审批者：决定一次有风险的操作是否放行。
 * 返回 boolean 是旧写法（true=allow / false=deny），仍然支持。
 */
export interface Approver {
  decide(req: ApprovalRequest): Promise<ApprovalDecision | boolean>;
}

/** 把审批者的返回值归一成三态结论 */
export function toDecision(d: ApprovalDecision | boolean): ApprovalDecision {
  return d === true ? 'allow' : d === false ? 'deny' : d;
}

/**
 * 从一个错误里取出「已经吐给用户的那半句话」。
 *
 * 为什么需要这么一个约定：中断和断连时，模型往往已经流出了一段文本——用户在屏幕上看见了，
 * `llm.delta` 事件里也记着，但如果只往历史里塞一句"（已中断）"，那半句话就从对话历史里
 * 消失了：模型下一轮看不见自己刚说过的话，从日志重建的历史也和当时的屏幕对不上。
 * 对一个把"可观测 + 可回放"当卖点的项目来说，这种不一致比丢一段文本更严重。
 *
 * 约定用鸭子类型而不是自定义错误类：provider 在错误对象上挂一个 `partial` 字符串就行，
 * 引擎不需要认识任何具体的 provider（`engine/` 不该 import `llm/`）。
 */
export function partialOf(e: unknown): string {
  if (typeof e !== 'object' || e === null) return '';
  const p = (e as { partial?: unknown }).partial;
  return typeof p === 'string' ? p : '';
}

/**
 * 这次审批能不能进「始终允许」记忆。
 *
 * 两条限制：
 * - 只有 `confirm` 能记。`dangerous` 是高风险操作，一次点头不该换来永久授权。
 * - `noMemory` 旁路（关键配置文件）照旧每次重问。
 */
export function memorable(req: ApprovalRequest): boolean {
  return req.level === 'confirm' && req.noMemory !== true;
}

/** 一条注入到上下文里的内容（来自 skill、记忆等） */
export interface ContextContribution {
  source: string;
  content: string;
  tokensEst: number;
}

/**
 * ContextProvider：按需为“本回合”贡献上下文的东西。
 * Skills、（Step5 的）记忆都是 ContextProvider——命中才注入，省 token。
 */
export interface ContextProvider {
  name: string;
  provide(userText: string): ContextContribution[] | Promise<ContextContribution[]>;
}

/**
 * 工具参数的 JSON Schema —— 就是交给模型的那张「填空表格」。
 * 有了它，参数边界由 API 协议保证，不再靠正则去猜模型写的散文。
 */
export interface ToolSchema {
  type: 'object';
  properties: Record<
    string,
    { type: 'string' | 'number' | 'boolean'; description?: string; enum?: string[] }
  >;
  required?: string[];
}

/** 发给模型的工具声明（与具体厂商协议无关，由各 Llm 实现自行转成自家格式） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: ToolSchema;
}

/** 没有参数的工具用它兜底 */
export const EMPTY_SCHEMA: ToolSchema = { type: 'object', properties: {} };

/**
 * 只读、无副作用工具的风险声明。
 *
 * 为什么必须显式写：`Tool.assess` 的缺省是 **confirm**（安全缺省）。
 * 不写就会每次弹审批——这是刻意的，"忘了写风险评估"过去等于静默拿到免审批执行权。
 * 真正只读的工具用这一行声明自己，代价是一行，换来的是新工具不会漏。
 */
export const safeAssess = (): RiskAssessment => ({ level: 'safe', summary: '只读操作' });

/** 一个可被 agent 调用的工具 */
export interface Tool {
  name: string;
  description: string;
  /** 参数的 JSON Schema。缺省时按「无参数」处理。 */
  parameters?: ToolSchema;
  /**
   * 纯状态工具：不碰文件、不执行命令、不联网，只改引擎自己的一份记录。
   * 这类调用**不计入回合步数上限**——`maxSteps` 是为了拦住"在真实操作里打转"，
   * 而记账占掉干活的工位是本末倒置（实测：12 步里有 5 步花在 task_plan 上，
   * 最后两个 write_file 被挤掉了）。
   */
  free?: boolean;
  /**
   * 只读且可缓存：本回合内同名同参再调一次，直接复用上次结果、不重复执行、不占步数。
   * 任何**非** cacheable 工具成功执行后缓存整体作废（写文件会让 glob/read 的结果过期）。
   *
   * 为什么需要：实测日志里模型会连着发几个等价的 glob（同一个目录换三种写法），
   * 一个回合 12 步里有 4~5 步是重复的，最后真正要写文件时步数已经用完。
   */
  cacheable?: boolean;
  /**
   * 同一批调用里可以和兄弟并发执行，即使它不是 `cacheable`。
   *
   * `cacheable` 顺带表达了"只读且顺序无关"，所以它自动可并行；但有些工具只读性质
   * 不成立（比如 `delegate` 派出去的子 agent 有自己的副作用）却仍然彼此独立。
   * 这个标记就是为它们准备的。
   *
   * 注意并行还有另一道门槛：**这一批一个都不需要审批**。所以可写的 `delegate`
   * （assess 为 confirm）不会走到并行分支——不用在这里为它开特例。
   */
  parallelSafe?: boolean;
  /**
   * 风险评估。**不写 = confirm**（见 `safeAssess` 上的说明），所以只读工具必须
   * 显式写 `assess: safeAssess`。
   *
   * 返回值刻意不允许 `undefined`：语义翻转成"安全缺省"之后，`return undefined`
   * 会被引擎当成 confirm，而写代码的人往往以为它是 safe——`read_file` 就这么把
   * "区内普通读取"悄悄变成了每次弹审批。让编译器把每条分支都逼出来。
   *
   * 风险可以依赖参数——比如写工作区内是 confirm，写 `.git` 是 deny。
   */
  assess?(args: Record<string, unknown>): RiskAssessment;
  /** 执行工具。只关心“做事+返回内容”，toolCallId 由引擎负责回填 */
  run(args: Record<string, unknown>): Promise<ToolOutput> | ToolOutput;
}

/** 一个回合内部的状态机状态 */
export type TurnState = 'idle' | 'thinking' | 'tool_call' | 'tool_result' | 'done';

/**
 * wire 事件：引擎内部发生的每一件事都会以事件形式广播出来。
 * 这条“事件流”就是玻璃盒可观测性的数据来源——后面的 TUI 面板全靠订阅它。
 */
export type WireEvent =
  | {
      type: 'session.started';
      sessionId: string;
      /** 会话日志文件路径 */
      path: string;
      /** 是否续跑一个已有会话（append 到同一个文件） */
      resumed?: boolean;
      /** 从哪个会话的哪一步分叉出来的。ts 是分叉点那个事件的时间，用于还原记忆屏蔽窗口 */
      forkedFrom?: { sessionId: string; seq: number; ts?: number };
      ts: number;
    }
  /** 给会话起个人类可读的名字。只追加、可多次改名，最后一条生效 */
  | { type: 'session.renamed'; sessionId: string; title: string; ts: number }
  | { type: 'turn.start'; turnId: string; userText: string; ts: number }
  | { type: 'state.change'; turnId: string; from: TurnState; to: TurnState; ts: number }
  | { type: 'llm.request'; turnId: string; messages: Msg[]; ts: number }
  | { type: 'llm.delta'; turnId: string; text: string; ts: number }
  | { type: 'llm.response'; turnId: string; response: LlmResponse; ts: number }
  | {
      type: 'tool.call';
      turnId: string;
      call: ToolCall;
      /**
       * 这一批有几个只读调用是**同时**跑的（只有并行批次才有这个字段）。
       * 并行会打乱"谁先跑完"，但事件流仍按模型给的顺序记；
       * 没有这个标记的话，回放时看到的就是一串普通的顺序调用，看不出实际是并发的。
       */
      parallel?: number;
      ts: number;
    }
  | { type: 'tool.result'; turnId: string; result: ToolResult; ts: number }
  | { type: 'approval.request'; turnId: string; request: ApprovalRequest; ts: number }
  | {
      type: 'approval.decision';
      turnId: string;
      request: ApprovalRequest;
      approved: boolean;
      /**
       * 原始结论。`always` 表示人选了"以后同类不再问"——
       * `--resume` 时把会话记忆还原回来，靠的就是重读这个字段，不需要另存一份记忆文件。
       */
      decision?: ApprovalDecision;
      ts: number;
    }
  /**
   * 一次操作因为 `.glassbox/policy.json` 里的预先允许而没有问人。
   *
   * 为什么必须单独发一条：一次没人看见的放行，和没有闸门是一样的。
   * 事件里写明命中了哪条规则（工具 + 参数前缀 + 允许到哪一级 + 为什么加的），
   * 这样"为什么这个命令没问我"事后永远查得到。
   */
  | {
      type: 'approval.policy';
      turnId: string;
      request: ApprovalRequest;
      /** 命中的规则，原样带出来 */
      rule: { tool: string; argPrefix?: string; maxLevel?: string; until?: string; reason?: string };
      ts: number;
    }
  | { type: 'plugin.loaded'; name: string; tools: string[]; ts: number }
  | { type: 'skill.available'; skills: string[]; ts: number }
  /**
   * 某个技能的完整正文进了上下文。
   *
   * 目录里只有摘要，正文什么时候进来、从哪条路进来、有没有被截断，是回放时解释
   * "它凭什么按这套流程干活"的唯一依据。模型看得见的东西必须留下记录。
   *
   * via: tool = 模型自己调 `skill` 工具加载；gesture = 用户 `/名字` 点名直接内联；
   * trigger = 旧的触发词全量注入（`GB_SKILL_MODE=inject` 的对照组）
   */
  | {
      type: 'skill.loaded';
      name: string;
      via: 'tool' | 'gesture' | 'trigger';
      tokensEst: number;
      truncated: boolean;
      ts: number;
    }
  | { type: 'context.injected'; turnId: string; contributions: { source: string; tokensEst: number }[]; ts: number }
  | { type: 'context.usage'; turnId: string; tokens: number; budget: number; messages: number; ts: number }
  | {
      type: 'context.compacted';
      droppedMessages: number;
      tokensBefore: number;
      tokensAfter: number;
      /** 摘要是模型写的（结构化八段）还是机械拼的（只留用户说过的话） */
      byModel?: boolean;
      ts: number;
    }
  /**
   * 削掉了过大的工具输出（压缩的第一级：不调模型、不丢消息）。
   * 模型看到的内容被改写了，所以必须留下事件——否则回放时无从解释它为什么只看到半个文件。
   */
  | { type: 'context.pruned'; prunedMessages: number; charsRemoved: number; ts: number }
  /**
   * 估算的 prompt token 与网关报回来的真实值对照。
   *
   * 这个项目零依赖，用不了真分词器，只能按字符种类分档估。估算准不准过去只能靠猜；
   * 网关的 `usage.prompt` 是免费送上来的真答案，拿它对一下账就有了一个机械指标：
   * 偏差率既能校准估算系数，也能给"预算/压缩这类改动到底有没有用"当尺子。
   */
  | {
      type: 'token.estimate';
      turnId: string;
      /** 我们发请求前估的 */
      estimated: number;
      /** 网关说实际用了多少 prompt token */
      actual: number;
      /** 偏差率：(估算 - 实际) / 实际，正数是高估 */
      drift: number;
      /** 命中前缀缓存的部分（provider 给了才有） */
      cached?: number;
      ts: number;
    }
    | {
      type: 'verify.started';
      turnId: string;
      /** 要执行的命令原文——它凭什么跑这个，必须看得见 */
      cmd: string;
      /** 命令来源：package.json scripts.test / .glassbox/verify.json */
      from: string;
      ts: number;
    }
  | {
      type: 'verify.done';
      turnId: string;
      cmd: string;
      ok: boolean;
      ms: number;
      /** 合并后的输出，已截断 */
      output: string;
      ts: number;
    }
  | {
      type: 'plan.updated';
      /** 这次是哪种操作：steps（重排计划）/ doing / done */
      op: string;
      /** 机械约束有没有放行（比如"已经有一步在做"会被拒） */
      ok: boolean;
      /** 拒绝原因或成功后的一句话——面板上要看得见它为什么被拒 */
      message: string;
      items: { id: number; text: string; status: string }[];
      ts: number;
    }
  | {
      type: 'turn.limit'; turnId: string; steps: number; maxSteps: number; ts: number }
  /**
   * 本回合累计花了多少真实 token。回合结束时发一次（网关报过 usage 才有）。
   *
   * 为什么要单独一个事件：`token.estimate` 是**每次请求**的对账，从来没人把一个回合
   * 加起来看过。而"这个回合花了多少"恰恰是唯一能跟用户直接对话的成本口径。
   * 有没有设上限都发——先让花费可见，再谈可控。
   */
  | {
      type: 'turn.cost';
      turnId: string;
      prompt: number;
      completion: number;
      /** 命中前缀缓存的输入 token（已包含在 prompt 里，便宜但不免费） */
      cached: number;
      /** 这个回合问了模型几次 */
      requests: number;
      /** 当时生效的上限，0 表示不限 */
      budget: number;
      ts: number;
    }
  /**
   * 累计花费撞上上限，本回合被停。
   *
   * 和 `turn.limit` 分开发：一个是"在工具里绕圈"，一个是"步子不多但每步很贵"。
   * 事后归因时这两种失败模式完全不同，不能混成一个信号。
   */
  | { type: 'turn.budget'; turnId: string; spent: number; budget: number; ts: number }
  /**
   * 用户把这个回合掐了。
   *
   * 中断只在「步与步之间」生效：已经在跑的工具拦不住（工具不接 signal），
   * 但绝不会在「assistant 的 tool_calls 已进历史、tool 结果还没进去」的时刻退出——
   * 那样对话就不合法了，下一回合直接被网关拒。所以中断也是一次正常收尾，有 turn.end。
   */
  | { type: 'turn.aborted'; turnId: string; steps: number; ts: number }
  | {
      type: 'web.request';
      url: string;
      ok: boolean;
      status?: number;
      bytes?: number;
      ms: number;
      note?: string;
      ts: number;
    }
  | { type: 'subagent.start'; task: string; tools: string[]; write?: boolean; ts: number }
  | {
      type: 'subagent.end';
      result: string;
      toolsUsed: string[];
      steps: number;
      /** 可写子 agent 改过的文件（相对/绝对路径按工具返回的原样） */
      changed?: string[];
      ts: number;
    }
  | { type: 'memory.distilled'; atoms: { kind: string; text: string }[]; total: number; ts: number }
  | {
      type: 'memory.injected';
      items: { kind: string; text: string; score: number }[];
      usedTokens: number;
      budget: number;
      dropped: number;
      /** 命中了但因为分叉被屏蔽掉的条数（分叉点之后才知道的事实/事件） */
      hiddenByFork?: number;
      ts: number;
    }
  | { type: 'memory.loaded'; count: number; path: string; ts: number }
  | { type: 'kb.loaded'; docs: number; chunks: number; path: string; ts: number }
  | { type: 'kb.imported'; docId: string; title: string; chunks: number; chars: number; version: number; ts: number }
  | {
      type: 'kb.injected';
      items: { title: string; headingPath: string; score: number; tokens: number; neighbor?: boolean }[];
      usedTokens: number;
      budget: number;
      dropped: number;
      considered: number;
      /** 被「同一篇最多几块」挡掉的数量 */
      cappedByDoc?: number;
      /** 被相对分数阈值挡掉的数量 */
      belowThreshold?: number;
      /** 实际拿去检索的字符串（去过停用词、可能拼了上一轮关键词） */
      query?: string;
      /** 是否借用了上一轮的关键词（指代兜底） */
      usedPrev?: boolean;
      /** 实际注入进提示词的那段正文原文（要对账"到底喂了什么"，GB_KB_LOG_TEXT=0 可关） */
      content?: string;
      ts: number;
    }
  | {
      type: 'kb.rewritten';
      /** 为什么改写：no-hit = 一段都没注入；weak-hit = 命中了但分数太低 */
      reason: 'no-hit' | 'weak-hit';
      /** 原来那个查询串（已去过停用词） */
      original: string;
      /** 模型给的候选 + 各自检索到几段 */
      candidates: { query: string; items: number }[];
      /** 最后换成了哪个（没换就是 undefined——候选一个都不如原来） */
      picked?: string;
      before: number;
      after: number;
      ts: number;
    }
  | {
      type: 'kb.contextualized';
      /** 每篇：补上几块、被机械闸拦下几块、模型漏给几块 */
      docs: { title: string; chunks: number; rejected: number; missing: number }[];
      failed: string[];
      /** 补完之后全库有上下文的块数 */
      total: number;
      ts: number;
    }
  | {
      type: 'activity.updated';
      entries: ActivityEntry[];
      summary: { created: number; edited: number; ran: number; other: number };
      ts: number;
    }
  | {
      type: 'wiki.built';
      /** 这次生成/更新了哪些条目 */
      pages: { ref: string; title: string; type: string; sources: number; verified: boolean }[];
      /** 校验没通过的条目数（数字在原文里找不到） */
      unverified: number;
      failed: string[];
      docs: number;
      ts: number;
    }
  | {
      type: 'wiki.summarized';
      /** 补上摘要/别名的条目 */
      pages: { ref: string; summary: string; aliases: number }[];
      failed: string[];
      ts: number;
    }
  | {
      type: 'wiki.injected';
      /** 进了本回合目录的条目 */
      items: { ref: string; summary: string }[];
      usedTokens: number;
      budget: number;
      /** 没进目录的条目及原因（未通过校验 / 缺摘要 / 超预算） */
      skipped: { ref: string; why: string }[];
      /** 进了目录但依据原文已改动的条目：注入了过期知识，面板要看得见 */
      stale: string[];
      ts: number;
    }
  | {
      type: 'wiki.audited';
      /** 五维加权综合分（0~100，确定性，不含模型抽检） */
      score: number;
      pages: number;
      dims: { key: string; label: string; score: number; issues: number }[];
      /** 模型抽检了几条（0 = 这次没调模型） */
      sampled: number;
      ts: number;
    }
  | { type: 'turn.end'; turnId: string; messages: Msg[]; ts: number };
