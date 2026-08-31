import type { ToolCall } from '../engine/types.ts';
import { extractUrl } from '../net/http.ts';

export interface ParsedCommand {
  name: string;
  args: Record<string, unknown>;
}

/** 工具指令语法说明（同时用于 FakeLlm 的回退提示和 RealLlm 的系统提示） */
export const GRAMMAR_HELP =
  'read <path> | write <path> :: <内容> | edit <path> ||| <旧文本> ||| <新文本> | run <命令> | ' +
  'glob <文件名模式> | grep [-i|-l|-c] <正则> [in <文件名模式>] | web <搜索词> | fetch <url> | ' +
  'delegate <子任务> | echo <文本>';

/**
 * 解析 grep 的可选开关与范围限定：
 *   grep -i StreamGate in *.ts   → 忽略大小写，只搜 .ts 文件
 *   grep -l TurnState            → 只列出命中的文件（files 模式）
 *   grep -c TODO in src/**       → 只统计每个文件命中几处（count 模式）
 */
function parseGrep(rest: string): Record<string, unknown> {
  let s = rest.trim();
  const args: Record<string, unknown> = {};
  // 开关只允许出现在最前面，避免把正则里的 -i 当成开关
  for (;;) {
    const m = s.match(/^(-[ilc])\s+/);
    if (!m) break;
    if (m[1] === '-i') args.ignoreCase = true;
    if (m[1] === '-l') args.mode = 'files';
    if (m[1] === '-c') args.mode = 'count';
    s = s.slice(m[0].length);
  }
  // 贪婪匹配：以最后一个 " in " 作为范围分隔，正则里含 " in " 也不会被切错
  const scoped = s.match(/^(.+)\s+in\s+(\S+)$/i);
  if (scoped) {
    args.pattern = scoped[1].trim();
    args.glob = scoped[2].trim();
  } else {
    args.pattern = s.trim();
  }
  return args;
}

/**
 * 把一行「指令语法」解析成工具调用。FakeLlm 和 RealLlm 共用这一套解析，
 * 从而保证：换模型不改引擎、也不改工具协议。
 */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^read\s+(.+)/i))) return { name: 'read_file', args: { path: m[1].trim() } };
  if ((m = t.match(/^edit\s+(\S+)\s*\|\|\|\s*([\s\S]*?)\s*\|\|\|\s*([\s\S]*)$/i)))
    return { name: 'edit_file', args: { path: m[1], old: m[2], new: m[3] } };
  if ((m = t.match(/^write\s+(\S+)\s*::\s*([\s\S]+)/i))) return { name: 'write_file', args: { path: m[1], content: m[2] } };
  if ((m = t.match(/^run\s+(.+)/i))) return { name: 'run_command', args: { command: m[1].trim() } };
  if ((m = t.match(/^glob\s+(.+)/i))) return { name: 'glob', args: { pattern: m[1].trim() } };
  if ((m = t.match(/^web\s+(.+)/i))) return { name: 'web_search', args: { query: m[1].trim() } };
  if ((m = t.match(/^fetch\s+(.+)/i))) {
    // URL 只吃 ASCII 合法字符：模型常把中文说明直接粘在链接后面
    const url = extractUrl(m[1]);
    return { name: 'web_fetch', args: { url: url ?? m[1].trim() } };
  }
  if ((m = t.match(/^grep\s+(.+)/i))) return { name: 'grep', args: parseGrep(m[1]) };
  if ((m = t.match(/^delegate\s+(.+)/i))) return { name: 'delegate', args: { task: m[1].trim() } };
  if ((m = t.match(/^echo\s+(.+)/i))) return { name: 'echo', args: { text: m[1] } };
  return null;
}

/** 把解析结果包成引擎用的 ToolCall */
export function toToolCall(cmd: ParsedCommand, id = `c_${Date.now()}`): ToolCall {
  return { id, name: cmd.name, args: cmd.args };
}
