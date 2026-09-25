# 线格式夹具

这些 JSON 的**字段名与数值形状**逐字来自官方 API 文档 `docs.typesafe.ai/api`（2026-09-23 检索）
中的响应示例；数值本身是供应商文档里的演示值，不是本项目真实调用产生的结果。

因此它们是契约夹具，不是执行证据：`cloud-inference` 仍是 BLOCKED（无凭据、无预算），
不能因为这里 3 个夹具解析通过就说真实云端验证过。

记录用途：适配器必须按字面形状校验 `model` / `answers` / `usage.input_tokens` /
`usage.output_tokens`，noul 无 `confidence` 字段，choice/score 有。
