# DSH Multi-Agent DAG Plugin

> **English** · [中文（简体）](./README.zh.md)


 Enable Your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to Schedule Multiple Agents in Parallel for Dramatically Improved Long‑Horizon Task Efficiency

## What's this?

DeepSeek Harness functions as a long‑running turn‑based execution machine.

Manually orchestrating multi‑agent workflows inside the main agent — where some subtasks are independent while others carry dependencies, need parallel execution, and require result aggregation — is both error‑prone and poorly scalable.

This is why we designed the **DSH‑DAG Plugin** for multi‑agent workloads. The model submits a concise JSON describing the workflow: nodes, dependencies, and success criteria. The plugin handles everything else:

- **Validate** the task graph before execution; reject invalid proposals immediately without consuming any inference calls.
- **Schedule** all ready‑to‑run nodes in parallel within configured concurrency limits.
- Perform **exponential‑backoff retries** for transient failures.
- **Merge** outputs from child nodes into a consolidated final answer.

In short, the mission of DSH‑DAG is: *validate tasks, allocate resources, execute in parallel, merge results*. It exists purely to boost throughput and eliminate manual orchestration bugs.

From the user’s perspective, no extra work is required. Use DeepSeek Harness as normal. Whenever the model needs to launch multiple agents, the DSH‑DAG plugin takes over **automatically**.


## Capabilities at a glance

| Capability | What it does |
|---|---|
| Declarative input | A JSON task graph: nodes, `dependsOn`, `inputSources`, success criteria, optional per-node model |
| Deterministic validation | Duplicate ids, unknown dependencies, cycles, missing input sources… invalid proposals are rejected **before any run starts**, with structured, model-correctable errors |
| Parallel scheduling | Independent nodes run concurrently under global + per-model limits; dependent nodes are released only when every parent succeeds |
| Node state machine | `PENDING → READY → RUNNING → SUCCEEDED / FAILED / CANCELLED`, failures cascade as `BLOCKED`, full audit trail |
| Retry & recovery | Only retryable errors retry, with bounded exponential backoff; per-node timeouts; clean cancellation propagation |
| Result aggregation | A single result passes through; many results are fused by one LLM call (or deterministically deduped and concatenated) |
| Observability | `dag/*` lifecycle events on the host, optionally recorded into the calling agent's session |

## How it works

```
DSH main agent
  │   the model calls the dag_run tool (or a plugin calls ctx.dag.start())
  ▼
dsh-dag      the Cordis plugin — tool, service, config, events
  │
  ▼
dag-core     the framework-free engine — model, validation, analysis,
             scheduler, state machine, retry, fusion
  │
  ▼
Parallel agent execution — concurrent child agents via DSH subagents
```

Every run follows one deterministic pipeline:

1. **Compile & validate** — the proposal is checked; an invalid graph returns fixable errors and no run is created.
2. **Execute by wave** — ready nodes run as concurrent child agents; each settlement releases (or blocks) its dependents.
3. **Retry & fuse** — bounded retries with validation feedback; successful results are fused into one final answer.

## Quick start

### 1. Install the plugin into a DSH profile

```bash
dsh plugin web <name> add dsh-dag
```

Installing applies the plugin's bundle patch, which inserts the `dsh-dag` row into the host composition and provides the `dag` service on the host plane. Verify it landed:

```bash
dsh --profile web --dump-config | grep dsh-dag
```

### 2. Expose the tool to your agents

The `dag_run` tool is exposed per agent by composing a preset copy with an isolated `dag` realm (mirroring how the built-in `delegation` group isolates `workflowEngine`):

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

### 3. Use it

Ask your agent for a multi-step task, or call the tool directly with a workflow like the one below.

## Using the `dag_run` tool

Submit a `TaskGraphProposal`-shaped JSON:

```jsonc
{
  "schemaVersion": "1.0",
  "planId": "research_plan",          // ^[a-z][a-z0-9_-]{0,63}$
  "objective": "Research X and write a report",
  "nodes": [
    {
      "nodeId": "search",
      "title": "Search the literature",
      "prompt": "Find and summarize the top sources on X.",
      "capabilityRequirements": ["web"],
      "outputRequirements": ["A bullet list of sources"],
      "successCriteria": ["at least 3 sources"],
      "executorKind": "runtime",
      "toolLabels": ["web_search"],
      "dependsOn": [],
      "inputSources": []
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

Invalid proposals never create a run — you get back structured, correctable errors instead.

### Result envelope

```jsonc
{
  "runId": "dag_a1b2c3d4",
  "status": "completed",              // completed | partial | failed | cancelled
  "value": "…fused final answer…",
  "nodeCount": 2,
  "agentsStarted": 3,
  "failures": [{ "nodeId": "draft", "status": "failed", "error": "…" }]
}
```

Anything other than `completed` surfaces as a tool error — never as a silent success.

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

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `toolName` | `dag_run` | The model-facing tool name |
| `subagentProvider` | `spawn` | `ctx.subagents` provider used for every node (and fusion) call |
| `globalLimit` | `4` | Global node concurrency (0 = unlimited) |
| `perModelLimits` | `{}` | Per-model node concurrency (0 = unlimited) |
| `retryPolicy.maxRetries` | `2` | Per-node retry ceiling |
| `retryPolicy.baseDelaySeconds` | `1` | Exponential backoff base |
| `retryPolicy.maxDelaySeconds` | `30` | Backoff cap |
| `nodeTimeoutSeconds` | `300` | Per-node timeout (0 disables) |
| `maxTotalNodes` | `32` | Hard node-count cap per run |
| `maxResultChars` | `100000` | Cap on dependency outputs injected into downstream prompts |
| `fusion` | `auto` | `auto`: single result passes through, many fuse via LLM; `llm`: always fuse; `none`: deterministic concatenation |
| `emitSessionEvents` | `true` | Record `dag/*` events into the calling agent's session |

## Observability

Observe-only `dag/*` events are emitted on the host and (optionally) appended to the calling agent's session:

`dag/run-start` · `dag/node-start` · `dag/node-end` · `dag/retry` · `dag/run-end`

Payloads carry scalar facts only — never live handles.

## Guarantees and limitations

**What you can rely on**

- **Determinism is code-enforced**: graph legality, state transitions, concurrency, retry caps and dependency propagation are all enforced by the engine — *the model decides, the code enforces*.
- **Safe cancellation**: `run.cancel()` / `exec.signal` aborts in-flight children; every child run is disposed.

**Current limitations (V0.1)**

- Foreground-only runs — no background start/poll, no journaling/resume.
- No budget/cost ledger; concurrency defaults conservatively to bound token spend.
- The plugin never decides single- vs multi-agent — the model calls `dag_run` only when it judges the task genuinely needs a DAG.
- Delegated children inherit DSH sub-agent policy (approval `never`, sandbox scope inherited); nodes that need approval-gated tools fail deterministically.

## Uninstall

```bash
dsh plugin --profile <name> remove dsh-dag
```

Then remove the composed preset copy (e.g. the `dag-delegation` group above) from your agent preset and restart the session. Active runs are cancelled automatically on unload.

---

## For developers

Quick orientation — the full engineering specification 
[`docs/DSH Multi-Agent DAG Plugin — Engineering Specification & Migration Plan.md`](docs/DSH%20Multi-Agent%20DAG%20Plugin%20—%20Engineering%20Specification%20%26%20Migration%20Plan.md).

```
packages/
├── dag-core/   dsh-dag-core  — framework-free orchestration engine (zero runtime deps)
└── dsh-dag/    dsh-dag   — the Cordis plugin adapter
```

```bash
npm install --ignore-scripts   # workspace install (typescript + vitest)
npm run build                  # tsc → packages/*/lib
npm run typecheck
npm test                       # 110 deterministic tests — no network, no real LLM
```

`dag-core` is a faithful TypeScript port of a proven Python orchestration middle layer, kept 1:1 for parity (component mapping in the spec above). The plugin adapter is deliberately thin: everything orchestration-related lives in `dag-core`, everything DSH-related lives in `dsh-dag`.

## License

MIT
