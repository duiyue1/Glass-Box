import type { Plugin } from '../engine/plugin.ts';
import { safeAssess, type Tool, type WireEvent } from '../engine/types.ts';
import { Wire } from '../engine/wire.ts';
import { ToolRegistry } from '../engine/toolRegistry.ts';
import { Loop, type Llm } from '../engine/loop.ts';
import { AutoApprover } from '../engine/approval.ts';
import { fsPlugin } from './fsPlugin.ts';
import { searchPlugin } from './searchPlugin.ts';
import { webPlugin } from './webPlugin.ts';
import { loadPlugins } from '../engine/plugin.ts';

/**
 * subagent 插件：提供 delegate 工具。
 * 把一个子任务下放给一个「上下文隔离、工具受限（只读）」的子 agent，
 * 子 agent 有自己的 Wire（不污染主时间线），跑完把结果回给主 agent。
 * 这是 Claude Code Task / AgentSwarm 的极简版。
 *
 * llm 由父级注入：子 agent 必须和主 agent 用同一个模型，
 * 否则真实模型模式下会得到一个"没有智能"的子 agent。
 */
export function subagentPlugin(workspace: string, llm: Llm): Plugin {
  return {
    name: 'subagent',
    setup(ctx) {
      const parentWire = ctx.wire;

      const delegate: Tool = {
        name: 'delegate',
        // 子 agent 只拿到只读工具，且内部自带审批者（confirm 放行 / dangerous 拒绝）
        assess: safeAssess,
        description: '把一个只读子任务（如搜索/读取）下放给隔离的子 agent，返回其结论',
        parameters: {
          type: 'object',
          properties: { task: { type: 'string', description: '交给子 agent 的只读子任务描述' } },
          required: ['task'],
        },
        async run(args) {
          const task = String(args.task ?? '');

          // 子 agent：独立 Wire + 受限工具（只读：read_file / glob / grep / web_fetch）
          // 给 fetch 不给 search：它只该读父 agent 已经定位到的地址，不该自己去发散搜索
          const childWire = new Wire();
          const childTools = new ToolRegistry();
          loadPlugins([fsPlugin({ readOnly: true }), searchPlugin(), webPlugin({ fetchOnly: true })], {
            tools: childTools,
            wire: childWire,
            workspace,
          });
          const child = new Loop(
            childWire,
            childTools,
            llm,
            new AutoApprover({ approveConfirm: true, approveDangerous: false }),
            // 子 agent 步数比主回合更紧：它只负责查清一件事，不该在里面长跑
            { maxSteps: Number(process.env.GB_SUB_MAX_STEPS ?? 6) },
          );

          parentWire.emit({
            type: 'subagent.start',
            task,
            tools: childTools.list().map((t) => t.name),
            ts: Date.now(),
          });

          const msgs = await child.runTurn(task, [
            // 子 agent 的提示词是全局常量，会列出 delegate 等它其实没有的工具；
            // 这里显式告知它的能力边界，免得它白白浪费步数去调用不存在的工具。
            {
              role: 'system',
              content:
                '你现在是一个只读子 agent：只能使用 read（读文件）、glob（找文件）、grep（搜内容）、fetch（抓网页）。' +
                '不能写文件、不能执行命令、不能联网搜索、也不能再 delegate。查清事实后直接给出结论。',
            },
          ]);

          const toolsUsed = childWire
            .history()
            .filter((e: WireEvent): e is Extract<WireEvent, { type: 'tool.call' }> => e.type === 'tool.call')
            .map((e) => e.call.name);
          const result = msgs.at(-1)?.content ?? '';

          parentWire.emit({
            type: 'subagent.end',
            result,
            toolsUsed,
            steps: toolsUsed.length,
            ts: Date.now(),
          });

          return {
            ok: true,
            content: `子 agent 完成（用了 ${toolsUsed.join(', ') || '无'}）：${result}`,
            meta: { action: 'delegated', command: task, added: toolsUsed.length },
          };
        },
      };

      ctx.tools.register(delegate);
    },
  };
}
