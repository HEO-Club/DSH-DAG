# DSH 多智能体 DAG 插件

> [English](./README.md) · **中文（简体）**

让你的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 能够并行调度多个智能体，大幅提升长程任务执行效率。

## 介绍

DeepSeek harness是一台"长时间运行"的回合机器。

在主智能体里手工编排多智能体工作流（一部分子任务互相独立、一部分互相依赖、并行执行、聚合结果）既容易出错，也无法扩展。



这就是为什么我们为mutil-agent工作模式设计了：DSH-DAG 插件。模型提交一段简短的 JSON 来描述工作流——节点、依赖、成功标准——剩下的事情交给插件：

- 在运行前**校验**任务图，非法提案直接拒绝，不会浪费任何一次调用；
- 在并发上限内**并行调度**所有就绪节点；
- 对有限的失败做**指数退避重试**；
- 把子节点结果**融合**成一份最终答案。

**简单来说，DSH-DAG的使命就是 *检查任务，分配资源，并行执行，融合结果*。它的存在就是为了帮你提高速度，避免错误。**

对于用户，你无需做任何额外的工作，只需要正常使用DeepSeek Harness，当模型需要调度多个智能体时，DSH-DAG插件会**自动接管**。

## 能力一览

| 能力 | 说明 |
|---|---|
| 声明式输入 | 一段 JSON 任务图：节点、`dependsOn`、`inputSources`、成功标准、可选的每节点模型 |
| 确定性校验 | 重复 id、未知依赖、环、缺失输入来源……非法提案在**运行开始前**被拒绝，并返回结构化、可被模型修正的错误 |
| 并行调度 | 独立节点在全局 + 按模型并发上限下并行运行；下游节点仅在所有父节点成功后释放 |
| 节点状态机 | `PENDING → READY → RUNNING → SUCCEEDED / FAILED / CANCELLED`，失败级联为 `BLOCKED`，全程可审计 |
| 重试与恢复 | 只重试可重试的错误，指数退避有上限；每节点超时；取消干净传播 |
| 结果聚合 | 单个结果直接透传；多个结果由一次 LLM 调用融合（或确定性去重拼接） |
| 可观测性 | `dag/*` 生命周期事件发往宿主，可选写入调用方智能体的 Session |

## 工作原理

```
DSH 主智能体
  │   模型调用 dag_run 工具（或插件调用 ctx.dag.start()）
  ▼
dsh-dag     Cordis 插件层 —— 工具、服务、配置、事件
  │
  ▼
dag-core    框架无关的编排引擎 —— 模型、校验、分析、
            调度器、状态机、重试、融合
  │
  ▼
并行智能体执行 —— 通过 DSH subagents 并发拉起子智能体
```

每一次运行都走同一条确定性流水线：

1. **编译与校验** —— 检查提案；非法图返回可修正的错误，不创建运行。
2. **按波次执行** —— 就绪节点作为并发子智能体运行；每个节点的结果会释放（或阻塞）它的下游。
3. **重试与融合** —— 带校验反馈的有界重试；成功的节点结果融合成一份最终答案。

## 快速开始

### 1. 安装到 DSH profile

```bash
dsh plugin --profile web add dsh-dag
```

安装时会自动应用插件的 bundle patch，把 `dsh-dag` 行插入宿主组合，并在宿主平面提供 `dag` 服务。验证是否生效：

```bash
dsh --profile web --dump-config | grep dsh-dag
```

### 2. 把工具暴露给你的智能体

`dag_run` 工具按智能体暴露：复制一份 preset 并用隔离域（`isolate`）组合，写法与内置 `delegation` 组隔离 `workflowEngine` 的方式一致：

```yaml
- id: dag-delegation
  name: cordis:group
  group: true
  isolate:
    dag: true
  config:
    - id: dsh-dag-tool
      name: 'dsh-dag'
```

### 3. 使用

直接让智能体处理一个多步骤任务，或者用下面的示例工作流直接调用工具。

## 使用 `dag_run` 工具

提交 `TaskGraphProposal` 形状的 JSON：

```jsonc
{
  "schemaVersion": "1.0",
  "planId": "research_plan",          // ^[a-z][a-z0-9_-]{0,63}$
  "objective": "调研 X 并撰写报告",
  "nodes": [
    {
      "nodeId": "search",
      "title": "检索文献",
      "prompt": "查找并总结关于 X 的权威资料。",
      "capabilityRequirements": ["web"],
      "outputRequirements": ["一份来源清单（列表形式）"],
      "successCriteria": ["至少 3 个来源"],
      "executorKind": "runtime",
      "toolLabels": ["web_search"],
      "dependsOn": [],
      "inputSources": []
    },
    {
      "nodeId": "draft",
      "title": "撰写报告",
      "prompt": "根据检索结果撰写报告。",
      "dependsOn": ["search"],
      "inputSources": [{ "sourceNodeId": "search", "purpose": "使用检索结果" }],
      "capabilityRequirements": ["general"],
      "outputRequirements": ["Markdown 报告"],
      "successCriteria": ["覆盖全部来源"],
      "executorKind": "runtime"
    }
  ]
}
```

非法的提案永远不会创建运行——你会收到结构化、可修正的错误。

### 结果信封

```jsonc
{
  "runId": "dag_a1b2c3d4",
  "status": "completed",              // completed | partial | failed | cancelled
  "value": "……融合后的最终答案……",
  "nodeCount": 2,
  "agentsStarted": 3,
  "failures": [{ "nodeId": "draft", "status": "failed", "error": "…" }]
}
```

除 `completed` 以外的状态都会以工具错误的形式呈现——绝不伪装成成功。

### 编程入口

```ts
const run = ctx.dag.start({
  proposal,               // TaskGraphProposal
  parent: exec.agent,
  options: { idempotencyKey?, nodeTimeoutMs?, maxTotalNodes?, fusion?, globalLimit?, maxRetries? },
})
const outcome = await run.result
await run.dispose()
```

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `toolName` | `dag_run` | 模型可见的工具名 |
| `subagentProvider` | `spawn` | 每个节点（及融合调用）使用的 `ctx.subagents` provider |
| `globalLimit` | `4` | 全局节点并发上限（0 = 不限） |
| `perModelLimits` | `{}` | 按模型并发上限（0 = 不限） |
| `retryPolicy.maxRetries` | `2` | 每节点重试上限 |
| `retryPolicy.baseDelaySeconds` | `1` | 指数退避基数 |
| `retryPolicy.maxDelaySeconds` | `30` | 退避上限 |
| `nodeTimeoutSeconds` | `300` | 每节点超时（0 = 禁用） |
| `maxTotalNodes` | `32` | 每次运行的节点数硬顶 |
| `maxResultChars` | `100000` | 注入下游 prompt 的依赖输出字符上限 |
| `fusion` | `auto` | `auto`：单结果透传、多结果 LLM 融合；`llm`：总是融合；`none`：确定性拼接 |
| `emitSessionEvents` | `true` | 把 `dag/*` 事件写入调用方智能体的 Session |

## 可观测性

只读的 `dag/*` 事件同时发往宿主，并（可选）写入调用方智能体的 Session：

`dag/run-start` · `dag/node-start` · `dag/node-end` · `dag/retry` · `dag/run-end`

负载只携带标量事实（runId、nodeId、status、attempt、objective、nodeCount），绝不含活动句柄。

## 保证与限制

**你可以放心依赖的**

- **确定性由代码强制**：图的合法性、状态转换、并发上限、重试上限与依赖传播全部由引擎保证——*模型做决策，代码做执行*。
- **安全的取消**：`run.cancel()` / `exec.signal` 会中止在途的子智能体；每个子运行必然被 dispose。

**当前限制（V0.1）**

- 仅前台运行——不支持后台启动/轮询，无日志恢复/断点续跑。
- 无预算/成本台账；并发默认保守，以约束 token 消耗。
- 插件永不自行判断单智能体 vs 多智能体——只有当模型判断任务确实需要 DAG 时才会调用 `dag_run`。
- 委派子智能体继承 DSH 子智能体策略（审批固定为 `never`、继承沙箱作用域）；需要审批类工具的节点会确定性失败。

## 卸载

```bash
dsh plugin --profile <name> remove dsh-dag
```

然后从智能体 preset 中移除组合的副本（例如上面的 `dag-delegation` 组），并重启会话。卸载时插件会自动取消所有进行中的运行。

---

## 给开发者

快速上手——完整的工程规范见
[`docs/DSH Multi-Agent DAG Plugin — Engineering Specification & Migration Plan.md`](docs/DSH%20Multi-Agent%20DAG%20Plugin%20—%20Engineering%20Specification%20%26%20Migration%20Plan.md)。

```
packages/
├── dag-core/   dsh-dag-core  —— 框架无关的编排引擎（零运行时依赖）
└── dsh-dag/    dsh-dag   —— Cordis 插件适配层
```

```bash
npm install --ignore-scripts   # workspace 安装（typescript + vitest）
npm run build                  # tsc → packages/*/lib
npm run typecheck
npm test                       # 110 个确定性测试 —— 无网络、无真实 LLM
```

`dag-core` 是经过验证的 Python 编排中间层的忠实 TypeScript 移植，为保持 1:1 对齐（组件映射见上方的规范文档）。插件适配层刻意保持轻薄：所有编排逻辑都在 `dag-core`，所有 DSH 相关逻辑都在 `dsh-dag`。

## 许可证

MIT
