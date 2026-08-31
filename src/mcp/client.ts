import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolSchema } from '../engine/types.ts';

/**
 * MCP（Model Context Protocol）的最小客户端：stdio + JSON-RPC 2.0。
 *
 * 为什么要有它：这个项目一直宣称"一切都是插件"，但插件只能是仓库里的 TS 模块——
 * 加一个能力就得改代码、重启进程。MCP 是现在事实上的外部工具接口
 * （Claude Code / Codex / deepseek-harness 都认它），接上之后
 * 别人写好的服务器（数据库、浏览器、内部系统）不用改一行引擎代码就能变成可调用的工具。
 *
 * 刻意的取舍：
 * - **只做 stdio**，不做 SSE / HTTP。stdio 是本地工具的主流形态，也不需要处理鉴权。
 * - **只做 tools**，不做 resources / prompts。工具是唯一能立刻改变 agent 能力的部分。
 * - **一条 JSON 一行**。协议规定 stdout 只许放协议消息，日志走 stderr——所以 stderr
 *   我们留着当排障信息，不解析。
 */

/** JSON-RPC 请求超时。服务器要装依赖（npx 首次拉包）时握手会很慢，给宽一点 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 我们声明支持的协议版本 */
const PROTOCOL_VERSION = '2024-11-05';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 工作目录，默认跟 Glass-Box 的工作区一致 */
  cwd?: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  readonly name: string;
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private buf = '';
  private seq = 0;
  private dead: string | undefined;
  /** 服务器往 stderr 写的东西。连不上时这是唯一的线索，所以留最后一段 */
  private log = '';

  constructor(name: string, cfg: McpServerConfig, opts: { timeoutMs?: number; cwd?: string } = {}) {
    this.name = name;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.child = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd ?? opts.cwd,
      env: { ...process.env, ...cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (d: string) => this.onData(d));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (d: string) => {
      this.log = (this.log + d).slice(-2000);
    });
    this.child.on('error', (e: Error) => this.kill(`启动失败: ${e.message}`));
    this.child.on('exit', (code, signal) =>
      this.kill(`进程退出（code ${code}${signal ? `, ${signal}` : ''}）`),
    );
  }

  /** 服务器还活着吗？不活着就给出原因 */
  get failure(): string | undefined {
    return this.dead;
  }

  /** 服务器 stderr 的最后一段，排障用 */
  get stderr(): string {
    return this.log.trim();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        // 不是合法 JSON：按协议这不该发生，但别让一行坏数据把连接搞死
        continue;
      }
      if (typeof msg.id !== 'number') continue; // 服务器的通知，我们不订阅任何东西
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? `JSON-RPC error ${msg.error.code}`));
      else p.resolve(msg.result);
    }
  }

  /** 连接断了：把所有还在等的请求一次性打回，别让调用方挂死 */
  private kill(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP 服务器 ${this.name} ${reason}`));
    }
    this.pending.clear();
  }

  private send(payload: object): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(`MCP 服务器 ${this.name} ${this.dead}`));
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 服务器 ${this.name} 的 ${method} 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.dead) this.send({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  /** 握手。必须先握手再调 tools/list，否则规范上服务器可以直接拒 */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'glass-box', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolDef[]> {
    const r = (await this.request('tools/list')) as { tools?: McpToolDef[] };
    return (r?.tools ?? []).filter((t) => typeof t?.name === 'string');
  }

  /**
   * 调一个工具。把 MCP 的 content 数组压成一段纯文本——
   * 引擎的 ToolOutput 只认文本，非文本内容如实标注类型，不静默丢掉。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const parts = (r?.content ?? []).map((c) =>
      c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? '未知'} 内容，本客户端只处理文本]`,
    );
    return { text: parts.join('\n').trim() || '(无输出)', isError: Boolean(r?.isError) };
  }

  close(): void {
    this.kill('已关闭');
    this.child.kill('SIGTERM');
  }
}

/** 哪些参数被降级成了字符串（调用前要把 JSON 串还原回结构） */
export type Coercions = Record<string, true>;

/**
 * MCP 的 inputSchema 是完整 JSON Schema；引擎的 ToolSchema 只认扁平的
 * string / number / boolean。差额部分**降级成字符串并在说明里写清楚**，
 * 调用前再把 JSON 串解析回来。
 *
 * 为什么不直接把完整 schema 透给模型：那需要引擎的 ToolSchema 也支持嵌套，
 * 而 ToolSchema 同时被 FakeLlm 的指令语法和 token 估算用着。降级是有损的，
 * 所以宁可如实告诉模型"这里要塞一段 JSON"，也不假装支持。
 */
export function toToolSchema(input: unknown): { schema: ToolSchema; coerce: Coercions } {
  const src = input as {
    properties?: Record<string, { type?: unknown; description?: string; enum?: unknown }>;
    required?: unknown;
  };
  const properties: ToolSchema['properties'] = {};
  const coerce: Coercions = {};
  for (const [key, raw] of Object.entries(src?.properties ?? {})) {
    // 联合类型（["string","null"]）取第一个非 null 的
    const declared = Array.isArray(raw?.type)
      ? (raw.type as unknown[]).find((t) => t !== 'null')
      : raw?.type;
    const kind =
      declared === 'number' || declared === 'integer'
        ? 'number'
        : declared === 'boolean'
          ? 'boolean'
          : 'string';
    const degraded = kind === 'string' && declared !== 'string' && declared !== undefined;
    if (degraded) coerce[key] = true;
    const note = degraded ? `（原类型 ${JSON.stringify(declared)}，请传 JSON 字符串）` : '';
    const description = `${raw?.description ?? ''}${note}`.trim();
    const values = Array.isArray(raw?.enum) ? raw.enum.filter((v) => typeof v === 'string') : [];
    properties[key] = {
      type: kind,
      ...(description ? { description } : {}),
      ...(kind === 'string' && values.length ? { enum: values as string[] } : {}),
    };
  }
  const required = Array.isArray(src?.required)
    ? (src.required as unknown[]).filter((r): r is string => typeof r === 'string' && r in properties)
    : [];
  return {
    schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    coerce,
  };
}

/** 把降级过的参数还原成结构。解析不了就原样传过去，让服务器自己报错 */
export function restoreArgs(args: Record<string, unknown>, coerce: Coercions): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of Object.keys(coerce)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    try {
      out[key] = JSON.parse(v);
    } catch {
      // 模型没给 JSON：原样传，服务器的报错比我们编的更准
    }
  }
  return out;
}
