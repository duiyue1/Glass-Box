import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { Plugin } from '../engine/plugin.ts';
import { safeAssess, type Tool } from '../engine/types.ts';
import { classifyCommandZone } from './paths.ts';
// 输出截断复用验证器里那个「头尾都留」的实现：测试框架的失败摘要通常在末尾，
// 只留开头等于什么都没留。同一个道理对 run_command 一字不差地成立。
import { clipOutput } from '../verify/verifier.ts';

/**
 * 一眼就该警惕的危险命令模式，附上「为什么危险」——
 * 审批弹窗上只写一句"匹配到危险命令模式"，人没法判断该不该点允许。
 */
const DANGER_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[rf]/, why: '递归/强制删除文件' },
  { re: /\bsudo\b/, why: '提权执行' },
  { re: /\bmkfs\b/, why: '格式化文件系统' },
  { re: /\bdd\b/, why: '裸写块设备' },
  { re: /:\(\)\s*\{/, why: 'fork 炸弹' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: '直接写磁盘设备' },
  { re: /git\s+push\b.*--force/, why: '强推会覆盖远端历史' },
  { re: /\bshutdown\b|\breboot\b/, why: '关机/重启' },
  // 下面四条是 git 状态的破坏面。文件工具那边写 .git/** 是直接 deny，
  // 但命令有正当用途（配 user.name、丢弃一次失败的改动），所以走 dangerous 让人自己判断
  { re: /\bgit\s+config\b/, why: '改 git 配置（等于写 .git/config）' },
  { re: /\bgit\s+reset\b/, why: '改 git index，可能丢掉已暂存的改动' },
  { re: /\bgit\s+clean\b/, why: '删除未跟踪文件，删掉的找不回来' },
  { re: /\bgit\s+checkout\s+(--|\.(?=\s|$))/, why: '丢弃工作树里未提交的改动' },
];

/**
 * 前台命令的默认超时。
 *
 * 原来写死 10 秒，而 `npm install` / `npm test` / `go build` 没有一个能在 10 秒内跑完——
 * 也就是说这个 agent 名义上能执行命令，实际上执行不了任何真实的构建。更别扭的是同一个
 * 项目里 `Verifier` 给的是 120 秒（`verify/verifier.ts:71`）：同一件事两套标准。
 * 统一到 120 秒。
 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 前台超时的硬上限：模型可以自己调长，但不能把一个回合无限期挂住 */
const MAX_FG_TIMEOUT_MS = 600_000;
/**
 * 后台任务的兜底上限。后台的意义就是长跑，但再长也要有个头——
 * 否则父进程退出后留下永远跑着的孤儿进程。
 */
const DEFAULT_BG_TIMEOUT_MS = 600_000;
const MAX_BG_TIMEOUT_MS = 3_600_000;
/** 单个后台任务累积输出的字符上限，超出丢最早的（丢了多少会如实告诉模型） */
const MAX_JOB_OUTPUT = 200_000;
/** execSync 的输出缓冲上限。默认 1MB，构建日志很容易超，超了 Node 直接抛错 */
const MAX_BUFFER = 16 * 1024 * 1024;

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]?.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 把模型给的超时收进合法区间。没给就用默认值 */
function clampTimeout(raw: unknown, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), 1_000), max);
}

type JobStatus = 'running' | 'done' | 'failed' | 'killed';

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  status: JobStatus;
  /** 累积输出（stdout + stderr 合并，按到达顺序），超上限时从头丢 */
  out: string;
  /** 因为超上限被丢掉的字符数 */
  dropped: number;
  /** `read_output` 读到哪了。只回增量——长任务每次把全部日志重灌一遍会把上下文吃光 */
  cursor: number;
  code: number | null;
  startedAt: number;
  endedAt?: number;
  timer?: NodeJS.Timeout;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 一行状态描述，`read_output` 的表头 */
function statusText(job: Job): string {
  const ms = (job.endedAt ?? Date.now()) - job.startedAt;
  const head =
    job.status === 'running'
      ? `运行中（已 ${secs(ms)}）`
      : job.status === 'killed'
        ? `已终止（耗时 ${secs(ms)}）`
        : `${job.status === 'done' ? '已结束' : '失败'}（退出码 ${job.code ?? '?'}，耗时 ${secs(ms)}）`;
  const lost = job.dropped > 0 ? `，早期输出已丢弃 ${job.dropped} 字符` : '';
  return `${job.command} — ${head}${lost}`;
}

/**
 * shell 插件：在工作区目录下执行命令。
 *
 * 三个能力，分别对应一类真实需求：
 * - **前台**（默认）：跑完拿输出。超时可配，输出头尾截断。
 * - **后台**（`background: true`）：`npm run dev`、长测试这类不该占住回合的命令，
 *   立刻返回一个任务号，之后用 `read_output` 取增量日志。
 * - **终止**（`kill_command`）：后台任务跑飞了要能停下来。
 *
 * 所有命令至少是 confirm；命中危险模式则升级为 dangerous。
 */
export function shellPlugin(): Plugin {
  return {
    name: 'shell',
    setup(ctx) {
      const { workspace } = ctx;
      const jobs = new Map<string, Job>();
      let seq = 0;
      const maxOut = numEnv('GB_SHELL_MAX_OUTPUT', MAX_JOB_OUTPUT);

      /** 进程退出时把还在跑的后台任务收掉，不留孤儿 */
      process.once('exit', () => {
        for (const job of jobs.values()) {
          if (job.status === 'running') job.child.kill('SIGKILL');
        }
      });

      const append = (job: Job, chunk: string): void => {
        job.out += chunk;
        if (job.out.length <= maxOut) return;
        const cut = job.out.length - maxOut;
        job.out = job.out.slice(cut);
        job.dropped += cut;
        job.cursor = Math.max(0, job.cursor - cut);
      };

      const startJob = (cmd: string, timeoutMs: number): Job => {
        const id = `job${++seq}`;
        const child = spawn(cmd, {
          cwd: workspace,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const job: Job = {
          id,
          command: cmd,
          child,
          status: 'running',
          out: '',
          dropped: 0,
          cursor: 0,
          code: null,
          startedAt: Date.now(),
        };
        jobs.set(id, job);

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (d: string) => append(job, d));
        child.stderr?.on('data', (d: string) => append(job, d));
        child.on('error', (e: Error) => {
          append(job, `\n[启动失败] ${e.message}\n`);
          job.status = 'failed';
          job.endedAt = Date.now();
          clearTimeout(job.timer);
        });
        child.on('exit', (code) => {
          job.code = code;
          // 已经被标成 killed 的不要覆盖成 failed：是我们主动停的，不是它自己崩的
          if (job.status === 'running') job.status = code === 0 ? 'done' : 'failed';
          job.endedAt = Date.now();
          clearTimeout(job.timer);
        });

        job.timer = setTimeout(() => {
          if (job.status !== 'running') return;
          job.status = 'killed';
          append(job, `\n[超过 ${secs(timeoutMs)} 上限，已终止]\n`);
          child.kill('SIGKILL');
        }, timeoutMs);
        // 别让这个定时器把 Node 进程吊住：命令跑完了就该能退
        job.timer.unref?.();
        return job;
      };

      const runCommand: Tool = {
        name: 'run_command',
        description:
          '在工作区目录下执行一条 shell 命令。默认前台执行并返回输出；' +
          'background=true 则放到后台立刻返回任务号，之后用 read_output 取日志、kill_command 终止。' +
          '长命令（dev server、大测试）请用后台，别占住整个回合',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            background: {
              type: 'boolean',
              description: '放到后台执行，立刻返回任务号（适合 dev server、长时间构建）',
            },
            timeoutMs: {
              type: 'number',
              description: '超时毫秒。前台默认 120000（上限 600000），后台默认 600000（上限 3600000）',
            },
          },
          required: ['command'],
        },
        assess(args) {
          const cmd = String(args.command ?? '');
          const where = args.background ? '（后台）' : '';
          const summary = `执行命令${where}: ${cmd}`;

          // 先判命令碰到的路径。文件工具早就按真实路径判归属了，但 run_command
          // 以前只看命令长什么样——`cat ~/.ssh/id_rsa` 和 `echo hello` 同为 confirm，
          // 等于 read_file/write_file 那边所有硬边界换个入口就全部失效
          const zone = classifyCommandZone(workspace, cmd);
          if (zone?.kind === 'secret') {
            const how =
              zone.matchedBy === 'literal'
                ? `命令里的 ${zone.path} 字面就命中了凭证名单（带变量，展开不了但也不放行）`
                : `命令里的 ${zone.path} 真实路径是 ${zone.real}，命中凭证黑名单`;
            return { level: 'deny', summary, reason: `${how}——换成命令行也一样不给碰` };
          }

          const hit = DANGER_PATTERNS.find((d) => d.re.test(cmd));
          if (hit) return { level: 'dangerous', summary, reason: hit.why };

          if (zone?.kind === 'outside') {
            return {
              level: 'dangerous',
              summary,
              reason: `命令里的 ${zone.path} 落在工作区之外（真实路径 ${zone.real}）`,
            };
          }
          if (zone?.kind === 'protected') {
            return {
              level: 'dangerous',
              summary,
              reason: `命令碰到 git 元数据 ${zone.path}——文件工具那边写 .git 是直接拒绝的`,
            };
          }
          return { level: 'confirm', summary };
        },
        run(args) {
          const cmd = String(args.command ?? '');
          if (!cmd.trim()) return { ok: false, content: 'run_command 需要 command' };

          // 在 run 里再挡一次凭证。assess 只是给审批看的，真正的闸门不能只有一道；
          // read_file 也是同样的双重拦截
          const zone = classifyCommandZone(workspace, cmd);
          if (zone?.kind === 'secret') {
            const what = zone.matchedBy === 'literal' ? zone.path : `${zone.path}（真实路径 ${zone.real}）`;
            return { ok: false, content: `拒绝执行：命令里的 ${what} 属于凭证类文件，永不放行` };
          }

          if (args.background) {
            const timeoutMs = clampTimeout(
              args.timeoutMs,
              MAX_BG_TIMEOUT_MS,
              numEnv('GB_SHELL_BG_TIMEOUT', DEFAULT_BG_TIMEOUT_MS),
            );
            const job = startJob(cmd, timeoutMs);
            return {
              ok: true,
              content:
                `已在后台启动 ${job.id}：${cmd}\n` +
                `用 read_output({ id: "${job.id}" }) 看日志，kill_command({ id: "${job.id}" }) 终止。` +
                `超过 ${secs(timeoutMs)} 会被自动终止。`,
              meta: { action: 'ran', command: cmd },
            };
          }

          const timeoutMs = clampTimeout(
            args.timeoutMs,
            MAX_FG_TIMEOUT_MS,
            numEnv('GB_SHELL_TIMEOUT', DEFAULT_TIMEOUT_MS),
          );
          try {
            const out = execSync(cmd, {
              cwd: workspace,
              encoding: 'utf8',
              timeout: timeoutMs,
              maxBuffer: MAX_BUFFER,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            return {
              ok: true,
              content: clipOutput(out) || '(无输出)',
              meta: { action: 'ran', command: cmd },
            };
          } catch (e) {
            const err = e as { stdout?: string; stderr?: string; message?: string; signal?: string };
            // 超时被 kill 时抛的是信号错误，stdout/stderr 可能是空的，得把 message 也带上；
            // 并且明确说出「是超时，不是命令本身失败」——否则模型会以为代码有问题，去改代码
            const timedOut = err.signal === 'SIGTERM' || /ETIMEDOUT|timed out/i.test(err.message ?? '');
            const merged = [
              err.stdout ?? '',
              err.stderr ?? '',
              timedOut ? `（超过 ${secs(timeoutMs)} 上限被终止；长命令请改用 background: true）` : '',
            ]
              .filter(Boolean)
              .join('\n');
            return {
              ok: false,
              content: `命令失败: ${clipOutput(merged) || err.message || '没有输出'}`,
              meta: { action: 'ran', command: cmd },
            };
          }
        },
      };

      const readOutput: Tool = {
        name: 'read_output',
        // free：轮询后台日志不算「在真实操作里打转」，不该占掉写文件的步数。
        // free 自己有 maxSteps*2 的上限兜住死循环。
        free: true,
        // 只读自己起的后台任务的日志。命令本身已经审批过了
        assess: safeAssess,
        description: '读取后台任务的新增输出与状态（只回上次读过之后的部分）',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'run_command 返回的任务号，如 job1' } },
          required: ['id'],
        },
        run(args) {
          const id = String(args.id ?? '');
          const job = jobs.get(id);
          if (!job) {
            const known = [...jobs.keys()].join(', ') || '（一个都没有）';
            return { ok: false, content: `没有这个后台任务: ${id}。现有任务：${known}` };
          }
          const fresh = job.out.slice(job.cursor);
          job.cursor = job.out.length;
          const head = `[${job.id}] ${statusText(job)}`;
          return {
            ok: true,
            content: fresh ? `${head}\n${clipOutput(fresh)}` : `${head}\n（没有新输出）`,
            meta: { action: 'ran', command: job.command },
          };
        },
      };

      const killCommand: Tool = {
        name: 'kill_command',
        description: '终止一个还在跑的后台任务',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '要终止的任务号' } },
          required: ['id'],
        },
        assess(args) {
          // 半路停下的进程可能留下半完成的状态（构建产物、临时文件），所以要人点一下
          return { level: 'confirm', summary: `终止后台任务: ${String(args.id ?? '')}` };
        },
        run(args) {
          const id = String(args.id ?? '');
          const job = jobs.get(id);
          if (!job) return { ok: false, content: `没有这个后台任务: ${id}` };
          if (job.status !== 'running') {
            return { ok: true, content: `[${job.id}] 早已结束：${statusText(job)}` };
          }
          job.status = 'killed';
          job.child.kill('SIGTERM');
          // 不理 SIGTERM 的进程给两秒再硬杀
          const hard = setTimeout(() => {
            if (job.endedAt === undefined) job.child.kill('SIGKILL');
          }, 2_000);
          hard.unref?.();
          return { ok: true, content: `已终止 ${job.id}：${job.command}`, meta: { action: 'ran', command: job.command } };
        },
      };

      ctx.tools.register(runCommand);
      ctx.tools.register(readOutput);
      ctx.tools.register(killCommand);
    },
  };
}
