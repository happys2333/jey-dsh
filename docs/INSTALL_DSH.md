# 在 DSH 里装载 Jey

基线：DSH `0.1.7-alpha.1`（提交 `c36a83f`）。本文只写实测过或官方文档写明的事实；没验的会直接标出来。

## 前置

- Node `^22.19.0 || >=24.0.0`（取自 DSH 包 `engines`；本仓库 CI 与本文的验证环境是 v24.15.0）。
- 一个能跑起来的 DSH。官方文档给的两条路（`README.md#run`）：

```sh
npx @deepseek-ai/dsh web          # 从 npm，默认 http://127.0.0.1:3080，加 --no-open 只打印地址
```

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build && pnpm dsh web    # 从源码
```

## 插件形态

DSH 插件是一个导出 `name` / `inject` / `apply(ctx, config)` 的模块，由 cordis 在装载时调用 `apply`。Jey 的入口在 `packages/adapter-dsh/src/jey-plugin.ts`，`inject` 只要 `tools`——审批通道是"有就用、没有就如实降级"，不作为硬依赖，这一点与宿主自身解析 `ask` 的做法一致。

## 装载（当前唯一可用方式：overlay）

在本仓库根目录建一个 profile 补丁文件，例如 `local/jey.cordis.yml`。`name` 必须是**绝对路径**（官方 `docs/user/develop/basic/index.md` 明确要求；补丁文件本身不会改变解析相对路径的 profile 目录）：

```yaml
- insert:
    - id: jey
      name: 'D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts'
      config:
        schemaVersion: '1'
        mode: off
        provider:
          kind: unconfigured
        egress:
          mode: deny
        limits: {}
        features: {}
        audit: {}
```

`config:` 块的形状就是 `config/config.schema.json`；`{}` 会让 schema 里的默认值填进来。上例是全关的最小可用配置：装上之后 Jey 不做任何事，`doctor` 之外也没有可观察行为。想开始观察再改：

```yaml
        mode: shadow
        provider:
          kind: mock          # 合成应答，只用于工程验证
        features:
          toolAssessment: true
```

**注意 `mode: enforce` + `provider.kind: mock` 会被直接拒绝装载**，报 `ENFORCE_WITH_MOCK`。这不是运行期降级，是 `apply` 阶段抛错、`ctx.plugin()` 随之失败——已有宿主测试钉住这条。

`provider.kind: local` 与 `typesafe` 现在都是真实现：前者连本机 `python/local_decider` 服务，后者连云端提供方。**Jey 自己不启动、不重启、不下载任何东西**——服务不在就是 `LOCAL_NOT_READY`，策略层按"必需检查不可用"升级，不会静默退回 mock。

## 接上本地提供方

先把服务跑起来（约 3.01 GB 权重，需单独授权执行；细节见 `python/README.md`）：

```sh
cd python && uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe -e "<SemIf 固定检出>[llamacpp]"
.venv/Scripts/python.exe -m local_decider.download_weights          # 下载并按 models.lock.json 校验 sha256
JEY_LOCAL_TOKEN="$(openssl rand -hex 24)" .venv/Scripts/python.exe -m local_decider.service --port 8732
```

然后 overlay 里：

```yaml
        mode: enforce
        provider:
          kind: local
          local:
            endpoint: 'http://127.0.0.1:8732'
            tokenRef: 'env:JEY_LOCAL_TOKEN'      # 引用，不是令牌本身
            ownership: external
            expectedModel:
              requested: bartowski/Qwen_Qwen3.5-4B-GGUF
              revision: 4168f45a16a1290d65a4ec0fa312ae917a4c15d6
              weightsDigest: 'sha256:13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983'
              tokenizerRevision: 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a
              quantization: Q4_K_M
        egress:
          mode: local-only
          allowedOrigins: ['http://127.0.0.1:8732']
          allowedPurposes: ['tool-assessment']
        limits:
          deadlineMs: 10000        # 见下：默认 1500 是云端量级
        features:
          toolAssessment: true
```

这份配置是**跑过 `loadConfig` 验证**的，不是照抄 schema；同样的内容以机器可读形式放在 `config/examples/off-minimal.json` 与 `config/examples/local-enforce.json`，`packages/core/test/unit/config-examples.test.ts` 会逐个装载它们并把 `expectedModel` 对着 `python/models.lock.json` 核对，所以示例不会和锁、也不会和 schema 悄悄分叉。几个会当场拒掉的写法：

| 写法 | 结果 |
|---|---|
| `egress.mode: local-only` 而不给 `allowedOrigins` | `LOCAL_ONLY_NEEDS_ORIGIN`（一个永远到不了服务、却写着"只走本地"的配置没有意义） |
| `allowedOrigins: ['http://localhost:8732']` | `LOCAL_ONLY_REJECTS_CLOUD_ORIGIN: http://localhost:8732 is not loopback` |
| `limits: {}` | 装载成功，但 `deadlineMs` 取默认 **1500** |
| 服务的权重和 `expectedModel` 不一致 | 装载成功、**第一次决策前**就失败：`ExpectedProvider` 先探 `capabilities()`，逐字段比对后才肯发第一个请求；不匹配是 `UNSUPPORTED_CAPABILITY` 且不可重试。探测不带任何任务状态，所以发错的代价不是内容外泄 |

`deadlineMs` 那条是实测出来的：CPU 上加载权重约 19 s（一次性），三条固定执行门问题冷状态 **2.48 s**、命中状态前缀缓存后每问约 0.5 s（`artifacts/local_inference_e2e.json`）。1500 ms 是云端提供方的量级，本地提供方不抬高就会每次 enforce 都 `TIMEOUT` 失败关闭。服务端也把自己能接受的时限钉在 60000 ms，与 schema 的 `limits.deadlineMs.maximum` 一致——配置只能收紧，不能放宽。


启动时把补丁文件交给 DSH：

```sh
dsh --profile <你的 profile> web        # profile 位于 $DSH_HOME/profiles
dsh plugin --profile <profile> add <包名>   # 官方 CLI，把参数转发给 profile 目录里的 pnpm
```

## 确认它真的在跑

Jey 默认把审计写到 stderr；设了 `JEY_AUDIT_PATH` 就改写成 JSON Lines 文件（路径只来自环境变量，绝不来自模型可见的配置，也不接受模型改 `audit.rawContent`）：

```sh
JEY_AUDIT_PATH=/tmp/jey.jsonl dsh --profile <profile> web --no-open
```

然后在会话里让它调一次工具，再看：

```sh
tail -n 3 /tmp/jey.jsonl
```

每行是一次决策，固定字段。值得核对的三点：`action` 是 Jey 的判断、`hostDecision` 是宿主原本的决定、`execution` 是实际发生了什么——**没执行就是 `null`**，不会出现"模型答了"被写成"工具跑了"。`synthetic: true` 表示这次应答来自 mock，不是真实模型。

`packages/adapter-dsh/test/host/plugin-entry.test.ts` 走的正是这条路径：真实的 `ctx.plugin(jeyPlugin, config)`、不注入 provider、不注入 sink、断言落盘的行能被恢复扫描器原样读回。

## 卸载

从 overlay 里删掉那个 `id: jey` 条目并重启即可。Jey 只注册监听器和一个同步 guard，`apply` 的清理会把它们逐个注销；插件实例被换掉时 generation 递增，此前在途的判断全部作废，不会跨实例生效。

## 还没实现 / 没验证

| 项 | 状态 |
|---|---|
| `status` / `doctor` 只读命令 | **NOT_IMPLEMENTED**（规格 §11 要求，属后续） |
| 已发布的 npm 插件包 | **不存在**，`jey-*` 尚未发布，也没有确认过名称可用性 |
| Windows 原生 / WSL2 / Linux / macOS 分别验证 | 只在 **Windows 原生 + Node 24.15** 实测过。`python/.venv` 与 llama.cpp 的 CPU 路线同理，Linux/macOS 路径未跑 |
| 本地提供方 | 服务、真实权重、真实 TS 客户端**已跑通**（见 `docs/STATUS.md` M3）；`pip install python/` 这条路没走过，实测方式是仓库内 `.venv` + `-m local_decider.service` |
| 断外网下的"严格离线" | **未验证**。只验证到代码路径不取网（`HF_HUB_OFFLINE=1` + `local_files_only` + 请求期不下载）；没做断网抓包级验证，所以不写"严格离线" |
| `expectedModel` 逐字段比对 | 核心逻辑有单测（含"不匹配时提供方调用数为 0"），字段**取值**在端到端里对着 `models.lock.json` 核过；两者之间没有真机 mismatch 演练 |
| `ask` 真正弹审批 | **BLOCKED**：需要组合 `@deepseek-ai/dsh-user-approval`，当前测试拓扑里没有它，实测到的是降级为拒绝 |
| `presentationFilter`（收窄模型可见工具） | **默认关闭**，且宿主合同 §8.2 的时序 gate 未通过前不应打开 |
