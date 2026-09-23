# Jey for DSH

Jey 是一个嵌进现有 Agent 的**可替换模型的结构化决策层**。它不接管宿主的规划、生成或授权体系，只在明确的节点上给出观测：这次工具调用是否推进当前目标、证据是否充分、是否与已声明的限制冲突。

设计代号 **ADL**（Agent Decision Layer）来自技术交接包；对外的产品与包名以本仓库为准，即 `jey-*`。

## 现在能用什么

**还不能安装。** 当前进度在 M0/M1：宿主合同已核实、决策核心的纯策略与外发策略已实现并通过测试。没有可用的 DSH 插件包、没有本地推理服务、没有 MCP 服务。

```sh
pnpm install
pnpm -r build && pnpm -r typecheck   # 类型合同
pnpm --filter jey-core test          # 73 条单元
pnpm --filter jey-core test:property # 16 条属性
```

真实状态逐条记在 `docs/STATUS.md`，未运行的项一律写 `NOT_RUN`/`BLOCKED`，不用工程测试通过冒充模型质量合格。

## 三条不可妥协的约束

1. **不增加权限**：模型说“没问题”只是不额外限制，永不取消宿主已有的 deny/ask/沙箱。
2. **不伪造有效性**：Mock、回放、真实推理分开记录；跳过不等于通过。
3. **不静默外传**：默认 `egress.mode=deny`。安装在本机、shadow 模式、本地 HTTP 代理都不等于离线推理。

## 读什么

| 文件 | 内容 |
|---|---|
| `docs/HOST_CONTRACT.md` | M0 实测的 DSH 宿主合同：真实扩展点签名、生命周期顺序、schema 子集 |
| `docs/STATUS.md` | gate 状态矩阵 |
| `docs/handoff/` | 技术交接包原件（哈希核验后复原，非本项目实现） |
| `packages/contracts` | 公共边界类型，不 import DSH |
| `packages/core` | 纯策略、外发策略、边界校验，无 I/O、无网络 |

基线固定为 DSH `0.1.7-alpha.1`（`c36a83f`），不是“永远最新”。
