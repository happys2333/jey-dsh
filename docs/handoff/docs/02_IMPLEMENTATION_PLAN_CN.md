# 本地 Agent 开发执行计划

**用途：** 从空目录或已有安全工作区完成 ADL，而不是只继续写文档。技术规格为 `01_TECHNICAL_SPEC_CN.md`。此包不是项目实现；下述 `pnpm adl:*` 是编码 Agent 必须实现的统一命令契约，目前不能直接在此交接包运行。

## 1. 执行规则

先阅读工作区已有 `AGENTS.md` 并检查未提交改动，不覆盖用户文件。不确定的宿主 API 必须从固定源码和真实安装包核实；不得按概念名猜函数。每个里程碑交付可测试增量，小提交、清晰 diff。测试失败先修实现，不能改测试以掩盖违反规格的行为。

可让多个子 Agent 并行编写不同模块，但主 Agent 负责契约和集成。M0、公共类型和测试接口稳定前不并行写宿主适配器。安全审查与实现者尽可能分离；同一个模型自评不是独立质量证据。

没有密钥或 GPU 时继续完成可执行模块、CPU 探针与报告。没有实际权重/预算时记录相应 gate BLOCKED，不能写 Mock 假装真实。没有远端写入授权时只生成本地包，不能自动创建公开仓库或 npm 发布。

## 2. 里程碑

### M0：环境和宿主合同（必须最先）

目标：确定真实环境及最小可加载路径。读取 `contracts/sources.lock.json`，克隆到项目受控 `.upstream/`，不要在现有宿主源码工作区直接改动。

记录 OS、架构、Node、pnpm、Python、可用 RAM/磁盘/GPU/驱动；不把完整环境变量写进报告。Node 优先选择满足固定宿主要求的已安装版本；不能悄悄修改全局版本或用户 profile。

核实：DSH `package.json` engines 和包发布状态、Cordis peer 要求、插件 manifest、CLI 管理命令、源码/构建导入方式、输出 schema DSL、审批服务行为、必要事件顺序。运行 `dsh --help` 和插件子命令 help，保存脱敏输出。

最小探针必须使用临时 DSH home 和临时 workspace，并通过固定版 `dsh` launcher 启动。注入一个仅记录事件顺序的 probe 和一个无副作用测试工具。使用 keyless 的测试模型适配器或固定响应驱动器，让真实 agent loop 产生工具调用。不得只手动调用回调函数声称完成宿主集成。

产物：`docs/HOST_CONTRACT.md`、`artifacts/environment.json`、`artifacts/compatibility.json`、关键 schema 快照、最小启动/卸载日志。包含确切 import、注册/卸载代码、持久日志和实际模型请求观察点。

验收：`compatibility` PASS。证明源固定且打包运行时版本一致；所有计划使用的接口已编译并至少 smoke 一次。若源码和 npm 不匹配，选固定源码 build 作为测试基线并说明不能声称 npm 已兼容。

### M1：类型、纯策略和输入边界

实现 `packages/contracts`、`core`，使用本包 `contracts/core-types.ts` 为起点但建立真实 runtime validation。JSON Schema 和类型同源生成；外部 JSON 一律先验证。建立正常/缺失/无效/超大输入测试。

实现 Observation 与 PolicyDecision 分离、模式、逐功能配置、TaskEnvelope、快照版本、结果有效性、错误类别、策略合并表、预算预留、单元/属性测试。

硬拒绝与用户取消不依赖模型。必要问题缺失、未知状态、非有限数值不能落入默认通过分支。批量请求中一个题错误，不得丢掉错误标志。

产物：纯模块、测试、配置 schema、示例和第一版审计记录。验收：`typecheck`、`unit`、`property` PASS；核心代码不能 import DSH/Cordis/MCP/Python。

### M2：DSH 最小原生闭环

先做 `off → shadow → test-only enforce`，只使用显式 synthetic provider。实现作用域化资源、pre-execute 异步检查、最终硬 guard、result 同步观察、task 状态与 dispose。保留所有原决定和取消信号。

优先测试：宿主 deny/ask、无审批通道、agent-less 调用、用户中途取消、HMR、同名 scoped 工具、PTC 嵌套、已有插件限制以及异常返回。未分类的 agent-less 受保护调用不应绕过检查；可配置不适用的受信系统维护调用，但必须显式 allowlist。

在 `agent/pre-step` 包装中保存最终返回的 enter messages，并保留 `startsRequestSeries` 等字段；注意仍有其他 outer listener 可改写，因此对支持组合做最终请求对照，不声称读取到了不可更改的“绝对最终”用户输入。

实现只读 doctor。工具推荐先做建议，不用 `ctx.tools.restrict()` 偷改宿主能力。可选筛选先列能力 gate，只有实际请求快照测试通过才启用。

产物：DSH 插件构建、临时 profile、可复现 smoke。验收：`host-integration`、`lifecycle` PASS；无全局实例、无第二份宿主运行时。

### M3：官方与本地提供方

云端：实现 TypeSafe HTTP Adapter、错误映射、有限重试、body 上限、重定向保护、外发审批。用录制结构/本地 HTTP fake 做 provider contract，不把它叫真实 Jev 调用。

本地：固定 SemIf 源码与模型/量化/tokenizer 文件身份。选择用户已有可运行硬件路径，至少完成 CPU 或 GPU 中的一种，不必同时实现全部平台。先重现上游 direct scorer，再实现常驻 Python 服务；本地客户端使用本项目 RPC，不假造“OpenAI-compatible 就一定能拿到所有 logits”。

实现队列、health、readiness、取消、worker 生命周期、超大输入、模型缺失以及离线模式。在没有模型缓存时先报告下载大小与许可要求，不自动开始未授权的大模型下载；有授权时完成下载锁定，并与离线运行分开。

产物：真实 local provider、Jev provider、运行说明、模型锁与自测。验收：`provider-contract` PASS；有条件时 `local-inference`、`local-offline` PASS；`cloud-inference` 按凭据和预算单独判定。

### M4：MCP、推荐和恢复

共享核心，不复制安全政策。在 stdio 提供三个工具，输入输出协议测试、初始化、list/call、取消、stderr 和错误码完整。MCP 的模型输入只拥有判断请求权限，不能转成宿主可信政策。

实现工具多标签排序建议、无合适候选、关键基础能力保留、目录变化与空候选。恢复仅撤销本插件自己的建议/展示掩码。

产物：独立 MCP 包和安装配置。验收：`mcp-contract` PASS；必须由真实 MCP 客户端进程调用，不仅测 handler 函数。

### M5：安全、并发和故障注入

执行安全测试矩阵，特别是 ask 被插件顺序改变、过期结果、跨会话泄漏、模型异常、取消 drain、无限注入上下文、超出预算、恶意候选描述、路径与秘密泄漏。

将不可保证的边界写进 SECURITY.md：同进程恶意插件、管理员直接命令、基础模型提示注入、外部状态竞态、未覆盖平台。不得把失败边界删掉以显得“安全”。

产物：安全审查与故障回归。验收：`security`、`lifecycle`、`secret-scan` PASS，公开证据无真实敏感数据。

### M6：真实质量与收益实验

固定评测协议后再跑 test split。实现规则基线、同本地模型生成式基线、ADL direct-logit 路线；官方 Jev 作为可选对照。语义标签来自可验证任务规范或人工复核，不把 Jev 的结果当唯一真值。

工程基线测试与真实评测分离。运行至少 30 个不同任务的探索批次，再按发布目标扩展；达不到统计门槛报告 inconclusive，不能从演示样例直接宣称总体提升。

产物：raw rows、标签/切分 hash、预测、耗时/用量、bootstrap 区间、失败样例、decision log 摘要。验收详见测试文档。质量 gate 未通过时仅发布 shadow/建议能力的候选版，不能叫 local-qualified。

### M7：打包、安装和 CI

构建 DSH/MCP tarball，检查运行时 external/peer 关系、必要文件、无源码路径依赖和密钥。使用新临时 home 从 tarball 安装，跑 doctor、一次调用、重启、卸载、重新安装与回滚。

CI 默认无云密钥，安全测试不得关闭。真实模型/云端测试由显式 workflow_dispatch 或受控 runner 运行。所有 Actions 固定完整提交 SHA；M0/实施时核实真实 Action 版本，不编造 SHA。

产物：安装包、checksums、SBOM/依赖清单、兼容表、CI 日志、证据包。验收：`pack-install` PASS，证据校验通过，产物能够独立安装。

### M8：授权上传与回传

按 `04_DELIVERY_AND_UPLOAD_CN.md` 执行。仅在上传计划明确授权的仓库/分支执行 push。没有目标时完成本地 zip 和 git bundle，不猜仓库、不给第三方自动开 PR。

GitHub 上传成功后还要核实远端 commit、workflow 和 artifacts；pending 是 pending。把下载/commit/PR 地址回传，但不得宣称远端尚未结束的测试已经通过。

---

## 3. 必须实现的统一命令

所有命令非交互、退出码真实、输出 JSON 摘要以及脱敏日志。缺少必需条件时明确 blocked，不能 shell `|| true`。

| 命令 | 工作内容 | 证据 gate |
|---|---|---|
| `pnpm adl:doctor` | 环境、依赖、能力与提供方配置，只读 | compatibility 的环境部分 |
| `pnpm adl:probe:dsh` | 真实固定宿主事件与 schema 探针 | compatibility |
| `pnpm adl:typecheck` | 所有 TS 严格检查、Python 类型/语法检查 | typecheck |
| `pnpm adl:test:unit` | 纯模块单测 | unit |
| `pnpm adl:test:property` | 策略代数和并发状态性质 | property |
| `pnpm adl:test:providers` | wire contract / 本地 fake HTTP / 错误 | provider-contract |
| `pnpm adl:test:dsh` | 真实 DSH 生命周期和工具执行 | host-integration |
| `pnpm adl:test:mcp` | 真实 MCP 客户端与进程 | mcp-contract |
| `pnpm adl:test:security` | 外发、注入、权限、路径 | security |
| `pnpm adl:test:lifecycle` | cancel/HMR/worker/并发 | lifecycle |
| `pnpm adl:test:local` | 真实本地权重推理 | local-inference |
| `pnpm adl:test:offline` | 模型预置、禁止外网后真实推理 | local-offline |
| `pnpm adl:test:cloud` | 显式预算内真实 Jev 请求 | cloud-inference |
| `pnpm adl:eval:baseline` | 固定工程基线与评测管线自检 | baseline-eval |
| `pnpm adl:eval:semantic` | 锁定标签的语义质量评测 | semantic-eval |
| `pnpm adl:eval:system` | 任务完成/成本/时延对照 | system-eval |
| `pnpm adl:build` | 构建所有部署入口 | pack-install 前置 |
| `pnpm adl:test:pack` | tarball 全新安装/卸载 | pack-install |
| `pnpm adl:scan` | 源码、包和公共证据秘密检查 | secret-scan |
| `pnpm adl:evidence` | 汇总已有结果，不伪造测试 | 生成 manifest |
| `pnpm adl:verify:engineering` | 运行工程集合并校验证据 | engineering |
| `pnpm adl:verify:local` | 工程 + 本地推理/断网/质量 | local-qualified |
| `pnpm adl:delivery` | 只生成本地上传预览和包 | 不自动上传 |

不要将命令的“存在”当成完成：脚本不能只 echo PASS，必须运行真实测试入口。将每个 gate 映射到命令、JUnit/JSON 报告、原始日志和精确 exitCode。

## 4. 本地执行编排建议

实现 `scripts/run-pipeline.mjs` 顺序驱动里程碑/测试，使用参数数组 spawn，不拼接来自仓库内容的 shell 命令。每阶段保存起止时间、git commit、dirty 状态、命令列表、退出码与证据路径。恢复时验证工件 hash 与当前代码版本；旧结果不能自动沿用到新 commit。

失败的必需工程 gate 终止 release 判定，但收集诊断和运行不依赖该失败的安全检查。失败后修复导致 commit 变化，相关 gate 重新执行。

本包 `scripts/validate_evidence.py` 是可运行的**证据结构和文件完整性校验器**，并不执行这些项目测试，也不证明报告内容真实。编码 Agent 需要实现真实测试 runner；校验器只作为第二道门。

## 5. 完成定义

不能以“代码写完”“Mock 可跑”“演示成功”“README 很完整”结项。最终至少回传：源 commit、依赖锁、安装包、真实宿主日志、工程 gate、真实本地模型身份与输出（或 BLOCKED 原因）、质量结果、失败清单、脱敏证据包、上传状态。

不要求在环境不允许时假装完成。要求把做到了什么与没做到什么准确分开，并继续推进剩余可以执行的工作。
