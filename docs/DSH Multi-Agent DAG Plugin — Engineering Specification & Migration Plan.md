# DSH Multi-Agent DAG Plugin — Engineering Specification & Migration Plan

> **Status:** Specification (not implemented).
> **Working name:** `dsh-dag` (adapter plugin) + `dsh-dag-core` (framework-free orchestration library).
> **Target platform:** DeepSeek Harness (DSH) `0.1.0-rc.6` (Cordis plugin model).
>
> This document is a **development specification for a future AI coding agent**. It is based on actual source inspection of both codebases:
>
> - **Router (source of the orchestration logic):** `C:\Users\32258\Desktop\MyWork\LLM router\code` — Python package `llm-router` (V0.1 staged runtime).
> - **DSH (target platform):** the installed npm packages under `...\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\*` (the compiled/typed DSH implementation, incl. `@deepseek-ai/cordis` with its TypeScript sources), the DSH CLI's shipped agent presets and plugin-development skills, and the official docs repo (`deepseek-ai/deepseek-harness`, `docs/user/develop/basic/*`) referenced via search. Direct network fetch of the docs site was blocked in this environment; items that could not be confirmed from source are explicitly marked.
>
> **Legend:** **[VERIFIED]** = confirmed against actual source in this analysis; **[DESIGN]** = proposed decision by this specification; **[UNKNOWN]** = not confirmable here — must be verified during implementation.

---

## A. Project Goal

### A.1 What the plugin is

Extract the **DAG-based orchestration and parallel multi-agent execution** capability that already exists and works in the Router repository and turn it into a **DeepSeek Harness (DSH) plugin**.

The Router (`llm-router`) is a Python "agentic router". In its V0.1 staged runtime it already:

1. decomposes a user goal into an acyclic task graph (`TaskGraphProposal` → `ExecutionPlan`),
2. deterministically validates it (cycles, duplicate/unknown node ids, input-source consistency),
3. analyzes it (topological levels, parallel groups, critical path, priorities),
4. schedules ready nodes under global and per-model concurrency limits,
5. executes independent nodes **concurrently** (pure asyncio),
6. propagates terminal outcomes to release or block dependent nodes,
7. retries failures with bounded exponential backoff,
8. validates node results, and
9. aggregates successful node results into a final answer.

That whole middle layer — from "validated task graph" to "fused final result" — is framework-neutral orchestration logic. This plugin re-implements it in **TypeScript/JavaScript** on top of DSH's official extension points, so any DSH agent can run deterministic multi-agent DAG workflows without re-deriving the orchestration and without coupling DSH to the Python Router.

```text
DSH (main Agent execution flow)
  ↓ calls (model calls a tool, or another plugin calls a service)
DSH Plugin Adapter   (Cordis plugin: tools, service, config, lifecycle, events)
  ↓
DAG Orchestration Core (framework-free TS library: DAG model, validation, analysis,
                        state machine, event-driven scheduler, async scheduler,
                        scheduling kernel, retry, node validation, fusion/dedup)
  ↓
Parallel Agent Execution (concurrent child Agents via DSH sub-agent seam /
                          workflow engine / raw agents.create)
```

### A.2 Problem it solves

- DSH's main agent loop is a single, long-running agent turn machine. Running a multi-agent workflow (many independent sub-tasks, some dependent on others, run in parallel, results aggregated) by hand from the main agent is error-prone and does not scale.
- DSH already ships *imperative* fan-out (`subagent` tool, `workflow` tool with model-written JS scripts), but it has no **declarative, deterministic, dependency-graph** orchestrator with ready-node detection, concurrency limits, retry policy, and result aggregation.
- The Router already solved exactly that deterministically. The plugin makes the proven behavior available inside DSH.

### A.3 Fixed design intent (from the task brief)

1. DSH remains responsible for the main Agent execution flow.
2. When a multi-agent workflow needs to run, **this plugin** provides the orchestration layer.
3. The plugin handles: DAG construction, dependency management, ready-node detection, scheduling, parallel execution, execution state, failure handling, and result aggregation.
4. The plugin does **NOT** initially take over the entire user task flow, and does **NOT** decide whether a task should use single-agent or multi-agent execution. That decision stays with the DSH main agent (the model) or with an outer orchestrator (e.g. a future Router adapter).
5. Core orchestration logic is separated from Router-specific logic as much as reasonably possible.
6. DSH-specific integration is implemented only through DSH's official plugin/extension mechanisms.

---

## B. Scope and Non-Goals

### B.1 In scope (plugin responsibilities)

| # | Capability | Notes |
|---|---|---|
| 1 | DAG / task-graph representation | Nodes, edges (`depends_on`), plan/run identity, per-node execution state. |
| 2 | DAG construction & compilation | From a model-supplied node list (`depends_on`, `input_sources`) into a validated, topologically ordered `ExecutionPlan`. |
| 3 | DAG validation (deterministic) | Duplicate ids, unknown dependencies, self-loops, cycles (Kahn), missing/undeclared input sources, schema compatibility, final-output existence, non-executability propagation. |
| 4 | DAG analysis | Topological levels, parallel groups, critical path, node priorities. |
| 5 | Ready-node calculation | Event-driven: PENDING→READY when all dependencies SUCCEEDED; PENDING→BLOCKED when a dependency FAILED/CANCELLED. |
| 6 | Scheduling | Wave execution of the ready frontier, priority ordering, global + per-resource concurrency limits. |
| 7 | Parallel execution | Independent nodes execute concurrently; dependent nodes are released when upstreams settle. |
| 8 | Execution state | Node state machine with validated transitions and an auditable transition log. |
| 9 | Retry / failure handling | Bounded exponential-backoff retry, retryable-error classification, timeout, cancellation propagation, stuck-run detection. |
| 10 | Result propagation | Node outputs/artifacts stored by node id; injected into dependent node prompts at request-build time. |
| 11 | Result aggregation | Single-result pass-through, deterministic dedup fallback, optional LLM fusion of successful outputs. |
| 12 | Observability | DAG/node lifecycle events exposed to DSH (session events + observer events). |

### B.2 Non-goals (explicitly NOT the plugin's job)

| # | Non-goal | Reason |
|---|---|---|
| 1 | Taking over the user task flow | The plugin is invoked; it does not decide whether a task becomes a DAG. |
| 2 | Deciding single-agent vs multi-agent | Stays with the DSH main agent / outer orchestrator. |
| 3 | Router request understanding | `src/understanding/*` (classifiers, risk detector, request standardization) stays in the Router. |
| 4 | Router model routing / allocation | `src/routing/*` (candidate scoring, `RouterModelAllocator`) stays in the Router. The plugin accepts an optional `model` per node or inherits the DSH default route. |
| 5 | Budget / cost ledger | `src/model_layer/*` (`BudgetController`, `CostLedger`) stays in the Router. The plugin passes through per-node `maxTokens` and enforces `maxTotalNodes`, but has no budget ledger. |
| 6 | Dynamic DAG modification / mid-run local re-planning | Router V0.1 does not support it; do not invent it in the plugin (V0.2 scope). |
| 7 | Long-term memory / capability profiles | Router V0.1 non-goal; also non-goal here. |
| 8 | Checkpointing / resume of a DAG run | DSH's workflow engine explicitly has no journaling/resume; the plugin follows the same discipline for V0.1. |
| 9 | Implementing a new Agent loop | `dsh-agent-loop` owns the agent loop; the plugin only orchestrates on top. |
| 10 | Replacing DSH's `workflow` tool | `dsh-tool-workflow` + `dsh-workflow-worker-thread` are the shipped imperative fan-out. The plugin is a *declarative deterministic* orchestrator; reusing the workflow engine as an execution backend is optional (E.5.2), never a replacement. |
| 11 | Porting Router persistence (SQLite attempt store, artifact store, checkpoint store) | Router infrastructure. Plugin keeps run state in memory + DSH events; only the idempotency *concept* is kept. |
| 12 | LLM-written DAG planning | V0.1: the model supplies the node list; the plugin compiles/validates/runs it. (A future `dag_plan` step is out of scope.) |

### B.3 Boundary rule

Everything that requires **semantic judgment** (write node prompts, decide retry strategy, judge result quality) may be delegated by the plugin to an Agent (sub-agent call). Every **deterministic rule** (graph legality, state transitions, concurrency, retry caps, dependency propagation) lives in deterministic code — mirroring the Router's "LLM decides, code enforces" principle ([VERIFIED] Router `AGENTS.md` §3.1).

---

## C. Existing Router Code Analysis

> All paths relative to the Router repo root. Claims verified by reading the sources and tests listed in Appendix A.

### C.1 How the Router runtime is built

The Router is a **staged runtime**: `src/runtime/staged.py` (`StagedActionDispatcher.dispatch(decision, state)`) executes a fixed action set (`src/router_agent/decisions.py`): `ANALYZE_REQUEST → CREATE_PLAN → VALIDATE_PLAN → ROUTE_NODE → EXECUTE_READY_NODES → VALIDATE_NODE → RETRY_NODE → FINALIZE → FAIL_RUN`. Loop state is `StagedRouterState` (`src/runtime/staged.py`): goal, `TaskGraphProposal`, compiled `ExecutionPlan`, `PlanAssignments` (model per node), node results, retry counts, `FinalAnswer`. The loop (`src/runtime/staged_loop.py`) does observe → decide → guard → dispatch rounds with a deadline, iteration cap, and stall detection.

The orchestration chain the plugin must reproduce:

```text
User request
 → src/understanding/*      RequestAnalysis, RequestMode                        [Router-specific — NOT migrated]
 → src/planning/*           LLM planner → TaskGraphProposal(nodes, depends_on,   [the plugin's INPUT contract]
                            input_sources)
 → src/planning/graph.py    TaskGraphCompiler.compile(proposal) → ExecutionPlan   [REUSE → dag-core]
 → src/planner/validation.py DAGValidator (Kahn cycles, dup ids, unknown deps)   [REUSE → dag-core]
 → src/planner/analysis.py  DAGAnalyzer (levels, parallel groups, priorities)    [REUSE → dag-core]
 → src/routing/*            PlanAssignments (model per node)                     [NOT migrated; model per node or DSH default]
 → src/planner/async_scheduler.py  waves + concurrency semaphores                [REUSE → dag-core]
 → src/executor/*           ExecutorRunner / DirectLLMExecutor / WorkerAgentExecutor → NodeResult  [ADAPT: node execution = DSH sub-agent call]
 → src/validation/*         NodeResultValidator (schema + success criteria)      [ADAPT: deterministic in plugin; LLM check optional]
 → src/fusion/*             TypedResultFusion + dedup → FinalAnswer              [ADAPT: final aggregation]
```

### C.2 Capability inventory (verified, with exact contracts)

#### C.2.1 DAG / graph representation — `src/core/models.py`

- `TaskStatus` (str Enum): `pending, ready, running, succeeded, failed, blocked, cancelled`.
- `Query`: `id, content, skill, required=True, context (dict), depends_on: list[str], input_schema, output_schema`.
- `PlanStep`: `query, status: TaskStatus = PENDING, result: Any|None, error: str|None` — the per-node state holder.
- `ExecutionAnalysis`: `topo_levels, parallel_groups, critical_path, priorities`.
- `ExecutionPlan`: `original_task, steps, revision, dag_edges: list[tuple[upstream,downstream]], analysis` + `ready_steps` property (PENDING/READY nodes whose deps are all SUCCEEDED).
- `ExecutionResult`: `query_id, model_used, content, metadata, artifact_ids, error`.
- `FinalAnswer`: `task, answer, sub_results, dedup_removed_node_ids`.

**Verdict: REUSE** (port to TS; drop `Query.skill`'s coupling to Router prompts; keep `context` as a typed bag).

#### C.2.2 DAG construction — `src/planning/contracts.py`, `src/planning/graph.py`

- `TaskGraphProposal` (`schema_version: "1.0"`, `plan_id`, `revision`, `objective`, `goal_analysis?`, `nodes: list[TaskNodeProposal]`, `fallback_plan`); `TaskNodeProposal` (`node_id` [pattern `^[a-z][a-z0-9_-]{0,63}$`], `title`, `prompt`, `depends_on`, `input_sources: list[InputSourceProposal{source_node_id,purpose}]`, `capability_requirements`, `output_requirements`, `success_criteria`, `executor_kind`, `tool_labels`, `executor_recommendation`, `estimate`).
- `TaskGraphCompiler.compile(proposal) → ExecutionPlan`: maps proposals to `Query`s (requirements into `query.context`), builds `dag_edges`, enforces `depends_on` ⇔ `input_sources` consistency (issues: `duplicate_dependency`, `duplicate_input_source`, `unknown_input_source`, `missing_input_source`, `undeclared_input_dependency`), runs `DAGValidator`, raises structured `PlanningError(INVALID_GRAPH, issues)` on failure, reorders steps by topo order, attaches `DAGAnalyzer.analyze`.

**Verdict: REUSE** — `TaskGraphProposal`/`TaskNodeProposal` become the plugin's **declarative workflow input schema**; `TaskGraphCompiler` becomes `dag-core`'s `compile()`.

#### C.2.3 DAG validation — `src/planner/validation.py`

`DAGValidator.validate(plan) → ValidationResult {valid, errors, warnings, topo_order, non_executable_node_ids}` with `ValidationIssue {code, message, severity, node_ids}`. Checks (never raises): `empty_plan`, `duplicate_node_id`, `missing_dependency`, `input_schema_unprovided`, `schema_unverified` (warning), `schema_mismatch`, **`cycle_detected` via Kahn's algorithm**, `isolated_node` (warning), `no_valid_final_output`, `no_required_final_output` (warning); then propagates non-executability along edges.

#### C.2.4 DAG analysis — `src/planner/analysis.py`

`DAGAnalyzer.analyze(plan) → ExecutionAnalysis`: Kahn topo sort (proves acyclicity), `dist_from_start`/`dist_to_end`, `topo_levels` (root=0), `parallel_groups` (same-level nodes run in parallel), `critical_path` (backtrack from deepest sink), `priorities` (slack+1; **lower = higher priority**, critical path = 1).

#### C.2.5 Node state machine — `src/planner/state_machine.py`

`TRANSITION_RULES`: `PENDING→{READY,BLOCKED,CANCELLED}`; `READY→{RUNNING,CANCELLED}`; `RUNNING→{SUCCEEDED,FAILED,CANCELLED}`; `BLOCKED→{CANCELLED}`; terminals absorbing. `TERMINAL_STATUSES={SUCCEEDED,FAILED,CANCELLED}`; `SUCCESS_STATUSES={SUCCEEDED}`. `transition(step, to_status, reason) → NodeTransition {node_id, from_status, to_status, reason, occurred_at}`; illegal transitions raise `NodeTransitionError`. Mutates `PlanStep.status` in place.

#### C.2.6 Ready-node calculation & scheduling — `src/planner/scheduler.py`, `src/planner/async_scheduler.py`, `src/scheduling/*`

- `EventDrivenScheduler`: `bind(plan)` builds `_parents`/`_children` adjacency; `activate()` (one-time, roots PENDING→READY); `ready(node_id)`; `start(node_id)` (READY→RUNNING); `notify(node_id, terminalStatus) → newly-ready ids`; `cancel(node_id)`; `history`. `_propagate` inspects **only direct children**: PENDING child → READY when all parents SUCCEEDED; → BLOCKED (and frontier-continued) when any parent FAILED/BLOCKED/CANCELLED. **No ready queue, no full-DAG scan** — this is the dependent-node release mechanism.
- `AsyncExecutionScheduler`: `bind(plan)`; `execute(node_ids, build_request, execute_one, max_waves)` — waves of `asyncio.gather` under **global + per-model `asyncio.Semaphore`s** (`ConcurrencyLimits {global_limit (0=unlimited), model_limits}`); `execute_wave`; `execute_committed_wave` (nodes already atomically RUNNING); `retry_wave`; `settle(result)` (SUCCEEDED → notify + `step.result = artifacts or content`; else notify + `step.error`); `stuck_reason()` (pending blocked by failed deps / cannot become runnable). One `execute()` drains the whole DAG. Type aliases: `NodeRequestBuilder = Callable[[str], NodeExecutionRequest]`, `NodeExecutor = Callable[[NodeExecutionRequest], Awaitable[NodeResult]]`.
- `DeterministicSchedulingKernel` (`src/scheduling/kernel.py` + `contracts.py`): `snapshot(plan, ...) → SchedulingSnapshot {candidates (ready nodes with priority/model/deps), global_limit, model_limits}`; `validate(snapshot, decision)` (rejects unknown/over-limit selections); `fallback(snapshot) → SchedulingDecision` (deterministic priority-ordered wave within limits); `commit(plan, decision, ...)` (validates then atomically transitions selected nodes PENDING→READY→RUNNING on a deep copy, returns `SchedulingCommit {decision, transitions}`). The optional LLM `AgentScheduler` (`src/scheduling/agent.py`) falls back to `kernel.fallback` on failure — the plugin can ship only the deterministic kernel.

#### C.2.7 Node execution — `src/executor/*`

- `NodeExecutionRequest`: `run_id, node_id, executor_kind, prompt, idempotency_key?, goal_id?, plan_id?, model_id?, deployment_id?, dependency_outputs: dict[node_id,str], dependency_artifacts: dict[node_id,list[ArtifactRef]], allowed_tools, output_requirements, success_criteria, expected_output_schema?, metadata, call_purpose, attachments`.
- `NodeResult`: `run_id, node_id, executor_kind, status: NodeResultStatus {succeeded,failed,timed_out,cancelled}, content, structured_output?, model_id?, duration_ms, metadata, artifacts, error?` — after-validator: success ⇒ no error; failure ⇒ error required.
- `ExecutionErrorType` (19 stable categories): `invalid_request, executor_unavailable, provider_error, invalid_response, timeout, cancelled, internal_error, model, network, rate_limit, tool, runtime, dag, validation, budget, permission, idempotency, artifact` (+ alias `WORKER_AGENT`). `ExecutionError {error_type, message, retryable, code?, details?}` with sanitized `public_error_message()`.
- `ExecutorKind`: `DIRECT_LLM` / `RUNTIME` (alias `WORKER_AGENT`).
- `DirectLLMExecutor` (`src/executor/direct.py`): one gateway call per node; injects `dependency_outputs` (bounded chars) + artifacts; JSON-Schema structured output with repair round; classifies errors (BudgetDenied → non-retryable `BUDGET`; provider exceptions → retryable `PROVIDER_ERROR`; schema failures → retryable `INVALID_RESPONSE`).
- `WorkerAgentExecutor` (`src/executor/worker.py`): translates a node into `AgentSpec(role=WORKER)` + `AgentRunRequest` via `AgentBroker` (`src/runtimes/*`); maps `AgentRunStatus {running, awaiting_approval, paused, succeeded, failed, timed_out, cancelled}` → `NodeResultStatus`.
- `ExecutorRunner` (`src/executor/runner.py`): idempotent (per-key lock + attempt store reuse), bounded (`asyncio.wait_for` → `TIMED_OUT` retryable), exception classification, cancellation-safe.
- `RetryingExecutorRunner` (`src/executor/retry.py`): `RetryPolicy {max_retries=0, base_delay_seconds=1, max_delay_seconds=30}`; `RetryTargets {backup_deployment_id?, backup_model_id?}`; delay = `min(max, base·2^(n-1))`; only retries `error.retryable`; records `retry_attempts` + `retry_exhausted` in metadata.
- `NodeResultValidator` (`src/validation/validator.py` + `contracts.py`): deterministic checks (`execution_failed`, `empty_result`, `invalid_json`, `schema_validation_failed`, required artifacts, success-criteria substring) + optional bounded LLM review.

#### C.2.8 Result aggregation — `src/fusion/*`

- `TypedResultFusion.fuse(task, results, failures) → FinalAnswer`: 0 results → "No successful results were produced."; 1 result → pass-through; N → one LLM call joining `[query_id] content` blocks.
- `dedup_node_results(results, max_items=64, max_total_chars=2_000_000) → (results, removed_ids)` and `failure_summary(failures)` — deterministic fallback.

#### C.2.9 Events & state — `src/domain/events.py`, `src/infrastructure/*`

- `RouterEventType` (31 values incl. `plan.created`, `dag.validated`, `node.started`, `node.completed`, `node.failed`, `node.result_reused`, `model.called`, `retry.recorded`, `run.completed`, `run.failed`, `run.cancelled`); `RouterRunStatus {completed, partial, failed, cancelled}`; `RouterEvent` envelope: `schema_version, event_id (event_<uuidhex>), event_type, occurred_at, run_id, goal_id, plan_id?, node_id?, trace_id?, span_id?, parent_span_id?, metrics? (latency_ms, execution_latency_ms, input_tokens, output_tokens, cost, retry_count, ...), details, plan_snapshot?, node_request?, node_result?, run_status?, completion_reason?`.
- `EventSink` protocol with `InMemoryEventSink`, `RedactingEventSink`, `JsonlEventSink` — sequential, order-preserving.

### C.3 Component mapping table (original → responsibility → reuse/refactor/remove → target plugin component)

| # | Original component (Router) | Responsibility | Verdict | Target plugin component |
|---|---|---|---|---|
| 1 | `src/core/models.py` (DAG/result half: `TaskStatus`, `Query`, `PlanStep`, `ExecutionPlan`, `ExecutionAnalysis`, `ExecutionResult`, `FinalAnswer`) | DAG/node/result domain model | **Reuse (port to TS)** | `dag-core` `model.ts` |
| 2 | `src/planning/contracts.py` (`TaskGraphProposal`, `TaskNodeProposal`, `InputSourceProposal`, `GoalAnalysis`, `ExecutionEstimate`, `FallbackPlan`) | Declarative workflow input schema | **Reuse (port to TS)** | `dag-core` `proposal.ts` (+ JSON Schema for the tool input) |
| 3 | `src/planning/graph.py` `TaskGraphCompiler` | Proposal → validated execution plan | **Reuse (port to TS)** | `dag-core` `compiler.ts` |
| 4 | `src/planner/validation.py` `DAGValidator` | DAG legality + Kahn cycle detection | **Reuse (port 1:1)** | `dag-core` `validation.ts` |
| 5 | `src/planner/analysis.py` `DAGAnalyzer` | Levels / parallel groups / critical path / priorities | **Reuse (port 1:1)** | `dag-core` `analysis.ts` |
| 6 | `src/planner/state_machine.py` | Node state machine | **Reuse (port 1:1)** | `dag-core` `state-machine.ts` |
| 7 | `src/planner/scheduler.py` `EventDrivenScheduler` | Ready propagation / BLOCKED cascade | **Reuse (port 1:1)** | `dag-core` `event-scheduler.ts` |
| 8 | `src/planner/async_scheduler.py` `AsyncExecutionScheduler` + `ConcurrencyLimits` | Wave execution, concurrency semaphores | **Reuse (port; asyncio → Promise)** | `dag-core` `async-scheduler.ts` |
| 9 | `src/scheduling/kernel.py` + `contracts.py` | Deterministic scheduling snapshot/validate/fallback/commit | **Reuse (port)** | `dag-core` `scheduling-kernel.ts` |
| 10 | `src/scheduling/agent.py` `AgentScheduler` | LLM scheduler agent | **Refactor (optional)** | adapter `scheduler-agent.ts` (or omit; kernel fallback suffices) |
| 11 | `src/executor/contracts.py` (`NodeExecutionRequest`, `NodeResult`, `NodeResultStatus`, `ExecutionError`, `ExecutionErrorType`, `ExecutorKind`) | Node execution contracts | **Reuse (port; strip `call_purpose`/attachment coupling)** | `dag-core` `executor-contracts.ts` |
| 12 | `src/executor/direct.py` `DirectLLMExecutor` | One model call per node | **Adapt** | adapter `NodeExecutor` → sub-agent call without tools (or single DSH model call) |
| 13 | `src/executor/worker.py` `WorkerAgentExecutor` + `src/runtimes/contracts.py` | One specialist agent run per node | **Adapt** | adapter `node-executor.ts` → `ctx.subagents.start()` |
| 14 | `src/executor/runner.py` `ExecutorRunner` | Executor + timeout + idempotency composition | **Adapt** | adapter `node-executor.ts` (timeout via `AbortSignal`; per-run `idempotencyKey` only) |
| 15 | `src/executor/retry.py` (`RetryPolicy`, `RetryingExecutorRunner`) | Bounded retry + backoff | **Reuse (port)** | `dag-core` `retry.ts` |
| 16 | `src/executor/attempts.py`, `idempotency.py` (SQLite) | Attempt persistence / idempotency | **Remove (concept kept)** | optional in-memory `idempotencyKey` in run state |
| 17 | `src/validation/*` (`NodeResultValidator`, `contracts.py`) | Node result validation | **Adapt** | `dag-core` `node-validator.ts` (deterministic) + optional LLM hook |
| 18 | `src/fusion/typed.py` + `dedup.py` | Result aggregation | **Adapt** | `dag-core` `fusion.ts`/`dedup.ts` (LLM join via sub-agent) |
| 19 | `src/domain/events.py`, `src/infrastructure/events.py` | Event vocabulary & sink | **Adapt** | adapter `events.ts` (own `dag/*` vocabulary, DSH events) |
| 20 | `src/runtime/staged.py` (`StagedActionDispatcher`), `src/runtime/staged_loop.py` | Orchestration loop | **Refactor (smallest core)** | adapter `dag-run.ts` (run controller; compile → waves → validate → retry → fuse) |
| 21 | `src/router_agent/decisions.py`, `guard.py`, `policy.py` | Action vocabulary, legal-action guard, controller policy | **Remove from plugin** (loop not ported) | — (adapter lifecycle is far simpler) |
| 22 | `src/router_agent/goals.py`, `observations.py` | Goal service, observation builder | **Remove from plugin** | — (DSH has `ctx.goals` if needed) |
| 23 | `src/understanding/*` | Request classification / risk | **Remove / not migrated** | — (DSH main agent decides) |
| 24 | `src/routing/*` | Model routing / allocation | **Remove / not migrated** | — (`model` per node or DSH default) |
| 25 | `src/model_layer/*` | Budget / cost / model registry | **Remove / not migrated** | — (DSH `llm`/`settings`/`credentials`) |
| 26 | `src/runtimes/*` (broker, checkpoints, protocol, registry, direct, fake) | Pluggable external runtimes | **Remove / not migrated** | — (DSH sub-agent seam replaces it) |
| 27 | `src/runtime_control/*` | Out-of-process worker control plane | **Remove / not migrated** | — (DSH agents are in-process) |
| 28 | `src/agentic.py` | Composition root | **Not migrated** | — (Router keeps its own runtime; `dag-core` is the shared behavioral contract) |

### C.4 Coupling analysis (what must be severed when porting)

The cleanly separable core: `core/models` (DAG half), `planner/*` (all five files), `scheduling/{contracts,kernel}.py`, `planning/{contracts,graph,errors}.py`, `executor/{contracts,protocol,registry,context,idempotency,retry,runner}.py`, `validation/*`, `fusion/dedup.py`, `domain/{artifacts,risk,events}.py` payload types, `infrastructure/*`.

The concrete entanglements (all verified):

1. `src/executor/contracts.py` imports `ModelCallPurpose` from `src.models.gateway` — a model-layer vocabulary leak into the generic execution contract. **Fix:** plugin-local `CallPurpose` enum (or drop the field).
2. `src/executor/direct.py` is written against the repo's `LLMGateway` Protocol + `ArtifactStore` + `src.prompts.TEMPLATES`. **Fix:** in DSH, node execution goes through the sub-agent seam, so the gateway Protocol is not ported; the *prompt templates* live in the plugin package.
3. `src/runtimes/contracts.py` imports `TokenUsage` from `src.models.gateway`; `src/domain/observation.py` imports model-layer metadata types. **Fix:** replaced by the DSH sub-agent result shape (`{output, structured?, stopReason}`).
4. `src/runtime/staged.py` (worst) imports `src.routing` (`RouterModelAllocator`, `PlanAssignments`), `src.understanding`, `src.model_layer.budget.BudgetController`, `src.models.BudgetDeniedError`. **Fix:** the adapter's `dag-run.ts` replaces these with (a) `model` per node or DSH default, (b) no budget gate, (c) no request-mode branching.
5. `src/router_agent/guard.py` references `understanding.models.RequestMode` — not ported (the plugin has no guard action vocabulary).

**Language note (critical):** the Router is Python; a DSH plugin is a JS/TS npm package. "Reuse" therefore means **port the algorithm faithfully to TypeScript** — same semantics, same invariants, same test scenarios — using the Python code as the reference/oracle, **not** vendoring Python into the plugin.

---

## D. DSH Integration Analysis

> Source of truth: installed DSH packages (`@deepseek-ai/*@0.1.0-rc.6`, `@deepseek-ai/cordis@4.0.1` — the latter ships its TypeScript sources), the DSH CLI's shipped agent presets and skills (`dsh/config/agent-presets/*`), and the Router repo's own DSH runtime integration (`integrations/runtimes/deepseek-harness/`). The official docs site was not reachable from this environment; cross-checked via search and shipped artifacts. Unconfirmable items are marked [UNKNOWN].

### D.1 Composition model (verified)

- DSH is a **Cordis application**: every capability is a plugin row in a YAML composition file. Two planes:
  - **Host composition** (`dsh-base/cordis.patch.yml` etc.): process-global registries/services — `llm`, `session`, `sandbox`, `approval`, `permission`, `tools`, `agents`, `agent-loop`, `subagent` (+ `subagent-spawn-in-process`, `subagent-fork-in-process`), `workflow-worker-thread` (+ `tool-workflow`), `goal`, `system-prompt`, persistence, model route.
  - **Agent preset** (`config/agent-presets/{standard,cordis,...}/agent.cordis.yml`): what one session contributes — tool rows, persona, prompt sections, skills.
- A composition file is a list of rows: `{ id, name (npm package specifier or `cordis:` builtin), config, disabled, group, isolate }`. Rows that publish services must live inside a `cordis:group` with `isolate: { <service>: true }` (per-agent private instance); otherwise they publish process-global and the preset mount is rejected ([VERIFIED] preset comments + `editing-cordis-compositions/SKILL.md`).
- **Patch layers** (application order) [VERIFIED, `dsh/lib/profile-boot-*.js`, `dsh/lib/plugin-*.js`]:
  1. bundle patches in `package.json` `dsh.profile.bundles` order (a package is a *bundle* when it declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — e.g. `dsh-base`, `dsh-headless`, `dsh-web-app`);
  2. the profile's own `cordis.patch.yml`;
  3. the home-level user layer `$DSH_HOME/cordis.patch.yml`;
  4. `--patch <file>` overlays.
- A patch uses `- insert: [{id, name, config}]` rows; a patch replaces a targeted row's **whole** `config` by `id`; last write wins.
- **Installing a plugin:** `dsh plugin --profile <name> add <package>` → pnpm in the profile directory → reconciles `dsh.profile.bundles` against installed packages. Worked example in this repo: `integrations/runtimes/deepseek-harness/cordis.patch.yml` = `- insert: - id: evo-router-runtime - name: '@evo-router/runtime-deepseek-harness'`.
- YAML supports `!!js <expression>` scalars evaluated against the loader context (e.g. `disabled: !!js process.platform === 'win32'`, `config.root: !!js dshHomePath('sessions')`).

### D.2 Plugin definition & registration (verified)

A DSH plugin is a **plain ESM module** exporting `{ name, Config, inject, apply }` (all shipped tool packages do exactly this, e.g. `dsh-tool-subagent/lib/index.js` → `export { Config, apply, inject, name }`). The loader imports the package and passes it to `ctx.plugin(plugin, config)`.

```ts
// plugin module shape (verified against cordis/src/registry.ts + shipped packages)
{
  name?: string;                              // display name (fiber diagnostics, loggers)
  Config?: StandardSchemaV1;                  // config validator — use @deepseek-ai/schemastery z.object(...)
  inject?: string[] | Record<string, any>;    // required services; plugin loads only when all are available
  provide?: string | string[];                // service name(s) this plugin provides (declaration)
  apply(ctx, config): any;                    // run body; return a disposer / promise of one / (async) generator
}
```

- **Registration paths:** programmatic `ctx.plugin(plugin, config)` (returns a thenable Fiber; `await` it to settle); declarative via composition rows (the normal DSH way) — the `Loader` service (`@deepseek-ai/cordis-plugin-loader`) owns an `EntryTree` of `Entry` rows, imports each row's `name`, and calls `ctx.registry.plugin(plugin, options.config)`; `cordis:group` and `cordis:include` are the builtin row types.
- Config is validated against `Config` via schemastery's StandardSchema (`~standard`) support; invalid config fails the mount loudly.

### D.3 Plugin lifecycle & Context API (verified)

- `Context` is a **proxied service resolver** (`cordis/src/context.ts`): `ctx.get(name)` for optional services (returns `undefined`); `ctx.<service>` for injected services; reading an undeclared service throws ("cannot get property x without inject").
- Fiber states: `PENDING → LOADING → ACTIVE → FAILED → UNLOADING → DISPOSED`; a fiber with unsatisfied `inject` stays PENDING and activates when services appear (plugin body re-runs on service changes).
- **Disposal = effect disposer:** whatever `apply` returns (a disposer, a promise of one, or an async generator yielding disposers) is run in reverse order on unload. Every contribution must be removable: `ctx.on(event, listener)` returns a disposer; `ctx.effect(fn, label)` owns subscriptions; tool/service/slot/timer registrations return disposers. There is no separate `dispose` field.
- Events: `ctx.on/once/emit/parallel/serial/bail/waterfall`. Waterfall listeners must call and return `next()`.
- Services: `class X extends Service { constructor(ctx, name) { super(ctx, name); } }` auto-registers via `ctx.reflect.provide`; plain plugins call `ctx.provide(name, value)` (fiber-owned). **[UNKNOWN]** whether the static `provide` field alone registers a service — no loader path using it was found; `Service` subclasses self-register, plain plugins must call `ctx.provide` themselves.
- Scoping: `ctx.isolate(name, label?)`, `ctx.intercept(name, config)`; `Service[resolveConfig]` merges ancestor intercept config (uses `Config.merge` when declared).

### D.4 Services this plugin will use (verified)

| Service | Package | API facts |
|---|---|---|
| `tools` | `@deepseek-ai/dsh-tools` | `ctx.tools.register(definition: ToolDefinition): () => void`. `ToolDefinition` = name + description + JSON-Schema `parameters` + `output: {schema, render(args, value) → ContentBlock[]}` + `execute(args, exec: ToolRunContext): Promise<unknown>`; `exec.signal` is the caller `AbortSignal`, `exec.agent` the calling Agent; optional `timeoutMs`, `isConcurrencySafe(args)`, `presentCall`/`presentResult`/`finalizeContent`. Typed helper `defineTool({name, description, parameters, output, execute, ...})`. Pipeline events `tools/pre-execute|execute|post-execute|result|change`. |
| `systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt.section({name, order, text, complete?}): () => void`. Tool guidance convention: name `tool:<toolName>`, order 100–199 (persona is order 0). |
| `subagents` | `@deepseek-ai/dsh-subagent` | `ctx.subagents.start(providerName, request): Promise<SubagentRun>`; `SubagentStartRequest = { label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`; `SubagentRun = { id: SessionId, localAgent?, result: Promise<SubagentResult>, dispose(): Promise<void> }`; `SubagentResult = { output: ContentBlock[], structured?, stopReason: 'completed'|'aborted'|'error'|'max-tokens'|'refusal' }` (never rejects for child-level failures). `registerProvider(provider)`, `getProvider(name)`, `list()`, `startContinuable(spec) → {childId, messageId}`, `followup(parent, childId, content, opts)`, `interrupt(...)`, `listChildren(parentSessionId, signal?)`, `listDescendants(...)`. Events `subagent/start|end`, `subagent/provider-added|removed`. **Concurrency-safe:** "the service may call one provider concurrently for distinct children"; sibling delegations overlap under the loop's rolling pool (`maxParallelToolCalls`); children run in their own sessions. |
| `agents` | `@deepseek-ai/dsh-agent` | `ctx.agents.create({sessionId, meta, agentOptions, signal, setup?}) → Promise<AgentHandle {agent, dispose()}>`; `agent.followup(msg)`, `agent.whenIdle()`, `agent.cancel(cause)`, `agent.ctx` (child-scoped context). `setup(agentCtx)` composes the child's world before publication (register child tools / prompt sections). `resume(...)` for persisted sessions. This is the deepest control path (used by the in-process subagent driver). |
| `workflowEngine` | `@deepseek-ai/dsh-workflow` + `dsh-workflow-worker-thread` | `ctx.workflowEngine.start({script, meta, args?, subagentProvider?, maxTotalAgents?, parent, signal?}) → WorkflowRun {id, meta, result (never rejects → {value, stopReason: completed|cancelled|error, error?, agentsStarted}), cancel(reason?), dispose()}`. Engine config: `provider` (default `spawn`), `maxConcurrentAgents` (0 → cpus−2, capped 16), `maxTotalAgents` (1000), `maxItemsPerCall` (4096), `syncTimeoutMs` (5000), `disposeGraceMs` (5000). Script hooks: `agent(prompt, {label, phase, schema, model})`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`. Events `workflow/start|end|phase|log|agent-start|agent-end`. |
| `llm` | `@deepseek-ai/dsh-llm` | `ctx.llm.registerAdapter(providers, adapter): () => void`; `createUserMessage({content, source})` helper for building `ContentBlock[]`. |
| `session` | `@deepseek-ai/dsh-session` | `session.append<T>(type, data, surfaceOpts?)`; `session.events` (immutable log); events `session/created|disposed|event|flush`. Used for projecting run records. |
| `jobs` | `@deepseek-ai/dsh-jobs` (+ `dsh-jobs-local`) | `ctx.jobs.start({kind, label, owner?, run(): JobHooks}) → JobId`; `list/get/read/kill/wait`. Optional: run DAG nodes as background jobs so the parent can `job_output`/`job_kill`. |

### D.5 Concurrent Agent execution in DSH (verified)

1. **Sub-agent concurrency:** `Promise.all` over `ctx.subagents.start(...)` runs children concurrently; each is an independent `SubagentRun` with its own session; results commit in model order; cancellation via the request `AbortSignal`.
2. **Workflow engine parallelism:** the model-written-script seam; the worker-thread engine runs the script in **one Node `worker_threads.Worker` per run** (script compiled via `vm.Script` in a fresh `vm.createContext` with only the hooks + `args` globals), concurrency via a FIFO semaphore (`maxConcurrentAgents`), `agent()` bridged to the host through a typed message RPC that calls `ctx.subagents.start(provider, {prompt, parent, signal, outputSchema, agentOptions})`.
3. **Raw `agents.create` fan-out:** as the in-process subagent driver does — create N child agents, `followup` + `whenIdle` each, `Promise.all`, then `handle.dispose()`.
4. **Cancellation discipline:** `run.cancel()` aborts the shared child signal; `dispose()` is idempotent, cancels, waits for quiescence up to `disposeGraceMs`, then force-terminates. The DAG plugin must apply the same holder-owned discipline (always dispose on every path).

**Known DSH limitations the plugin inherits for V0.1** [VERIFIED, `dsh-workflow/README.md`]: workflows are foreground-only (no background start/poll), no journaling/resume, no saved/nested workflows, no token-budget vocabulary; the worker/vm is **not a security sandbox**.

### D.6 Official examples available for the implementer

- `@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md` — the dynamic plugin toolset (`cordis_inspect_list/query/self`, `cordis_define`, `cordis_run`, `cordis_stop`, `cordis_undefine`); plain-JS plugin bodies; `ctx.get` vs `inject` rules; side-effect ownership; dynamic tool registration via `harness`.
- `@deepseek-ai/dsh/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md` — composition authoring (plane rule, realm rule, preset copy-then-edit, shipped-preset prohibition).
- Presets `standard/agent.cordis.yml`, `cordis/agent.cordis.yml` — the `delegation` group with `isolate: { workflowEngine: true }` containing `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `workflow-worker-thread`, `tool-workflow`, `tool-ralph` — the closest existing composition to what this plugin adds.
- `@deepseek-ai/dsh-base/cordis.patch.yml` — the base host composition (service inventory + config keys).
- This repo's own `integrations/runtimes/deepseek-harness/` — a complete DSH plugin: `src/plugin.ts` (`export const name/inject/apply`), `src/contracts.ts` (typed `HarnessContext` with `agents/llm/tools`), `src/worker.ts` (uses `ctx.agents.create`, `ctx.tools.register`), `cordis.patch.yml`.
- Official docs (re-read at implementation time): `docs/user/develop/basic/{index,tool,config,publish}.md` and `docs/cordis-primer.zh.md` in `deepseek-ai/deepseek-harness`. **[UNKNOWN]** exact page contents (unfetchable here).

---

## E. Target Architecture

### E.1 Overview

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ DSH (main Agent flow)                                                     │
│   - the model decides "this task is a multi-agent DAG"                    │
│   - calls `dag_run` tool (or an outer plugin calls ctx.dag service)       │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ workflow spec (JSON): objective, nodes[{id,title,prompt,
               │ dependsOn,inputs,model?,...}], options{concurrency,retry,fusion}
               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ DSH Plugin Adapter  (dsh-dag, Cordis plugin)                  │
│   - provides `dag` service (DAGRunController)                             │
│   - registers `dag_run` tool (defineTool + tool:dag_run prompt section)   │
│   - config: subagentProvider, concurrency, retry, timeout, fusion         │
│   - bridges exec.signal → run.cancel(); projects run records into Session │
│   - emits dag/* events                                                    │
└──────────────┬────────────────────────────────────────────────────────────┘
               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ DAG Orchestration Core  (dsh-dag-core, framework-free TS lib)     │
│   compile(proposal) → validate → analyze → schedule → execute waves →     │
│   validate nodes → retry → fuse                                           │
│   model.ts / proposal.ts / compiler.ts / validation.ts / analysis.ts /    │
│   state-machine.ts / event-scheduler.ts / async-scheduler.ts /            │
│   scheduling-kernel.ts / retry.ts / executor-contracts.ts /               │
│   node-validator.ts / fusion.ts / dedup.ts / errors.ts                    │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ NodeExecutor interface (buildRequest(nodeId) → executeOne(request) → NodeResult)
               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Parallel Agent Execution (adapter-provided)                               │
│   - default: ctx.subagents.start(provider, {...}) per node, run           │
│     concurrently under a limiter; results via run.result; dispose always  │
│   - alternative backend: workflow engine (script with agent()/parallel()) │
│   - optional deep control: raw ctx.agents.create + followup/whenIdle      │
└───────────────────────────────────────────────────────────────────────────┘
```

### E.2 Component responsibilities

#### E.2.1 `dag-core` — framework-free TypeScript library

Pure orchestration; **zero `@deepseek-ai/*` imports**; unit-testable in isolation. Ports Router modules C.2 (rows 1–9, 11, 15, 17–18).

| File | Ports from | Contents |
|---|---|---|
| `model.ts` | `src/core/models.py` (DAG half) | `TaskStatus`, `Query`, `PlanStep`, `ExecutionPlan` (+ `readySteps`), `ExecutionAnalysis`, `ExecutionResult`, `FinalAnswer`. |
| `proposal.ts` | `src/planning/contracts.py` | `TaskGraphProposal`, `TaskNodeProposal`, `InputSourceProposal`, `GoalAnalysis`, `ExecutionEstimate`, `FallbackPlan`; JSON Schema generated for the tool input. |
| `compiler.ts` | `src/planning/graph.py` | `compile(proposal) → ExecutionPlan` (input-source checks + validator + analyzer + topo ordering). |
| `validation.ts` | `src/planner/validation.py` | `DAGValidator` port (Kahn, duplicates, unknown deps, schema compat, sink checks, non-executability propagation). |
| `analysis.ts` | `src/planner/analysis.py` | `DAGAnalyzer` port (levels, parallel groups, critical path, priorities). |
| `state-machine.ts` | `src/planner/state_machine.py` | `TRANSITION_RULES`, `TERMINAL_STATUSES`, `SUCCESS_STATUSES`, `transition()`, `NodeTransition`. |
| `event-scheduler.ts` | `src/planner/scheduler.py` | `EventDrivenScheduler` port (activate/ready/start/notify/cancel, parent/child indexes, `_propagate`, history). |
| `async-scheduler.ts` | `src/planner/async_scheduler.py` | `AsyncExecutionScheduler` port: `execute(nodeIds, {buildRequest, executeOne}, maxWaves)` with a small Promise-based `Limiter` (no dependency), wave gather, `settle`, `stuckReason`. |
| `scheduling-kernel.ts` | `src/scheduling/kernel.py` + `contracts.py` | snapshot/validate/fallback/commit. |
| `executor-contracts.ts` | `src/executor/contracts.py` | `NodeExecutionRequest`, `NodeResult`, `NodeResultStatus`, `ExecutionError`, `ExecutionErrorType` (+ `isRetryable`), `ExecutorKind`. |
| `retry.ts` | `src/executor/retry.py` | `RetryPolicy`, `RetryingExecutorRunner` port. |
| `node-validator.ts` | `src/validation/validator.py` + `contracts.py` | Deterministic checks (`emptyResult`, `invalidJson`, `schemaValidationFailed`, required artifacts, success criteria); optional `llmValidate` callback injected by the adapter. |
| `fusion.ts` + `dedup.ts` | `src/fusion/typed.py` + `dedup.py` | `dedupNodeResults`, `failureSummary`, `fuse(task, results, failures, {llmFuse})`. |
| `errors.ts` | `src/planning/errors.py` | `PlanningError`-equivalent with codes and `issues`. |

#### E.2.2 DSH adapter plugin (`dsh-dag`)

- `index.ts` — plugin entry:
  ```ts
  import z from '@deepseek-ai/schemastery'
  const name = 'dsh-dag'
  const inject = ['tools', 'subagents', 'systemPrompt']   // + 'session' optional
  const Config = z.object({ ... })                        // see config.ts
  function apply(ctx, config) { /* provide 'dag', register tool, section, events */ }
  export { Config, apply, inject, name }
  ```
  - `ctx.provide('dag', dagRunController)` (fiber-owned).
  - `ctx.tools.register(defineTool({ name: config.toolName, parameters: <proposal JSON Schema>, execute(args, exec) { ... } }))`.
  - `ctx.systemPrompt.section({ name: 'tool:' + config.toolName, order: 150, text: <guidance> })` — guidance: use only for explicit multi-agent DAG workflows; the model decides single vs multi-agent.
  - `ctx.effect`-owned disposal of every registration.
- `config.ts` — schemastery Config: `toolName` (`dag_run`), `subagentProvider` (`spawn`), `globalLimit` (0 = unlimited), `perModelLimits`, `retryPolicy {maxRetries, baseDelaySeconds, maxDelaySeconds}`, `nodeTimeoutSeconds`, `maxTotalNodes`, `maxResultChars`, `fusion: 'auto'|'llm'|'none'`, `emitSessionEvents` (true).
- `dag-service.ts` — `class DAGRunController extends Service` (provide `'dag'`): `start(request): DAGRun`, `get(id)`, `list()`, `cancel(id, reason?)`. Programmatic entry for outer orchestrators.
- `dag-run.ts` — run controller: `DAGRun {id, meta, result, cancel(reason?), dispose()}`; holds run state (plan, per-node states, results, retry counts); drives compile → validate → wave schedule → execute → validate nodes → retry → fuse; computes run status `completed | partial | failed | cancelled`.
- `tool.ts` — `dag_run` `ToolDefinition` (mirrors `dsh-tool-workflow` lifecycle): synchronously validate the proposal (structured, model-correctable errors; no run created); `execute` starts a run, awaits `run.result` in `try/finally { run.dispose() }`, bridges `exec.signal` → `run.cancel()`, returns canonical `{runId, status, value, nodeCount, agentsStarted, failures}`; non-`completed` stop reasons → `isError`.
- `node-executor.ts` — implements `NodeExecutor`:
  - `buildRequest(nodeId)` assembles `NodeExecutionRequest` from node + run state: injects `dependency_outputs` (stringified upstream `content`, bounded) and artifact refs;
  - `executeOne(request)` → `ctx.subagents.start(config.subagentProvider, { label: request.nodeId, prompt: createUserMessage({content: request.prompt, source: {kind: 'dag'}}), parent, signal, outputSchema, agentOptions: {model?}, maxDepth })` → await `run.result` → always `run.dispose()` → map `{output, structured?, stopReason}` to `NodeResult` with `ExecutionError` classification + retryability;
  - per-node timeout composed onto `exec.signal` (`AbortSignal.timeout` + `AbortSignal.any` where available);
  - optional pre/post deterministic + LLM validation hooks.
- `fusion-executor.ts` — optional LLM fusion via one sub-agent call with a fixed fusion prompt (or `ctx.llm`); dedup fallback in dag-core.
- `events.ts` — emits observe-only `dag/run-start|run-end|node-start|node-end|node-failed|retry|phase|log` payloads (no live handles); projects the run into the calling Agent's Session for root transport executions (same pattern as `dsh-tool-workflow`).
- `contracts.ts` — typed `HarnessContext` (like the Router integration's `contracts.ts`).
- `cordis.patch.yml` — bundle patch inserting the plugin row (and, optionally, a tool row inside a preset's `delegation` group with `isolate`).

#### E.2.3 What remains in the original Router

Everything in C.3 rows 21–28. The Router keeps its own Python runtime; `dag-core`'s TS port is the *behavioral contract* between the two implementations (parity harness, H.4).

### E.3 How the plugin receives a multi-agent workflow

1. **Model-initiated (primary):** the DSH main agent calls `dag_run` with a `TaskGraphProposal`-shaped JSON (`objective`, `nodes[{id, title, prompt, dependsOn, inputs[{sourceNodeId, purpose}], outputRequirements, successCriteria, model?}]`, `options{concurrency, retry, fusion}`). The plugin compiles/validates/runs; the tool result is the aggregated final value + per-node status.
2. **Programmatic (secondary):** any plugin with `ctx.dag` calls `ctx.dag.start(request)` and awaits the run (same contract minus the model-facing envelope). This is the seam a future Router→DSH adapter uses.
3. **Not supported (V0.1):** the plugin does not plan the DAG (no LLM planner); the model supplies nodes and dependencies; the plugin only compiles, validates, and runs.

### E.4 How the DAG is constructed, scheduled, executed, propagated, aggregated

Follows the Router pipeline exactly ([VERIFIED] C.2):

1. **Compile:** `compile(proposal)` → input-source checks → `DAGValidator.validate()` → on error, return structured issues (no run); on success → `DAGAnalyzer.analyze()` → topologically ordered `ExecutionPlan`.
2. **Ready frontier:** `EventDrivenScheduler.activate()` marks root nodes READY. `AsyncExecutionScheduler.execute(firstWave, {buildRequest, executeOne}, maxWaves)`:
   - wave = currently READY nodes sorted by priority (`ExecutionAnalysis.priorities`);
   - each node runs concurrently under global + per-resource semaphore limits;
   - each terminal `NodeResult` settles through `EventDrivenScheduler.notify()` → downstream READY (all parents SUCCEEDED) or BLOCKED (any parent FAILED/CANCELLED) — the dependent-node release mechanism;
   - loop until no node is READY; `stuckReason()` detects deadlock.
3. **Node execution:** `buildRequest(nodeId)` assembles the request (dependency outputs/artifacts injected); `executeOne` = adapter node executor (sub-agent call). `RetryingExecutorRunner` wraps it with `RetryPolicy`; only retryable errors retry; per-node retry counters in run state; non-retryable → FAILED → downstream BLOCKED.
4. **Result propagation:** SUCCEEDED node `content`/`structured_output`/artifact refs stored keyed by node id; injected into dependent prompts at build time.
5. **Aggregation:** after the last wave, run status = `completed` (required nodes SUCCEEDED), `partial` (some required failed but a result can be produced), `failed` (fatal). `fuse()` returns the single result, the deduped LLM fusion, or the failure summary — mirroring `TypedResultFusion` + `FinalAnswer`.

### E.5 Design decisions & open choices

#### E.5.1 Plugin placement

**[DESIGN]** Ship `dsh-dag` as a host-composition row (it provides the `dag` service; per D.1, service-publishing rows belong to the host plane or to an `isolate` realm inside a preset). Expose the model-facing tool per-agent via the standard preset pattern: a `cordis:group` row with `isolate: { dag: true }` containing the tool row — mirroring the shipped `delegation` group (`isolate: { workflowEngine: true }`). Validate the mount with `ctx.agentPresets.standingKeyFor(id)` when authoring the preset copy.

#### E.5.2 Execution backend

**[DESIGN, default = direct `ctx.subagents`]** The DAG scheduler needs per-node control (retry, per-node validation, dependency injection, concurrency limits) that the model-written-script model does not give declaratively. Port the Router's wave scheduler and call `ctx.subagents.start()` per node — DSH guarantees concurrency-safety of sibling delegations and each child runs in its own session. The workflow engine stays available as an alternative `NodeExecutor` backend (generate a script whose `agent()` calls run under `parallel()`); implement only if direct sub-agents prove insufficient (e.g. event-loop blocking). **[UNKNOWN]** the exact public typing of `ctx.subagents` on the context for third-party plugins — the service is registered by `dsh-subagent` and used internally by `dsh-workflow-worker-thread` ([VERIFIED]); confirm the `.d.ts` surface at implementation time.

#### E.5.3 Fusion and validation LLM calls

**[DESIGN]** Default `fusion: 'auto'`: single result → pass-through; multiple → one sub-agent call with the Router's fusion prompt ported into the plugin package. `fusion: 'none'` returns the deduped concatenation. LLM node-quality validation is **off** by default (deterministic checks only).

#### E.5.4 Model selection

**[DESIGN]** Optional `model` per node (mirrors `AgentModelPolicy.model_id`); absent → child inherits the provider's default route (like `dsh-tool-subagent`'s `agentOptions`). No model scoring/routing in the plugin.

#### E.5.5 Idempotency / re-entrancy

**[DESIGN]** Run state is in memory; repeated identical calls start new runs. Optional caller-supplied `idempotencyKey` is echoed in events for correlation; no dedup store (Router's SQLite attempt store is not ported).

---

## F. Target Repository Structure

> Working names; npm workspaces monorepo (mirrors the DSH repo's `packages/*` layout).

```text
dsh-dag-plugin/
├── package.json                         # workspaces: ["packages/*"], private
├── tsconfig.base.json
├── README.md                            # install/usage/design overview
│
├── packages/
│   ├── dag-core/                        # dsh-dag-core — framework-free TS lib
│   │   ├── package.json                 # type: module; main/exports lib/index.js; zero @deepseek-ai deps
│   │   ├── src/
│   │   │   ├── index.ts                 # public exports
│   │   │   ├── model.ts                 # TaskStatus, Query, PlanStep, ExecutionPlan,
│   │   │   │                            #   ExecutionAnalysis, ExecutionResult, FinalAnswer
│   │   │   ├── proposal.ts              # TaskGraphProposal/TaskNodeProposal/InputSourceProposal/...
│   │   │   │                            #   (+ JSON Schema for the tool input)
│   │   │   ├── compiler.ts              # compile(proposal) → ExecutionPlan
│   │   │   ├── validation.ts            # DAGValidator port
│   │   │   ├── analysis.ts              # DAGAnalyzer port
│   │   │   ├── state-machine.ts         # transitions, TERMINAL/SUCCESS statuses
│   │   │   ├── event-scheduler.ts       # EventDrivenScheduler port
│   │   │   ├── async-scheduler.ts       # AsyncExecutionScheduler port (+ Limiter)
│   │   │   ├── scheduling-kernel.ts     # snapshot/validate/fallback/commit
│   │   │   ├── executor-contracts.ts    # NodeExecutionRequest/NodeResult/Error/Status
│   │   │   ├── retry.ts                 # RetryPolicy, RetryingExecutorRunner
│   │   │   ├── node-validator.ts        # deterministic result validation
│   │   │   ├── fusion.ts / dedup.ts     # aggregation + dedup
│   │   │   └── errors.ts                # error codes/issues
│   │   └── tests/                       # vitest; scenarios ported from Router tests
│   │       ├── validation.test.ts       # ← tests/test_validation.py
│   │       ├── state-machine.test.ts    # ← tests/test_node_state_machine.py
│   │       ├── event-scheduler.test.ts  # ← tests/test_event_scheduler.py
│   │       ├── async-scheduler.test.ts  # ← tests/test_async_scheduler.py
│   │       ├── scheduling-kernel.test.ts
│   │       ├── retry.test.ts            # ← tests/test_retry_policy.py
│   │       ├── node-validator.test.ts   # ← tests/test_result_validation.py
│   │       ├── fusion.test.ts           # ← tests/test_fusion_dedup.py
│   │       └── e2e.test.ts              # ← scenarios from tests/test_agentic_e2e.py
│   │
│   └── dsh-dag/                         # dsh-dag — the Cordis plugin
│       ├── package.json                 # type: module; "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
│       │                                # peerDeps: dsh-tools, dsh-subagent, dsh-system-prompt,
│       │                                #   dsh-session, dsh-agent, dsh-workflow, cordis, schemastery
│       ├── cordis.patch.yml             # bundle patch: insert dag plugin row
│       ├── tsconfig.json / tsconfig.build.json
│       ├── src/
│       │   ├── index.ts                 # plugin entry: name, inject, Config, apply
│       │   ├── config.ts                # schemastery Config
│       │   ├── dag-service.ts           # DAGRunController (provide 'dag')
│       │   ├── dag-run.ts               # DAGRun state + lifecycle
│       │   ├── tool.ts                  # dag_run ToolDefinition + tool:dag_run section
│       │   ├── node-executor.ts         # ctx.subagents-backed NodeExecutor + retry/timeout
│       │   ├── fusion-executor.ts       # optional LLM fusion via sub-agent call
│       │   ├── events.ts                # dag/* events + Session projection
│       │   └── contracts.ts             # typed HarnessContext
│       └── tests/
│           ├── plugin-mount.test.ts     # loads under a test Cordis context
│           ├── dag-run.test.ts          # E2E with FakeSubagentProvider
│           ├── node-executor.test.ts    # prompt assembly, error mapping, retry, timeout
│           ├── tool.test.ts             # schema validation, exec.signal cancellation
│           └── fixtures/                # fake sub-agent provider; sample DAG specs
│
└── docs/
    └── architecture.md                  # this document as implementation reference
```

**Purpose of important modules:** see E.2. Keep `dag-core` free of any `@deepseek-ai/*` import so it can be tested standalone and reused (e.g. by the Router parity harness).

---

## G. Implementation Plan

> Steps 1–7 are pure TS ports (no DSH runtime). Step 8+ is the DSH plugin. Each step is independently verifiable.

| Step | Task | Reuses / references | Deliverable & verification |
|---|---|---|---|
| 1 | **Port domain model & contracts** — `model.ts`, `proposal.ts`, `executor-contracts.ts` from `src/core/models.py` (DAG half), `src/planning/contracts.py`, `src/executor/contracts.py`. Keep exact field/enum names; strip Router-only fields (`call_purpose`, attachments) into optional extension slots. | C.2.1/2/7 | Types compile; JSON-Schema validation tests for proposals (port `tests/test_validation.py` fixtures). |
| 2 | **Port validation & analysis & state machine** 1:1 — `validation.ts`, `analysis.ts`, `state-machine.ts`. | C.2.3/4/5 | Parity tests: same inputs → same `ValidationResult`/`ExecutionAnalysis`/transition outcomes as Python. |
| 3 | **Port event-driven scheduler** — `event-scheduler.ts` (indexes, activate/ready/start/notify/cancel, `_propagate`, history). | C.2.6 | Tests ported from `tests/test_event_scheduler.py` (READY/BLOCKED cascades, illegal transitions, one-time activate). |
| 4 | **Port async scheduler + kernel** — `async-scheduler.ts` (waves, `Limiter`, settle, stuckReason), `scheduling-kernel.ts` (snapshot/validate/fallback/commit). | C.2.6 | Tests ported from `tests/test_async_scheduler.py` + `tests/scheduling/test_kernel.py` (concurrency limits, priority order, atomic commit). |
| 5 | **Port retry + node validation + fusion/dedup** — `retry.ts`, `node-validator.ts`, `fusion.ts`, `dedup.ts`. | C.2.7/8 | Tests ported from `test_retry_policy.py`, `test_result_validation.py`, `test_fusion_dedup.py`. |
| 6 | **Wire `compiler.ts`** — input-source checks + validator + analyzer + topo ordering. | C.2.2 | Compiler tests ported from `tests/planning/test_graph.py` (issue codes: `missing_dependency`, `unknown_input_source`, `cycle_detected`, ...). |
| 7 | **dag-core E2E runner** — `runPlan(plan, executeOne)` combining steps 2–6 (mirrors Router `_execute_ready` + `_validate_nodes` + `_retry_nodes` + `_finalize` from `src/runtime/staged.py`). | C.1, `src/runtime/staged.py` (read-only reference) | E2E with a fake `executeOne`: diamond, chain, failure→BLOCKED, retry-exhausted, timeout, all-fail (port `test_agentic_e2e.py` scenarios). |
| 8 | **DSH plugin skeleton** — package scaffolding, `cordis.patch.yml` bundle, `index.ts` (`name/inject/Config/apply`), `config.ts`, effect disposal. | D.2/D.3/D.6; Router `integrations/runtimes/deepseek-harness` as worked example | Plugin mounts in a test Cordis context (vitest with `@deepseek-ai/cordis` + `cordis-plugin-loader`, or a dev `dsh --profile` smoke profile); service + tool registration and clean disposal asserted. |
| 9 | **Node executor adapter** — `node-executor.ts` via `ctx.subagents.start`; prompt assembly from `dependency_outputs`; error mapping (`ExecutionErrorType` + retryability); timeout via `AbortSignal`; always `run.dispose()`. | D.4 (subagents), D.5; Router `src/executor/{worker,direct,runner,retry}.py` behavior | Tests with a **FakeSubagentProvider** registered on a test `ctx.subagents` (same interface as `dsh-subagent-spawn-in-process`); assert prompt injection, error mapping, dispose-on-all-paths, timeout. |
| 10 | **Run controller + tool** — `dag-run.ts`, `dag-service.ts`, `tool.ts`; `exec.signal` → `cancel`; canonical result envelope; `isError` on non-completed stop reasons. | D.4 (tools/systemPrompt); `dsh-tool-workflow` lifecycle | Tool tests: valid/invalid proposals, cancellation, timeout, envelope shape; guidance section registered. |
| 11 | **Events + Session projection** — `events.ts`; observe-only `dag/*` events; project run records into the calling Agent's Session for root executions. | D.4 (session); `dsh-tool-workflow` Session projection | Tests assert event pairing/order (run-start before node-start; node-end before run-end; no unpaired terminals). |
| 12 | **Preset integration** — add the tool row to a preset copy (of `standard` or `cordis`) inside a `cordis:group` with `isolate`; verify with `dsh --profile <dev> --dump-config` and a live smoke run. | D.1/D.6; preset YAMLs | `--dump-config` shows the composed rows; a real DSH session calls `dag_run` and gets a valid multi-agent result with ≥2 parallel nodes. |
| 13 | **Docs & acceptance** — README (install via `dsh plugin --profile <name> add dsh-dag`), architecture doc, acceptance checklist (I). | — | All acceptance criteria green. |

> **Porting discipline:** for every step, run the *same test scenarios* that exist in the Router against the TS port. Discrepancies are bugs in the port unless they are deliberate, documented changes (e.g. dropping SQLite persistence). Do not silently diverge.

---

## H. Testing Requirements

### H.1 dag-core unit tests (framework-free, vitest)

Port the Router's deterministic suites scenario-for-scenario:

- **DAG validation** (← `tests/test_validation.py`, `tests/planning/test_graph.py`): duplicate node ids; unknown dependency; self-loop; cycle; schema mismatch/unverified; isolated node; missing final output; non-executability propagation; empty plan; input-source issue codes.
- **State machine** (← `tests/test_node_state_machine.py`): every legal/illegal transition; terminal absorbing; `NodeTransition` audit fields.
- **Event-driven scheduler** (← `tests/test_event_scheduler.py`): one-time activate; one level per notify; multi-dependency waits for all parents; failure → child BLOCKED; wrong notify status rejected; history.
- **Async scheduler** (← `tests/test_async_scheduler.py`): wave priority order; global + per-resource concurrency limits honored; settle→propagate; `stuck_reason`; `max_waves`.
- **Scheduling kernel** (← `tests/scheduling/test_kernel.py`): snapshot projects only ready nodes; validate rejects unknown/over-limit; commit atomically transitions to RUNNING.
- **Retry** (← `tests/test_retry_policy.py`): attempt bound; backoff schedule; retryable-only; backup targets order; `retry_attempts` metadata.
- **Node validator** (← `tests/test_result_validation.py`): `empty_result`, `invalid_json`, `schema_validation_failed`, artifact checks, `repair_suggestions`.
- **Fusion/dedup** (← `tests/test_fusion_dedup.py`): single-result pass-through; zero-result notice; dedup ordering; failure summary.

### H.2 dag-core E2E tests

Mirror `tests/test_agentic_e2e.py` with a fake `executeOne`:

1. Diamond DAG: independent leaves run **in parallel** (assert via a concurrency counter); merge node runs after both.
2. Chain DAG: strict ordering; dependency output injected into downstream prompt.
3. Failure → downstream BLOCKED; run status `partial`/`failed` per policy.
4. Retry-exhausted node → FAILED; transient retryable failure → succeeds after N−1 attempts.
5. Timeout → `timed_out` → handled by retry policy.
6. Concurrency limit: at most K nodes in flight; per-resource limit respected.
7. All succeed → `completed` with fused final value.

### H.3 DSH integration tests (adapter)

- **Plugin mount:** loads under a test Cordis context (fake `tools`/`subagents`/`systemPrompt`/`session`); `dag` service + `dag_run` tool registered; unmount removes them (disposer correctness).
- **Fake sub-agent provider:** register a `FakeSubagentProvider` on `ctx.subagents` (same contract as `dsh-subagent-spawn-in-process`) returning scripted outputs/failures; run full `dag_run` deterministically (no real LLM, no network).
- **Tool contract:** structured, model-correctable schema errors; `exec.signal` aborts → run cancelled → `isError` with reason; non-completed stop reasons never reported as success; canonical envelope.
- **Events:** `dag/run-start` before any `dag/node-start`; paired node start/end; `dag/run-end` last; no unpaired terminals (invariant discipline ported from `dsh-tool-workflow`).
- **Cancellation/quiescence:** `cancel()` mid-wave → pending children aborted; `dispose()` idempotent; no leaked child runs (assert every started fake run was disposed).

### H.4 Router parity harness (recommended)

A small script that runs the same scenario JSONs through (a) the Python Router's compile/validate/schedule path and (b) `dag-core`, and diffs plan/status/result projections. This guards against semantic drift between the two implementations. (Python side runs inside the Router repo; never a plugin dependency.)

### H.5 Test rules

No real API keys, no network, no real DSH profile in CI beyond an optional smoke job; external model/tool calls are always faked (same rule as Router `AGENTS.md` §6.4). Coverage target for `dag-core` deterministic logic ≥ 80% (mirroring Router policy). Never "fix" tests by deleting assertions or lowering validation.

---

## I. Acceptance Criteria

The plugin is complete when **all** of the following hold:

1. **Packaging/install:** `dsh plugin --profile <dev> add dsh-dag` installs the bundle; `dsh --profile <dev> --dump-config` shows the plugin row; a DSH session on the composed preset exposes `dag_run` to the model.
2. **Declarative input:** the model (or any caller) can submit a `TaskGraphProposal`-shaped workflow with `dependsOn`/`inputs`, concurrency, retry, and fusion options; malformed proposals return structured, model-correctable errors without creating a run.
3. **Deterministic DAG core:** cycle, duplicate-id, unknown-dependency, and no-final-output proposals are rejected deterministically (never executed); valid DAGs compile to a topologically ordered plan with correct `parallelGroups`/`priorities`.
4. **Parallel execution:** independent nodes of a diamond DAG execute concurrently (observed via a concurrency counter in tests); dependent nodes start only after all parents succeed.
5. **Dependency release & blocking:** on node failure, downstream nodes become BLOCKED (never execute); cancellation cascades the same way; no node ever runs with an unsatisfied dependency.
6. **State machine integrity:** every node transitions only along `TRANSITION_RULES`; a transition log is retained per run; illegal transitions are impossible by construction (state machine/kernel throw).
7. **Retry/failure:** retries bounded by `maxRetries`; only retryable errors retry; exponential backoff; retry exhaustion → FAILED; per-node timeout → `timed_out` and handled.
8. **Result propagation & aggregation:** upstream outputs/artifacts are injected into dependent prompts; the final result is the single result (1 node), the deduped LLM fusion (N nodes, `fusion: auto`), or a failure summary; run status is `completed`/`partial`/`failed`/`cancelled` correctly.
9. **DSH integration:** plugin mounts/unmounts cleanly (no leaked tools/services); `exec.signal` cancellation reaches the run and children quiesce; `dag/*` events are paired and ordered; root executions project a run record into the calling Agent's Session; non-completed stop reasons are never surfaced as success.
10. **No takeover:** the plugin never auto-decides single vs multi-agent; the tool guidance instructs the model to use it only for explicit multi-agent DAG workflows; the DSH main agent flow is otherwise untouched.
11. **Parity:** `dag-core` passes the parity harness against the Router for the shared scenario set (H.4).
12. **Docs:** README documents install, config keys, the workflow input schema, event vocabulary, and known limitations (foreground-only, no resume — matching DSH workflow limitations).

---

## J. Open Questions / Risks

### J.1 UNKNOWN / needs confirmation at implementation time

1. **`ctx.subagents` public typing for third-party plugins** — the service is real and used internally by `dsh-workflow-worker-thread` ([VERIFIED]), but whether the installed `dsh-subagent` package exposes stable public types for direct `start()` calls by non-DSH plugins must be re-confirmed against the installed package's `.d.ts` and the base composition row (`subagent` in `dsh-base/cordis.patch.yml`).
2. **Tool-registration contract details** — `ctx.tools.register(ToolDefinition)` and `defineTool` are verified; the exact fields required at runtime (e.g. `output.render`, `presentCall`/`presentResult` optionality, parameters JSON-Schema dialect) should be confirmed with `Tool.listTools` in a live profile (the shipped skill mandates querying the live catalog rather than trusting docs).
3. **Session-event projection API** — `dsh-tool-workflow` writes workflow run records into the calling Agent's Session; the exact API for appending custom `dag/*` records (`session.append`, `SessionEventMap` registration) must be read from `dsh-session` types at implementation time.
4. **Official doc contents** — `docs/user/develop/basic/index.md` ("第一个插件") and siblings could not be fetched from this environment (network blocked); content was cross-checked via search snippets and the shipped skills/presets. Re-read the docs pages before finalizing the packaging section.
5. **`provide` static field wiring** — the `Plugin.Base.provide` declaration exists, but no loader path using it to auto-register a service was found; plain plugins should call `ctx.provide(name, value)` themselves. Confirm during step 8.
6. **Schemastery vs JSON Schema** — `dsh-tools` uses JSON-Schema-style parameter definitions and `defineTool`; confirm whether plugin `Config` should be declared with `@deepseek-ai/schemastery` `z.object` (as `dsh-tool-workflow` depends on it) and how `Config.merge`/intercept resolution interacts (verified: `Service[resolveConfig]` uses `Config.merge` when declared).
7. **Worker-thread engine as node-execution backend** — if direct `ctx.subagents` calls prove insufficient, generating a workflow-engine script per run is possible ([VERIFIED] engine API); the exact script-hook surface for the DAG-runner pattern needs prototyping (J.3.2).

### J.2 Design decisions that may need revisiting

1. **Python → TS parity cost** — the Router logic is mature and tested; the port must be faithful. Mitigation: parity harness (H.4) + porting the Router's test scenarios verbatim. Document any deviation.
2. **Direct sub-agents vs workflow engine** (E.5.2) — the default keeps the deterministic core authoritative; revisit if DSH evolves the workflow seam into a first-class orchestration runtime.
3. **Per-agent vs host service placement** (E.5.1) — realm/isolate placement affects whether `dag` runs are per-session; follow the `workflowEngine` precedent and validate with a two-session test.
4. **Fusion by default** — LLM fusion costs one extra agent run; `fusion: 'auto'` is safe (single result short-circuits), but deployments may want `'none'`; keep config-driven.
5. **Version pinning** — this analysis targets DSH `0.1.0-rc.6`. The Router's own DSH runtime integration probes APIs rather than rejecting versions by number; the plugin should declare peerDependencies with `^0.1.0-rc.6`-style ranges and probe cheaply at startup.

### J.3 Risks

1. **API drift** — DSH is pre-1.0; plugin APIs may change between releases. Mitigate: keep all DSH-touching code in the adapter package (`dag-core` stays framework-free); "probe, don't pin-reject".
2. **Event-loop blocking** — a DAG wave is `await`-based; a misbehaving child could block the host loop. The workflow engine solves this with worker threads; if needed, reuse it as the backend instead of inventing threads.
3. **Concurrency ceiling** — DSH enforces `maxTotalAgents`/`maxConcurrentAgents` at the workflow-engine level; direct sub-agent calls are bounded by the plugin's own `globalLimit` and `maxTotalNodes`. Default conservatively (e.g. `globalLimit ≤ 4`) to avoid runaway token spend; the plugin has no budget ledger (B.2.5) — document this explicitly.
4. **Child policy inheritance** — delegated children pin approval to `'never'` and inherit sandbox scope ([VERIFIED], `dsh-subagent` README); a node needing approval-gated tools fails deterministically rather than prompting. Document and surface this in node failure errors.
5. **Secrets & logs** — follow Router `AGENTS.md` §7: never log node prompts/results containing credentials; keep `ExecutionError` messages sanitized (port the Router's `public_error_message` pattern).

---

## Appendix A — Key source references (for the implementing agent)

**Router (Python reference implementation):**
- `src/core/models.py`, `src/planning/contracts.py`, `src/planning/graph.py`, `src/planning/errors.py`
- `src/planner/validation.py`, `src/planner/analysis.py`, `src/planner/state_machine.py`, `src/planner/scheduler.py`, `src/planner/async_scheduler.py`
- `src/scheduling/kernel.py`, `src/scheduling/contracts.py`, `src/scheduling/agent.py`
- `src/executor/contracts.py`, `src/executor/retry.py`, `src/executor/direct.py`, `src/executor/worker.py`, `src/executor/runner.py`, `src/executor/idempotency.py`, `src/executor/attempts.py`
- `src/validation/validator.py`, `src/validation/contracts.py`, `src/validation/acceptance.py`
- `src/fusion/typed.py`, `src/fusion/agent.py`, `src/fusion/dedup.py`
- `src/domain/events.py`, `src/infrastructure/events.py`, `src/domain/artifacts.py`, `src/domain/observation.py`
- `src/runtime/staged.py`, `src/runtime/staged_loop.py`, `src/runtime/config.py` (read-only references for the run lifecycle)
- Tests: `tests/test_validation.py`, `tests/planning/test_graph.py`, `tests/test_node_state_machine.py`, `tests/test_event_scheduler.py`, `tests/test_async_scheduler.py`, `tests/scheduling/test_kernel.py`, `tests/test_retry_policy.py`, `tests/test_result_validation.py`, `tests/test_fusion_dedup.py`, `tests/test_worker_agent_executor.py`, `tests/test_executor_runner.py`, `tests/test_agentic_e2e.py`

**DSH (target platform; local checkout `...\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\*`):**
- `@deepseek-ai/cordis` — `src/context.ts`, `src/service.ts`, `src/registry.ts`, `src/fiber.ts`, `src/reflect.ts`, `src/events.ts` (plugin/context/lifecycle API)
- `@deepseek-ai/cordis-plugin-loader` — `src/config/entry.ts`, `src/config/group.ts`, `src/index.ts` (entry rows, `cordis:group`/`cordis:include`, `isolate`)
- `@deepseek-ai/dsh` — `config/agent-presets/{standard,cordis}/agent.cordis.yml` (preset composition), `config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md`, `config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md`
- `@deepseek-ai/dsh-base/cordis.patch.yml` (base host composition; service inventory)
- `@deepseek-ai/dsh-subagent` — `README.md`, `lib/types/index.d.ts` (`SubagentRuntime.start`, `SubagentRun`, `SubagentResult`, continuation)
- `@deepseek-ai/dsh-tool-subagent` — `lib/index.js` (worked `defineTool` + `subagents.start` example), `README.md` (concurrency safety)
- `@deepseek-ai/dsh-subagent-spawn-in-process` / `dsh-subagent-in-process-driver` — the concrete spawn provider and the `agents.create` + `followup`/`whenIdle` driver pattern
- `@deepseek-ai/dsh-workflow` + `@deepseek-ai/dsh-workflow-worker-thread` + `@deepseek-ai/dsh-tool-workflow` — `README.md`s and `lib/*` (workflow seam, worker-thread engine + concurrency semaphore + cancellation, tool lifecycle + Session projection)
- `@deepseek-ai/dsh-tools` — `lib/types/index.d.ts` (`ToolDefinition`, `defineTool`, `tools.register`, `ToolRunContext`, `exec.signal`), `lib/types/schema.d.ts`
- `@deepseek-ai/dsh-system-prompt` — `lib/types/index.d.ts` (`section({name, order, text})`)
- `@deepseek-ai/dsh-agent` — `lib/types/runtime-types.d.ts` (`Agent`, `AgentHandle`, `agents.create/resume`, `setup`), `lib/types/index.d.ts`
- `@deepseek-ai/dsh-session` — `lib/types/index.d.ts` (`session.append`, events)
- Router's own worked DSH plugin: `integrations/runtimes/deepseek-harness/` (`src/plugin.ts`, `src/contracts.ts`, `src/worker.ts`, `cordis.patch.yml`)
- Official docs (re-read at implementation time): `docs/user/develop/basic/{index,tool,config,publish}.md`, `docs/cordis-primer.zh.md` in `deepseek-ai/deepseek-harness`
