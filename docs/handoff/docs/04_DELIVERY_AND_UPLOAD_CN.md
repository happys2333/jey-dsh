# 构建、CI、证据打包、授权上传与回传

## 1. 三种“上传”必须分开

**上传源代码**是将经过审查的 commit 推送到用户指定仓库分支；**上传测试证据**是保存脱敏报告/日志与构建包；**正式发布**是 npm/GitHub Release 等公开分发。前两项授权不自动包含第三项。

本次任务交付技术方案和本地 Agent 流程，没有实际上传任何仓库、创建 PR、发布 npm 或访问生产系统。`templates/upload-plan.example.json` 默认全部关闭。编码 Agent 只能根据用户明确授权填写目标，不能推断 GitHub 用户名等同于所有仓库或 npm scope 的授权。

## 2. 产物清单

```text
artifacts/review/<run-id>/
  evidence.manifest.json       # 该目录下文件的精确索引与哈希
  summary.md                  # 人能读的结果，不夸大结论
  compatibility.json          # 宿主和关键依赖版本
  environment.json            # 脱敏环境、硬件、模型标识
  reports/*.json              # 逐 gate 汇总与实际测试统计
  logs/*.log                  # 脱敏命令输出
  eval/*.jsonl                # 允许公开的逐行评测输出
  packages/*.tgz              # 精确构建产物，可选
  dependency-report.json      # 依赖、许可证、已知风险
  checksums.txt
```

完整用户对话、真实客户日志、源凭据、SSH key、`.env`、DSH home、模型权重、tokenizer 私有缓存、node_modules 不进入证据。证据包中只纳入已经复制到公共 staging 目录并审查的 allowlist 文件。

manifest 不记录自己的 SHA，避免自引用。可以记录全部 artifacts 的哈希，随后在外部为整个 zip 生成 SHA-256。诊断失败也能打包，但用 collection profile，不贴合格标签。

## 3. 证据校验与本地打包

以下两个命令在**本交接包中已经提供**；它们是 Python 标准库工具，不依赖项目实现。`artifacts/review/...` 是未来真实测试生成的目录，不在本包内伪造成功样例。

```bash
# 校验证据结构，不宣称全部通过；适合失败/阻塞回传。
python scripts/validate_evidence.py artifacts/review/RUN/evidence.manifest.json --profile collection

# 只有完整工程结果均通过时才成功。
python scripts/validate_evidence.py artifacts/review/RUN/evidence.manifest.json --profile engineering

# 要宣称“本地可用且质量达标”，还要求真实本地、断网和质量证据。
python scripts/validate_evidence.py artifacts/review/RUN/evidence.manifest.json --profile local-qualified

# 本地打包；只会读 manifest 明确列出的文件，不会上传。
python scripts/pack_evidence.py artifacts/review/RUN/evidence.manifest.json \
  --profile collection --output artifacts/adl-review-RUN.zip
```

校验器只检查声明、kind、必需 gate、路径与 SHA；不能证明日志没造假，也不分析真实代码质量。需要可重放命令、原始输出、runner 与人工审查支撑。它也不是完整 secret scanner；打包前必须另跑 `adl:scan` 并审查压缩包内部文件。

## 4. CI 实施规范

### 4.1 默认工程流水线

push/PR（仅受支持分支）触发：checkout 固定 revision → 按锁定 Node/pnpm 安装 → frozen-lockfile → typecheck → unit/property/provider contract → 真实 DSH keyless integration → MCP/security/lifecycle → build/pack-install → secrets scan → evidence generation → engineering 校验 → artifact 上传。

真实模型和云端推理不作为普通外部 PR 默认动作。外部 PR 不给云端凭据、不在高权限自托管 runner 运行未审查代码、不使用能让不可信 PR 代码取得 secrets 的触发方式。Action 固定完整提交 SHA；最小 `contents: read` 权限，单独授权发布 job。[S13]

工程报告无论成功或失败都生成；但失败时上传只使用 collection 状态，且 job 仍失败，不能通过 `continue-on-error` 伪装通过。

### 4.2 真实本地模型流水线

显式 `workflow_dispatch` 或用户授权本地命令执行。先确认缓存模型身份，再限制外网；不得在断网测试中临时下载模型。预置服务的 OS/GPU/驱动、模型/量化、tokenizer、模板均记录。公共云 runner 无足够内存/GPU时不强行声明通过。

`local-qualified` gate 不能仅靠 `curl localhost/health`。必须获得真实推理输出并证明外部联网被禁；质量实验使用冻结数据与基线。

### 4.3 云端流水线

使用显式预算、专门测试凭据、synthetic/已授权数据。费用上限与调用次数预留在脚本中实施，secret 只通过受保护机制注入。无凭据退出 BLOCKED，不自动用另一个环境变量中的云 key。

### 4.4 工件

GitHub Actions artifact 用于保存测试输出，名称必须含 run/commit 与 profile，设置明确保留期，并只上传公共 staging，不使用仓库根通配。上游官方文档支持上传测试/构建 artifacts 和保留期设置。[S14]

正式 release 的下载包必须对应通过测试的同一个 SHA。测试完又改文件/重打包，需要重新验证包哈希和安装门槛，不能“测试旧包、发布新包”。

## 5. 上传前置检查

本地 Agent 在 `adl:delivery` 中输出 dry-run 计划，至少包括：

- 目标仓库 `owner/repo`、对应 remote URL、目标分支、源 commit；
- 准备推送的 commits/files、待上传工件与 SHA；
- 是否创建 PR、release、npm（分别授权）；
- 数据 classification、秘密扫描结果、排除项；
- 已通过/失败/阻塞的 gates 和最终声明等级。

工作区 dirty 时不能使用旧 PASS 报告。代码提交之后生成证据，报告绑定该 commit；证据目录不再作为该 commit 的必需内容，以免反复自引用。证据通过 Actions artifacts 或后续独立报告提交保存，明确源代码 SHA。

## 6. 授权后的代码上传算法

1. 读取本地可信 `upload-plan.json`，默认未授权；检查目标不是占位符，分支不是保护分支，操作类型与用户意图一致。
2. `git status --short`、`git remote -v`、`git log` 检查环境，不输出 token-bearing URL；使用已有凭据工具确认访问，不读取/显示 token 值。
3. 校验 manifest 与当前 commit 一致、包哈希一致、secret scan通过，展示干运行清单。
4. 仅向授权 remote 的新功能分支推送当前 commit。默认不 push main/master，不 force，不自动 merge，不重写他人提交。
5. 用户授权 create_pr 时再创建 PR，正文包含做了什么、测试命令与结果、已知限制和 artifact 引用。仅在用户明确授权目标上游时才向第三方项目提 PR。
6. 读取远端 commit 验证 SHA；读取对应 workflow。未结束就记 PENDING，失败则回传具体 job，不能把 push 成功写成 CI 通过。

精确 CLI 参数由编码 Agent 在当前安装版本 `--help` 核对后使用；不能让 README/模型输出拼接成任意 shell。用户只给了“上传流程”而没指定仓库时，停止第 4 步，完成其他全部本地产物。

## 7. 没有仓库或凭据时

生成源码压缩包或 `git bundle`，以及独立的公共证据 zip。源码包来自明确白名单或 Git tracked 文件，不能递归压缩整个 home；git bundle 前确认提交历史没有秘密，不能只扫描当前文件。

报告写 `UPLOAD=BLOCKED_TARGET_NOT_CONFIGURED` / `BLOCKED_AUTH`，并保留可上传产物。禁止捏造 GitHub URL；禁止说“稍后自动上传”。

## 8. 最终回传格式

```text
项目：agent-decision-layer
源代码提交：完整 SHA
固定 DSH：版本 + SHA
工程验证：PASS / FAIL / BLOCKED
本地推理：PASS / FAIL / BLOCKED（模型/硬件）
严格离线：PASS / FAIL / BLOCKED
语义质量：PASS / FAIL / INCONCLUSIVE
系统收益：PASS / FAIL / INCONCLUSIVE
官方 Jev：PASS / FAIL / BLOCKED
安装包：路径 + SHA
证据包：路径 + SHA
上传：NOT_REQUESTED / BLOCKED / PUSHED / CI_PENDING / VERIFIED
已知问题：具体问题、影响、复现命令
```

随后提供失败样例与下一轮最小修复范围。不要只回复“全部运行成功”。

## 9. 回滚

每次安装保存用户原 profile 配置的受控备份，明确自己创建/修改了哪些条目。卸载只移除本插件项及其拥有的资源，不清理全局缓存或用户会话。回滚使用前一已验证 tarball 与对应配置；新格式本地审计保留只读，不能删除以掩盖异常。

生产部署/客户环境不属于此研发验证流程。该技术规格不授权任何生产操作。
