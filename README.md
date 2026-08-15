# DSH Multi-Agent DAG Plugin

> **Language:** English | [中文（简体）](./README.zh.md)

Declarative, deterministic multi-agent DAG orchestration for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The DSH main agent loop is a single long-running turn machine. Running a
multi-agent workflow (many independent sub-tasks, some dependent on others,
run in parallel, results aggregated) by hand from the main agent is
error-prone and does not scale. DSH already ships *imperative* fan-out
(`subagent` tool, `workflow` tool), but no **declarative, deterministic,
dependency-graph** orchestrator with ready-node detection, concurrency limits,
retry policy, and result aggregation.

This plugin provides exactly that, as a faithful TypeScript port of the
proven orchestration middle layer of the [`llm-router`](https://github.com/your-org/llm-router)
Python package (V0.1 staged runtime). Design and migration plan:
[`docs/dsh-plugin/DSH Multi-Agent DAG Plugin — Engineering Specification & Migration Plan.md`](../docs/dsh-plugin/DSH%20Multi-Agent%20DAG%20Plugin%20—%20Engineering%20Specification%20%26%20Migration%20Plan.md).

```
DSH (main Agent execution flow)
  ↓ model calls `dag_run` (or any plugin calls ctx.dag.start())
DSH Plugin Adapter   @evo-router/dsh-dag   (Cordis plugin: tool, service, config, events)
  ↓
DAG Orchestration Core  @evo-router/dag-core  (framework-free TS: DAG model, validation,
                        analysis, state machine, event-driven scheduler, async scheduler,
                        scheduling kernel, retry, node validation, fusion/dedup)
  ↓
Parallel Agent Execution  (concurrent child Agents via ctx.subagents)
```

## Repository layout

```
packages/
├── dag-core/    @evo-router/dag-core  — framework-free orchestration core
│   ├── src/     model, proposal, compiler, validation, analysis, state-machine,
│   │            event-scheduler, async-scheduler, scheduling-kernel,
│   │            executor-contracts, retry, node-validator, fusion, dedup, run
│   └── tests/   95 tests (validation, analysis, state machine, schedulers,
│                kernel, retry, node validation, fusion/dedup, E2E scenarios)
└── dsh-dag/     @evo-router/dsh-dag  — the Cordis plugin adapter
    ├── src/     index, config, dag-service, dag-run, tool, node-executor,
    │            fusion-executor, events, contracts
    ├── cordis.patch.yml
    └── tests/   16 tests (plugin mount, run controller, node executor, tool contract)
```

## Install

```bash
# from this directory
npm install --ignore-scripts          # workspace install (typescript + vitest)

# build + verify
npm run build                         # tsc → packages/*/lib
npm run typecheck
npm test                              # 111 tests, no network, no real LLM
```

### Install the plugin into a DSH profile

```bash
dsh plugin --profile <name> add @evo-router/dsh-dag
```

This applies `packages/dsh-dag/cordis.patch.yml`, which inserts the `dsh-dag`
row into the host composition. For local development you can add the package
by directory path instead of a registry name. The `dag` service lives on the
host plane (it is shared across sessions); expose the `dag_run` tool per agent
by composing a preset copy with an `isolate` realm (mirroring the shipped
`delegation` group that isolates `workflowEngine`):

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

> Note: `dsh-dag` is a bundle plugin — installing it via `dsh plugin add`
> applies its patch automatically. Verify with
> `dsh --profile <name> --dump-config | grep dsh-dag` and a live session.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `toolName` | `'dag_run'` | Model-facing tool name. |
| `subagentProvider` | `'spawn'` | `ctx.subagents` provider used for every node (and fusion) call. |
| `globalLimit` | `4` | Global node concurrency (0 = unlimited). |
| `perModelLimits` | `{}` | Per-model node concurrency (0 = unlimited). |
| `retryPolicy.maxRetries` | `2` | Per-node retry ceiling. |
| `retryPolicy.baseDelaySeconds` | `1` | Exponential backoff base. |
| `retryPolicy.maxDelaySeconds` | `30` | Backoff cap. |
| `nodeTimeoutSeconds` | `300` | Per-node timeout (0 disables). |
| `maxTotalNodes` | `32` | Hard node-count cap per run. |
| `maxResultChars` | `100_000` | Cap on dependency outputs injected into downstream prompts. |
| `fusion` | `'auto'` | `'auto'` single result passes through, N results fuse via LLM; `'llm'` always fuse; `'none'` deterministic concatenation. |
| `emitSessionEvents` | `true` | Project `dag/*` records into the calling Agent's Session. |

## Workflow input schema (`dag_run`)

The model (or any caller) submits a `TaskGraphProposal`-shaped JSON:

```jsonc
{
  "schemaVersion": "1.0",
  "planId": "research_plan",          // ^[a-z][a-z0-9_-]{0,63}$
  "objective": "Research X and write a report",
  "nodes": [
    {
      "nodeId": "search",             // ^[a-z][a-z0-9_-]{0,63}$
      "title": "Search the literature",
      "prompt": "Find and summarize the top sources on X.",
      "capabilityRequirements": ["web"],
      "outputRequirements": ["A bullet list of sources"],
      "successCriteria": ["at least 3 sources"],
      "executorKind": "runtime",      // direct_llm | runtime | worker_agent
      "toolLabels": ["web_search"],
      "model": "deepseek-chat",       // optional; absent → provider default
      "dependsOn": [],                // optional
      "inputSources": []              // one entry per dependsOn entry
    },
    {
      "nodeId": "draft",
      "title": "Draft the report",
      "prompt": "Write the report from the search results.",
      "dependsOn": ["search"],
      "inputSources": [{ "sourceNodeId": "search", "purpose": "use search results" }],
      "capabilityRequirements": ["general"],
      "outputRequirements": ["Markdown report"],
      "successCriteria": ["covers all sources"],
      "executorKind": "runtime"
    }
  ]
}
```

The plugin **compiles and validates** the proposal deterministically (duplicate
ids, unknown dependencies, cycles via Kahn, input-source consistency, schema
compatibility, final-output existence, non-executability propagation) and
returns structured, model-correctable errors **without creating a run** when it
is invalid.

### Tool result envelope

```jsonc
{
  "runId": "dag_a1b2c3d4",
  "status": "completed",              // completed | partial | failed | cancelled
  "value": "…fused final answer…",
  "nodeCount": 2,
  "agentsStarted": 3,                 // nodes + optional fusion call
  "failures": [{ "nodeId": "draft", "status": "failed", "error": "…" }]
}
```

Non-`completed` statuses are surfaced as tool errors (never as success).

### Programmatic entry

```ts
const run = ctx.dag.start({
  proposal,               // TaskGraphProposal
  parent: exec.agent,
  options: { idempotencyKey?, nodeTimeoutMs?, maxTotalNodes?, fusion?, globalLimit?, maxRetries? },
})
const outcome = await run.result
await run.dispose()
```

## Event vocabulary

Observe-only `dag/*` events are emitted on the host and (optionally) appended
to the calling Agent's Session:

`dag/run-start` · `dag/node-start` · `dag/node-end` · `dag/retry` · `dag/run-end`

Payloads carry scalar facts only (runId, nodeId, status, attempt, objective,
nodeCount) — never live handles.

## Behavior guarantees

- **Deterministic core**: graph legality, state transitions (`PENDING → READY →
  RUNNING → SUCCEEDED/FAILED/CANCELLED`, `BLOCKED` cascade), concurrency limits,
  retry caps and backoff, and dependency propagation are enforced in code
  (mirroring the Router's "LLM decides, code enforces" principle).
- **Parallel execution**: independent nodes run concurrently under global +
  per-model limits; dependent nodes are released only when every parent
  succeeds and are BLOCKED when any parent fails or is cancelled.
- **Retry**: only retryable errors retry, with bounded exponential backoff and
  validation feedback appended to the retry prompt; per-node timeouts map to
  `timed_out` and follow the retry policy.
- **Aggregation**: single result passes through; N results fuse via one
  sub-agent call (`fusion: auto`/`llm`) or deterministic dedup concatenation
  (`fusion: none`); run status is `completed`/`partial`/`failed`/`cancelled`.
- **Cancellation**: `run.cancel()` / `exec.signal` aborts in-flight children;
  every child run is always disposed.

## Known limitations (V0.1)

- Foreground-only runs (no background start/poll) and **no journaling/resume**
  — matching the DSH workflow engine discipline.
- No budget/cost ledger; concurrency defaults conservatively (`globalLimit ≤ 4`)
  to bound token spend.
- Delegated children inherit DSH sub-agent policy: approval is pinned to
  `'never'` and the child inherits the sandbox scope; a node needing
  approval-gated tools fails deterministically.
- The plugin never decides single- vs multi-agent; the tool guidance instructs
  the model to use `dag_run` only for explicit multi-agent DAG workflows.
- `dag-core`'s JSON Schema validation supports an inline draft-07 subset
  (`$ref` unsupported).

## Testing

- `packages/dag-core`: 95 tests, ported scenario-for-scenario from the Router's
  deterministic suites (`test_validation.py`, `test_analysis.py`,
  `test_node_state_machine.py`, `test_event_scheduler.py`,
  `test_async_scheduler.py`, `scheduling/test_kernel.py`,
  `test_retry_policy.py`, `test_result_validation.py`, `test_fusion_dedup.py`)
  plus E2E scenarios mirroring `test_agentic_e2e.py`.
- `packages/dsh-dag`: 16 tests with a fake sub-agent provider — plugin mount
  under a real cordis `Context`, run controller E2E, node-executor error
  mapping, tool contract. No network, no real LLM, no real DSH profile.
