# Gate 状态

核对日期：2026-09-23。只记录本机实际执行过的命令；未执行的写 `NOT_RUN`，外部条件缺失的写 `BLOCKED`。工程 gate 通过不代表真实模型质量合格。

## M0 环境与宿主合同

| gate | 状态 | 证据 |
|---|---|---|
| compatibility | **PARTIAL** | `docs/HOST_CONTRACT.md`（逐条引用固定提交内文件行号）；`artifacts/environment.json`；`npm install --dry-run @deepseek-ai/dsh@0.1.7-alpha.1` 解析 512 包成功 |
| 真实插件加载探针 | **NOT_RUN** | 下一步：装 `@deepseek-ai/dsh@0.1.7-alpha.1`，用 `cordis.yml` overlay 加载并观察 `system-prompt/assemble → agent/pre-step → tools/pre-execute → tools/result` 顺序 |

已核实的事实（不是声明，是查过的）：

- DSH `0.1.7-alpha.1` = 提交 `c36a83f`，npm 已发布（tag `alpha`）。
- 交接包声称的 6 个扩展点全部存在于固定提交源码：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、`agent/pre-step`、`agent/request`、`system-prompt/assemble`。
- `tools/result` 是 `@mode emit` 且参数为 `Readonly`、返回 `undefined` → 只广播，不能改写结果。
- `systemPrompt.assemble()` 在 `agent.ts:271` 早于 `:275` 的 `agent/pre-step` → R-01 是宿主固有性质。
- `LlmCallConfig` 不含 `tools`；模型可见工具集只存在于 `PromptAssembly.tools`。
- TypeSafe/Jev 端点真实存在；SemIf 无 HTTP 服务；`buberlo/dsh-jev` 为 MIT。

## M1 核心

命令与结果（Windows / Node v24.15.0 / pnpm 9.15.9）：

```sh
pnpm install                 # 5 包，成功
pnpm -r typecheck            # 0 error（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
pnpm --filter jey-core test          # 35 tests, 35 pass, 0 fail
pnpm --filter jey-core test:property # 9 properties, 9 pass, 0 fail
```

| gate | 状态 | 覆盖 |
|---|---|---|
| typecheck | **PASS** | contracts + core，无 `any` 兜底，无 `@ts-ignore` |
| unit | **PASS** | 策略表 1 全 16 格、absorbing 行、硬规则、取消优先、必需题缺失、未校准不得 deny、陈旧快照、off/shadow 惰性；外发 deny 默认、local-only 精确 origin、allowlist 五条件、调用方不得指定传输参数；边界校验的路径收集 |
| property | **PASS** | Jey 永不放宽宿主决定；`allow` 结果只可能来自 `allow`+`abstain`；shadow/off 惰性；无观测时 enforce 不 abstain；放行必经已配置 origin/destination |
| 已实现模块 | — | `policy.ts`（§7.2 两张表）、`egress.ts`（§5.3）、`validate.ts`（§6.1 边界校验） |
| 未开始 | **NOT_RUN** | `QuestionCompiler`、`SnapshotBuilder`、`truncation`（§5.2）、`DecisionCoordinator`（§4.4/§10）、无进展检测（§9）、DSH schema 子集映射、`config.schema.json` |

## 过程中发现并修掉的真实缺陷

1. **shadow 不惰性**：概率分支（conflict/goal/evidence）没有检查 mode，`shadow` 下仍会产出 `ask`/`deny`。属性测试在 1000 次随机输入下命中；此前的单元测试因为固定了 `snapshotFresh: false` 而走进提前返回、把它掩盖了。修法是把 mode 处理从各分支上移到唯一出口，使不变量成为结构性事实。
2. **校验器静默失效**：`Check` 谓词只返回布尔、不记录失败路径（重构时误删了做登记的 helper），导致 `requestId: ''`、`snapshot.turn: -1`、`catalogDigest: ''` 三种非法输入被判为合法通过。已修，并补一条“收集全部路径而非第一条”的回归测试。
3. `isJsonValue` 先把所有 `number` 判为合法、之后才检查有限性 → `NaN`/`Infinity` 可穿过 `state` 校验。已修。

这三条都属于“看起来通过、实际不安全”一类，记录在此以便复核。

## 阻塞项

| gate | 状态 | 缺什么 |
|---|---|---|
| local-inference / local-offline | **BLOCKED** | 无 Python（可用 `uv` 安装）；SemIf CPU 路线需下载约 3.01 GB 权重并在启动时访问 HF 取固定 tokenizer → 需明确授权，M1/M2 通过后再问 |
| cloud-inference | **BLOCKED** | 无 `TYPESAFE_API_KEY`、无调用预算。代码与 fixture 契约测试照常实现 |
| secret-scan / pack-install / CI | **NOT_RUN** | M5/M7 |
| 上传 | 授权范围：可 push 到 feature 分支，**不可** push `main`、不可 publish npm、不可向第三方仓库发 PR |
