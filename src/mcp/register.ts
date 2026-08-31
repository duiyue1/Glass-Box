import fs from 'node:fs';
import path from 'node:path';
import type { Wire } from '../engine/wire.ts';
import type { ToolRegistry } from '../engine/toolRegistry.ts';
import type { Tool } from '../engine/types.ts';
import { safeAssess } from '../engine/types.ts';
import { McpClient, restoreArgs, toToolSchema, type McpServerConfig } from './client.ts';

/**
 * 把 `.glassbox/mcp.json` 里声明的 MCP 服务器接进 ToolRegistry。
 *
 * 为什么不做成 `Plugin`：`Plugin.setup()` 是同步契约，而 MCP 要先握手、再 `tools/list`
 * 才知道有哪些工具。硬塞进 setup 只能靠 fire-and-forget，那样第一个回合大概率还没注册完。
 * 所以这里是一个显式的异步步骤，由入口在 `app.init()` 之后 await。
 */

export interface McpServerEntry extends McpServerConfig {
  /** 配着但暂时不启用 */
  disabled?: boolean;
  /**
   * 信任这台服务器：它的工具按 safe 处理，不再逐次审批。
   * **默认 false**——MCP 服务器是外部进程，能读文件、能发网络请求，
   * 默认让它免审批等于把这个项目所有的安全边界一次性交出去。
   * 只有明确知道某台服务器是只读的、来源可信时才打开。
   */
  trust?: boolean;
}

export interface McpConfig {
  servers?: Record<string, McpServerEntry>;
}

export interface McpStatus {
  server: string;
  ok: boolean;
  tools: string[];
  error?: string;
  /** 服务器 stderr 的最后一段（失败时才有意义） */
  stderr?: string;
}

export function mcpConfigPath(workspace: string): string {
  return path.join(workspace, '.glassbox', 'mcp.json');
}

/** 读配置。没有文件就是"没配 MCP"，零成本返回 undefined——不是错误 */
export function readMcpConfig(workspace: string): McpConfig | undefined {
  const p = mcpConfigPath(workspace);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as McpConfig;
  } catch (e) {
    throw new Error(`${p} 不是合法 JSON：${(e as Error).message}`);
  }
}

/**
 * 工具名：`mcp__<服务器>__<工具>`。
 * 带上服务器名是因为两台服务器很可能都有一个叫 `search` 的工具；
 * 前缀 `mcp__` 让人一眼看出这是外部能力，而不是引擎自带的。
 * 非法字符换成 `_`，并按 OpenAI 的限制截到 64 字符。
 */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}

/**
 * 连上所有启用中的服务器并注册它们的工具。
 * 单台连不上不影响其他台——如实记在返回的 status 里，由调用方打给人看。
 */
export async function connectMcp(opts: {
  workspace: string;
  tools: ToolRegistry;
  wire: Wire;
  config?: McpConfig;
  timeoutMs?: number;
}): Promise<{ status: McpStatus[]; close: () => void }> {
  const cfg = opts.config ?? readMcpConfig(opts.workspace);
  const entries = Object.entries(cfg?.servers ?? {}).filter(([, s]) => s && !s.disabled);
  const clients: McpClient[] = [];
  const status: McpStatus[] = [];
  const close = () => {
    for (const c of clients) c.close();
  };
  if (!entries.length) return { status, close };

  for (const [server, entry] of entries) {
    if (!entry.command) {
      status.push({ server, ok: false, tools: [], error: '缺少 command' });
      continue;
    }
    const client = new McpClient(server, entry, { cwd: opts.workspace, timeoutMs: opts.timeoutMs });
    clients.push(client);
    try {
      await client.initialize();
      const defs = await client.listTools();
      const names: string[] = [];
      for (const def of defs) {
        const { schema, coerce } = toToolSchema(def.inputSchema);
        const name = mcpToolName(server, def.name);
        const tool: Tool = {
          name,
          description: `[MCP ${server}] ${def.description ?? def.name}`,
          parameters: schema,
          assess: entry.trust
            ? // 显式信任：标 safe。**不能留空**——`assess` 缺省是 confirm（安全缺省），
              // 留空会让 trust 完全失效
              safeAssess
            : (args) => ({
                level: 'confirm',
                summary: `调用外部工具 ${server}/${def.name}`,
                reason: 'MCP 服务器是外部进程，它能做什么由服务器决定',
                preview: JSON.stringify(args, null, 2).slice(0, 800),
              }),
          async run(args) {
            try {
              const r = await client.callTool(def.name, restoreArgs(args, coerce));
              return {
                ok: !r.isError,
                content: r.text,
                meta: { action: 'delegated', command: `${server}/${def.name}` },
              };
            } catch (e) {
              return { ok: false, content: `MCP 调用失败: ${(e as Error).message}` };
            }
          },
        };
        opts.tools.register(tool);
        names.push(name);
      }
      status.push({ server, ok: true, tools: names });
      opts.wire.emit({ type: 'plugin.loaded', name: `mcp:${server}`, tools: names, ts: Date.now() });
    } catch (e) {
      client.close();
      status.push({
        server,
        ok: false,
        tools: [],
        error: (e as Error).message,
        ...(client.stderr ? { stderr: client.stderr } : {}),
      });
    }
  }
  return { status, close };
}
