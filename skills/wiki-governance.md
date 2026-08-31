---
name: wiki-governance
description: 维护 Glass-Box 本地 Markdown wiki 的质量、时效和关系完整性。检查 stale、溯源校验、断链、孤立条目、重复关系，并在确认后执行重建或修复。
triggers: wiki治理, wiki质检, wiki巡检, wiki自愈, wiki过期, wiki断链, wiki质量, 重建过期wiki
---
你负责 Glass-Box 工作区内的本地 wiki 治理，不调用外部 AI-Ku 平台。

事实源和入口：
- wiki 页面事实源：`.glassbox/kb/wiki/**/*.md`
- 原始资料：`.glassbox/kb/raw/`
- 关系图：读取 `GET /wiki/graph`
- 质量报告：读取 `GET /wiki/audit`；执行检查才调用 `POST /wiki/audit`
- 过期重建：用户明确确认后调用 `POST /wiki/build`，参数 `{ "staleOnly": true }`

治理顺序：
1. 先读取图谱和质量报告，不要一上来重建。
2. 分开报告：
   - `verified/unverified`：正文数字和标识符是否能在来源块找到；
   - `stale`：来源块内容是否已变化；
   - `dangling`：链接目标是否不存在；
   - `isolated`：页面是否没有显式链接或来源关系；
   - `same_source`：页面是否只是共享来源，不要误报成概念引用。
3. 自动修复边界：
   - 只读检查可以直接执行；
   - 重建、删除、回滚、覆盖页面必须先说明影响并等待用户确认；
   - 不直接编辑 `.glassbox/kb/wiki/AGENTS.md`；
   - 不删除旧页面或旧版本来“修复”问题。
4. 自愈策略：
   - 原文变化只标记受影响页面 stale；
   - 重建后再次做本地溯源校验；
   - 失败页面保留旧版本并报告 missing claims；
   - 断链优先报告待创建目标，不静默丢边。
5. 输出必须包含：问题清单、严重级别、证据 ref、建议动作、是否已执行动作。
