# 本交接包的实际检查记录

日期：2026-09-22。**仅验证交接包、辅助脚本和拟定类型合同；不是 ADL 产品的测试报告。**

## 本次实际运行

| 命令/检查 | 结果 | 范围 |
|---|---|---|
| `python -m unittest discover -s tests -v` | PASS，53 tests，0 failures，0 skipped | 45 个证据校验/打包测试 + 8 个交接合同一致性测试 |
| `python -m py_compile scripts/validate_evidence.py scripts/pack_evidence.py` | PASS，退出码0 | Python 脚本语法 |
| `tsc --strict --noEmit --target ES2022 --lib ES2022,DOM contracts/core-types.ts` | PASS，退出码0 | 独立 TypeScript 公共接口，无宿主代码 |
| JSON/JSONL、任务 DAG、来源 SHA、默认配置检查 | PASS | 包含于上述8个合同测试 |
| 74 个项目验收场景状态检查 | PASS | 场景均为 NOT_RUN，没有伪造执行 |
| 未填写的 evidence 模板 | 按预期被拒绝 | 模板不是合格测试证据 |

自测原始输出见 `tests/HANDOFF_SELF_TEST_OUTPUT.txt`。临时测试 fixtures 中出现的 commit、模型身份和 PASS 是合成输入，用来检查校验器分支；它们不表示发生过真实项目测试。测试临时目录已清理。

运行环境：Python 3.13.5，TypeScript 5.8.3，Node v22.16.0。脚本设计最低 Python 3.10+，本次实际只在上述 Python/Linux 环境验证；未声称跨版本或 Windows 原生实测。

本次 Node 不满足文档所核对的 DSH Node 下限，因此没有尝试借助它进行真实宿主验证；TypeScript 合同编译不依赖 DSH。

## 本次没有执行

没有实现或安装 ADL 插件，没有运行 DSH 原生集成，没有加载 SemIf/其他真实模型，没有调用 Jev API，没有 GPU/严格离线质量评测，没有创建仓库、push、PR、GitHub Release 或 npm 发布。

`engineering`、`local-qualified`、`cloud-qualified` 的产品结果当前均为 **NOT_RUN**。辅助工具的测试通过不能替代这些结果。

## 校验工具的边界

验证器核对声明、必需 gate、kind、路径、大小和 SHA-256；不证明日志真实、不审核模型输出是否正确、不进行完整秘密扫描。打包器只从公共 allowlist 读取文件，不上传、不覆盖已有包。目录应在打包时冻结，仍需源码审查、独立运行、秘密扫描和最终上传授权。
