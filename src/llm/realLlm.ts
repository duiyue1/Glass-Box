import type { Llm, TokenSink } from '../engine/loop.ts';
import type { Msg, LlmResponse, TokenUsage, ToolCall, ToolSpec } from '../engine/types.ts';
import { GRAMMAR_HELP, parseCommand, toToolCall } from './commandGrammar.ts';
import { StreamGate } from './streamGate.ts';
import { estimateText } from '../engine/tokens.ts';

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  family: string;
  /** 上下文窗口（token）。网关不告诉我们这个数，只能由使用者声明。 */
  contextWindow: number;
}

/** 不知道模型窗口时的保守默认值：宁可早压缩，也不要撞窗口溢出 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * OpenAI 兼容网关报"上下文超窗口"时的说法。各家措辞不同，只能按关键词认。
 * 认错的代价不对称：认成溢出最多白压一次历史，没认出来则整个回合报废。
 */
const OVERFLOW_MARKS = [
  'context_length_exceeded',
  'maximum context length',
  'context length exceeded',
  'reduce the length',
  'too many tokens',
  'exceeds the maximum',
  '超过最大长度',
  '上下文长度',
];

/**
 * 判断一条网关错误是不是上下文窗口溢出。
 * @param error 网关返回的错误文本
 */
export function isContextOverflow(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return OVERFLOW_MARKS.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * 从环境变量解析模型配置。兼容用户给的 MIDSCENE_* 命名，也支持 GLASSBOX_* 覆盖。
 */
export function resolveModelConfig(): ModelConfig {
  const env = process.env;
  const window = Number(env.GLASSBOX_MODEL_WINDOW ?? env.MIDSCENE_MODEL_WINDOW ?? DEFAULT_CONTEXT_WINDOW);
  return {
    baseUrl: env.GLASSBOX_MODEL_BASE_URL ?? env.MIDSCENE_MODEL_BASE_URL ?? '',
    model: env.GLASSBOX_MODEL_NAME ?? env.MIDSCENE_MODEL_NAME ?? '',
    apiKey: env.GLASSBOX_MODEL_API_KEY ?? env.MIDSCENE_MODEL_API_KEY ?? '',
    family: env.GLASSBOX_MODEL_FAMILY ?? env.MIDSCENE_MODEL_FAMILY ?? '',
    contextWindow: Number.isInteger(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW,
  };
}

/** 工具结果回喂给模型时的前缀。也是最容易被模型"顺手续写"的标记，所以同时作为停止词。 */
export const TOOL_RESULT_MARK = '【工具结果】';

/**
 * 模型越过自己的回合、继续替我们编造后续对话时会冒出的标记。
 * 抽取指令时遇到它们就截断——否则这些垃圾会原样成为工具参数。
 * 「工具结果」带冒号才算（实测模型会写成没有方括号的 `工具结果：`），
 * 这样正常搜索这四个字不会被误伤。
 */
const NOISE_MARKS = [TOOL_RESULT_MARK, '工具结果：', '工具结果:', 'ACTION:', 'ACTION：', '```'];

/**
 * 从模型回复里稳健地抽取 ACTION 指令。容忍这些常见"脏输出"：
 * - 用 ```代码块``` 包裹
 * - ACTION 前面带解释性文字
 * - 用中文冒号「：」
 * - 同一行里粘了第二条 ACTION、或粘了它自己编的【工具结果】、后续说明
 * 抽不到返回 null（当作纯文本回复）。
 *
 * 注意：启用原生 tool calling 后这条路只是兜底（网关忽略 tools 参数时）。
 * 它之所以还留着，是因为 FakeLlm 与 GB_TOOLCALL=0 仍走文本协议。
 */
export function extractActionCommand(content: string): string | null {
  const cleaned = content.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  for (const raw of cleaned.split('\n')) {
    const m = raw.trim().match(/action\s*[:：]\s*(.+)/i);
    if (!m) continue;
    // 只取第一条指令：模型偶尔会把第二条 ACTION、或它预测的工具结果挤在同一行，
    // 整行当参数会喂给工具一堆垃圾（实测出现过 path 里带着 "【工具结果】…"）。
    let cut = m[1];
    for (const mark of NOISE_MARKS) {
      const i = cut.indexOf(mark);
      if (i > 0) cut = cut.slice(0, i);
    }
    return cut.replace(/[`\s]+$/, '').trim();
  }
  return null;
}

/** 旧的文本指令协议：模型写一行 ACTION，我们用正则把它抠出来。GB_TOOLCALL=0 时仍走这条。 */
const PROTOCOL = `你是运行在终端里的 coding agent。你可以使用以下工具（指令语法）：
${GRAMMAR_HELP}

规则：
- 需要使用工具时，请只回复一行，格式为：ACTION: <指令>
  例如：ACTION: grep TurnState   或   ACTION: read package.json
- 检索建议：先用 glob 按文件名定位（ACTION: glob **/*.test.ts），再用 grep 搜内容；
  grep 可加范围与开关：ACTION: grep -i streamgate in *.ts（忽略大小写）、-l 只列文件、-c 只统计数量。
- 需要代码库以外的外部信息（新版本、报错含义、第三方文档、实时数据）才联网：先 web 搜，再 fetch 读具体页面。
  例：ACTION: web node 22 type stripping 限制   然后 ACTION: fetch https://nodejs.org/api/typescript.html
  查询词要短（3~8 个关键词），不要把解释、道歉、日期堆进去，也不要把说明文字写进参数。
  搜索只给标题和摘要；任何具体数值/事实（温度、版本号、价格…）都必须 fetch 页面读到正文后再回答。
  同一个问题不要反复换措辞重搜——搜过一次没有就去 fetch 具体页面。
  fetch 的参数必须是纯 URL，后面不要跟任何说明文字。
- read 可以读图片（png/jpg/gif/webp）：读完你会直接看到图像本身，可以描述、分析它。
  工作区外的路径也能读，但会先向用户请求授权；凭证类文件（.env/.ssh/*.pem 等）永远读不到。
- 不要把 ACTION 放进代码块，也不要在同一条回复里发起多个工具调用。
- 发出 ACTION 那一行后立即停止输出：不要自己编写工具的返回结果，也不要预测下一轮对话。
- 角色为 tool 的消息（或以「工具结果」开头的内容）是上一步工具的返回，请据此继续或给出最终答复。
- 不需要工具、可以直接回答时，用简洁中文正常回复，不要带 ACTION。`;

/**
 * 原生 tool calling 下的系统提示：不再教语法（参数格式由 JSON Schema 保证），
 * 只讲「什么时候用哪个工具」这类行为约束。
 */
const NATIVE_GUIDE = `你是运行在终端里的 coding agent。需要动手时直接发起工具调用（tool call），参数按各工具的 schema 填。

规则：
- 检索：先用 glob 按文件名定位（如 **/*.test.ts），再用 grep 搜内容；grep 支持 ignoreCase、glob 限定范围、mode=files/count。
- 联网：只有需要代码库以外的外部信息（新版本、报错含义、第三方文档、实时数据）才联网。
  先 web_search 看标题摘要，再 web_fetch 读具体页面。查询词要短（3~8 个关键词），不要把解释或日期堆进去。
  搜索结果只是线索；任何具体数值/事实（版本号、价格、温度…）都必须 fetch 到正文后再回答。
  同一个问题不要反复换措辞重搜——搜过一次没有就直接 fetch 具体页面。web_fetch 的 url 必须是纯 URL。
- read_file 可以读图片（png/jpg/gif/webp），你会直接看到图像本身。工作区外的路径会先向用户请求授权；
  凭证类文件（.env/.ssh/*.pem 等）永远读不到。
- 绝不要自己编造工具的返回结果，也不要预测下一轮对话。工具结果会以 tool 消息的形式回给你。
- 如果上下文里带了【资料库】片段，回答相关问题时优先采用它，并标明来源标题；里面没有的就说没有，不要编。
- 不需要工具、可以直接回答时，用简洁中文正常回复。`;

/**
 * 计划提示：只有 task_plan 这个工具真的注册了才追加（GB_PLAN=0 时不注册，也就不该提它）。
 *
 * 为什么需要这一句：实测过不加它的版本——三次真实模型跑，**一次都没调用 task_plan**。
 * 光有工具没用，模型不知道什么时候该用它。Claude Code 也是在系统提示里明确要求用 TodoWrite 的。
 */
const PLAN_HINT = `
- 三步以上、或者要跨多个文件的活：先用 task_plan 的 steps 列出步骤（一行一步），
  可以同一次调用里带上 doing 直接开工；做完一步标 done。
  计划会自动出现在之后每一回合的上下文里，不用复述。它不占本回合的工具步数。
  一两步能做完的活不要用它。`;

/**
 * 技能提示：只有 `skill` 工具真的注册了才追加（没有技能 / GB_SKILL_MODE=inject 时不注册）。
 *
 * 和 PLAN_HINT 同一个理由：opt-31 实测过"光注册工具不说明"的版本，三次真实模型跑一次都没调用。
 * dsh 的目录模板也把这句写成硬指令（"call the `skill` tool with the exact skill name
 * before taking task actions"），并且专门带一句防重复加载。
 */
const SKILL_HINT = `
- 任务对上了 skill 工具清单里某个技能的描述，就**先调 skill 把正文取回来**再动手；
  清单只是摘要，不要凭摘要推测里面的步骤。它不占本回合的工具步数。
  如果上下文里已经出现了某个技能的 <skill_content> 块，照它做就行，不要再为它调一次 skill。`;

/** 是否启用原生 tool calling。GB_TOOLCALL=0 可退回旧的 ACTION 文本协议。 */
export function nativeToolCallsEnabled(): boolean {
  return process.env.GB_TOOLCALL !== '0';
}

/** 这一轮的工具里有没有 task_plan——有才在系统提示里提计划 */
export function hasPlanTool(tools?: ToolSpec[]): boolean {
  return Boolean(tools?.some((t) => t.name === 'task_plan'));
}

/** 这一轮的工具里有没有 skill——有才在系统提示里提技能 */
export function hasSkillTool(tools?: ToolSpec[]): boolean {
  return Boolean(tools?.some((t) => t.name === 'skill'));
}

/** 系统提示的完整拼法。overhead() 过秤的和真正发出去的必须是同一段文本，所以只留这一处 */
export function systemPrompt(native: boolean, tools?: ToolSpec[]): string {
  return (
    (native ? NATIVE_GUIDE : PROTOCOL) +
    (hasPlanTool(tools) ? PLAN_HINT : '') +
    (hasSkillTool(tools) ? SKILL_HINT : '')
  );
}

/** 把工具声明转成 OpenAI 的 tools 数组 */
export function toOpenAiTools(specs: ToolSpec[]): object[] {
  return specs.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

/**
 * 解析模型给的 arguments。正常情况就是一段 JSON 字符串；
 * 少数网关/模型会在外面裹一层解释文字，所以失败时再试着截取第一个 {...}。
 * 实在解析不出就返回空对象——让工具自己报「缺少参数」，比抛异常中断回合好。
 */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  const s = (raw ?? '').trim();
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    // 往下修一次
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // 放弃
    }
  }
  return {};
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * 解析 provider 回的 usage。
 *
 * OpenAI 系：prompt_tokens / completion_tokens / total_tokens，缓存命中在
 * prompt_tokens_details.cached_tokens；DeepSeek 另给一对
 * prompt_cache_hit_tokens / prompt_cache_miss_tokens。两种都认，缺就不填。
 *
 * 为什么值得单独记：Agent 场景下输入 token 绝大部分是重复前缀，命中缓存与否
 * 价格差一到两个数量级——「这一回合花了多少」光看轮数是看不出来的。
 */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens);
  const completion = num(u.completion_tokens) ?? num(u.output_tokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = num(details?.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
  const out: TokenUsage = {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    total: num(u.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
  };
  if (cached !== undefined) out.cached = cached;
  return out;
}

function toToolCalls(raw: RawToolCall[] | undefined): ToolCall[] {
  return (raw ?? [])
    .filter((c) => c.function?.name)
    .map((c, i) => ({
      id: c.id || `c_${Date.now()}_${i}`,
      name: c.function!.name!,
      args: parseToolArgs(c.function!.arguments),
    }));
}

/**
 * 内部 Msg -> OpenAI 消息格式。
 *
 * 原生模式下必须严格成对：assistant(带 tool_calls) 紧跟 tool(带同一个 tool_call_id)。
 * 图片是个例外——多数模型不接受 tool 消息里塞图像，所以把图片拆成紧随其后的一条 user 消息，
 * 这样「读图」能力在原生模式下照样有效。
 */
export function mapMessages(messages: Msg[], native: boolean): object[] {
  const withImages = (role: string, text: string, images?: string[]): object =>
    images?.length
      ? {
          role,
          content: [
            { type: 'text', text },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        }
      : { role, content: text };

  if (!native) {
    // 旧协议：tool 消息降级成带前缀的 user 消息
    return messages.map((m) => {
      const role = m.role === 'tool' ? 'user' : m.role;
      const text = m.role === 'tool' ? `${TOOL_RESULT_MARK}${m.content}` : m.content;
      return withImages(role, text, m.images);
    });
  }

  return messages.flatMap((m) => {
    if (m.role === 'tool') {
      const msg = { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
      if (!m.images?.length) return [msg];
      return [msg, withImages('user', '（上一步工具返回的图片）', m.images)];
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return [
        {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      ];
    }
    return [withImages(m.role, m.content, m.images)];
  });
}

type ChatOk = { ok: true; content: string; toolCalls?: ToolCall[]; usage?: TokenUsage };
type ChatErr = { ok: false; error: string };

/**
 * RealLlm：调用 OpenAI 兼容 /chat/completions 的真实模型。实现同一个 Llm 接口，
 * 所以换模型不改引擎。工具调用默认走原生 tools/tool_calls（参数由 JSON Schema 保证），
 * 网关不支持时会自动落回 ACTION 文本解析。
 */
export class RealLlm implements Llm {
  private readonly cfg: ModelConfig;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  readonly contextWindow: number;

  constructor(cfg: ModelConfig) {
    this.cfg = cfg;
    this.timeoutMs = Number(process.env.GLASSBOX_MODEL_TIMEOUT ?? 60000);
    this.maxAttempts = Math.max(1, Number(process.env.GLASSBOX_MODEL_RETRIES ?? 2));
    this.contextWindow = cfg.contextWindow;
  }

  /**
   * 系统提示 + 工具声明要占多少 token。原生模式下工具 schema 是要序列化进请求的，
   * 工具一多它比系统提示还贵，所以不能只算提示。
   * @param tools 本回合注册了哪些工具
   */
  overhead(tools?: ToolSpec[]): number {
    const native = nativeToolCallsEnabled() && Boolean(tools?.length);
    const system = systemPrompt(native, tools);
    const schema = native ? JSON.stringify(toOpenAiTools(tools!)) : '';
    return estimateText(system) + (schema ? estimateText(schema) : 0);
  }

  async complete(
    messages: Msg[],
    onToken?: TokenSink,
    tools?: ToolSpec[],
    signal?: AbortSignal,
  ): Promise<LlmResponse> {
    const native = nativeToolCallsEnabled() && Boolean(tools?.length);
    const system = systemPrompt(native, tools);
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: system },
        ...mapMessages(messages, native),
      ],
    };
    if (native) {
      body.tools = toOpenAiTools(tools!);
      body.tool_choice = 'auto';
    } else {
      // 停止词：旧协议下模型经常在发出 ACTION 后继续替我们编造【工具结果】和下一轮对话，
      // 编出来的东西会污染工具参数。让服务端在这个标记处直接停笔。
      // 原生模式不需要——工具结果走的是 tool 消息，没有这个标记。
      body.stop = [TOOL_RESULT_MARK, '工具结果：'];
    }

    const wantStream = Boolean(onToken) && process.env.GB_STREAM !== '0';
    let res: ChatOk | ChatErr;
    if (wantStream) {
      const s = await this.streamChat(body, onToken!, signal);
      // 流式成功但什么都没拿到（空内容、无工具调用）也算失败：
      // 实测遇到过同一个请求流式返回空、非流式正常的情况。
      // 只要还没往用户屏幕上吐字，就安全地改用非流式重来一次（带重试）。
      if (s.ok && (s.content.trim() || s.toolCalls?.length)) res = s;
      else if (!s.emitted && !signal?.aborted) res = await this.postChat(body, signal);
      else res = s.ok ? s : { ok: false, error: s.error };
    } else {
      res = await this.postChat(body, signal);
    }
    // 中断的请求不该把半截结果当成答复：抛出去，让 Loop 走它的中断收尾
    if (signal?.aborted) throw new Error('用户中断');
    if (!res.ok) {
      return isContextOverflow(res.error) ? { text: `（${res.error}）`, overflow: true } : { text: `（模型调用失败：${res.error}）` };
    }

    if (res.toolCalls?.length) return { toolCalls: res.toolCalls, usage: res.usage };

    // 兜底：网关忽略了 tools 参数、或走的是旧协议时，仍然认 ACTION 行
    const cmdLine = extractActionCommand(res.content);
    if (cmdLine) {
      const cmd = parseCommand(cmdLine);
      if (cmd) return { toolCalls: [toToolCall(cmd)], usage: res.usage };
    }
    return { text: res.content.trim() || '（模型返回为空）', usage: res.usage };
  }

  /**
   * 流式请求（SSE）。逐块解析 `data: {...}`：
   * - delta.content 是给人看的文本，经 StreamGate 过滤后通过 onToken 吐出去；
   * - delta.tool_calls 是分片到达的工具调用，按 index 累积 name/arguments，收完再一次性返回。
   * 流式不做重试（会导致重复输出）；若一个 token 都没吐就失败，交给调用方回退到非流式。
   */
  private async streamChat(
    body: object,
    onToken: TokenSink,
    external?: AbortSignal,
  ): Promise<(ChatOk & { emitted?: boolean }) | { ok: false; error: string; emitted: boolean }> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    // 超时和用户中断是两个独立的理由，谁先来都要断开连接
    const signal = external ? AbortSignal.any([ctrl.signal, external]) : ctrl.signal;
    let emitted = false;
    // 流式默认不带 usage，要显式要一条统计块。老网关可能不认这个参数，
    // 所以 400 时脱掉它重来一次（此时还没吐字，重来是安全的）。
    const wantUsage = process.env.GB_USAGE !== '0';

    try {
      const post = (withUsage: boolean) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({
            ...body,
            stream: true,
            ...(withUsage ? { stream_options: { include_usage: true } } : {}),
          }),
          signal,
        });

      let resp = await post(wantUsage);
      if (!resp.ok && resp.status === 400 && wantUsage) resp = await post(false);
      if (!resp.ok) {
        const errText = await resp.text();
        clearTimeout(timer);
        return { ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}`, emitted };
      }
      if (!resp.body) {
        clearTimeout(timer);
        return { ok: false, error: '流式响应无响应体', emitted };
      }

      const gate = new StreamGate();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let usage: TokenUsage | undefined;
      // 工具调用按 index 累积：id/name 只在第一片出现，arguments 是一小段一小段拼出来的
      const acc = new Map<number, { id: string; name: string; args: string }>();

      const handleLine = (line: string): void => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const j = JSON.parse(payload) as {
            usage?: unknown;
            choices?: {
              delta?: {
                content?: string;
                tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
              };
            }[];
          };
          // usage 通常在最后一个块里（choices 为空），也有网关每块都带
          const u = parseUsage(j.usage);
          if (u) usage = u;
          const delta = j.choices?.[0]?.delta;
          const text = delta?.content;
          if (typeof text === 'string' && text) {
            full += text;
            const out = gate.push(text);
            if (out) {
              emitted = true;
              onToken(out);
            }
          }
          for (const tc of delta?.tool_calls ?? []) {
            const i = tc.index ?? 0;
            const cur = acc.get(i) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(i, cur);
          }
        } catch {
          // 忽略无法解析的行
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx).trim());
          buf = buf.slice(idx + 1);
        }
      }
      // 流结束后缓冲里可能还剩最后一行（末尾没有换行）。
      // 不处理它就会丢内容——极端情况下整段回复只有一行、又没有换行结尾，
      // 就会得到「模型返回为空」，而同样的请求非流式却是正常的。
      if (buf.trim()) handleLine(buf.trim());

      clearTimeout(timer);
      const tail = gate.flush();
      if (tail) {
        emitted = true;
        onToken(tail);
      }

      const toolCalls = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => c)
        .filter((c) => c.name)
        .map((c, i) => ({
          id: c.id || `c_${Date.now()}_${i}`,
          name: c.name,
          args: parseToolArgs(c.args),
        }));
      return { ok: true, content: full, toolCalls: toolCalls.length ? toolCalls : undefined, usage };
    } catch (e) {
      clearTimeout(timer);
      const err = external?.aborted
        ? '用户中断'
        : (e as Error).name === 'AbortError'
          ? `请求超时（${this.timeoutMs}ms）`
          : (e as Error).message;
      return { ok: false, error: err, emitted };
    }
  }

  /** 带超时 + 重试的请求：网络异常/超时/5xx 会重试，最多 maxAttempts 次。 */
  private async postChat(body: unknown, external?: AbortSignal): Promise<ChatOk | ChatErr> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let lastError = 'unknown';

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // 用户中断了就别再开下一次尝试：重试会让"按了停还在跑"
      if (external?.aborted) return { ok: false, error: '用户中断' };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      // 超时和用户中断是两个独立的理由，谁先来都要断开连接
      const signal = external ? AbortSignal.any([ctrl.signal, external]) : ctrl.signal;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const errText = await resp.text();
          lastError = `HTTP ${resp.status}: ${errText.slice(0, 200)}`;
          if (resp.status >= 500 && attempt < this.maxAttempts) continue; // 服务端错误可重试
          return { ok: false, error: lastError };
        }
        const data = (await resp.json()) as {
          usage?: unknown;
          choices?: { message?: { content?: string; tool_calls?: RawToolCall[] } }[];
        };
        const msg = data.choices?.[0]?.message;
        const calls = toToolCalls(msg?.tool_calls);
        return {
          ok: true,
          content: msg?.content ?? '',
          toolCalls: calls.length ? calls : undefined,
          usage: parseUsage(data.usage),
        };
      } catch (e) {
        clearTimeout(timer);
        if (external?.aborted) return { ok: false, error: '用户中断' };
        lastError = (e as Error).name === 'AbortError' ? `请求超时（${this.timeoutMs}ms）` : (e as Error).message;
        if (attempt < this.maxAttempts) continue; // 网络异常/超时可重试
        return { ok: false, error: lastError };
      }
    }
    return { ok: false, error: lastError };
  }
}
