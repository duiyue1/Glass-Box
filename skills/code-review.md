---
name: code-review
description: 代码审查的检查清单
triggers: review, 审查, cr, code review
---
做 code review 时按优先级检查：

1. 正确性：边界条件、错误处理、并发/竞态
2. 安全：注入、越权、密钥硬编码
3. 可维护性：命名、重复、过度抽象
4. 测试：关键路径是否有覆盖

先指出阻塞性问题，再提改进建议，最后给结论。
