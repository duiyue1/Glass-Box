import type { Plugin } from '../engine/plugin.ts';
import { safeAssess, type Tool } from '../engine/types.ts';
import { formatPlan, MAX_ITEMS, type PlanResult, type PlanStore } from '../plan/plan.ts';

/**
 * plan 插件：把任务计划变成模型可以调用的工具（对标 Claude Code 的 TodoWrite）。
 *
 * 只有一个工具，三个互斥的用法：
 *   task_plan({ steps: "读现状\n改 loop\n补测试" })  建立/替换计划
 *   task_plan({ doing: 2 })                          开始做第 2 步
 *   task_plan({ done: 2 })                           第 2 步做完
 *
 * 是 safe 工具：它不碰文件、不执行命令，只改一份清单，没有审批的必要。
 * 返回内容里**总是带上完整清单**——模型下一步要判断"还剩什么"，
 * 让它自己记不如每次给它看。
 */
export function planPlugin(store: PlanStore, onUpdate?: (op: string, res: PlanResult) => void): Plugin {
  const reply = (op: string, res: PlanResult) => {
    onUpdate?.(op, res);
    const body = formatPlan(res.items);
    return { ok: res.ok, content: body ? `${res.message}\n${body}` : res.message };
  };

  return {
    name: 'plan',
    setup(ctx) {
      const taskPlan: Tool = {
        name: 'task_plan',
        // 纯记账，不占回合步数上限
        free: true,
        assess: safeAssess,
        description:
          `记录并推进任务计划。适合需要三步以上、跨多个文件的活；一两步就能做完的别用它。` +
          `steps 给完整计划（一行一步，最多 ${MAX_ITEMS} 步），可以同时带 doing 直接开工；` +
          `done 标记做完某一步，也可以同时带 doing 接着做下一步（done 和 steps 不要一起给）。` +
          `计划会在之后每一回合自动出现在上下文里，不用重复复述。`,
        parameters: {
          type: 'object',
          properties: {
            steps: { type: 'string', description: '完整计划，一行一步。会替换原计划（同样文本的步骤保留已有状态）' },
            doing: { type: 'number', description: '把第几步标记为进行中（可以和 steps 一起给）' },
            done: { type: 'number', description: '把第几步标记为已完成' },
          },
        },
        run(args) {
          const steps = typeof args.steps === 'string' ? args.steps : '';
          const doing = args.doing === undefined ? undefined : Number(args.doing);
          const done = args.done === undefined ? undefined : Number(args.done);
          if (!steps.trim() && doing === undefined && done === undefined) {
            return {
              ok: false,
              content: `task_plan 要给一个参数：steps / doing / done。当前计划：\n${formatPlan(store.list()) || '（还没有计划）'}`,
            };
          }
          // 只有 steps 和 done 不能混：done 的序号指"改动前那份计划"，
          // 和整份替换同时给的话指哪份说不清。
          // doing 可以和任何一个搭配——`done:1, doing:2`（干完一步接着下一步）
          // 和 `steps + doing`（建完计划顺手开工）都是模型最自然的用法，实测都发生过，
          // 之前一律拒掉等于每次白烧一步。
          if (steps.trim() && done !== undefined) {
            return { ok: false, content: 'steps 和 done 不要一起给：done 的序号指的是改动前那份计划' };
          }
          if (doing !== undefined && !Number.isInteger(doing)) {
            return { ok: false, content: 'doing 要是步骤序号（整数）' };
          }
          if (done !== undefined && !Number.isInteger(done)) {
            return { ok: false, content: 'done 要是步骤序号（整数）' };
          }
          // 顺序固定：先建计划 / 先收尾上一步，再开工下一步。
          // 这样 "同时只能一个 doing" 的约束不会把 done+doing 这种正常用法误伤。
          const ops: { op: string; res: PlanResult }[] = [];
          const finish = () => {
            // 中间的操作各发一次事件，最后一条交给 reply（它自己会发）
            for (const o of ops.slice(0, -1)) onUpdate?.(o.op, o.res);
            const last = ops.at(-1)!;
            return reply(last.op, last.res);
          };
          if (steps.trim()) {
            ops.push({ op: 'steps', res: store.setSteps(steps) });
            if (!ops.at(-1)!.res.ok) return finish();
          }
          if (done !== undefined) {
            ops.push({ op: 'done', res: store.mark(done, 'done') });
            if (!ops.at(-1)!.res.ok) return finish();
          }
          if (doing !== undefined) {
            // doing 失败时前面的改动已经生效了，如实把失败返回去，让模型看到具体原因
            ops.push({ op: 'doing', res: store.mark(doing, 'doing') });
          }
          return finish();
        },
      };
      ctx.tools.register(taskPlan);
    },
  };
}
