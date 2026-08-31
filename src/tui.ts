import { AutoApprover } from './engine/approval.ts';
import { buildApp, parseTurns } from './app.ts';
import { Renderer } from './tui/renderer.ts';

const WORKSPACE = process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const approveMode = process.env.GB_APPROVE;
const approver = new AutoApprover({
  approveConfirm: approveMode !== 'none',
  approveDangerous: approveMode === 'all',
});

const app = buildApp({ workspace: WORKSPACE, approver });
app.init();
await app.initMcp();

// 跑完所有回合，产生完整事件流（Wire 自动记录到 history）
const input = process.argv.slice(2).join(' ') || 'write demo.txt :: 你好，玻璃盒';
for (const turn of parseTurns(input)) {
  await app.session.ask(turn);
}
const events = app.wire.history();

const cols = Math.min(process.stdout.columns || 100, 120);
const isTty = Boolean(process.stdout.isTTY);
const renderer = new Renderer({ color: isTty, cols });

if (isTty) {
  const delay = Number(process.env.GB_DELAY ?? 220);
  process.stdout.write('\x1b[?25l');
  for (const ev of events) {
    renderer.apply(ev);
    process.stdout.write('\x1b[2J\x1b[H' + renderer.frame() + '\n');
    await sleep(delay);
  }
  process.stdout.write('\x1b[?25h');
} else {
  for (const ev of events) renderer.apply(ev);
  console.log(renderer.frame());
}
