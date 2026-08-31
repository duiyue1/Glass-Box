import type { Approver } from './engine/types.ts';
import { AutoApprover, InteractiveApprover } from './engine/approval.ts';
import { buildApp, parseTurns } from './app.ts';
import { formatSummary } from './activity/activity.ts';
import { formatEvent } from './logView.ts';

const WORKSPACE = process.cwd();

// 审批者：真实终端 -> 交互问 y/N；非交互 -> 按 GB_APPROVE 决定
function pickApprover(): Approver {
  if (process.stdin.isTTY) return new InteractiveApprover();
  const mode = process.env.GB_APPROVE;
  if (mode === 'all') return new AutoApprover({ approveConfirm: true, approveDangerous: true });
  if (mode === 'none') return new AutoApprover({ approveConfirm: false, approveDangerous: false });
  return new AutoApprover({ approveConfirm: true, approveDangerous: false });
}

const app = buildApp({ workspace: WORKSPACE, approver: pickApprover() });

// 先订阅，再 init（保证 session.started / plugin.loaded / skill.available 不丢）
// 渲染逻辑和 replay.ts 共用 formatEvent：回放出来的和当时看到的必须一致
let lastSummary = { created: 0, edited: 0, ran: 0, other: 0 };
app.wire.subscribe((ev) => {
  if (ev.type === 'activity.updated') lastSummary = ev.summary;
  for (const l of formatEvent(ev)) console.log(l);
});

app.init();
// 外部工具服务器（.glassbox/mcp.json）。没配就是零成本的一次 existsSync
await app.initMcp();

// 支持多回合：用 ";;" 分隔，可演示上下文压缩
const input = process.argv.slice(2).join(' ') || 'echo 你好世界';
for (const turn of parseTurns(input)) {
  const messages = await app.session.ask(turn);
  console.log('最终回复:', messages.at(-1)?.content, '\n');
}

console.log('本次活动轨迹汇总:', formatSummary(lastSummary));
console.log('会话日志:', app.journal.path);
