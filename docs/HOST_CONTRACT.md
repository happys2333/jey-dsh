# HOST_CONTRACT：DSH 宿主固定合同（M0）

核对日期：2026-09-22。核对人：本地编码 Agent。
基线：`deepseek-ai/deepseek-harness` @ `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`（提交信息 `Merge pull request #4901 from deepseek-harness/rel/dsh-0.1.7-alpha.1`，2026-09-22T04:12:33Z）。
本文件中的每一条都指向固定提交内的真实文件或 npm 注册表查询结果；没有一条来自推测。若与 `docs/handoff/docs/01_TECHNICAL_SPEC_CN.md` 冲突，以本文件为准并先写 ADR。

## 1. 安装与运行时事实

| 项 | 实测值 | 来源 |
|---|---|---|
| monorepo 根包 | `@deepseek-ai/dsh-root` `0.1.7-alpha.1` | `package.json` |
| npm 发布 | `@deepseek-ai/dsh` 存在 `0.1.7-alpha.1`，dist-tag `alpha`；`latest` 仍为 `0.1.5-rc.2` | `npm view @deepseek-ai/dsh dist-tags` |
| Node 下限 | `^22.19.0 \|\| >=24.0.0` | `package.json` `engines` |
| 本机 Node | v24.15.0 → 满足 `>=24.0.0` | `node --version` |
| 依赖解析 | `npm install --dry-run @deepseek-ai/dsh@0.1.7-alpha.1` 成功解析 512 包 | 本次执行 |
| Cordis peer | `@deepseek-ai/cordis ^4.0.3`（已发布 4.0.3，但 `latest` 标签停在 4.0.2） | `npm view @deepseek-ai/dsh-agent-loop@0.1.7-alpha.1 peerDependencies` |
| 测试基座 | `@deepseek-ai/dsh-agent-loop-testkit@0.1.7-alpha.1` 已发布 | npm |

**与交接包的差异**：交接包自测记录写“本次 Node 不满足 DSH Node 下限”，因此未做任何宿主验证。本工作区 Node 24.15.0 满足下限，所以 M0 的原生探针在本机是可执行项，不是 BLOCKED 项。

## 2. 插件模型

DSH 插件是一个导出 `name` 和 `apply(ctx)` 的 TypeScript 模块，通过 `cordis.yml` overlay 以绝对路径注入（`docs/user/develop/basic/index.md`）。`ctx` 类型来自 `@deepseek-ai/cordis`。

扩展点在源码里以 `declare module '@deepseek-ai/cordis' { interface Events { … } }` 声明，并带 JSDoc `@mode` 标记（`waterfall` 可改写、`emit` 只广播）。

## 3. 本项目将使用的扩展点（逐字签名）

文件：`packages/core/tools/src/index.ts`，均在 `Scoped<ToolRuntime>` 上。

| 事件 | 签名 | mode |
|---|---|---|
| `tools/pre-execute` | `(exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>` | waterfall |
| `tools/execute` | `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>` | waterfall |
| `tools/post-execute` | `(exec, result: Readonly<ToolExecutionResult>, next) => Promise<PostToolDecision>` | waterfall |
| `tools/result` | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined` | emit |
| `tools/change` | `() => void` | emit |

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string }
```

`index.ts:147-152` 的注释确认：`next()` 委托到 allow；缺少审批支持时 `ask` 转为拒绝；异步 gate 必须观察 `exec.signal`；注册表在它们 settle 之后会重查取消，但不会丢弃其 promise。

单调 guard（`index.ts:720`、`1123`）：

```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
guard(guard: ToolGuard): () => void   // 返回精确 disposer
```

JSDoc 明确：guard 在可扩展 waterfall **之后**运行；任一分层返回字符串即拒绝，没有任何 guard 能强制放行别的 guard 已拒绝的调用。→ 交接包的“同步 guard 只拒绝”结论成立。

作用域限制（`index.ts:1084`）：`restrict(filter: ToolRestriction): () => void`，且带四条运行时抛错守卫——必须 `agent.ctx`（全局 ctx 会遮蔽所有 agent）、`restrict({})` 视为空操作即报错、不得点名保留的 PTC 传输工具 `RUN_CODE_NAME`、点名未知全局工具即报错。→ 交接包“restriction 是作用域过滤、不是安全屏障”成立，且实际比描述更强：误用会立即抛错。

Agent / system prompt 侧（`packages/core/scope/src/scoped-events.generated.ts:18,19,31,34,36` 确认这五个事件均为 agent/scope 作用域）：

| 事件 | payload |
|---|---|
| `agent/pre-step` | `{ agent, messages: UserMessage[], turn, step, signal }` → `PreStepDecision` |
| `agent/request` | `{ agent, turn, step, signal }` → 包装 `LlmCallConfig` |
| `system-prompt/assemble` | `(assembly: PromptAssembly, context: AssembleContext, next)` |

```ts
export interface PromptAssembly { sections; contexts; tools: ToolSchema[]; variables }
export interface LlmCallConfig { provider; model; reasoningEffort?; temperature?; maxTokens?; stop? }
```

`LlmCallConfig` 不含 tools。→ **模型可见工具集唯一来源是 `PromptAssembly.tools`**，§8.2 的 presentation-only 筛选只能落在 `system-prompt/assemble`，无第二条路径。

## 4. 生命周期顺序（R-01 已在宿主源码证实）

`packages/core/agent-loop/src/agent.ts` `preStep()`：

```
271: const assembly = await this.loopCtx.systemPrompt.assemble(...)   // 先组装，含 tools
275: const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ... })
283: return { ...decision, assembly }
```

同文件 `toolsChanged()` 用 `session.requestHeader()` 比对 assembly.tools，说明宿主自己承认“组装后的工具集可能与已记录请求头不同”。

结论：在 `agent/pre-step` 内调用 `restrict()` 只影响**下一步**的 assembly，当前步发往模型的 schema 已冻结。R-01 成立，且属宿主固有性质而非某插件缺陷。→ 硬筛选必须走 `system-prompt/assemble`；本项目在通过 §8.2 gate 前保持建议模式。

## 5. 工具 JSON Schema 是强制子集

`docs/subsystems/tools.md:100,421-451`：作者 DSL `ValueSchemaSpec` 仅支持 `string|number|integer|boolean|null|array|object|json|oneOf`，标量 `enum/const` 必须匹配节点类型，显式 object 必须声明 `additionalProperties: true|false`。原始 JSON Schema 走 `assertSupportedJsonSchema()` / `validateJsonSchemaValue()`，**不支持的关键字是 reject 而非忽略**；`oneOf` 需 ≥2 分支且恰好命中一个。

→ 交接包 S05 的警告成立且需要具体工作量：`packages/contracts` 与 MCP 侧的 schema 必须在宿主边界做子集映射，映射失败要报 `UNSUPPORTED_CAPABILITY`，不能交给宿主抛错。

## 6. 与参考项目 `buberlo/dsh-jev` 的关系

固定提交 `d2f77a1f68906d1576caaa8aa22be65913905d19` 已核。三个风险点复核结果：

- **R-01 ACCURATE（比交接包更强）**：`adapters/pre-step.ts:25` 注册 `agent/pre-step`，`:146` 调 `agent.ctx.tools.restrict({ allow })`；宿主侧顺序见本文件第 4 节。该仓库 `docs/architecture.md:64` 与 `pre-step.ts:5-8` 的自我描述（“在模型请求组装前准备”）与源码不符。
- **R-02 ACCURATE**：`pre-step.ts:26` 先 `await next()`，`:29` 从 `payload.messages` 取消息；而宿主提交的是 `decision.messages`（`PreStepDecision` 变体 `{kind:'enter', messages}`）。第三方插件改写输入时，参考实现读到的是旧输入。
- **R-03 PARTIALLY ACCURATE**：截断属实（`pre-step.ts:57-69`，`maxStateChars` 默认 4000）；但“摘要”措辞不准确（无模型参与），且它有跳过 `source.kind !== 'user'` 的三层回退。→ 测试矩阵里该场景应断言“最近一条用户文本 + 截断语义”，不要断言“摘要质量”。
- 许可证：该仓库整体 MIT（根 `LICENSE`，`package.json` `license: "MIT"`），借用具体实现需保留版权声明。ADR-001 的独立实现决定不受影响。

## 7. 提供方合同修正（影响 M3 代码，需写进契约）

1. `questions` 是**以调用方自选 ID 为键的 map**，不是数组。交接包未写这一点。
2. 缺少凭据时真实返回 **403** `{"detail":{"error_type":"authentication_error", …}}`，而 `docs.typesafe.ai/api` 的错误表写的是 401。适配器两种都要处理。
3. 端点不止 `POST /v1/systemone`，还有 `GET /v1/models`。“单端点”表述需修正。
4. 已记录限制：Choice ≤255 候选；Score 2–10 档；64k tokens/请求，state + 最长问题 32k；约 250k tokens/s、1200 req/min；输出 token 免费；**未公布单次问题数上限，也未公布免费额度**；官方声明限额“动态调整”。
5. 计费：文档给出每 Btok/Mtok 输入价，无费用字段 → 按 §10.4 用调用数/字节上界，成本记 `null`。

## 8. 本地推理可用性（M3 的关键前提）

`TheoLeeCJ/SemIf` @ `1f2dea3e…`（PR #18 合入 llamacpp CPU backend）核实：MIT 许可证；入口是 CLI console script `semif-score = semif_phase1.cli:main`，`--backend torch|mlx|llamacpp`、`--device auto|cuda|mps`；仓库内 grep `fastapi|uvicorn|aiohttp|http.server|grpc|jsonrpc` 源码命中为 0 → 交接包“SemIf 不原生提供本项目 HTTP API、常驻 RPC 是新增工作”成立。
约束：需 Python ≥3.10；`--model/--revision` 即使走 `--gguf` 也必填，`llamacpp_backend.py:227` 会 import `transformers` 取固定参考 tokenizer，因此**启动阶段需要 HF 可访问 `Qwen/Qwen3.5-4B@851bf6e8…`**；CPU 最小权重约 3.01 GB（`bartowski/Qwen_Qwen3.5-4B-GGUF@4168f45a…`）。
本机状态：无 Python，但有 `uv 0.11.32` → Python 3.10+ 可按需装。权重下载属外发动作，需明确授权后才做。

## 9. MCP 版本决定

`modelcontextprotocol.io/specification/2025-11-25/server/tools` 存在且核实（`inputSchema` 必填、`outputSchema` 可选、结构化结果在 `structuredContent`；协议错误用 JSON-RPC 码如 `-32602`，工具执行错误用 `isError: true`）。但已发布日期版本含 **`2026-07-28`（current）**，`2025-11-25` 已被取代。→ 需要 ADR 决定固定哪一版；本文件先按交接包指定的 `2025-11-25` 实现并记录差异。

## 10. M0 gate 状态

| gate | 状态 | 说明 |
|---|---|---|
| compatibility | **PARTIAL** | 源码合同、版本、依赖解析、Node 下限已实测；真实插件加载探针与 `tools/result` 顺序观测尚未执行（下一步） |

已产出的证据：本文件；`artifacts/environment.json`；`docs/handoff/SHA256SUMS.txt` 校验 19/25 通过。
未产出（阻塞）：`docs/handoff/tests/*` 与三个 `templates/*` 在交接包中缺失 → 见 `artifacts/handoff_gaps.json`。交接包自测的“53 tests PASS”因此在本工作区**不可复核**，不继承其结论。
