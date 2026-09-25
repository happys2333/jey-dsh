# Gate 状态

核对日期：2026-09-25（M3 local 推理本轮实测更新）。只记录本机实际执行过的命令；未执行的写 `NOT_RUN`，外部条件缺失的写 `BLOCKED`。工程 gate 通过不代表真实模型质量合格。

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

## M2 DSH 插件闭环

```sh
pnpm -r build            # 0 error
pnpm -r typecheck        # 0 error
pnpm --filter jey-adapter-dsh test   # 20 测试（7 探针 + 6 闭环 + 3 cordis 入口 + 4 落盘 sink），20 pass，0 fail
```

真实 Cordis 上下文 + 真实 `ToolRuntime` + 生产 `AgentLoop`，只有 LLM 是脚本驱动器、
决策提供方是 synthetic mock。全程离线、无密钥。

| gate | 状态 | 证据 |
|---|---|---|
| host-integration | **PASS（闭环 + 装载入口）** | 6 条闭环测试：shadow 下工具体照常执行且 provider 被问一次；`off` 下 provider 调用数为 0 且不产记录；`enforce`+mock 在装载时就被 `ConfigError` 拒绝；已暂停路径仅凭确定性规则拒绝、**不产生 provider 调用**；`close()` 之后不留监听器；审计三段字段分立 |
| lifecycle | **PASS（部分）** | 装载/卸载、generation 递增、事件顺序、审计行可被 `scanJournal` 原样回读且无隔离行 |

未覆盖（不记为通过）：

- egress 拒绝路径只在 core 单测里覆盖；宿主级需要 local/typesafe 真实提供方（M3）。
- `ask` 的授予仍 BLOCKED：本宿主拓扑里没有 `dsh-user-approval`。
- `dsh` 发行入口 + `cordis.yml` overlay 的真机启动未跑（`docs/INSTALL_DSH.md` 里的命令来自官方文档，本机只验证到 testkit 拓扑）。

已补齐（原列为未覆盖）：

- `apply()` 这个 cordis 入口现在有端到端测试：真实 `ctx.plugin(jeyPlugin, config)`、不注入 provider、不注入 sink、经 `JEY_AUDIT_PATH` 落盘、落盘行可被恢复扫描器原样读回。
- `fileLineSink` 追加与轮转有 4 条单测（含"外部写入者把文件撑大后仍按磁盘真实大小轮转"）。
- 一个新确认的宿主行为：**effect 内抛错会让 `ctx.plugin()` 一起拒绝**，所以被拒的配置不可能"静默装上了但没生效"。这条已被 `enforce+mock` 与未实现提供方两条测试钉住。

**设计裁决（写清楚，因为它和"shadow 什么都不改"表面矛盾）**：确定性硬规则在 shadow
下也照常拒绝。理由是 shadow 的含义是"模型的意见只作观察"，而"这条路径已经连续失败
3 次"是已发生事实的记录，不是意见；同步 `guard()` 本来也在拒绝它，若 waterfall 在
shadow 下放过同一件事，两层就会互相矛盾。核心里 `evaluatePolicy` 的 shadow 不变量
仍然成立——它保护的是模型派生动作。

## M1 核心

命令与结果（Windows / Node v24.15.0 / pnpm 9.15.9）：

```sh
pnpm install                          # 成功，含真实 DSH 包
pnpm -r typecheck                     # 0 error（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
pnpm -r test                          # 144 + 20 + 14 + 29，全部 0 fail
pnpm --filter jey-core test:property  # 16 properties, 16 pass, 0 fail
cd python && .venv/Scripts/python.exe -m unittest discover -s tests -t .
                                      # 58 tests, OK (skipped=6)；6 条为需显式授权的真人推理测试
JEY_RUN_INFERENCE=1 ... tests.test_inference   # 6 pass（真实权重）
JEY_E2E_LOCAL=1 pnpm --filter jey-provider-local test:e2e:local  # 2 pass（真实服务 + 真实客户端）
```

| gate | 状态 | 覆盖 |
|---|---|---|
| typecheck | **PASS** | contracts + core + adapter-dsh，无 `any` 兜底，无 `@ts-ignore` |
| unit | **PASS** | 144 条：策略表 1 全 16 格与 absorbing 行、取消优先、必需题缺失、未校准不得 deny、陈旧快照、off/shadow 惰性；外发 deny 默认、精确 origin、allowlist 条件、调用方不得指定传输参数；边界校验路径收集、score 的 `expectedIndex` 是期望值（可为小数）且分布键必须是 `"0".."K-1"`；快照绑定与新鲜度；字节预算裁剪；无进展计数；固定模板与能力预检；生命周期、队列、配额账本与拒绝/归还；配置结构与矛盾组合、`config/examples/*.json` 全部过 `loadConfig` 且本地示例逐字段对着 `models.lock.json` 核；审计记录结构、隐私由字段集合而非脱敏保证、单次写者有界轮转、崩溃后撕裂末行只隔离不改写、键控摘要 |
| property | **PASS** | Jey 永不放宽宿主决定；`allow` 只可能来自 `allow`+`abstain`；shadow/off 惰性；无观测时 enforce 不 abstain；放行必经已配置 origin；裁剪后必为合法 JSON、不超预算、有记录、受保护段不被整段丢弃；暂停路径不会重获失败预算 |
| **M1** | **PASS** | `tasks.json` 要求的三件交付物齐了：`packages/contracts`、`packages/core`、`config/config.schema.json`；typecheck / unit / property 三个 gate 全绿 |
| 已实现模块 | — | `policy.ts`（§7.2）、`egress.ts`（§5.3）、`validate.ts`（§6.1）、`snapshot.ts`（§4.2/§10.1）、`truncation.ts`（§5.2）、`progress.ts`（§9）、`questions.ts`（§7.1/§8.1）、`coordinator.ts`（§4.4/§10.1/§10.2/§10.4）、`budget.ts`（§10.4 预留-归还账本）、`config.ts` + `config/config.schema.json`（§13、附录 4）、`audit.ts`（§11、§5.4、§4.1 三段分离）、`canonical.ts` |
| 本轮接线 | — | 裁剪真正进请求路径：`maxStateBytes` 在提交前生效，策略与本次调用放不下就 `INSUFFICIENT_CONTEXT` 不送问；`perTurnCalls`/`perSessionCalls` 从"配置里有"变成协调器真的执行并如实拒绝；队列按会话轮转，单会话最多排 `maxQueuePerSession` 个；审计事件新增 `truncatedPaths`，被裁掉什么必须看得见 |

## M3 提供方

```sh
pnpm --filter jey-provider-typesafe test  # 20 条契约测试, 20 pass, 0 fail（无网络、无凭据）
pnpm --filter jey-provider-local test     # 14 条客户端契约测试, 0 fail
cd python && .venv/Scripts/python.exe -m unittest discover -s tests -t .   # 58 tests, OK (skipped=6)
JEY_RUN_INFERENCE=1 .venv/Scripts/python.exe -m unittest tests.test_inference   # 6 pass，真实权重
JEY_E2E_LOCAL=1 pnpm --filter jey-provider-local test:e2e:local   # 2 pass，真实服务 + 真实 TS 客户端
```

| gate | 状态 | 说明 |
|---|---|---|
| provider-contract（typesafe） | **PASS** | 线格式逐字取自官方 API 文档（2026-09-23 检索）；出站体断言、`answers` 回镜键集断言、每个 primitive 的取值/键集/求和/一致性断言、403-vs-401、429/529 可重试、3xx 拒绝跟随、取消真的打断出站请求 |
| 隐私边界 | **PASS** | `snapshot/purpose/budget/requestId` 不出站；凭据缺失时 fetch 调用数为 0；token 不出现在任何错误文本里；审计只记别名不记 URL |
| cloud-inference | **BLOCKED** | 无 `TYPESAFE_API_KEY`、无调用预算。20 条全是对夹具与桩传输的契约测试，**不是**真实调用记录 |
| provider-contract（local） | **PASS（客户端 + 服务端）** | 客户端 14 条；服务端 `python/local_decider` 52 条协议/映射/锁测试（真实 socket、真实 `http.client`）：鉴权逐端点、字面 loopback 的 Host 校验、Origin 一律拒、413 双源（服务配置与请求预算取严格者）、411/404/405、422 题数超限、队列满 → 429 可重试、队列里耗尽预算 → 504、错误体与访问日志都不带请求内容 |
| **local-inference** | **PASS（真实权重，本机 CPU）** | `Qwen_Qwen3.5-4B-Q4_K_M.gguf` sha256 与 `python/models.lock.json` 逐项相符（`13c16f42…f8a983`，3,013,027,808 字节）；加载 12–19 s（热/冷页缓存两次实测）；三条固定执行门问题 2.48–2.67 s 全 answered（两次实测，后者见 `artifacts/local_inference_e2e.json`），同一 prompt 两次打分逐位相同；`origin=native-logits`、`calibration=uncalibrated`、`outputTokens=0`、`egress.occurred=false` |
| local-offline | **PASS（有限度）** | 服务只读本地已验证文件：`HF_HUB_OFFLINE=1` + `local_files_only=True`，缺 tokenizer 或权重不匹配即 `LOCAL_NOT_READY`，请求路径永不下载。未做断外网抓包验证，所以只声明"代码路径不取网"，不声明"严格离线" |
| 模型身份门 | **PASS（新增，缺陷 26）** | `ExpectedProvider` 在发第一个请求前逐字段比对 `provider.local.expectedModel` 与服务自报身份（`sha256:` 前缀两侧归一），不匹配即不可重试的 `UNSUPPORTED_CAPABILITY` 且提供方调用数为 0；7 条单测 + 端到端里对着 `models.lock.json` 核取值 |

真实推理下的安全性质（本轮实测，不是推导）：`conflicts-with-constraint` 的 `pYes=0.138`、
`advances-goal=0.757`、`evidence-sufficient=0.673`，经 `evaluatePolicy({mode:'enforce',
calibrationAvailable:false})` 得到 `abstain / no-jey-restriction`，宿主 `allow` 原样保留。
属性写成"未校准概率不可能产出 deny"，而不是钉死这一轮的数值。

**运维事实：`limits.deadlineMs` 默认 1500 ms 是云端提供方的量级。** CPU 上冷状态三条问题
实测 2.5 s，因此本地提供方必须显式抬高该值（schema 上限 60000），否则 enforce 下每次检查
都会以 `TIMEOUT` 失败关闭。服务端 `MAX_DEADLINE_MS` 也钉在 60000，与配置上限一致。

v1 明确**不重试**：重试只能有一层负责，协调器与提供方同时重试会让请求数相乘。代价是限流会表现为一次失败的检查，由策略层按"必需检查不可用"升级，而不是被静默吞掉。

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

14. **会话配额按 agent 键控**：`sessionKey` 原本是 `session:${sessionId}/${agentId}`，等于每个子 agent 都带一份新的会话额度，`perSessionCalls` 上限形同虚设。写账本单测时才暴露，改成只按 sessionId 键控。
15. 公平性上限一开始是我推导出来的公式（`min(maxQueue, maxConcurrent)`），结果在 `maxConcurrent = 1` 时每个会话最多只能排 1 个，轮转策略**永远观察不到差异**——测试无论如何都会绿。改成协调器的显式参数 `maxQueuePerSession`，让策略本身可测。
16. 我在截断路径的宿主测试里断言了"shadow 下工具体照常执行"，实际没执行——原因是我把参数撑宽后违反了探针工具自己的 schema，宿主在 Jey 之前就拒了。这是个无关原因造成的"假失败"，去掉该断言并写明：拒自 Jey 还是拒自宿主，看审计记录的 `reasonCodes` 就能分辨。

M3 local 服务这一轮新增（全部由真实执行暴露，不是读代码读出来的）：

17. **`parseAnswer` 要求 `expectedIndex` 是整数**，而 §1.3 的定义是 `Σ(i×p_i)`：两档 0.5/0.5 的分布期望是 0.5，整数校验把它判为非法，而 `provider-typesafe` 自己就在产出 1.05（其单测钉着这个数）。给 Python 端写映射时才撞出来。同时补上"score 分布键必须是 `"0".."K-1"`"——原先 `{low:0.5,high:0.5}` 这种用标签当键的响应也能过。
18. **`python/local_decider/service.py` 少 `__main__` 守卫**：`python -m local_decider.service` 把所有定义执行一遍就退出，**exit 0、零输出、不服务**。TS 端到端测试第一次跑才撞见（"service exited with 0"）。这类"入口静默空转"只有真跑一次才能发现。
19. **Handler 的配置根本挂不上去**：`decider/token/max_input_bytes` 只写在 server 对象上，而代码用 `self.decider` 读——类里的 `decider: Decider` 只是注解、不创建属性，任何请求都会 `AttributeError`。写第一版服务测试前改成 property。
20. `download_weights` 的输出里**验证记录被 `**plan` 同名键覆盖**，打印出来的 JSON 没有 sha256/matches。退出码仍然对（判定发生在打印之后），但"证据"被自己抹掉了。键集冲突改为命名空间嵌套。
21. `LocalScorer.load` 没设 `HF_HOME` 就调 `snapshot_download(local_files_only=True)` → 去默认用户缓存里找本仓库缓存的 tokenizer，报"未缓存"。`huggingface_hub` 在 import 时就读环境变量，所以设置必须先于任何 import。
22. **队列时间被扣两遍**：`Decider.run` 把"剩余秒数"当参数传给 `evaluate()`，而 `evaluate()` 内部又按 `deadline - (now - started)` 再减一次已耗时。绝对时刻与相对量混用；改成两端都传绝对单调时刻。
23. 两处纯粹是我打错的字：包名写成 `semi_phase1`（正确是 `semif_phase1`，4 处）；`evaluate()` 的 Python 补丁里我把 `class Job:` 连同 `__slots__` 一起替换成了重复的 `class Decider:`，靠回读文件才没留下破损源码。**同类错误的防线还是那条：改完立刻读回来看，别信工具说"成功"。**
24. `is_loopback_host` 一开始接受 `localhost` 与 `ip6-localhost`，把边界交给了解析器和 `/etc/hosts`。改成只认 `127.x.x.x` 与 `::1` 字面量，与 TS 客户端的 `isLoopbackEndpoint` 对齐。
25. `LocalOptions.requestTimeoutMs` 声明了但从未被读——一个看起来能调、实际无效的全局超时，而且和"超时只来自请求剩余预算"的设计相矛盾。删掉，不是补上。
26. **`provider.local.expectedModel` 是个纯装饰字段**：schema 要求它、`config.ts` 给它建了类型、`loadConfig` 校验它的形状，但从头到尾**没有任何一处把它和服务自报的身份对比过**。也就是说，本机跑着另一个 checkpoint（换了文件、换了量化、被人替掉），Jey 照样把任务状态发过去。写服务的时候为了对齐 `sha256:` 前缀才撞见。现在由 `ExpectedProvider` 在**发第一个请求之前**探 `capabilities()` 逐字段比对，不匹配即 `UNSUPPORTED_CAPABILITY`、不可重试、提供方调用数保持 0；探测不带任务状态，所以代价不是内容外泄。这跟早先 `perTurnCalls`"配置里有但没人执行"是同一类洞：**声明了的控制必须找到执行它的那行代码，否则它只是文档。**

另记：一次用 shell 打补丁的操作有 3 处替换静默没生效却报告成功，靠 grep 复核才发现；此后同类改动一律用编辑器改并回读确认。本轮仍有一次编辑器改动把 `class Job:` 换成了错误的目标行（缺陷 23），说明"回读"这一步不能省——工具说成功只代表它做了某件事，不代表那件事是对的。

这些都属于“看起来通过、实际不安全”一类，记录在此以便复核。

## 阻塞项

| gate | 状态 | 缺什么 |
|---|---|---|
| cloud-inference | **BLOCKED** | 无 `TYPESAFE_API_KEY`、无调用预算。代码与 fixture 契约测试照常实现 |
| local-inference | **已解除** | 2026-09-25 授权后完成：Python 3.12.13（uv）、SemIf 固定提交 editable 安装、3.01 GB 权重按锁校验通过。真实推理见上表。取权重过程中 HF 的 xet 传输在本机走到约 11 MB 后完全停住（进程活着，六分钟内零进展），杀掉后设 `HF_HUB_DISABLE_XET=1` 走经典 HTTP 达到 ~3 MB/s、十来分钟完成并验过 sha256——`download_weights.py` 里那行 setdefault 就是为这个，不是风格选择。第一次尝试留下的 `.incomplete` 仍躺在缓存里，不影响正确性 |
| `ask` 授予通道 | **BLOCKED** | 本宿主拓扑没有 `dsh-user-approval`，需先组合它再测 |
| `restrict()` 时序、发行版 overlay 启动 | **NOT_RUN** | §8.2 presentation-only gate；M2 遗留 |
| 宿主级 egress 拒绝（真实提供方） | **NOT_RUN** | 现在具备条件：local 服务可以真跑，M5 补 |
| secret-scan / pack-install / CI | **NOT_RUN** | M5/M7 |
| MCP 适配（M4）、评测（M6）、最终报告（M8） | **NOT_STARTED** | — |
| 上传 | 授权范围：可 push 到 feature 分支，**不可** push `main`、不可 publish npm、不可向第三方仓库发 PR |
