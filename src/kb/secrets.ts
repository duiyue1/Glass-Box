/**
 * 导入前的敏感信息扫描（对齐 AI-Ku 合规 Agent 的「敏感信息过滤」）。
 *
 * 动机很直接：资料库的内容每回合都可能被塞进模型请求里发到外部 API。
 * 一份带着 API key 的配置文档导进来，等于把密钥主动送出去。
 *
 * 这里只**提示**，不改内容、不阻止导入——判断"这是不是真密钥"要靠人。
 * 宁可多报几次（占位符 xxx / your-key 会被过滤掉），也不要漏。
 */

export interface SecretHit {
  /** 命中的类别，给人看的 */
  kind: string;
  /** 行号，从 1 开始 */
  line: number;
  /** 打码后的片段——报告里绝不回显完整密钥 */
  preview: string;
}

interface Rule {
  kind: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { kind: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { kind: 'AWS Access Key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { kind: '私钥文件', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // key = value 形式：值要够长且不像占位符
  { kind: '疑似密钥赋值', re: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*['"]?([^\s'"]{12,})/i },
  { kind: '带密码的连接串', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@/i },
];

/** 明显是示例/占位符的值，不报 */
const PLACEHOLDER =
  /^(?:x{3,}|\*{3,}|<[^>]+>|\$\{[^}]+\}|your[-_a-z0-9]*|xxx+|todo|changeme|placeholder|example[-_a-z0-9]*|test[-_a-z0-9]*|dummy[-_a-z0-9]*|redacted|\.{3,})$/i;

/** 只露头尾各 3 个字符，中间打码 */
function mask(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return '*'.repeat(t.length);
  return `${t.slice(0, 3)}${'*'.repeat(Math.min(12, t.length - 6))}${t.slice(-3)}`;
}

/**
 * 扫描文本里的疑似密钥。
 * 逐行扫，最多报 20 条（一份泄了的配置文件可能满屏都是，报前几条就够引起注意）。
 */
export function scanSecrets(text: string, maxHits = 20): SecretHit[] {
  const out: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < maxHits; i++) {
    const line = lines[i];
    if (line.length > 4000) continue; // 超长行大概是数据，不扫
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (!m) continue;
      const value = m[1] ?? m[0];
      if (PLACEHOLDER.test(value.trim())) continue;
      out.push({ kind: rule.kind, line: i + 1, preview: mask(value) });
      break; // 同一行报一次就够
    }
  }
  return out;
}
