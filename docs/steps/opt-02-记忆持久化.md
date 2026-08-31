# 优化 02 · 记忆持久化（落盘 JSON，跨会话记得）

> Step5 的记忆只活在内存里——进程一退就全忘了。这一步把它**落盘**：记忆存到 `.glassbox/memory.json`，下次启动自动加载，真正做到"跨会话记得"。

---

## 1. 一句话理解这一步

之前你告诉 agent「记住项目用 Gurobi」，关掉再开，它就忘了。
现在：这条记忆会写进磁盘文件，**下次启动一个全新的进程，它依然记得**，并能在你问相关问题时检索出来。

实测（两个独立进程）：
```
运行1：记住这个项目用 Gurobi 求解器   → 蒸馏 +1，落盘
运行2（新进程）：Gurobi 怎么配置       → 载入 1 条历史记忆 → 检索注入
```

---

## 2. 存到哪、存什么

- 位置：工作区下的 **`.glassbox/memory.json`**（已加入 `.gitignore`，不会被提交）。
- 内容：完整的两层记忆——`l0`（原始对话记录）+ `atoms`（蒸馏出的 L1 原子）：

```json
{
  "version": 1,
  "l0":   [ { "ts": ..., "role": "user", "text": "记住这个项目用 Gurobi 求解器" } ],
  "atoms":[ { "id": "...", "kind": "fact", "text": "这个项目用 Gurobi 求解器", ... } ]
}
```

`version` 字段是给未来留的：万一以后格式变了，可以据此做迁移。

---

## 3. 什么时候读、什么时候写

- **读（加载）**：在 `Memory.init()` 里——启动时若文件存在就读进来，并广播新事件 `memory.loaded`（带加载条数），日志/面板会显示「载入 N 条历史记忆」。
- **写（落盘）**：每次回合结束、蒸馏出新原子后（`onTurnEnd`）立即保存。demo 量级同步写文件足够，不搞防抖。

一个和前面一致的小心思：加载放在 `init()` 而非构造函数里。因为 `memory.loaded` 是要广播的事件，必须**等订阅者就位后再发**（Step2/Step4 那个"先订阅后触发"的教训）——所以 `buildApp` 的 `init()` 里在插件加载、skills 广播之后，也调一次 `memory.init()`。

---

## 4. 职责划分：Store 管数据，Memory 管 IO

- `MemoryStore` 只关心"数据结构"：新增 `toJSON()` / `loadJSON()` 两个纯序列化方法，不碰文件系统。
- `Memory` 负责"编排"：文件读写、路径创建、事件广播都在这里。

这样 `MemoryStore` 保持纯粹、好测；文件 IO 的副作用集中在一处。

---

## 5. 开关与配置

- 默认开启持久化，路径 `<workspace>/.glassbox/memory.json`。
- `GB_MEM_PERSIST=0` → 关闭持久化（纯内存，适合一次性演示/测试，不留痕迹）。

```bash
GB_LLM=fake node src/index.ts "记住这个项目用 Gurobi 求解器"
GB_LLM=fake node src/index.ts "Gurobi 怎么配置"          # 新进程仍记得
GB_MEM_PERSIST=0 node src/index.ts "..."                 # 不留痕迹
```

---

## 6. 新增/改动文件

```
src/memory/store.ts   # +toJSON() / loadJSON()（纯序列化，不碰文件）
src/memory/memory.ts  # +persistPath；init() 加载 + 广播 memory.loaded；onTurnEnd() 后 save()
src/engine/types.ts   # +wire 事件 memory.loaded
src/app.ts            # 组装持久化路径；init() 里调 memory.init()；支持 GB_MEM_PERSIST=0
src/index.ts / tui/renderer.ts  # 展示"载入 N 条历史记忆"
test/persistence.test.ts        # 新增：落盘→新实例加载→可检索；memory.loaded 条数
.gitignore            # 忽略 .glassbox
```

---

## 7. 回归测试

新增 2 条持久化用例，跑了全量：`npm test → 18 passed / 0 failed`。老的 16 条一条没退化。

---

## 8. 下一步（优化 03 预告）

**精确编辑工具 `edit_file`**：现在只有 `write_file`（整文件覆盖），太粗暴。加一个 search/replace 式精确编辑工具，并在审批时**显示 diff**，呼应 Claude Code / codex 的 edit 工具设计。
