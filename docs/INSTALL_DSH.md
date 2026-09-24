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

**注意 `mode: enforce` + `provider.kind: mock` 会被直接拒绝装载**，报 `ENFORCE_WITH_MOCK`。这不是运行期降级，是 `apply` 阶段抛错、`ctx.plugin()` 随之失败——已有宿主测试钉住这条。同理，`provider.kind: local` / `typesafe` 目前抛 `not implemented yet`：真实提供方在 M3 落地，宁可装载失败也不静默换成 mock。

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
| Windows 原生 / WSL2 / Linux / macOS 分别验证 | 只在 **Windows 原生 + Node 24.15** 实测过 |
| `ask` 真正弹审批 | **BLOCKED**：需要组合 `@deepseek-ai/dsh-user-approval`，当前测试拓扑里没有它，实测到的是降级为拒绝 |
| `presentationFilter`（收窄模型可见工具） | **默认关闭**，且宿主合同 §8.2 的时序 gate 未通过前不应打开 |
