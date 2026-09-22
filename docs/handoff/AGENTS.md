# Agent execution contract

本目录是 ADL 的技术交接资料，不是已完成插件。用户目标是实现、测试、打包并在明确授权时上传整个项目，不是继续给出泛泛建议。

## 阅读顺序

先读 README_CN.md、docs/01_TECHNICAL_SPEC_CN.md、docs/02_IMPLEMENTATION_PLAN_CN.md、docs/03_TEST_AND_EVALUATION_CN.md、docs/04_DELIVERY_AND_UPLOAD_CN.md。事实来源在 docs/05_SOURCES_CN.md；机器任务在 contracts/tasks.json。

## 必须遵守

- 检查工作区已有规则和未提交改动，不覆盖用户文件。若在已有仓库中，保留原 AGENTS.md 并合并适用指令，不直接替换。
- M0 首先确认固定 DSH 宿主合同，禁止虚构 API 或通过 any/禁用检查隐藏不兼容。
- 按里程碑写真实代码和测试，不用 echo PASS、Mock 或旧报告冒充真实推理。
- Observation、PolicyDecision、ExecutionOutcome 分离；AI 不能增加权限。
- 默认禁止外发，shadow 不等于离线；没有授权不能自动切换云端、下载大模型或付费调用。
- 不把源码最新分支与已发布旧包混装；不打包宿主共享运行时副本。
- 核心不依赖 DSH；MCP 不冒充其他宿主原生拦截。
- 每一步记录具体命令和产物；失败修复后绑定新 commit 重新验证相关 gates。
- 全部关键 gate 使用 PASS/FAIL/BLOCKED/SKIPPED 区分。真实质量不通过就保留 shadow，不修改测试集凑结果。
- 外部条件阻塞只阻塞相关步骤，继续剩余本地任务。
- 上传必须匹配用户明确授权的 owner/repo、分支和操作，不自动新建公开仓库、发上游 PR、publish 或 force push。

## 并行

contracts 和 HOST_CONTRACT 稳定后，可并行 core、provider、adapter、test 工作；变更公共契约须由主 Agent 合并。安全审查采用独立任务，不让实现者凭主观声明验收自己。

## 完成

交回完整源 SHA、构建包、工程与真实模型结果、离线证据、对照实验、已知问题、公共证据包和准确上传状态。没有运行的步骤写 BLOCKED/NOT_RUN。scripts/validate_evidence.py 只是文件/声明校验，不是测试 runner 或质量证明。
