# JEV

JEV is TypeSafe's hosted decision model. You send it a `state` and typed questions; it returns, for each question, a yes/no probability (`noul`), one of your declared options with a distribution (`choice`), or a position on your scale (`score`). It never returns text. This fork uses it as a judgment step between deterministic code and an LLM agent: code measures and decides, JEV answers one typed question where code would otherwise guess, and code turns the answer into an action.

The build is split into tracks; ownership, merge order and the verified list of existing code are in [design-notes/jev-tracks.md](design-notes/jev-tracks.md). Feature 1, the catastrophe gate, is deterministic and makes no JEV call; it is not covered here.

## Rules

These come from Tyler's decisions of 2026-09-28 and bind every call site.

- **JEV never gates an agent.** No JEV feature blocks, denies or adds a confirmation step to an agent's tool call. The catastrophe gate is the only gate, and it is code.
- **Fail open.** No key, the switch off, a timeout, an HTTP error, a malformed answer or a low-confidence answer all mean exactly today's behaviour. `JevService.decide` never rejects, and its result type makes today's behaviour the default branch (see [The outcome](#the-outcome)).
- **Code owns the numbers.** Token lines, confidence floors, caps and the final decision are constants or config in code. JEV answers; it does not decide.
- **The classifier stays the single authority** for role, model, thinking, account and tools. A JEV answer is one of its inputs, and a guess from it may add capability but never remove tools.
- **Agent tools are added at spawn only.** The tool list an agent sees is a function of labels written at create, so a reload or resume lists the same tools and the prompt cache survives.
- **Every call site has its own switch** under `agents.jev`, and a master switch turns them all off.

## What leaves the machine

JEV is hosted only. Calls go to OpenRouter, which forwards them to TypeSafe in the US West. TypeSafe does not train on inputs, keeps them "as long as reasonably necessary" (zero retention is enterprise-only), and holds a perpetual licence to derive telemetry, including classifications, from them. Tyler accepted this for the features below; each can be switched off.

| Feature               | What is sent, after [redaction](#redaction)                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2 Spawn hint          | The new agent's title, the first 6,000 characters of its prompt, and role names                                        |
| 3a Remediation triage | The condition's kind, title, summary, evidence (8 KB cap), the remedy attempts and the agent task text                 |
| 3b Finish triage      | The agent's title and the last 4,000 characters of its final message                                                   |
| 4, 5 File tools       | The full text of each file the agent names, under its working directory, up to 60 KB each                              |
| 6 `ask_jev`           | The agent's own state text (8 KB cap), named files, a command's output, a diff and its commit messages                 |
| 9 Compaction timing   | A leader's user messages since its last compaction (clipped), its last reply (clipped), and the names of tools it used |
| 10 Stall judgment     | The agent's title, the first 800 characters of its assignment, and a summary of its last 25 timeline rows              |
| 11 UI                 | Nothing                                                                                                                |

## The client

### Where it lives

The client is a daemon module, `packages/server/src/server/jev/`. Every JEV request leaves the daemon process. The account-pool plugin reaches it through one RPC, `jev.decide`, on its `PaseoApi`.

Every call site except feature 2's is daemon code (3, 4–6, 9, 10), and the pieces that must be single — the key, the spend cap, the ledger the UI reads, the audit file, the circuit breaker — belong with them. The plugin needs JEV for feature 2 only.

The alternatives, and why not:

- **A new workspace package** (`packages/jev`). Every workspace dependency of the server has to be built before the server's declarations are current (`build:server-deps`), and electron-builder packs only declared production dependencies, so a new package touches the root build scripts, CI filters and desktop packaging, all shared with upstream. It still leaves two processes making calls, so the ledger and the spend cap would need an RPC anyway.
- **A vendored copy in the plugin.** The daemon compiles the plugin with esbuild into a CJS bundle and runs it by indirect eval in a subprocess (`packages/server/src/server/plugins/compiler.ts:386-412`, `plugins/plugin-process.ts:224-227`). A second copy would work, but it splits the ledger, the spend cap and the key between two processes and drifts from the daemon's copy.
- **Tools served by the plugin**, the way `exposeClassifierTool` serves `agent_model_policy` over a Unix socket and a stdio bridge. `ask_jev` has to route its `command` through the catastrophe gate, which is daemon code (`packages/server/src/server/agent/catastrophe-gate.ts`), and the file tools need the calling agent's working directory and denied tools, which the daemon's `/mcp/agents` route already resolves from `callerAgentId`.

The module is fork-only and new, so it adds no merge friction with upstream beyond the handful of wiring lines listed per track.

Files, all under `packages/server/src/server/jev/`:

| File           | Owns                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`  | The types every track builds against. Committed with this doc as an interface stub.                                                                                                             |
| `wire.ts`      | Request and response validation and the `noul` / `choice` / `score` builders, adapted from disler/ten-levels-of-jev `core/types.ts`, `core/client.ts` and `core/helpers.ts` with the MIT notice |
| `transport.ts` | The OpenRouter and TypeSafe HTTP transports: one attempt each                                                                                                                                   |
| `fake.ts`      | The deterministic fake transport and `createTestJevService()`                                                                                                                                   |
| `config.ts`    | The `agents.jev` resolver and key lookup                                                                                                                                                        |
| `redact.ts`    | Outbound redaction                                                                                                                                                                              |
| `ledger.ts`    | Per-call entries, daily totals, the spend cap                                                                                                                                                   |
| `audit.ts`     | Bounded payload retention                                                                                                                                                                       |
| `service.ts`   | `createJevService()`: deadlines, retries, the circuit, validation, the outcome                                                                                                                  |

No `index.ts`: callers import from the file that owns the thing.

### Transport

|              | OpenRouter (default)                        | TypeSafe direct                        |
| ------------ | ------------------------------------------- | -------------------------------------- |
| Endpoint     | `https://openrouter.ai/api/alpha/decisions` | `https://api.typesafe.ai/v1/systemone` |
| Model        | `~typesafe/jev-latest`                      | `jev-latest`                           |
| Key variable | `OPENROUTER_API_KEY`                        | `TYPESAFE_API_KEY`                     |

The OpenRouter endpoint is the one the reference implementation calls live. TypeSafe's SDK docs describe OpenRouter as a base URL of `https://openrouter.ai/api` with the SDK's own `/v1/systemone` path, so both URLs may be live; this is unverified until a key exists. `agents.jev.endpointUrl` overrides the URL without a code change. Pin a versioned model (`typesafe/jev-1.13`) through `agents.jev.model` once thresholds are calibrated; the moving alias can change answers under you. Every ledger entry records the model that answered.

Each request is `POST` with `Authorization: Bearer <key>`, `Content-Type: application/json`, `redirect: "error"`, and the body `{ model, state, questions }`. Node's `fetch` keeps connections alive, which matters: a cold connection has been measured at about 900 ms against a warm p50 near 300 ms.

### Key

- The key is read at call time from the environment variable named by `agents.jev.keyEnv`, then from the env file at `agents.jev.envFile` (default `~/.config/paseo/jev.env`, one `OPENROUTER_API_KEY=…` line, mode 0600). Reuse `parseEnvFileValue` (`services/quota-fetcher/providers/openai-api.ts:82`). The env file lets you add a key without restarting the daemon.
- Config names where the key lives and never holds it, the same as `agents.providerUsage.openaiApi`.
- The key never appears in a log line, an error message, the audit file, the ledger, a JEV payload or a wire message. Errors name the variable, never the value. HTTP error bodies are not logged. `redact.ts` replaces the key's exact value if it ever appears in outbound state.
- With no key, every feature is off. The service logs one line per process, `jev: off, no key (set OPENROUTER_API_KEY or add it to ~/.config/paseo/jev.env)`, and nothing else.
- A 401 or 402 marks JEV unavailable (`key-rejected`) for 10 minutes and logs once.

### Deadlines, retries, the circuit

Each call site has a deadline that covers every retry and the response body. Defaults, in `agents.jev.<feature>.timeoutMs`:

| Feature              | Deadline              | Why that number                                                                                 |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `spawnHint`          | 1,500 ms              | It sits on the create path. Independent p50 is 236–276 ms from Europe, p95 720 ms from Germany. |
| `notificationTriage` | 3,000 ms              | It delays a push, not an agent                                                                  |
| `remediationTriage`  | 5,000 ms              | The ladder is serialized; it runs once per episode                                              |
| `agentTools`         | 8,000 ms per JEV call | The agent is waiting on its own tool call                                                       |
| `compactionTiming`   | 5,000 ms              | Off the agent's path; the monitor sweeps every 60 s                                             |
| `stallJudgment`      | 5,000 ms              | The sweep is serialized and runs every 5 minutes                                                |

- **Retries.** 429, 502, 503 and 529 are retried with backoff `250 ms × 2^attempt` plus up to 20% jitter, at least `Retry-After`, at most 3 attempts, and never past the deadline.
- **Concurrency.** At most `agents.jev.maxConcurrent` (default 8) requests in flight daemon-wide; the rest queue inside their deadline. TypeSafe's published limit is 1,200 requests per minute.
- **The circuit.** Five consecutive timeouts, network errors or 5xx open it for 60 seconds. While open, `decide` returns `unavailable: circuit-open` at once, so a JEV outage adds no latency anywhere.
- **Spend cap.** Once today's cost reaches `agents.jev.maxUsdPerDay` (default $1.00, about 25,000 decisions at list price), every call returns `unavailable: daily-budget` until the UTC day turns. Logged once per day.

### Validation

Before sending, validate the request with the reference's rules: a non-empty question map; `noul` criteria only `true`/`false`; `choice` 1–255 options with string-or-null descriptions; `score` 2–10 non-blank levels; the body JSON-serializable. Code also caps a call at 16 questions and the state at 60,000 UTF-8 bytes. Over the byte cap the call fails with `state-too-large` without sending.

The byte cap is below the reference's. TypeSafe allows 32K tokens for the state plus the longest question and 64K for the whole request; OpenRouter lists a 32,000 context. The reference sizes its file limit against the 64K figure, so a large file there would be rejected upstream. JEV's tokenizer is unknown; 60 KB assumes about 2.5 bytes per token and leaves room for the questions. The ledger records `stateBytes` and `input_tokens` for every call, so the ratio can be measured and the cap moved.

After receiving, validate with the reference's `validateResponse`: `model` is a non-blank string; `usage.input_tokens` and `output_tokens` are non-negative integers; every question has an answer of its own type; `noul` is in [0, 1]; a distribution has exactly the declared keys, each in [0, 1], summing to 1 within 0.025; a `choice` is a declared key; a `score` is in [0, levels − 1] and its legend matches the declared levels. Unknown extra fields are kept. Any violation is `failed: contract`.

### The outcome

```ts
type JevOutcome =
  | { kind: "answered"; callId; answers; meta }
  | { kind: "shadow"; callId; answers; meta }
  | { kind: "unavailable"; callId; reason }
  | { kind: "failed"; callId; reason; meta | null };
```

The full types are in `jev/contract.ts`. Only `answered` may change behaviour. Write every call site as `if (outcome.kind !== "answered") return todaysBehaviour();` and shadow mode, failures and outages all take the default branch. In shadow mode (`agents.jev.<feature>.shadow: true`) the call is still made and the call site records what it would have done, through its own pure decision function, without doing it.

`isActive(feature)` answers synchronously whether a call would be sent now: key present, master and feature switches on, spend under the cap, circuit closed. Check it before doing work to build state: reading files, fetching a timeline tail.

### Config

`agents.jev` in `config.json`, a `.strict()` object in `persisted-config.ts`. It is read from `config.json` on use, cached for 5 seconds, the same way `agents.tokenAudit` and `agents.providerUsage` are, so every key is live. It goes in `RELOADABLE_PATHS` with no mutable mapping, so `paseo daemon reload` does not report it as needing a restart. It is not part of the mutable config the app receives.

| Key                                                   | Default                   | What it does                                                      |
| ----------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `enabled`                                             | `true`                    | Master switch. Off, or no key, and nothing is sent.               |
| `provider`                                            | `"openrouter"`            | `"openrouter"` or `"typesafe"`                                    |
| `model`                                               | per provider              | The model id sent                                                 |
| `endpointUrl`                                         | per provider              | Full URL override                                                 |
| `keyEnv`                                              | per provider              | Environment variable holding the key                              |
| `envFile`                                             | `~/.config/paseo/jev.env` | Fallback file for the key                                         |
| `maxUsdPerDay`                                        | `1`                       | Daily spend cap, reported plus estimated                          |
| `maxConcurrent`                                       | `8`                       | Requests in flight, daemon-wide                                   |
| `inputUsdPerMillion`                                  | `0.042`                   | Price used when the response reports no cost                      |
| `audit.enabled`                                       | `true`                    | Keep request and response payloads                                |
| `audit.includeState`                                  | `true`                    | Off: keep a hash and sizes instead of the state                   |
| `audit.maxEntries`                                    | `200`                     | Newest kept                                                       |
| `audit.maxBytes`                                      | `4000000`                 | On-disk cap                                                       |
| `audit.retainDays`                                    | `7`                       | Older entries dropped                                             |
| `spawnHint.enabled`, `.shadow`, `.timeoutMs`          | `true`, `false`, `1500`   | Feature 2                                                         |
| `remediationTriage.enabled`, `.shadow`, `.timeoutMs`  | `true`, `false`, `5000`   | Feature 3a                                                        |
| `notificationTriage.enabled`, `.shadow`, `.timeoutMs` | `true`, `false`, `3000`   | Feature 3b                                                        |
| `agentTools.enabled`, `.timeoutMs`                    | `true`, `8000`            | Features 4–6. No `shadow`: an agent asked, so it gets the answer. |
| `agentTools.maxCallsPerAgentPerHour`                  | `600`                     | Per agent; past it the tools answer `agent-budget`                |
| `compactionTiming.enabled`, `.shadow`, `.timeoutMs`   | `true`, `false`, `5000`   | Feature 9                                                         |
| `compactionTiming.considerAtTokens`                   | `200000`                  | Below this, no call                                               |
| `compactionTiming.ceilingTokens`                      | `500000`                  | A deferral never holds a leader past this                         |
| `compactionTiming.maxDeferrals`                       | `3`                       | Consecutive turns a compaction may be held                        |
| `compactionTiming.cutPoint`                           | `true`                    | Ask where the live work starts before `/compact`                  |
| `stallJudgment.enabled`, `.shadow`, `.timeoutMs`      | `true`, `false`, `5000`   | Feature 10                                                        |
| `stallJudgment.loopWatch`                             | `true`                    | Watch running agents for loops                                    |

Confidence floors are code constants, listed per feature below. They are thresholds, and code owns thresholds.

The foundation track creates this whole schema, including every feature's keys, so no feature track edits `persisted-config.ts`.

### Ledger

One entry per `decide` call, including `unavailable` ones: `callId`, time, feature, call site, subject agent ids, outcome and reason, model, attempts, elapsed ms, `stateBytes`, question count, input and output tokens, and cost as `{ usd, source }`. `source` is `reported` when the response's `usage.cost` is a finite non-negative number, `estimated` from `input_tokens × inputUsdPerMillion` otherwise (output is free), `fake` under the fake, `unknown` when neither is possible.

- **In memory:** a ring of the newest 2,000 entries.
- **On disk:** `$PASEO_HOME/jev/ledger.json`, daily totals per feature for 30 days, written atomically at most every 30 seconds and at shutdown. Entries are not persisted, only totals.
- **Read:** `JevService.status()`, and the `jev.status` RPC.

### Audit

`$PASEO_HOME/jev/audit.json`, mode 0600, the newest `audit.maxEntries` calls within `audit.maxBytes` and `audit.retainDays`, written atomically. Each record holds the redacted state (first 16 KB, plus a SHA-256 and the byte length of all of it), the questions, the answers, the ledger fields and nothing else. It exists so you can see exactly what left the machine and what came back. With `audit.includeState: false` it keeps the hash and sizes only.

### Redaction

`redact.ts` runs over the serialized state of every call before it is sent, audited or measured. It replaces, with `[redacted:<kind>]`:

- the JEV key's exact value;
- PEM private key blocks;
- strings shaped like `sk-…`, `sk-ant-…`, `sk-or-…`, `ghp_…`, `github_pat_…`, `xox[abpr]-…`, `AKIA…`, `AIza…`;
- the value in `KEY=value` lines whose name ends in `_KEY`, `_TOKEN`, `_SECRET` or `PASSWORD`.

It is a backstop, not a boundary. The file tools also refuse secret-shaped paths ([Features 4–6](#features-46-agent-tools)).

### The fake

`fake.ts` ports the reference's `MockJev`: token overlap between the flattened state and each option's text, through a softmax, with confidence from the distribution's peak. It returns contract-valid answers for any valid question, deterministically, with model `jev-fake` and cost `{ usd: 0, source: "fake" }`. It also takes a script, so a test states the exact answer it needs:

```ts
const jev = createTestJevService({
  answers: { task_class: { type: "choice", choice: "mechanical", confidence: 0.9 } },
});
```

A scripted `choice` gets a distribution with the named option at `confidence` and the remainder spread evenly; a scripted `score` gets a legend from the question. The fake can also be told to time out, fail with an HTTP status or return a contract violation, so every fail-open branch has a test.

- Tests inject it through `createTestJevService()` or the daemon's test overrides (`createPaseoDaemon(config)` with `jevOverrides.transport`, following `pushNotificationSender`).
- A scratch daemon started with `PASEO_JEV_BACKEND=fake` uses it with no key. The daemon logs `jev: fake backend` at startup. `config.json` cannot select it.
- Never make a live call from a test.

### RPCs

Following `agent.context_usage.read` (`packages/protocol/src/context-usage/rpc-schemas.ts`):

| RPC                                | Permission        | Request                                                                                | Response payload                                                                                                                                            |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jev.decide.request` / `.response` | `workspace.write` | `feature`, `callSite`, `state`, `questions`, optional `subject`, optional `deadlineMs` | `callId`, `outcome` (string: `answered`, `shadow`, `unavailable`, `failed`), `reason` (string or null), `answers` (or null), `model` (or null), `elapsedMs` |
| `jev.status.request` / `.response` | `daemon.read`     | none                                                                                   | The `JevStatus` shape in `contract.ts`                                                                                                                      |

- Outcome, reason and feature are plain strings on the wire with the values listed in a comment, so adding one never narrows a schema. The question and answer schemas are `z.discriminatedUnion("type", …)`.
- Both are gated on `server_info.features.jev`.
- `PaseoApi` gains `jev: { decide, status }` (`packages/client/src/index.ts:483-491`); `DaemonClient` gains `jevDecide` and `jevStatus`.
- The plugin gets no gate check of its own: an older daemon answers the unknown RPC with an error, which the plugin treats like `unavailable`.

## Feature 2: spawn hint

When a create has no `paseo.task-class` label, or a child create has neither `paseo.agent-type` mapping nor `paseo.agent-role` label, the classifier asks JEV what class of work the prompt is and, for such a child, which role. JEV outranks the keyword seeds. It never outranks a label, and it cannot lower a task a hard-risk keyword already marked hard.

### Seam

`classifyAgent` stays pure and synchronous (`plugins/claude-account-pool/server/classifier.ts:1165`; its header at `:68-75` rules out I/O). The async call happens before it:

- `index.server.ts:322-339`, the role hook. After `await refreshPolicyForCreate()` (`:331`) and before `roleRouter(input, context)` (`:332`), call `await fetchSpawnHint(request, context.paseo)` (new, `server/jev-hint.ts`) and pass the result in.
- `role-router.ts:630-650` passes it to `classifyAgent` as `ClassifierInput.jevHint`.
- `role-resolve.ts:153-177` (`resolveRole`) and `:241-253` (`resolveTaskClass`) take the hint as a tier.
- New sources: `RoleSource` `"classified-jev"` (`classifier.ts:169-181`), `TaskClassSource` `"jev"` (`role-resolve.ts:179`).
- `fetchSpawnHint` asks only when a value is missing: no declared task class, or a child with no type mapping and no role label. Otherwise it returns `{ status: "not-needed" }` without a call.

`jevHint` is an input, like pool health, so the decision stays replayable from its log line. The `role-model-policy.explain` RPC and the `agent_model_policy` tool pass no hint and say "decided at create" for an unlabelled value; a preview must not spend.

### State and questions

```json
{
  "title": "<config.title, or empty>",
  "prompt": "<initialPrompt, first 6000 characters>",
  "spawned_by": "a person | another agent"
}
```

```json
{
  "task_class": {
    "type": "choice",
    "instructions": "Which class of work does `prompt` hand to the new agent? Judge the work it asks for, not the length or tone of `prompt`.",
    "criteria": {
      "mechanical": "Rote and fully specified: a rename, a formatting pass, a version bump, a changelog line, copying or moving text, running named commands and reporting the output",
      "standard": "Ordinary engineering in a known area: implement or fix a described behaviour, write or update tests, review a bounded change, research a specific question",
      "hard": "Open-ended or high-stakes: design across several modules, concurrency, security or data-loss risk, a migration, a root-cause hunt without a lead, or choosing between approaches",
      "other": "Not a task: a greeting, a status question, or too little text to tell"
    }
  },
  "reasoning": {
    "type": "score",
    "instructions": "How much reasoning does the work in `prompt` need before the first change is made?",
    "criteria": [
      "None: the steps are spelled out and only need doing",
      "Some: read a few files, then follow an existing pattern",
      "Deep: weigh approaches, trace behaviour across modules, or reason about failure modes"
    ]
  }
}
```

For a child with no type mapping and no role label, add `role`. Its options are the policy's roles minus the leader, built in code:

```json
{
  "role": {
    "type": "choice",
    "instructions": "Which kind of agent does `prompt` ask for?",
    "criteria": {
      "worker": "Makes the change: implements, fixes, edits files, runs builds and tests",
      "reviewer": "Judges existing work without changing it: reviews a diff, verifies a claim, audits for defects",
      "advisor": "Finds things out and recommends: researches, investigates, compares options, gives a second opinion",
      "<custom role id>": "An operator-defined role named <name>, also called <aliases>",
      "other": "None of these"
    }
  }
}
```

### Thresholds and precedence

Task class, highest first:

1. A declared `paseo.task-class` label.
2. `hard` when `HARD_SEED_RE` matches (`role-resolve.ts:198-199`). JEV cannot lower a risk keyword.
3. JEV `hard` when `task_class` is `hard` at confidence ≥ 0.55, or `reasoning.score` ≥ 1.6 at confidence ≥ 0.55.
4. JEV `standard` when `task_class` is `standard` at confidence ≥ 0.60.
5. JEV `mechanical` when `task_class` is `mechanical` at confidence ≥ 0.75 **and** `reasoning.score` ≤ 0.6. Two independent answers must agree before the cheapest model runs.
6. `mechanical` when `MECHANICAL_SEED_RE` matches.
7. Default (the role's standard pool).

The floors are asymmetric on purpose: a wrong "hard" costs money, a wrong "mechanical" costs the work.

Role, for a child at tiers 3–4 only: JEV's `role` at confidence ≥ 0.70 and not `other` replaces the keyword tier. It is still a guess, so `toolProfileIsEvidenceBased` (`classifier.ts:426-431`) withholds that role's tool profile exactly as it does today. JEV can change the model a child runs; it cannot take a tool away.

Thinking follows the class through `policy.thinking.byTaskClass` (`classifier.ts:1027`), as it does now. The `reasoning` score informs the class; it does not set a thinking level of its own. See the disagreement noted in the track plan.

### Labels and the log

- `paseo.task-class-source`: `declared`, `jev`, `seed` or `default`.
- `paseo.jev-call`: the `callId`, when JEV answered, so the UI track can attach the decision to the new agent's timeline.
- The `classifier-decision` line (`decision-log.ts`) gains `jev: { status, callId, taskClass: { choice, confidence }, reasoning: { score, confidence }, role? }`.

### Fail open

Any outcome other than `answered` leaves `jevHint` as `{ status: "unavailable" | "failed" | "shadow" }`, and precedence skips steps 3–5 and the JEV role. That is today's classifier. A shadow answer is logged as `wouldBe`.

### Cost, cache, latency

- About 1,500–2,500 input tokens per call, $0.00006–$0.0001.
- No cache effect: the model is chosen before the session exists.
- Up to 1.5 s added to an unlabelled create, median about 0.3 s. Labelled creates pay nothing. The plugin's 30 s budget for all its hooks (`packages/server/src/server/plugins/runtime.ts:33`) is not at risk. Measure the unlabelled share from `classifier-decision` lines before and after; the live log held only five lines on 2026-09-28, one of them unlabelled.

### Tests and verification

- `jev-hint.test.ts`: every precedence step above with scripted answers; the `HARD_SEED_RE` override; the two-answer rule for `mechanical`; `other` and low confidence falling through; `not-needed` when labels are present; no call when `jev.decide` rejects; shadow logs `wouldBe` and changes nothing.
- `classifier.test.ts`: a JEV role still withholds tools; `classified-jev` and the `jev` source reach the decision and the reasons.
- `role-router` test: the new labels are written.
- Verify: `npx vitest run plugins/claude-account-pool/server/jev-hint.test.ts --bail=1`.

## Feature 3a: remediation triage

Before the ladder starts a remediation agent (up to 2M tokens), JEV judges whether an agent is the right next step. It can send the episode to a person sooner, or give it one more grace window. It cannot stop an agent from starting later.

### Seam

`RemediationLadder.startAgent` (`packages/server/src/server/remediation/ladder.ts:304-380`). After every existing gate has passed — escalation on, not in cooldown, under the daily cap, a free slot, no account blocker (`:311-342`) — and before the request is built (`:344`), call a new optional dependency:

```ts
triageEscalation?(input: { episodeKey: string; observation: RemediationObservation }): Promise<EscalationTriage>;
```

It is added to `RemediationLadderDependencies` (`ladder.ts:58-65`) and wired in the ladder factory in `bootstrap.ts:864-935`. The episode records the result so JEV is asked once per episode: `EpisodeSchema` (`ladder-state.ts:44-59`) gains optional `jevTriage` and `jevDeferredUntil`. `evaluate` (`ladder.ts:250-302`) returns early while `jevDeferredUntil` is in the future, next to the grace check at `:280-283`. Advisory episodes (`escalation.advice: true`) are not triaged.

### State and questions

```json
{
  "condition": "<observation.kind>",
  "title": "<observation.title>",
  "summary": "<observation.summary>",
  "evidence": "<observation.evidence, cut at 8 KB like escalation.ts>",
  "attempts": ["<remedy>: <outcome> - <detail>"],
  "agent_task": "<observation.escalation.task>"
}
```

```json
{
  "route": {
    "type": "choice",
    "instructions": "An automatic remedy has already run for the problem in `summary` and `evidence`; `attempts` lists what it did. What should happen next?",
    "criteria": {
      "agent_can_fix": "A coding agent with a shell on this machine could plausibly clear it by doing `agent_task`: stop leftover processes, reclaim files it can prove are safe, restart or unstick an agent",
      "needs_person": "Only a person can clear it: signing in again, paying, deciding about someone's work, or anything off this machine",
      "clearing_on_its_own": "The readings show it already easing or likely to clear within minutes: a spike, a burst, a job that is finishing, a value sitting right at its threshold",
      "other": "None of these"
    }
  },
  "evidence_current": {
    "type": "noul",
    "instructions": "Does `evidence` show the problem in `summary` happening now?",
    "criteria": {
      "true": "Current readings, process lists or file sizes that match `summary`",
      "false": "`evidence` is empty, stale, contradicts `summary`, or only restates it"
    }
  }
}
```

### Thresholds

| Answer                                                                                                             | Action                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `needs_person` at confidence ≥ 0.80                                                                                | Rung 3 now, with the reason "JEV judged this needs a person (0.84)". No agent.                                               |
| `clearing_on_its_own` at confidence ≥ 0.80, `evidence_current` < 0.40, and the observation's level is not `urgent` | Defer rung 2 once, by the condition's grace window or 10 minutes, whichever is longer. After that the agent starts as today. |
| Anything else                                                                                                      | The agent starts as today                                                                                                    |

A deferred episode that clears on its own closes as resolved, as any episode does.

### Fail open

Not `answered`: the agent starts as today. The ladder serializes observations, so the call is bounded by the 5-second deadline and made once per episode.

### Cost, cache, latency

Under 3,000 input tokens per episode. No cache effect: no agent context is touched, and a skipped remediation agent is a whole context not built. Up to 5 seconds added to rung 2, once.

### Tests and verification

- `remediation/jev-triage.test.ts`: the decision function for each row of the table, including the `urgent` exclusion.
- `ladder.test.ts`: `needs_person` escalates without calling `createAgent`; `clearing_on_its_own` defers once and then creates; a second observation in the same episode does not ask again; `triageEscalation` absent or returning a failure behaves exactly like today; advisory episodes are never triaged; the fields survive a state reload.
- Verify: `npx vitest run packages/server/src/server/remediation/ladder.test.ts --bail=1`.

## Feature 3b: finish triage

A root agent's finish pushes an `alert` today. JEV reads the final message and can send a routine finish as a `notice` instead, which lands in the digest. It never drops a push, never raises one, and never touches permission or error pushes.

### Seam

`VoiceAssistantWebSocketServer.broadcastAgentAttention` (`packages/server/src/server/websocket-server.ts:2620-2704`). The final message is already fetched at `:2644`. At `:2661-2666`:

- Keep `attentionPushLevel` (`agent-attention-policy.ts:90-95`) as the base level.
- The in-app messages (`:2668` onward) must not wait for JEV. Move the push into a detached async step: if the base is `alert` and the reason is `finished`, ask JEV, then send at the level the answer leads to; otherwise send at the base level at once.
- The logic lives in a new `packages/server/src/server/attention-push-triage.ts`: the question, the state builder and a pure `finishedPushLevel(base, answers)`.

The finished edge itself (`agent-manager.ts:6673-6691`) does not change.

### State and question

```json
{ "title": "<agent title>", "final_message": "<last assistant message, last 4000 characters>" }
```

```json
{
  "needs_person": {
    "type": "choice",
    "instructions": "`final_message` is the last thing an agent said before it stopped. What does it need from the person who started it?",
    "criteria": {
      "answer_or_decision": "It asks a question, asks for approval, offers options to choose from, or says it is waiting for input",
      "failure": "It says it could not finish, hit an error or a limit, or left something broken or half done",
      "result_to_review": "It finished and hands over something to look at: a pull request, a report, a design, an answer to the question it was given",
      "routine": "Nothing to look at: an acknowledgement, a status line, a cleanup or bookkeeping step that went as expected",
      "other": "None of these"
    }
  }
}
```

### Thresholds

`routine` at confidence ≥ 0.85 turns the `alert` into a `notice`. Everything else sends the `alert`. A message with no text sends the `alert`.

### Fail open

Not `answered`: the `alert` goes out as now, at most 3 seconds later.

### Cost, cache, latency

Under 1,500 input tokens per finish. No cache effect. The push is delayed by up to 3 seconds; the in-app notice is not delayed.

### Tests and verification

- `attention-push-triage.test.ts`: `finishedPushLevel` for each option and the floor; a delegated child's `notice` and every non-`finished` reason are never sent to JEV.
- A websocket-server test with a recording push sender and the fake: a scripted `routine` sends `notice`; a timeout sends `alert`; the client messages go out before the push.
- Add the row to the sender inventory in [notification-policy.md](notification-policy.md#sender-inventory).
- Verify: `npx vitest run packages/server/src/server/attention-push-triage.test.ts --bail=1`.

## Features 4–6: agent tools

Seven tools on the daemon's existing Paseo MCP server, for agents the classifier marked at create. Code reads the files or runs the command, sends them to JEV, and returns typed answers; the content never enters the agent's context.

### Which agents get them

- The classifier decides, at create. The plugin polls `jev.status` every 60 seconds; when `agents.jev.agentTools` is active and the decided tool profile does not deny `Read`, the role hook writes `paseo.jev-tools: on`.
- The daemon lists the tools for exactly the agents carrying that label, whatever JEV's state at launch. So a reload or resume lists the same tools and keeps the prompt cache. When JEV is off at call time the tool answers with an error naming why ("JEV is off on this host: no key. Use Read or Bash."), and the agent does what it would have done without it.
- Agents created without the label never gain the tools.

### Seam

- New `packages/server/src/server/agent/tools/jev-tools.ts`: `registerJevTools({ registerTool, jev, callerAgentId, resolveCallerAgent, commandGate, … })`, following `registerDeviceLeaseTools` (`agent/tools/device-lease-tools.ts:57`).
- `agent/tools/paseo-tools.ts`: `PaseoToolHostDependencies` (`:112-166`) gains `jevTools`; call `registerJevTools` beside the device lease tools (`:1244-1253`) when `jevTools` is set, `callerAgentId` is set, and the caller's labels include `paseo.jev-tools: on`. `resolveCallerAgent` (`:650-659`) gives the caller's `cwd` and labels. No tools register for a catalog built without a caller.
- `bootstrap.ts:2300-2340`, `createAgentToolHostDependencies`: pass `jevTools`, including the command gate adapter.
- The tools reach the agent as `mcp__paseo__<name>` over `/mcp/agents` (`bootstrap.ts:2382`). No new MCP server and no new connection.

### Reading files safely

New `agent/tools/jev-file-state.ts`:

- Resolve against the caller agent's `cwd` (`resolvePathFromBase`, `path-utils.ts:22`), then `realpath` both, and refuse anything whose real path is outside the real `cwd` (`isSameOrDescendantPath`, `path-utils.ts:30`). Symlinks cannot escape.
- Expand globs over `git ls-files --cached --others --exclude-standard` when `cwd` is in a git work tree, so ignored files are never candidates. Outside git, walk the directory and skip `node_modules`, `.git`, `dist`, `build`, `coverage`, `.dev`, `.paseo`. Which glob matcher to use on the daemon's Node floor (`node:fs/promises` `glob` as the reference does, or `node:path` `matchesGlob`) is UNKNOWN: check before choosing.
- Skip, with a reason the agent sees: over 60,000 bytes; empty; a NUL byte in the first 8 KB; lock and binary extensions (the reference's list); and secret-shaped names: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `credentials*`, `*.keystore`. The agent can still `Read` any of them; the tool only declines to send them to a third party.
- Refuse the file tools for an agent whose `paseo.tools-denied` label includes `Read`. Refuse `command` for an agent whose denied tools include `Bash`. A JEV tool never does what the agent's own tools may not.

### The tools

Descriptions below are the text the agent sees. Each ends with the same guidance: **Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.**

**`ask_jev_file_bool`** `(path, question, yes?, no?)` → `{ path, answer, noul }`. State `{ path, content }`. One `noul`, with `yes`/`no` as criteria. `answer` is `noul > 0.5`.

> Yes or no about one file, without reading it into your context. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. Write the question against `content`, the file's text; `path` is in the state too. Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.

**`ask_jev_file_choice`** `(path, question, options)` → `{ path, choice, confidence, probabilities }`. Adds `other: "None of the above"` when the agent supplied no `other`, `none` or `none_of_the_above`.

> Pick one of your options about one file, without reading it. Returns { path, choice, confidence, probabilities }; choice is always one of your keys, and an "other" option is added if you leave none. Up to 255 options. Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.

**`ask_jev_file_score`** `(path, question, levels)` → `{ path, score, top, nearest, confidence, legend }`.

> A position on a scale you define, about one file, without reading it. Levels are ordered low to high, 2 to 10 of them, each a described situation, not a degree. Returns { path, score, top, nearest, confidence, legend }. Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.

**`ask_jev_files`** `(paths_or_globs, questions_json, recursive?)` → `{ results: [{ path, answers }], skipped: [{ path, reason }], calls }`. Expand, prune (the rules above), cap at 255 files with "over the 255 file cap; narrow the pattern" for the rest, then one JEV call per file with every question, at most 8 in flight per tool call. The whole tool call has 60 seconds; files not reached are skipped with "out of time".

> Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, drops ignored, binary, secret-shaped and oversized files, caps the list at 255, and makes one JEV call per file. Returns { results: [{ path, answers }], skipped: [{ path, reason }], calls }. questions_json is a JSON object keyed by question id; each question is {"type":"noul","instructions":"Does `content` …?","criteria":{"true":"…","false":"…"}}, {"type":"choice","instructions":"Which … is `content`?","criteria":{"option":"when it applies","other":"none of the above"}} or {"type":"score","instructions":"How … is `content`?","criteria":["lowest situation","…","highest situation"]}. Ask everything you need in one block; it is one call per file either way. Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.

**`pick_first_file`** `(question, candidates: [{ path, note? }])` → `{ path | null, confidence, probabilities }`. State `{ question, files }`; one `choice` keyed by path, at most 254 paths plus `none: "No file in the list fits"`. `path` is null for `none` or confidence < 0.30.

> After ask_jev_files, choose which file to open first for a goal. The pick is always one of your paths, or null when nothing fits. Pass a one-line note per path if you have one. Use Read to open the file it picks.

**`ask_jev`** `(questions_json, state?, paths?, command?)` → `{ answers, state_summary, model }`. Level 10 of the reference. Code assembles one state: the agent's own `state` (8 KB cap, refused with "pass paths or command instead" above it) as the base, `files` keyed by path (up to 20, same rules), and `output: { command, exit_code, stdout, stderr }`. Over 60 KB the call is refused with the reference's split message naming the parts. `command`:

- goes through the catastrophe gate first (`CommandGate` in `jev/contract.ts`), and is refused with the gate's reason when it would be refused as a Bash call;
- is refused when the agent's denied tools include `Bash`;
- runs in the agent's `cwd`, with the daemon's environment minus `agents.jev.keyEnv`, `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY`, plus `CI=1`; through the platform shell (`/bin/sh` on macOS, `cmd.exe` on Windows); 60-second timeout; stdout and stderr capped at 200,000 characters before the state budget applies.

Until the catastrophe gate lands, `command` is refused with "command needs the catastrophe gate; run it with Bash", so there is never a window where `ask_jev` runs what Bash would not.

> Ask JEV typed questions about one situation: files, a command's output, your own notes, or any mix. It answers in about half a second for a fraction of a cent, and each answer is a number you can branch on, not prose. Pass paths and code reads the files into files["path"]. Pass command and code runs it in your working directory and puts the result in output {command, exit_code, stdout, stderr}; the command goes through the same safety gate as Bash. Use state only for what only you can say, not for pasting content. One call judges one situation: up to 20 files and about 60 KB. Write questions against files["path"], output or your own field names; always give a choice an "other" option; describe situations, not degrees. Good uses: run the tests through command and classify the failure before choosing a fix; decide whether a request is clear enough to plan. Not for exact lookups, counting or math. Use Read when you need the code itself, to edit or quote it. Use grep for exact strings.

The description also carries this test-failure recipe verbatim:

```json
{
  "failure_kind": {
    "type": "choice",
    "instructions": "What kind of failure does `output` show?",
    "criteria": {
      "bug_in_code": "The code under test does the wrong thing: an assertion about real behaviour fails",
      "wrong_test": "The test expects the wrong thing, or is out of date with an intended change",
      "environment": "A missing tool, dependency, port, file or permission; the code never really ran",
      "flaky": "Timing, ordering or the network makes it pass and fail without a code change",
      "other": "None of these"
    }
  }
}
```

**`ask_jev_diff_risk`** `(base?)` → `{ risk, needs_full_review, parts, reason }`. The level-3 code-review risk, with the threshold in code, for deciding whether a diff gets the full adversarial review before merge. Code runs `git diff <base>...HEAD` and `git log --format=%B <base>..HEAD` as argv (no shell, read-only, so no gate), with `base` defaulting to the upstream branch or `origin/HEAD`. State `{ diff, commit_message }`. Questions, from `level03/code-review-risk.ts`:

```json
{
  "security_risk": {
    "type": "score",
    "instructions": "How much security risk does `diff` carry?",
    "criteria": [
      "No surface touched that handles input, auth, or secrets",
      "Handles input or auth, but follows existing safe patterns",
      "Introduces a plausible injection, secret leak, auth bypass, or invalid token handling"
    ]
  },
  "complexity": {
    "type": "score",
    "instructions": "How complex is the change in `diff`?",
    "criteria": [
      "Small, local change in one file, obvious on first read",
      "Touches several files, session handling, or adds branching",
      "Cross-cutting change with subtle invariants"
    ]
  },
  "bad_practice": {
    "type": "score",
    "instructions": "Does `diff` follow the conventions in `diff`'s surrounding context?",
    "criteria": [
      "Follows existing patterns cleanly",
      "Minor style drift from surrounding code",
      "Works against the established patterns"
    ]
  },
  "commit_quality": {
    "type": "score",
    "instructions": "Does `commit_message` accurately describe `diff`?",
    "criteria": [
      "Vague or unrelated to the change",
      "Names the area but misses key parts of the change",
      "Accurately covers the change: names the fix and the files"
    ]
  }
}
```

`risk = 0.5·security + 0.2·complexity + 0.1·bad_practice + 0.2·(1 − commit_quality)`, each normalized to 0–1 by its top level. `needs_full_review` is true when `risk ≥ 0.5`, when `security_risk.score ≥ 1.5`, when the diff is over 60 KB, or when JEV did not answer. Every failure answers "review it": the full review is today's behaviour.

> Score a branch's diff for risk before merge, and say whether it needs the full adversarial review. Code runs git diff and git log itself; you pass only the base branch. Returns { risk 0..1, needs_full_review, parts, reason }. Any failure, or a diff over 60 KB, answers needs_full_review: true. Use Read when you need the code itself.

### Limits

`agentTools.maxCallsPerAgentPerHour` (600) counts JEV calls, not tool calls, so one `ask_jev_files` over 255 files spends 255. Past it the tools answer `agent-budget` with the time it resets.

### Fail open

Not `answered`: the tool returns `isError` with the reason in one line, and nothing else changes. For `ask_jev_files`, per file: that file is in `skipped` with the reason.

### Cost, cache, latency

- About $0.00004 per file answered at typical sizes; 255 files about $0.01.
- Listed at spawn only and stable across reloads, so no cache break. Each use costs the agent one model step, about 25K weighted tokens at the fleet's median context (research 03 §3), and a `ToolSearch` step on first use when MCP tools are deferred. That step is the real price. The tools pay only when they replace reading files the agent did not need, and the tool descriptions say when not to use them.
- Tool results append at the tail, which is cache-neutral.
- 0.3–0.7 s per JEV call; `ask_jev_files` over 255 files at 8 in flight takes about 13 s.

### Tests and verification

- `jev-file-state.test.ts` in a temporary git repo: outside-`cwd` and symlink escapes refused; ignored, secret-shaped, binary, empty and oversized files skipped with reasons; the 255 cap.
- `jev-tools.test.ts` with the fake: each tool's result shape; `other` added; `pick_first_file` floor; `ask_jev` state assembly and the split message; `command` refused when the gate refuses, when `Bash` is denied, and when no gate is wired; the key variables absent from the command's environment; `ask_jev_diff_risk` weights and every fail-to-review path; tools absent without the label and without a caller; the per-agent budget.
- Verify: `npx vitest run packages/server/src/server/agent/tools/jev-tools.test.ts --bail=1`.

## Feature 9: compaction timing

Leader compaction ([leader-compaction.md](leader-compaction.md)) starts at one line, `prepareAtTokens` (default 400K). JEV adds a better "when": start earlier at a clean break once the context passes a lower line, and hold off while the leader is mid-way through a multi-step edit. It decides when to compact, never which messages to drop: per-item keep/drop is what independent replays measured as no better than a coin flip.

This does nothing while `agents.leaderCompaction.enabled` is false, which is its default and the live daemon's setting on 2026-09-28.

### Seam

- The monitor and planner stay synchronous. A new async advisor, `packages/server/src/server/agent/leader-compaction-timing.ts`, asks JEV after each leader turn and keeps one verdict per agent in memory.
- It is fed by `onAgentTurnFinished` (fired at `agent-manager.ts:6607-6614` for non-internal, non-quiet turns). `bootstrap.ts:1968` becomes a fan-out to the title tracker and the advisor.
- It asks only when the agent is a compaction candidate (`isLeaderCompactionCandidate`, `leader-compaction-planner.ts:100-107`) and `contextWindowUsedTokens` ≥ `considerAtTokens`. It does not know the monitor's state, so the monitor's own prepare, compact and restore turns cost up to three calls per episode; the planner reads verdicts only in `armed`. It reads the state from `agentManager.fetchTimeline(id, { direction: "tail", limit: 400 })` (`agent-manager.ts:2356-2359`).
- `planLeaderCompactionStep` (`leader-compaction-planner.ts:165-220`) takes an optional `timing` input. In `armed` it starts an episode when `isOverThreshold` (`:117-122`) is true and the verdict is not `defer`, or when the verdict is `startEarly`.
- `AgentLeaderCompactionMonitor` (`agent-leader-compaction-monitor.ts`) gets the advisor through its options (built at `bootstrap.ts:2880-2892`) and passes `advisor.verdictFor(agent.id)` into the planner in `sweep` (`:251-286`). `formatPrepareMessage` (`:56-79`) says why the episode started: the line, or the boundary JEV saw.
- The cut point: when a `prepare` step completes and the plan moves to `waiting { step: "compact" }`, the monitor calls `advisor.requestCutPoint(agentId)`; `formatCompactCommand` (`:85-91`) takes an optional sentence and appends it when the answer is ready by the sweep that sends `/compact`.

### State and questions

State, built in code from the timeline since the last `compaction` row:

```json
{
  "current_request": "<latest user message, first 600 characters>",
  "previous_work": "<earlier user messages, newest 40, each clipped to 200 characters; daemon envelopes as 'system: …' clipped to 120; plus the last restore note, clipped to 400>",
  "recent_turn": "<last assistant text, first 600 characters, or '(tool calls only: …)'>",
  "tools_this_turn": ["<tool names>"]
}
```

The four questions, verbatim from `level07/should-compact.ts`:

```json
{
  "switched_gears": {
    "type": "noul",
    "instructions": "Is `current_request` a different task from `previous_work`?",
    "criteria": {
      "true": "A new feature, a different file area, a different goal, or an unrelated question",
      "false": "The same task continuing, a follow up, a fix to what was just done"
    }
  },
  "at_boundary": {
    "type": "noul",
    "instructions": "Did `recent_turn` finish a unit of work?",
    "criteria": {
      "true": "Tests passed, a commit was made, a summary was given, or a question was asked of the user",
      "false": "Mid task, more steps clearly remain"
    }
  },
  "needs_history": {
    "type": "score",
    "instructions": "How much of `previous_work` does the next step need?",
    "criteria": [
      "None; the new work stands alone",
      "Some references, a file name or a decision",
      "Most of it; the work continues directly from it"
    ]
  },
  "mid_operation": {
    "type": "noul",
    "instructions": "Is the agent in the middle of a multi step edit whose partial state only exists in the conversation?",
    "criteria": {
      "true": "Half applied changes, a plan being executed step by step, an unfinished refactor",
      "false": "A clean point, nothing half done"
    }
  }
}
```

The cut point, from `level07/pick-cut-point.ts`, over the user turns since the last compaction (newest 60, each clipped to 120 characters, keyed by index):

```json
{
  "live_from": {
    "type": "choice",
    "instructions": "Which turn in `turns` starts the work that is still live? Earlier turns can be summarized briefly.",
    "criteria": {
      "0": "<first request>",
      "1": "<second request>",
      "none": "Every turn is still live; keep the most recent context only"
    }
  }
}
```

### Thresholds

From the reference's `decideTier`, in code:

- `mid = mid_operation > 0.6`
- `switched = switched_gears > 0.7`
- `boundary = at_boundary > 0.6 and needs_history.score < 1`

| Context                                            | Verdict                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Under `considerAtTokens` (200K)                    | No call                                                                                                                      |
| From `considerAtTokens` to under `prepareAtTokens` | `startEarly` when `(switched or boundary) and not mid`; otherwise none                                                       |
| At or over `prepareAtTokens`                       | `defer` when `mid`, at most `maxDeferrals` (3) consecutive turns and never at or over `ceilingTokens` (500K); otherwise none |

A verdict is replaced by the next turn's and ignored once the agent has started another turn. The cut point is used at confidence ≥ 0.6 and not `none`: `/compact` gains "The live work starts at "<request>". Summarize everything before it in a few lines; keep the decisions, file paths and open questions from there on in full."

### Fail open

No verdict, or not `answered`: the monitor starts at `prepareAtTokens`, exactly as now. No cut point: `/compact` goes out with today's text. Hysteresis, the three-turn sequence and `startTurnIfIdle` are untouched, so the advisor can never interrupt a turn.

### Cost, cache, latency

- One call per leader turn above 200K tokens, about 1,000–2,500 input tokens, about $0.0001. A leader taking 300 such turns a day costs about $0.03. Plus one cut-point call per compaction.
- The JEV call touches no context. The effect on the cache is the point of the feature: compaction rebuilds the cache whenever it happens, and starting it at a boundary rebuilds a smaller one; a deferral postpones a rebuild by at most three turns and 100K tokens.
- Nothing on the agent's path: the advisor runs after the turn, and its verdict is read at the next 60-second sweep.

### Tests and verification

- `leader-compaction-timing.test.ts`: no call under the line, for a non-candidate, or while an episode is open; state built from a fixture timeline, with envelopes marked; each verdict from scripted answers; the deferral count and ceiling; the cut-point floor.
- `leader-compaction-planner.test.ts`: `startEarly` starts under the line; `defer` holds at the line and not at the ceiling; no `timing` gives today's plan.
- Verify: `npx vitest run packages/server/src/server/agent/leader-compaction-timing.test.ts --bail=1`.

## Feature 10: stall judgment

The stalled-agent sweep ([stalled-agents.md](stalled-agents.md)) stays the only stall system. JEV adds one judgment about what the agent's recent activity shows: progressing, looping, blocked on missing information, or waiting on a person. It changes the nudge's wording, whether a remediation agent is worth sending, and allows one extra wait. It also watches running agents for loops the time-based rule cannot see.

### Seam

- `StallSweepDependencies` (`agent-stall-sweep.ts:60-70`) gains `readRecentActivity(agentId, limit)` and an optional `judgeStall(input)`. Both are wired in `createAgentStallSweep` (`bootstrap.ts:1023-1071`); `readRecentActivity` wraps `agentManager.fetchTimeline(id, { direction: "tail", limit })`.
- In `handleCandidate` (`:320-348`), on the live branch before `act` (`:341-344`), ask once per episode; the episode records the judgment.
- `act` builds the nudge prompt at `:436-443`; `buildStallNudgePrompt` (`:606-618`) takes an optional judgment line.
- `buildStallObservation` (`:624-677`) omits `escalation` when the judgment is `blocked_missing_info` or `waiting_on_human`, so the ladder goes to a person instead of an agent.
- The loop watch runs in `sweep` (`:192-247`) over running agents that are not stall candidates.
- New code lives in `packages/server/src/server/agent/stall-judgment.ts`: questions, the state builder, the pure decision function and the loop prefilter.

### State and question

```json
{
  "title": "<agent title>",
  "assignment": "<initial prompt, first 800 characters>",
  "quiet_minutes": 34,
  "recent": [
    "tool Bash `npm test -- auth` -> failed: <first 160 characters of the error>",
    "assistant: <first 160 characters>"
  ]
}
```

`recent` is the last 25 timeline rows, oldest first: tool calls as name, input summary and status; assistant and reasoning text clipped; errors clipped. JEV decision rows are excluded.

```json
{
  "activity": {
    "type": "choice",
    "instructions": "`recent` is the tail of an agent's activity, oldest first, and `quiet_minutes` is how long it has shown nothing new. Which describes the agent now?",
    "criteria": {
      "progressing": "Each step builds on the last and the latest step is plausibly still running: a long build, a test run, a download, a wait on another agent or on CI",
      "looping": "It repeats the same command, edit or failing check with no new information between tries",
      "blocked_missing_info": "It says or shows it cannot continue without a file, credential, decision or fact it does not have",
      "waiting_on_human": "It is waiting for a person: its last message asks a question or for approval, or its last command is waiting for interactive input",
      "other": "None of these"
    }
  }
}
```

### Thresholds, for a stall candidate

| Answer                           | Action                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `progressing` at ≥ 0.80          | Hold once for another `stallMinutes`; then act as today even if JEV says the same                                                                                        |
| `looping` at ≥ 0.75              | Nudge as today; the prompt adds "You appear to be repeating: <the repeated step>. Try a different approach, or say what blocks you."                                     |
| `blocked_missing_info` at ≥ 0.75 | Nudge as today; the prompt asks it to name what it is missing; the observation has no `escalation`, so after the recheck grace the ladder goes to a person, not an agent |
| `waiting_on_human` at ≥ 0.75     | Nudge as today (the interrupt frees a command stuck on input); the prompt says to end the turn with the question instead of waiting inside it; no `escalation`, as above |
| Anything else                    | Today's behaviour                                                                                                                                                        |

### The loop watch

For a running agent that is not a stall candidate, a prefilter in code: in its last 12 tool calls, one tool with the same input (first 200 characters of its JSON) appears 4 or more times, or one error text appears 3 or more times. Only then ask the same question. `looping` at ≥ 0.80 on two consecutive sweeps reports `looping-agent:<agentId>` to the ladder: kind `looping-agent` (new in `RemediationConditionKind`, `remediation/contract.ts:14-24`), remedy `none`, no escalation, level `notice`, grace 0. The ladder records it and a person gets it in the digest. The episode closes when the prefilter stops matching. Nothing interrupts a running agent on the loop watch's say-so.

Polling loops (CI watchers, `paseo wait`) repeat by design; the `progressing` option names them, and the two-sweep rule and `notice` level keep a wrong call cheap.

### Fail open

Not `answered`: today's nudge, today's observation. The sweep is serialized, so each judgment is bounded by its 5-second deadline, and at most `maxNudgesPerSweep` candidates plus 8 loop-watch agents are judged per sweep.

### Cost, cache, latency

Under 2,500 input tokens per judgment. No cache effect beyond the existing nudge, which appends at the tail. Nothing on an agent's path.

### Tests and verification

- `stall-judgment.test.ts`: the state builder on fixture timelines, excluding JEV rows; the loop prefilter's positive and negative cases, including a polling loop; the decision function for every row, including the hold-only-once rule.
- `agent-stall-sweep.test.ts`: a scripted `progressing` holds one sweep then nudges; `blocked_missing_info` sends an observation without `escalation`; the loop watch reports only after two sweeps; with `judgeStall` absent or failing, every existing test passes unchanged.
- Verify: `npx vitest run packages/server/src/server/agent/stall-judgment.test.ts --bail=1`.

## Feature 11: UI

### Spend on the budget strip

JEV appears as one more account row in the budget strip's "other" section, the same way the OpenAI API's spend does ([orchestration-panel.md](orchestration-panel.md#budget-strip)). No new wire field and no new app data source.

- New `packages/server/src/services/quota-fetcher/providers/jev.ts` implements `ProviderUsageFetcher` from `JevService.status()`: `providerId: "jev"`, `displayName: "JEV"`, `status: "available"`, no windows, and two balances in `ProviderUsageBalanceSchema`'s shape (`messages.ts:6836-6845`): `{ id: "spent-today", label: "Spent today", used: <usd>, limit: <maxUsdPerDay>, unit: "usd", resetsAt: <next UTC midnight> }` and `{ id: "calls-today", label: "Calls today", used: <calls>, unit: "requests" }`. Register it in `PROVIDER_USAGE_FETCHERS` (`services/quota-fetcher/manifest.ts:17-68`) and pass the service in where `ProviderUsageService` is built (`websocket-server.ts:779-790`).
- When JEV is unavailable for a reason other than the spend cap, the fetcher reports `status: "unavailable"` with no balances, so the row is absent (`resolveOtherAccountIds`, `account-budget-strip-model.ts:164-183`). At the spend cap it reports the balances with `tone: "warning"` on the spend.
- App: `PROVIDER_VENDORS` (`account-budget-strip-model.ts:247`) gains `jev: "TypeSafe"`, so the row reads "TypeSafe (JEV)".
- The row inherits the strip's 75-second poll and the service's 5-minute cache, and carries its read time like every row.

### Decisions in the agent's timeline

A new timeline item, `jev_decision`, carrying `JevDecisionNote` plus the cost:

```ts
z.object({
  type: z.literal("jev_decision"),
  id: z.string(),
  callId: z.string(),
  feature: z.string(),
  question: z.string(),
  verdict: z.string(),
  confidence: z.number().nullable(),
  action: z.string(),
  applied: z.boolean(),
  costUsd: z.number().nullable().optional(),
});
```

- **Protocol.** Added to `AgentTimelineItemPayloadSchema` (`packages/protocol/src/messages.ts:1283-1335`) and the `AgentTimelineItem` union (`agent-types.ts:447-460`). New client capability `CLIENT_CAPS.jevDecisionItems` (`client-capabilities.ts`, with the hello schema entry beside `messages.ts:8048`) and `server_info.features.jevDecisionItems`, each with a `COMPAT(jevDecisionItems)` tag.
- **Old clients.** In `Session.supportsTimelineItem` (`session.ts:1318-1327`), a client without the capability gets the row as a `notification` item (`level: "info"`, message `JEV: <question> <verdict>; <action>`) instead of dropping it, and the existing `timelineNotifications` gate then applies to that. The conversion is the COMPAT shim.
- **Which decisions get a row.** 2 (on the new agent, on `agent.created`, through its `paseo.jev-call` label), 3a when the observation links an agent, 3b, 9 when the verdict changed the plan or a cut point was used, 10. Tool calls (4–6) are already `tool_call` rows and get none.
- **Appending.** `JevService.decisions` is ledger-only in the foundation; the ui track replaces it with a sink that appends rows through a new `AgentManager.appendDaemonNoteItem`.
  - That method records the row without `touchUpdatedAt`. `appendTimelineItem` (`agent-manager.ts:3795-3818`) calls it at `:3801`.
  - `lastActivityAtOf` (`:1892-1902`) ignores `jev_decision` rows, so a JEV row never resets the stall sweep's clock.
  - `getLastAssistantMessage` already skips non-assistant rows at the tail (`:4910-4936`), so a finish report or a `REMEDIATION:` line is still found.
  - No prompt is built from these rows.
- **Rendering.** `agent-stream/view.tsx:864-902` gets a `jev_decision` case beside `plugin`; `types/stream.ts` maps it (next to the `plugin` cases at `:1579` and `:1737`). One compact row: the feature, the question, the verdict with its confidence, what code did, the cost, and "shadow" when `applied` is false.
- **Durability.** Like plugin rows, these live in daemon memory and do not survive a restart. The ledger's daily totals and the audit file do.

### Tests and verification

- The fetcher: balances from a status; absent when off; warning at the cap.
- `session.ts`: a capable client gets `jev_decision`; an old one gets the `notification` form.
- `agent-manager.ts`: a JEV row does not move `lastActivityAt` and does not hide the last assistant message.
- App: `account-budget-strip.browser.test.tsx` with a `jev` row in the fixture, and a stream view test for the new row.
- Verify: `npx vitest run packages/server/src/services/quota-fetcher/providers/jev.test.ts --bail=1`.

## Testing

- Every track tests against the fake. No test makes a live call or reads a real key; a test that finds `OPENROUTER_API_KEY` set must still use the fake.
- Each feature's decision is a pure function from answers to action, tested per threshold row. The async wrapper is tested for every non-`answered` outcome giving today's behaviour.
- Live verification waits for Tyler's key. Then: switch every feature to `shadow` for a day, read the audit and the ledger, compare each feature's "would have" against what happened, and move floors only on that evidence. TypeSafe publishes no calibration figures, independent measurements put its expected calibration error between 0.13 and 0.25, and it is weakest on "does anything apply" questions, so the floors above are starting points.

## Reference implementation

disler/ten-levels-of-jev (MIT, cloned at `~/.cache/jev-repos/ten-levels-of-jev`). The client, wire types, mock and question builders are adapted from `apps/ten-levels/src/core/`; the questions for features 4–6 and 9 come from `levels/level03`, `level07`, `level08`, `level09` and `level10`. It is a teaching repo with no production users and every figure in it comes from demo runs; its architecture (extensions for the Pi agent) is not this one.
