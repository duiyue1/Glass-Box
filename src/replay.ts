import { listSessions, readEvents } from './engine/journal.ts';
import { rebuildInfo } from './engine/rebuild.ts';
import { sessionsDir } from './app.ts';
import { formatEvent } from './logView.ts';
import { resolveWorkspace, stripFlags } from './cli.ts';

/**
 * 会话回放 CLI。
 *
 *   node src/replay.ts                      列出所有会话
 *   node src/replay.ts <sessionId>          重播成人类可读日志
 *   node src/replay.ts <sessionId> --to 42  只放到第 42 步
 *   node src/replay.ts <sessionId> --json   输出原始事件（每行一条）
 *
 * 会话日志属于工作区（`<工作区>/.glassbox/sessions`），所以这里也认 `--workspace`。
 *
 * 回放用的是和实时日志同一个渲染器（logView.formatEvent），
 * 所以「回放出来的」就是「当时看到的」，不是另做一套展示。
 */

const args = process.argv.slice(2);
const dir = sessionsDir(resolveWorkspace(args));
const flags = new Set(args.filter((a) => a.startsWith('--')));
// 先把带值的 flag 连值一起摘掉，否则 `--workspace /tmp/x` 里的路径会被当成 sessionId
const rest = stripFlags(args, ['--to', '--workspace', '-C'], ['--json']);
const positional = rest.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
const toIdx = args.indexOf('--to');
const until = toIdx >= 0 ? Number(args[toIdx + 1]) : undefined;
const sessionId = positional[0];

if (!sessionId) {
  const list = listSessions(dir);
  if (!list.length) {
    console.log(`（${dir} 下还没有会话日志。跑一次 npm start / npm run chat 就会生成）`);
    process.exit(0);
  }
  console.log(`会话日志目录: ${dir}\n`);
  for (const s of list) {
    const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : '?';
    const fork = s.forkedFrom ? `  ← 分叉自 ${s.forkedFrom.sessionId}@${s.forkedFrom.seq}` : '';
    console.log(`${s.sessionId}  ${when}  ${s.events} 事件 / ${Math.round(s.bytes / 1024)}KB${fork}`);
    if (s.firstAsk) console.log(`    首个提问: ${s.firstAsk.slice(0, 60)}`);
  }
  console.log('\n回放: node src/replay.ts <sessionId> [--to <seq>] [--json]');
  process.exit(0);
}

const records = readEvents(dir, sessionId, Number.isFinite(until) ? until : undefined);
if (!records.length) {
  console.error(`读不到会话 ${sessionId}（目录: ${dir}）`);
  process.exit(1);
}

if (flags.has('--json')) {
  for (const r of records) console.log(JSON.stringify({ seq: r.seq, ...r.ev }));
} else {
  for (const r of records) {
    for (const l of formatEvent(r.ev)) console.log(`#${String(r.seq).padStart(4)} ${l}`);
  }
  const info = rebuildInfo(records);
  console.log(
    `\n回放结束：${records.length} 个事件，${info.turns} 个完整回合，最后一个回合结束于 #${info.atSeq}`,
  );
  console.log(`从这里继续: node src/chat.ts --resume ${sessionId}`);
  console.log(`从某一步分叉: node src/chat.ts --resume ${sessionId} --at <seq>`);
}
