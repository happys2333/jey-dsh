# 已核实来源与适用范围

核对日期：2026-09-22。以下为官方文档、协议及项目自身源码。本文所有性能/验收阈值、架构选择、包名和自定义协议都属于新项目设计，不能据此说上游已经实现。未执行 DSH 安装、SemIf 推理、Jev API 或竞品测试。

## S01 · DSH 基线提交

https://github.com/deepseek-ai/deepseek-harness/commit/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61

GitHub 提交记录显示为 `release(dsh): 0.1.7-alpha.1`，时间 2026-09-22T04:12:33Z。用于确定本次设计参考基线，不保证用户已安装该版本或 npm 包在其网络下可获得。

## S02 · DSH 架构与贡献约束

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/architecture.md

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/AGENTS.md

支持插件/事件扩展、通过 profile 启动、宿主日志与模型可见内容一致等事实。编码 Agent 必须重新读取固定版本完整规则；本交接包不覆盖上游工作区规则。

## S03 · DSH 生命周期

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/agent-lifecycle.md

固定源码检索明确展示 `system-prompt/assemble` 先于 `agent/pre-step`。本方案据此提出时序一致性测试，不声称已经复现竞品运行故障。

## S04 · DSH 工具流水线

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/tool-execution-pipeline.md

支持 pre/approval/guard/execute/post/finalize/result 的位置关系、最终结果观察与 PTC 分派的说明。

## S05 · DSH 工具接口

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/subsystems/tools.md

核对了 output schema、冻结参数、同步 guard、restriction 作用域、最终同步 tools/result、取消与调用身份。注意：DSH 的工具 JSON Schema 子集不等于完整 JSON Schema；核心/MCP schema 应在宿主边界做支持子集映射与运行时检查。

## S06 · DSH 提示/工具组装

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/subsystems/system-prompt.md

https://github.com/deepseek-ai/deepseek-harness/blob/c36a83ff6bb95e3f82cf79f9be7c724270a8aa61/docs/user/develop/basic/index.md

支持 assembly 扩展点、上下文、模型工具投影和最小插件加载方式。并未提供本项目所需的全部现成“最终用户输入与动态路由”自动保证，需要真实探针。

## S07 · TypeSafe Quick start

https://docs.typesafe.ai/introduction/quickstart

用于确认官方端点和基本请求/响应结构。站点会变化，M0 记录检索日与契约 fixture，勿将演示 model 版本当成用户实际调用版本。

## S08 · TypeSafe API / primitives

https://docs.typesafe.ai/api

https://docs.typesafe.ai/primitives/choice

https://docs.typesafe.ai/primitives/noul

https://docs.typesafe.ai/primitives/score

用于核实三种问题、回答键、分布、Score 索引与错误状态。题型数量上限等供应商限制应由适配器能力声明与测试约束，不扩散为全项目硬编码。

## S09 · Confidence

https://docs.typesafe.ai/confidence

明确 provider confidence 是概率分布统计量，Noul 不带该字段。不支持“置信度等于动作正确/安全概率”的解读。

## S10 · SemIf 本地基线

https://github.com/TheoLeeCJ/SemIf/tree/1f2dea3e25379f9dfc98cb83c324f00ab5deda37

https://github.com/TheoLeeCJ/SemIf/blob/1f2dea3e25379f9dfc98cb83c324f00ab5deda37/README.md

独立实现、直接候选评分、后端路径、模型身份与量化边界。本方案不转述其评测数字为本项目结果；包装常驻 RPC 是本项目新增工作。代码和模型许可证分别核实。

## S11 · buberlo/dsh-jev 参考审查

https://github.com/buberlo/dsh-jev/tree/d2f77a1f68906d1576caaa8aa22be65913905d19

https://github.com/buberlo/dsh-jev/blob/d2f77a1f68906d1576caaa8aa22be65913905d19/packages/dsh-jev/src/adapters/pre-step.ts

https://github.com/buberlo/dsh-jev/blob/d2f77a1f68906d1576caaa8aa22be65913905d19/packages/dsh-jev/src/adapters/assessment.ts

https://github.com/buberlo/dsh-jev/blob/d2f77a1f68906d1576caaa8aa22be65913905d19/packages/dsh-jev/src/service.ts

本次定向核对，不等于完整审计。R-01/R-02/R-03 为源码观察引出的验证目标，未运行竞品复现。README 本身也区分回放与实时重新规划，不应误述为作者没有这项说明。

## S12 · MCP Tools 协议

https://modelcontextprotocol.io/specification/2025-11-25/server/tools

用于工具发现、调用、结构化输出和错误分类。该协议不保证任意宿主提供自动拦截其余工具的能力。本项目固定实现版本，不能擅自声称它是今日最新全部协议。

## S13 · GitHub Actions 安全

https://docs.github.com/en/actions/reference/security/secure-use

用于最小权限、依赖固定和不可信代码边界。具体 Action SHA 与 runner 版本由实现时查询官方仓库确定，不使用杜撰的固定 SHA。

## S14 · GitHub Actions 工件

https://docs.github.com/en/actions/tutorials/store-and-share-data

支持保存测试/构建产物、明确路径与保留期。工件保存成功不是内容正确性的证明。

---

## 未核实/未执行事项

npm 名称可用性与所有包的发布状态、用户实际硬件和模型缓存、Jev API 凭据/余额、本地或云端真实质量、用户目标上传仓库、GitHub 写权限、任何生产环境。它们进入 M0 或条件 gate，不用假设填补。
