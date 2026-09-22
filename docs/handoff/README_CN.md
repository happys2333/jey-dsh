# ADL × DSH：技术设计与本地 Agent 执行交接包

**版本 1.0｜2026-09-22｜中文｜独立设计，不是官方 Jev / DSH 项目。**

这是一份用于**实现项目**的交接包，不是已经完成的插件。目标是：独立决策核心 + DSH 原生接入 + 官方 Jev 适配 + 至少一个真实本地推理后端 + MCP 工具入口，以及可核验的开发、测试、安装、打包、授权上传流程。

## 立即使用

解压到新的目录。把下面这段交给本地编码 Agent，或直接把 `START_LOCAL_AGENT_CN.md` 全文作为任务输入：

```text
阅读本交接包的 START_LOCAL_AGENT_CN.md 和 AGENTS.md，随后按 docs 中的技术规格、实施计划及 contracts/tasks.json 开始实现 ADL。
先完成固定版本的真实 DSH 合同探针，再实现核心、原生适配器、真实本地后端与 MCP。
实际运行测试，输出源码、安装包和脱敏证据；不要只继续写设计文档，也不要将 Mock、SKIPPED 或 BLOCKED 写成真实模型 PASS。
上传仅按我明确授权的目标执行；目标缺失时完成本地源码包和测试证据包，不猜仓库或擅自公开发布。
```

已有工作区的用户指令和未提交修改必须保留。交接包中的 AGENTS.md 是拟建项目规则，不授权覆盖其他仓库规则。没有密钥/权重/上传目标时继续其余开发，对缺少条件的部分如实标记阻塞。

## 文件索引

| 文件 | 用途 |
|---|---|
| `docs/01_TECHNICAL_SPEC_CN.md` | 主规格：目标、架构、DSH 边界、状态/并发、策略、提供方、权限、审计 |
| `docs/02_IMPLEMENTATION_PLAN_CN.md` | M0–M8 开发计划、统一命令、产物及完成条件 |
| `docs/03_TEST_AND_EVALUATION_CN.md` | 工程、真实模型、系统收益三层评测与准入门槛 |
| `docs/04_DELIVERY_AND_UPLOAD_CN.md` | CI、安装包、证据、源代码上传、授权、回滚和最终报告 |
| `docs/05_SOURCES_CN.md` | 已核实来源、固定提交、未确认事项及结论边界 |
| `docs/06_PROTOCOL_AND_CONFIG_CN.md` | 自定义本地 RPC、错误、配置、概率语义和 schema 映射 |
| `START_LOCAL_AGENT_CN.md` / `AGENTS.md` | 可直接给编码 Agent 的任务及工作规则 |
| `contracts/core-types.ts` | 独立 TypeScript 公共边界类型，无 DSH 运行时依赖 |
| `contracts/tasks.json` | 9 个里程碑及依赖；全部未开始，不是执行报告 |
| `contracts/test-matrix.csv` | 74 个必须实现的具体验收场景；全部 NOT_RUN |
| `contracts/sources.lock.json` | 参考宿主、SemIf 和参考审查代码的固定 SHA |
| `contracts/evidence.schema.json` | 公共证据声明结构；不证明内容真实性 |
| `templates/` | 默认关闭配置、上传计划、最终报告、故意未填的证据模板 |
| `examples/decision-cases.jsonl` | 10 个合成开发样例，不是独立质量测试集 |
| `scripts/validate_evidence.py` | 可运行：检查证据结构、gate、路径与哈希 |
| `scripts/pack_evidence.py` | 可运行：只打包 allowlist，不上传、不覆盖旧包 |
| `tests/` | 随包辅助工具和交接合同的自测，不是插件测试 |
| `HANDOFF_VALIDATION.md` | 本次实际完成的交接包检查、范围与未执行事项 |

参考 DSH 为 `0.1.7-alpha.1` 对应提交，不是“永远最新”。详见来源文档；实际发布包/依赖关系在 M0 再核实。

## 哪些现在能运行

本包的 Python 辅助工具仅需 Python 3.10+ 标准库。可以在交接目录执行：

```bash
python -m unittest discover -s tests -v
python scripts/validate_evidence.py --help
python scripts/pack_evidence.py --help
```

TypeScript 文件是类型合同，可用已安装的编译器检查：

```bash
tsc --strict --noEmit --target ES2022 --lib ES2022,DOM contracts/core-types.ts
```

文档中的 `pnpm adl:*`、Python 本地服务端点、DSH/MCP 安装包是**编码 Agent 接下来要实现的合同**；当前交接目录没有 package.json，也不提供可安装插件。不要在此目录直接运行尚未实现的产品命令。

## 证据模式

`collection`：只校验并收集已有结果，可以包含 FAIL/BLOCKED/INCONCLUSIVE；不代表工程合格。

`engineering`：必须有完整的工程 gate PASS，含真实 DSH keyless 集成、协议、故障和安装验证。它不证明真实模型有效。

`local-qualified`：工程通过之外，还要求同一真实本地提供方的权重身份、断网推理、语义和系统质量证据。

`cloud-qualified`：官方 Jev 的真实调用与质量证据；不能替代本项目要求的本地合格。

校验工具只能检查报告的声明与完整性，无法识破全部伪造日志。测试代码、原始输出、复现命令和独立审查仍是必要条件。模板故意不满足校验；不能把它填成几个 PASS 就当项目已经完成。

## 安全与上传默认值

默认 off，未配置 provider，不发起模型网络请求，不下载权重，不推送仓库，不发布 npm。模型和 cloud 的启用、外发用途、预算、远端写操作分别显式授权。脱敏不是外发许可，也不是保证识别所有秘密。

证据打包器只接收受控 public staging 目录；目录在校验/打包时不应有其他写者。它拒绝常见私密路径、符号链接和越界，不是针对恶意同账号进程的通用沙箱。打包前仍必须进行源码/工件秘密扫描与审查。

## 完成后回传什么

按 `templates/FINAL_REPORT_CN.md` 回传源代码 SHA、依赖/模型锁、工程 gate、真实推理和离线结果、质量/收益及失败样例、安装包、证据包和上传状态。事实不足时写 BLOCKED 或 INCONCLUSIVE，不把“代码已上传”写成“测试都通过”。
