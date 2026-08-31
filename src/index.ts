import type { Approver } from './engine/types.ts';
import { AutoApprover, InteractiveApprover } from './engine/approval.ts';
import { buildApp, parseTurns } from './app.ts';
import { formatSummary } from './activity/activity.ts';
import { formatEvent } from './logView.ts';
import { hasFlag, resolveWorkspace, stripFlags } from './cli.ts';

/**
 * 一次性跑几个回合的入口。
 *
 * 两种输出形态：
 * - 默认：给人看，`formatEvent` 渲染的事件流 + 最终回复。
 * - `--json`：给程序看，**stdout 只有 JSONL**（每行一个 wire 事件，末尾一行 result）。
 *   人类日志一律走 stderr，所以 `node src/index.ts "任务" --json | jq` 是干净的。
 *
 * 退出码（能被 CI / 脚本直接判断，这是"能塞进流水线"的前提）：
 * - `0` 全部回合跑完
 * - `1` 有回合抛异常
 * - `2` 用法错误（参数不对、工作区不存在）
 */
const EXIT_OK = 0;
const EXIT_FAILED = 1;

const argv = process.argv.slice(2);
const json = hasFlag(argv, '--json');
const workspace = resolveWorkspace(argv);

// --json 下 stdout 是数据通道，所有人类可读的噪音让给 stderr
if (json) process.env.GB_LLM_QUIET = '1';

// 审批者：真实终端 -> 交互问 y/N；非交互 -> 按 GB_APPROVE 决定
function pickApprover(): Approver {
  // --json 意味着"被程序调用"，即使挂在 TTY 上也不该停下来等人敲 y
  if (process.stdin.isTTY && !json) return new InteractiveApprover();
  const mode = process.env.GB_APPROVE;
  if (mode === 'all') return new AutoApprover({ approveConfirm: true, approveDangerous: true });
  if (mode === 'none') return new AutoApprover({ approveConfirm: false, approveDangerous: false });
  return new AutoApprover({ approveConfirm: true, approveDangerous: false });
}

const app = buildApp({ workspace, approver: pickApprover() });
const emit = (obj: unknown): void => console.log(JSON.stringify(obj));

// 先订阅，再 init（保证 session.started / plugin.loaded / skill.available 不丢）
// 渲染逻辑和 replay.ts 共用 formatEvent：回放出来的和当时看到的必须一致
let lastSummary = { created: 0, edited: 0, ran: 0, other: 0 };
app.wire.subscribe((ev) => {
  if (ev.type === 'activity.updated') lastSummary = ev.summary;
  if (json) {
    // 事件已经过图片脱敏（redactImages），可以整条吐出去
    emit(ev);
    return;
  }
  for (const l of formatEvent(ev)) console.log(l);
});

app.init();
// 外部工具服务器（.glassbox/mcp.json）。没配就是零成本的一次 existsSync
await app.initMcp();

// 支持多回合：用 ";;" 分隔，可演示上下文压缩
const rest = stripFlags(argv, ['--workspace', '-C'], ['--json']);
const input = rest.join(' ') || 'echo 你好世界';

const replies: string[] = [];
let failure: string | undefined;
for (const turn of parseTurns(input)) {
  try {
    const messages = await app.session.ask(turn);
    const reply = messages.at(-1)?.content ?? '';
    replies.push(typeof reply === 'string' ? reply : JSON.stringify(reply));
    if (!json) console.log('最终回复:', reply, '\n');
  } catch (e) {
    failure = (e as Error).message;
    break;
  }
}

if (json) {
  emit({
    type: 'result',
    ok: failure === undefined,
    error: failure,
    replies,
    activity: lastSummary,
    sessionId: app.journal.sessionId,
    journal: app.journal.path,
  });
} else {
  if (failure !== undefined) console.error('执行失败:', failure);
  console.log('本次活动轨迹汇总:', formatSummary(lastSummary));
  console.log('会话日志:', app.journal.path);
}

process.exit(failure === undefined ? EXIT_OK : EXIT_FAILED);
