# Gate 状态

核对日期：2026-09-23。只记录本机实际执行过的命令；未执行的写 `NOT_RUN`，外部条件缺失的写 `BLOCKED`。工程 gate 通过不代表真实模型质量合格。

## M0 环境与宿主合同

| gate | 状态 | 证据 |
|---|---|---|
| compatibility | **PASS（本地运行时）** | `artifacts/compatibility.json`：真实 Cordis 上下文 + 真实 `ToolRuntime` + 生产 `AgentLoop`，只有 LLM 是脚本驱动器；7 个宿主测试全过，事件序列可用 `JEY_TRACE_FILE=<path> pnpm --filter jey-adapter-dsh test` 重放并逐字节比对 |
| 实测顺序 | 已执行 | `assemble → pre-step → llm-request → pre-execute → pre-execute-decision → guard → execute → post-execute → result → assemble → …`，R-01 在运行时成立 |
| 已证实的保护性质 | 已执行 | `pre-execute` deny 后工具体不跑；同步 guard 拒绝压过内层 waterfall 的 allow；`tools/result` 的 exec/result/content 三层全冻结、写入抛 `TypeError`；工具集只经 `PromptAssembly.tools` 投影到请求头 |
| `ask` 授予通道 | **BLOCKED** | 探针未组合 `dsh-user-approval`；实测到文档所述降级（`ask` → 拒绝）。转为可测要求：装载时必须探测宿主审批能力，不能凭配置假定 |
| `restrict()` 时序 | **NOT_RUN** | 与 §8.2 presentation-only gate 绑定 |
| 发行版 overlay 加载 | **NOT_RUN** | 用 `@deepseek-ai/dsh` + `cordis.yml` 绝对路径装载，属 M2 host-integration gate |

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
pnpm install                          # 成功，含真实 DSH 包
pnpm -r typecheck                     # 0 error（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
pnpm --filter jey-core test           # 122 tests, 122 pass, 0 fail
pnpm --filter jey-core test:property  # 16 properties, 16 pass, 0 fail
pnpm --filter jey-adapter-dsh test    # 7 宿主测试, 7 pass, 0 fail（真实 agent loop，离线无密钥）
```

| gate | 状态 | 覆盖 |
|---|---|---|
| typecheck | **PASS** | contracts + core + adapter-dsh，无 `any` 兜底，无 `@ts-ignore` |
| unit | **PASS** | 122 条：策略表 1 全 16 格与 absorbing 行、取消优先、必需题缺失、未校准不得 deny、陈旧快照、off/shadow 惰性；外发 deny 默认、精确 origin、allowlist 条件、调用方不得指定传输参数；边界校验路径收集；快照绑定与新鲜度；字节预算裁剪；无进展计数；固定模板与能力预检；生命周期与队列；配置结构与矛盾组合；审计记录结构、隐私由字段集合而非脱敏保证、单次写者有界轮转、崩溃后撕裂末行只隔离不改写、键控摘要 |
| property | **PASS** | Jey 永不放宽宿主决定；`allow` 只可能来自 `allow`+`abstain`；shadow/off 惰性；无观测时 enforce 不 abstain；放行必经已配置 origin；裁剪后必为合法 JSON、不超预算、有记录、受保护段不被整段丢弃；暂停路径不会重获失败预算 |
| M1 完成度 | **PARTIAL** | 见下"未开始"。已交付的模块本身 gate 为 PASS，不等同于 M1 整体完成 |
| 已实现模块 | — | `policy.ts`（§7.2）、`egress.ts`（§5.3）、`validate.ts`（§6.1）、`snapshot.ts`（§4.2/§10.1）、`truncation.ts`（§5.2）、`progress.ts`（§9）、`questions.ts`（§7.1/§8.1）、`coordinator.ts`（§4.4/§10.1/§10.2）、`config.ts` + `config/config.schema.json`（§13、附录 4）、`audit.ts`（§11、§5.4、§4.1 三段分离的 `recordDecision`、`AuditJournal`、`scanJournal`）、`canonical.ts` |
| 未开始 | **NOT_RUN** | 按会话公平性与 §10.4 的 turn/session 配额执行（上限已在配置里声明但还没落地执行）、`AuditJournal` 的落盘 sink（属 adapter：文件、轮转、权限）、DSH 工具 schema 子集映射（属 adapter，M2） |

## 过程中发现并修掉的真实缺陷

1. **shadow 不惰性**：概率分支（conflict/goal/evidence）没有检查 mode，`shadow` 下仍会产出 `ask`/`deny`。属性测试在 1000 次随机输入下命中；此前的单元测试因为固定了 `snapshotFresh: false` 而走进提前返回、把它掩盖了。修法是把 mode 处理从各分支上移到唯一出口，使不变量成为结构性事实。
2. **校验器静默失效**：`Check` 谓词只返回布尔、不记录失败路径（重构时误删了做登记的 helper），导致 `requestId: ''`、`snapshot.turn: -1`、`catalogDigest: ''` 三种非法输入被判为合法通过。已修，并补一条“收集全部路径而非第一条”的回归测试。
3. `isJsonValue` 先把所有 `number` 判为合法、之后才检查有限性 → `NaN`/`Infinity` 可穿过 `state` 校验。已修。
4. **暂停后重获失败预算**：同一路径暂停后遇到同一指纹的失败，计数从 1 重新开始，等于允许 Agent 每轮再犯 3 次、无限循环。属性测试给出反例 `[4]` 后修掉：暂停态在同指纹下保持计数不变，指纹变化（实质进展）才解冻。
5. `buildSnapshot` 只冻结外层对象，`ref` 可被就地改写 → 应用决策时读到的可能是被改过的元组。已连 `ref` 一起冻结。
6. 传给 `fc.jsonValue` 的 `shapeDepth` 在该版本并非合法约束项，运行时被静默忽略。由 typecheck 抓到并移除。
7. **回写即失效的开关**：`"const": false` 而没有 `"default"` 时，字段缺省就是 `undefined`，`undefined !== false` 会让"关掉"读成"没关"。`features.modelRouting` 与 `audit.rawContent` 各中一次，现补 default 并加了一条 schema 自审测试。
8. **我自己写的 loopback 正则是个洞**：`^http://127\.[^/?]+$` 会放过 `http://127.evil.com/`。给这条写回归测试时才发现，已改成必须匹配 `127.x.x.x` 或 `[::1]` 字面量，并留下该反例测试。
9. **队列饥饿死锁**：入队的请求被同时计入"执行中"名额，`#pump` 的条件 `inflight < maxConcurrent` 永远不成立，排队的 run 再也不会被启动。表现是测试挂到超时。
10. **超时在非法相位上结算**：deadline 原本在 `await provider` 返回之后才判定，此时 run 已在 `observed`，而 `observed → timed_out` 不在状态表里，于是抛 `IllegalTransition` 成为未处理拒绝，调用方的 promise 永不落地。改为用 race 在 `running` 相位就结算，迟到的答案只做诊断。
11. Node 的类型剥离不支持 TypeScript 参数属性（`constructor(readonly x: T)`），一个 `Run` 构造函数就让 9 个测试文件全部加载失败。
12. **`referenceDigest` 用字符串长度判熵是错的**：一份 `{path:"a.txt"}` 的 sha256 是 71 字符的"高熵字符串"，却仍然承诺着一个一次就能猜中的内容。测试断言"hmac 前缀"时失败才暴露。改成一律要求密钥——摘要的输入有多少熵只有调用者知道，这个函数不该替它猜。
13. 自查时抓到的两处自我坑陷：`DECISION_KEYS` 被我写成 `fieldCheck({...})` 的返回值（那个函数返回的是问题列表而不是键名，会让未知字段检查整体失效）；`AuditJournal.#counters` 用只读接口类型标注后无法自增，而 `readonly` 元组让 `.includes(string)` 通不过类型检查。

另记：一次用 shell 打补丁的操作有 3 处替换静默没生效却报告成功，靠 grep 复核才发现；此后同类改动一律用编辑器改并回读确认。

这些都属于“看起来通过、实际不安全”一类，记录在此以便复核。

## 阻塞项

| gate | 状态 | 缺什么 |
|---|---|---|
| local-inference / local-offline | **BLOCKED** | 无 Python（可用 `uv` 安装）；SemIf CPU 路线需下载约 3.01 GB 权重并在启动时访问 HF 取固定 tokenizer → 需明确授权，M1/M2 通过后再问 |
| cloud-inference | **BLOCKED** | 无 `TYPESAFE_API_KEY`、无调用预算。代码与 fixture 契约测试照常实现 |
| secret-scan / pack-install / CI | **NOT_RUN** | M5/M7 |
| 上传 | 授权范围：可 push 到 feature 分支，**不可** push `main`、不可 publish npm、不可向第三方仓库发 PR |
