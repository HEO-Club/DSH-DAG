# DSH 多智能体 DAG 插件

> 声明式、确定性的多智能体 DAG 编排插件，面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
>
> 代码仓库：`@evo-router/dag-core`（编排核心，框架无关） + `@evo-router/dsh-dag`（DSH 适配插件）

DSH 的主智能体循环是一个"单条长时间运行回合"的机器。在主智能体里手工编排多智能体工作流（大量互相独立、部分互相依赖、并行执行、聚合结果）既易出错又难以扩展。DSH 已经内置了**命令式**的扇出能力（`subagent` 工具、`workflow` 工具），但缺少一个**声明式、确定性、基于依赖图**的编排器：就绪节点检测、并发上限、重试策略、结果聚合。

本插件补上这一环——它是 [`llm-router`](../README.md)（Python 包）V0.1 分阶段运行时中经过验证的编排中间层的忠实 TypeScript 移植。设计与迁移方案见
[`docs/dsh-plugin/DSH Multi-Agent DAG Plugin — Engineering Specification & Migration Plan.md`](../docs/dsh-plugin/DSH%20Multi-Agent%20DAG%20Plugin%20—%20Engineering%20Specification%20%26%20Migration%20Plan.md)。

```
DSH 主智能体执行流
  ↓ 模型调用 dag_run（或任意插件调用 ctx.dag.start()）
DSH 适配插件   @evo-router/dsh-dag   （Cordis 插件：工具、服务、配置、事件）
  ↓
DAG 编排核心   @evo-router/dag-core   （框架无关 TS：DAG 模型、校验、分析、
               状态机、事件驱动调度器、异步调度器、调度内核、重试、
               节点校验、融合/去重）
  ↓
并行智能体执行  （经 ctx.subagents 并发拉起子智能体）
```

---

## 核心特性

| 能力 | 说明 |
|---|---|
| 声明式输入 | 模型（或调用方）提交 `TaskGraphProposal` 形状的 JSON：节点、`dependsOn`、`inputSources`、成功标准、可选每节点模型 |
| 确定性 DAG 校验 | 重复节点、未知依赖、自环、环（Kahn）、输入源一致性、schema 兼容、最终输出存在性、不可执行传播——非法提案**不创建运行**，返回结构化可纠正错误 |
| DAG 分析 | 拓扑层级、并行分组、关键路径、优先级 |
| 就绪节点计算 | 事件驱动：全部上游 SUCCEEDED → READY；任一上游 FAILED/CANCELLED → BLOCKED |
| 并行执行 | 独立节点并发运行（全局 + 按模型信号量）；下游仅在所有父节点成功后释放 |
| 执行状态机 | `PENDING→READY→RUNNING→SUCCEEDED/FAILED/CANCELLED`、`BLOCKED` 级联，合法转换 + 审计日志 |
| 重试 / 失败处理 | 仅重试可重试错误，指数退避有上限；每节点超时 → `timed_out` 并入重试策略；取消传播；卡死检测 |
| 结果传播 | 上游输出/产物按节点 id 存储，在构造下游请求时注入（有字符上限） |
| 结果聚合 | 单结果直通；N 结果走 LLM 融合（`fusion: auto/llm`）或确定性去重拼接（`fusion: none`） |
| 可观测性 | `dag/*` 生命周期事件（宿主事件 + 可选写入调用方 Agent 的 Session） |

---

## 仓库结构

```
packages/
├── dag-core/    @evo-router/dag-core  — 框架无关的编排核心
│   ├── src/     model, proposal, compiler, validation, analysis, state-machine,
│   │            event-scheduler, async-scheduler, scheduling-kernel,
│   │            executor-contracts, retry, node-validator, fusion, dedup, run
│   └── tests/   95 个测试（校验、分析、状态机、调度器、内核、重试、
│                节点校验、融合/去重、E2E 场景）
└── dsh-dag/     @evo-router/dsh-dag  — Cordis 适配插件
    ├── src/     index, config, dag-service, dag-run, tool, node-executor,
    │            fusion-executor, events, contracts
    ├── cordis.patch.yml
    └── tests/   16 个测试（插件挂载、运行控制器、节点执行器、工具契约）
```

---

## 快速开始

```bash
# 在本目录安装依赖（typescript + vitest）
npm install --ignore-scripts

# 构建 + 验证
npm run build        # tsc → packages/*/lib
npm run typecheck
npm test             # 111 个测试，无网络、无真实 LLM
```

### 安装到 DSH profile

```bash
dsh plugin --profile <name> add @evo-router/dsh-dag
```

该命令应用 `packages/dsh-dag/cordis.patch.yml`，把 `dsh-dag` 行插入宿主组合。本地开发时可直接用目录路径代替包名安装。

- `dag` 服务位于**宿主平面**（跨会话共享）；
- `dag_run` 工具按智能体暴露：复制一份 preset 并用 `isolate` 隔离域组合（镜像内置 `delegation` 组对 `workflowEngine` 的隔离写法）：

```yaml
- id: dag-delegation
  name: cordis:group
  group: true
  isolate:
    dag: true
  config:
    - id: dsh-dag-tool
      name: '@evo-router/dsh-dag'
```

> `dsh-dag` 是 bundle 插件——`dsh plugin add` 安装时即自动应用其 patch。验证：
> `dsh --profile <name> --dump-config | grep dsh-dag`，再在真实会话里跑一次冒烟。

---

## 配置项

| 键 | 默认值 | 含义 |
|---|---|---|
| `toolName` | `'dag_run'` | 模型可见的工具名 |
| `subagentProvider` | `'spawn'` | 每个节点（及融合调用）使用的 `ctx.subagents` provider |
| `globalLimit` | `4` | 全局节点并发上限（0 = 不限） |
| `perModelLimits` | `{}` | 按模型并发上限（0 = 不限） |
| `retryPolicy.maxRetries` | `2` | 每节点重试上限 |
| `retryPolicy.baseDelaySeconds` | `1` | 指数退避基数 |
| `retryPolicy.maxDelaySeconds` | `30` | 退避上限 |
| `nodeTimeoutSeconds` | `300` | 每节点超时（0 = 禁用） |
| `maxTotalNodes` | `32` | 每次运行的节点数硬顶 |
| `maxResultChars` | `100_000` | 注入下游 prompt 的依赖输出字符上限 |
| `fusion` | `'auto'` | `'auto'` 单结果直通、多结果 LLM 融合；`'llm'` 总是融合；`'none'` 确定性拼接 |
| `emitSessionEvents` | `true` | 把 `dag/*` 记录写入调用方 Agent 的 Session |

---

## 工作流输入 schema（`dag_run`）

模型（或任意调用方）提交 `TaskGraphProposal` 形状的 JSON：

```jsonc
{
  "schemaVersion": "1.0",
  "planId": "research_plan",          // ^[a-z][a-z0-9_-]{0,63}$
  "objective": "调研 X 并撰写报告",
  "nodes": [
    {
      "nodeId": "search",             // ^[a-z][a-z0-9_-]{0,63}$
      "title": "检索文献",
      "prompt": "查找并总结关于 X 的权威资料。",
      "capabilityRequirements": ["web"],
      "outputRequirements": ["一份来源清单（列表形式）"],
      "successCriteria": ["至少 3 个来源"],
      "executorKind": "runtime",      // direct_llm | runtime | worker_agent
      "toolLabels": ["web_search"],
      "model": "deepseek-chat",       // 可选；缺省走 provider 默认路由
      "dependsOn": [],                // 可选
      "inputSources": []              // 每个 dependsOn 项必须对应一条
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

插件会**确定性编译并校验**提案（重复 id、未知依赖、Kahn 环检测、`dependsOn` ⇔ `inputSources` 一致性、schema 兼容、最终输出存在性、不可执行传播）；非法提案**不创建运行**，返回结构化、模型可纠正的错误。

### 工具结果信封

```jsonc
{
  "runId": "dag_a1b2c3d4",
  "status": "completed",              // completed | partial | failed | cancelled
  "value": "……融合后的最终答案……",
  "nodeCount": 2,
  "agentsStarted": 3,                 // 节点数 + 可选融合调用
  "failures": [{ "nodeId": "draft", "status": "failed", "error": "…" }]
}
```

非 `completed` 状态以工具错误形式呈现（绝不伪装成成功）。

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

---

## 事件词汇表

观察型 `dag/*` 事件同时发往宿主，并（可选）追加到调用方 Agent 的 Session：

`dag/run-start` · `dag/node-start` · `dag/node-end` · `dag/retry` · `dag/run-end`

负载只携带标量事实（runId、nodeId、status、attempt、objective、nodeCount），绝不含活动句柄。

---

## 行为保证

- **确定性核心**：图合法性、状态转换（`PENDING → READY → RUNNING → SUCCEEDED/FAILED/CANCELLED`、`BLOCKED` 级联）、并发上限、重试上限与退避、依赖传播均由代码强制（呼应 Router 的"LLM 决策、代码执行"原则）。
- **并行执行**：独立节点在全局 + 按模型上限下并发运行；下游仅在全部父节点成功后释放，任一父节点失败/取消则 BLOCKED。
- **重试**：只重试可重试错误，指数退避有上限，重试 prompt 会附加校验反馈；每节点超时映射为 `timed_out` 并进入重试策略。
- **聚合**：单结果直通；N 结果经一次子智能体调用融合（`fusion: auto/llm`）或确定性去重拼接（`fusion: none`）；运行状态为 `completed/partial/failed/cancelled`。
- **取消**：`run.cancel()` / `exec.signal` 中止在途子智能体；所有子运行必然被 dispose。

---

## 已知限制（V0.1）

- **仅前台运行**（无后台启动/轮询），**无日志恢复/断点续跑**——与 DSH 工作流引擎的纪律一致。
- **无预算/成本台账**；并发默认保守（`globalLimit ≤ 4`）以约束 token 消耗。
- 委派子智能体继承 DSH 子智能体策略：审批固定为 `'never'`、继承沙箱作用域；需要审批类工具的节点会确定性失败。
- 插件**永不**自行判断单智能体 vs 多智能体；工具指引要求模型仅在明确的"多智能体 DAG 工作流"场景使用 `dag_run`。
- `dag-core` 的 JSON Schema 校验支持内联 draft-07 子集（不支持 `$ref`）。

---

## 测试

- `packages/dag-core`：95 个测试，逐场景移植自 Router 的确定性测试套件（`test_validation.py`、`test_analysis.py`、`test_node_state_machine.py`、`test_event_scheduler.py`、`test_async_scheduler.py`、`scheduling/test_kernel.py`、`test_retry_policy.py`、`test_result_validation.py`、`test_fusion_dedup.py`），另含镜像 `test_agentic_e2e.py` 的 E2E 场景。
- `packages/dsh-dag`：16 个测试，使用假子智能体 provider——真实 cordis `Context` 下的插件挂载、运行控制器 E2E、节点执行器错误映射、工具契约。无网络、无真实 LLM、无真实 DSH profile。

---

## 设计参考

- 迁移来源与 1:1 移植纪律：见规范文档（上文链接），其中含 Router 组件映射表（C.3）、耦合切断点（C.4）与验收标准（I）。
- 核心原则：**确定性规则在代码中，语义判断委托给子智能体**（镜像 Router `AGENTS.md` §3.1）。
- 后续方向（V0.2+）：失败反思、动态路由、计划修订、Checkpoint、Human-in-the-loop——见规范 B.2 非目标清单。

## 许可证

MIT
