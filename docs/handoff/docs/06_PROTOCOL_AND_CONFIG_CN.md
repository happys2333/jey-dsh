# 协议、配置与执行语义附录

**以下为 ADL 自定义设计，不是现成的 Jev、SemIf 或 DSH API。** `contracts/core-types.ts` 是起点；实现时需要生成运行时 schema、HTTP/MCP 边界校验及契约测试。本包只有接口，没有评分服务实现。

## 1. 本地服务职责

Python 服务只负责“给定 state 和 questions，返回结构化观测”。不持有 DSH 实例、不执行工具、不读取用户传入路径、不改变权限，也不返回可直接执行的宿主决定。TypeScript 端维护可信快照、用途限制和策略合并。

进程内 `AbortSignal` 不进入 JSON。传输取消由客户端断开和服务端任务控制实现；无法中断的计算需要明确 `discard-only` 能力，不返回“已停止计算”的虚假确认。

### 1.1 端点

| 方法和路径 | 成功响应 | 失败/约束 |
|---|---|---|
| `GET /health/live` | 200，`{"live":true}` | 仅说明进程活着，不加载模型、不下载、不泄漏配置 |
| `GET /health/ready` | 200，`{"ready":true}` | 未就绪 503，`{"ready":false,"code":"LOCAL_NOT_READY"}` |
| `GET /v1/capabilities` | 200，已加载提供方身份和能力 | 需要认证；模型缺失时 503，不能回传虚构身份 |
| `POST /v1/decide` | 200，`DecisionResponse` | 认证、大小、版本、schema、队列、deadline 均检查 |

默认绑定 `127.0.0.1`，不绑定 `0.0.0.0`；可用显式 IPv6 loopback，但不能从用户问题中更改地址。除不含敏感信息的 live 探针外，其余接口需 `Authorization: Bearer <本地服务专用随机令牌>`。云端 Jev token 绝不复用作本地 token。

默认不允许跨域浏览器调用。限制 Host/Origin、请求体大小、连接数和慢请求时间。真实隔离依赖 OS 用户/容器权限；同一账号下的恶意程序不在该 HTTP token 的隔离承诺内。

### 1.2 请求示例

以下是**人为编写的协议样例**，不是真实调用记录。`requestId` 来自可信客户端；MCP 输入中的用户字符串不能被直接当作宿主认证的 call identity。

```json
{
  "schemaVersion": "1",
  "requestId": "example-request-001",
  "purpose": "tool-assessment",
  "snapshot": {
    "sessionId": "example-session",
    "agentId": "example-agent",
    "turn": 1,
    "step": 2,
    "generation": 1,
    "taskVersion": 1,
    "policyVersion": "policy-v1",
    "catalogDigest": "example-catalog-digest",
    "callDigest": "example-call-digest",
    "observationSequence": 12
  },
  "state": {
    "trustedPolicy": ["仅做只读检查"],
    "userTask": "定位测试失败原因",
    "call": {"tool": "read_test_log", "arguments": {"logId": "test-1"}},
    "observations": [],
    "omissions": []
  },
  "questions": [
    {"kind": "boolean", "id": "relevant", "instructions": "该调用是否直接有助于定位当前测试失败原因？"},
    {"kind": "boolean", "id": "conflict", "instructions": "给定的调用是否与列出的只读限制冲突？"}
  ],
  "budget": {"maxElapsedMs": 3000, "maxInputBytes": 32768}
}
```

服务端限制不能被请求中的较大 budget 放宽。实际限制取服务配置、调用方配置、请求预算的更严格值。`maxInputBytes` 度量 JSON 请求体 UTF-8 字节；特定 scorer 的 token 上限另行检查。不得把 32KB 等同 32k token。

客户端在入队前以单调时钟记录总 deadline，连接/排队/执行均消耗预算。服务端接收时仅获得**剩余预算**，不是重新获得原始总时限。响应时延还应由客户端单独测量，不能只相信服务端字段。

### 1.3 观测示例

这是一个题目的**合成答案结构**，概率只是示意，不能用作验收结果：

```json
{
  "id": "relevant",
  "status": "answered",
  "answer": {
    "kind": "boolean",
    "pYes": 0.8,
    "probability": {
      "origin": "synthetic",
      "calibration": "uncalibrated",
      "calibrationId": null
    }
  }
}
```

包装成 `DecisionResponse` 时必须包含 requestId、原快照标识、完整 provider identity、逐题 outcomes、timing、usage 和外发记录。合成提供方必须 `kind=mock` 且 `synthetic=true`。真实本地结果使用 `native-logits`，云端分布用 `provider-distribution`，但这并不自动意味着已校准。

所有题 ID 必须恰好出现一次；不支持题型返回相应题的错误，不能丢掉该题。`status=ok` 表示全部题 answered；存在 answered 和 error/abstained 时为 partial；没有 answered 时为 failed。策略仍检查自己需要的题，不能仅看整批 status。

Choice 分布键严格等于请求 options 的 ID 集合。Score 分布键统一为 `"0".."K-1"`，`levels` 保留原有顺序；`expectedIndex=Σ(i×p_i)`，不得把它冒充 normalized risk。若另报 normalized value，明确公式 `expectedIndex/(K-1)` 且 K 至少为2。

`providerConfidence` 只在实际提供方有该字段时保留；Noul 不补造。calibration 文件适用性由模型、模板、数据域身份匹配决定，而不是发现一个文件就标 calibrated。

`egress` 指**离开被声明的本机/部署信任边界的数据传输**，不是“没有任何本地 socket”。本地 RPC 的字节数可以单独计数；只有完成后端审查和断外网测试后才可宣称严格离线。云端 destinationId 是配置中的安全别名，不包含含 token 的原始 URL。

## 2. 错误和重试

| 情形 | HTTP 状态 | ADL code | 默认重试 |
|---|---:|---|---|
| JSON/字段不合法 | 400 | INVALID_INPUT | 否 |
| 本地服务认证失败 | 401 | AUTH | 否 |
| 体积过大 | 413 | INVALID_INPUT | 否 |
| 能力不支持 | 422 或逐题错误 | UNSUPPORTED_CAPABILITY | 否 |
| 排队或并发满 | 429 | QUEUE_FULL | 预算内，非无界重试 |
| 模型未就绪 | 503 | LOCAL_NOT_READY | 显式 readiness 重试，与任务推理重试区分 |
| 超过剩余时限 | 504 | TIMEOUT | 默认不重试，已无总预算 |
| 提供方输出不合法 | 502 | INVALID_RESPONSE | 默认不重试 |

客户端断开时服务可能无法送回响应，不强求一个特定 HTTP 状态。调用方将结果记为 CANCELLED，并在完成日志中记录是否实际停止、废弃或终止了 worker。

顶层错误格式：`{"schemaVersion":"1","requestId":null或合法ID,"error":{"code":"...","retryable":false}}`。公开错误不带原始 prompt、路径、堆栈、header 或密钥；本地受控诊断可记录有限关联 ID。

请求 ID 只用于关联，不用作授权或全局缓存键。重试带 attempt 编号写入客户端审计；服务端缓存必须包含请求内容完整摘要与模型身份，不可仅凭重复 requestId 复用答案。

## 3. 提供方映射

TypeSafe Adapter 把 ADL `boolean/choice/score` 映射到官方 Noul/Choice/Score，使用官方文档核对实际字段。ADL 的 `snapshot/purpose/budget` 是内部合同，不能不经白名单转换整包发给供应商。外发 state 仅含用途允许的最小字段。[S07][S08]

SemIf Adapter 接收 ADL 问题，转换为固定 scorer 所支持的 `state/question/options`。模型/tokenizer/模板配置来自进程启动配置，不来自该请求。使用上游 scoring 路线；不能用普通 Chat Completions 生成出的概率字符串替代 native-logit 路线。[S10]

公共合同中的 `DecisionAction` 仅用于可信进程内 PolicyEngine。HTTP 提供方响应不含动作，避免把外部模型输出直接当宿主指令。

## 4. 配置 schema 的最低要求

`templates/adl.config.example.json` 是 off 状态最小示例。以下为实现者要支持的联合配置：

| 配置 | 允许值/约束 |
|---|---|
| mode | off / shadow / enforce |
| provider.kind | unconfigured / mock / local / typesafe |
| provider.local（仅 local） | 已核实的 loopback URL、tokenRef、ownership=external、预期模型/模板身份 |
| provider.typesafe（仅 typesafe） | credentialRef、明确 model、经过审核的 endpointOrigin |
| egress.mode | deny / local-only / allowlist |
| egress.allowedPurposes | 明确用途枚举，不默认允许所有用途 |
| egress.allowedOrigins | 精确 origin；禁止通配、禁止请求内容改变 |
| limits | 正整数、有合理上限；部署可调，默认值在一处定义 |
| features | 每项显式开关；modelRouting 在 v1 不实现自动切换时不得接受 enabled=true |
| calibration | 可为空；有效文件必须含身份和适用任务声明 |
| audit | 原始数据默认不保存；诊断保留、容量和失败策略明确 |

含义：`deny` 不允许任何提供方网络连接；off/unconfigured 配置无需连接。使用真实本地服务时显式设置 `local-only`，且只允许固定 local 服务 origin；云端则使用 `allowlist` 并指定用途和字段。连接可信边界以外的“内网服务”也需要显式授权，不能只因私有 IP 就当本地。

off+unconfigured 是合法默认状态，doctor 显示 NOT_CONFIGURED。**mode 不为 off 时** unconfigured 必须失败。production enforce+mock 失败；专用测试 fixture 可以在测试运行时注入 Mock，但不能通过用户配置伪装生产模式。

不得在普通模型可调用工具中提供修改上述字段的功能。配置文件可重新加载，但每次变化提升 generation、废弃在途观测、清理相应缓存；不把旧审批迁移到新 generation。

## 5. 宿主 schema 差异

核心 HTTP/MCP 可用完整 JSON Schema 验证；DSH 的工具 schema DSL 有其支持子集，不能直接粘贴含不受支持关键字的 schema。[S05]

生成 DSH 定义时映射到支持的类型/enum/object/array 等声明；在受信工具 body 入口补齐范围、长度、交叉字段、深度和大小检查。既不能让 DSH 接受后不执行约束，也不能为了编译通过而删掉所有校验。将 schema 一致性作为 contract test。

## 6. 版本与升级

wire `schemaVersion=1` 是本项目协议版本，与 DSH 包版本、Jev model、SemIf commit 不相同。未知协议版本拒绝，不悄悄降级。新增可选响应字段需明确 parser 策略；输入未知字段默认拒绝，避免误拼配置静默无效。

首次发布前生成 OpenAPI/JSON Schema、样例 round-trip 测试与客户端契约快照。模型身份变化后 readiness 可以恢复，但旧校准、旧质量标签与旧缓存不自动继续有效。
