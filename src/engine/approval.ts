import readline from 'node:readline/promises';
import type { ApprovalDecision, ApprovalRequest, Approver, WireEvent } from './types.ts';
import { memorable, toDecision } from './types.ts';

/**
 * AutoApprover：非交互场景（脚本、演示、测试）用的审批者。
 * 用两个开关决定放行策略，方便一键复现“批准/拒绝”两种效果。
 *
 * 注意 `deny` 级别根本走不到这里——它在 Loop 里就被硬挡了，
 * 所以「全放行」策略也放不行 `.git` 写入、凭证读取这类操作。
 */
export class AutoApprover implements Approver {
  private readonly approveConfirm: boolean;
  private readonly approveDangerous: boolean;

  constructor(opts: { approveConfirm: boolean; approveDangerous: boolean }) {
    this.approveConfirm = opts.approveConfirm;
    this.approveDangerous = opts.approveDangerous;
  }

  async decide(req: ApprovalRequest): Promise<boolean> {
    return req.level === 'dangerous' ? this.approveDangerous : this.approveConfirm;
  }
}

/**
 * 会话记忆键：**工具名 + 首个字符串参数的前两段**。
 *
 * 为什么是"前两段"：`run_command "npm test -- --watch"` 与 `run_command "npm test"`
 * 应该算同一类（都是 `run_command:npm test`），而 `npm install` 不能蹭进来。
 * 取整条命令太细（换个参数就要重问），只取工具名太粗（批准过一次 run_command
 * 就等于交出 shell）。两段是实践里的折中。
 *
 * **这个键刻意不承担安全职责**，它只做归类。曾经想过把它改成"命令里所有程序名的集合"
 * 来堵 `npm test && curl x | sh`（跟 `npm test` 撞同一个键），但那会让键变得更粗——
 * `npm test` 会连带覆盖 `npm install`，比原来更危险。
 * 真正的收口在产生请求的那一侧：组合命令由 `shellPlugin` 标上 `noMemory`，
 * 于是它既不进记忆、也匹配不到记忆（见 `memorable()`）。
 *
 * 没有字符串参数就退化成工具名。
 */
export function memoryKey(req: ApprovalRequest): string {
  const first = Object.values(req.args ?? {}).find((v) => typeof v === 'string');
  if (typeof first !== 'string') return req.toolName;
  const head = first.trim().split(/\s+/).slice(0, 2).join(' ');
  return head === '' ? req.toolName : `${req.toolName}:${head}`;
}

/**
 * RememberingApprover：把人答的「始终允许」记成会话记忆，同类调用不再问。
 *
 * 为什么这是**安全设计的一部分**，而不只是体验优化：加固之后要确认的东西变多了，
 * 如果每条命令、每个新工具都问一遍，真人会直接上 `GB_APPROVE=all`——
 * 那前面所有的分级、硬拒绝、关键文件保护就一起废了。
 * 让"逐次确认"可持续，才谈得上让人真的去看每一次确认。
 *
 * 包在任何 Approver 外面用；`deny` 走不到这里（Loop 已挡）。
 */
export class RememberingApprover implements Approver {
  private readonly inner: Approver;
  private readonly remembered: Set<string>;

  constructor(inner: Approver, remembered: Iterable<string> = []) {
    this.inner = inner;
    this.remembered = new Set(remembered);
  }

  /** 现在记住了哪些（面板/调试用） */
  keys(): string[] {
    return [...this.remembered];
  }

  async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    const eligible = memorable(req);
    const key = memoryKey(req);
    if (eligible && this.remembered.has(key)) return 'allow';
    const decision = toDecision(await this.inner.decide(req));
    if (decision === 'always' && eligible) this.remembered.add(key);
    return decision;
  }
}

/**
 * 从会话日志还原「始终允许」记忆。
 *
 * 不需要另存一份记忆文件：`approval.decision` 事件本来就带着当时的完整 request，
 * 挑出 `decision === 'always'` 的重算一次 key 就是记忆。
 * 好处是记忆键算法以后要改，旧日志也能按新算法重算，不会对不上。
 */
export function rememberedFrom(records: readonly { ev: WireEvent }[]): string[] {
  const keys = new Set<string>();
  for (const { ev } of records) {
    if (ev.type !== 'approval.decision' || ev.decision !== 'always') continue;
    if (!memorable(ev.request)) continue;
    keys.add(memoryKey(ev.request));
  }
  return [...keys];
}

/**
 * InteractiveApprover：在真实终端里逐条问用户。
 * 这是“分级审批”给人看的一面——危险操作会带上更醒目的标记和原因。
 */
export class InteractiveApprover implements Approver {
  async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const mark = req.level === 'dangerous' ? '[危险]' : '[需确认]';
    const reason = req.reason ? `（原因：${req.reason}）` : '';
    if (req.preview) {
      console.log('  变更预览:');
      for (const line of req.preview.split('\n')) console.log('    ' + line);
    }
    const canRemember = memorable(req);
    const hint = canRemember ? '[y=允许 / a=以后同类不再问 / N=拒绝] ' : '[y/N] ';
    const answer = await rl.question(`\n${mark} ${req.summary}${reason}\n是否允许？${hint}`);
    rl.close();
    const t = answer.trim().toLowerCase();
    if (canRemember && (t === 'a' || t === 'always')) return 'always';
    return /^y(es)?$/.test(t) ? 'allow' : 'deny';
  }
}
