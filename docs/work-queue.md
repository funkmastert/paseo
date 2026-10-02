# Work queue

The work queue gives a piece of work an owner, a state and a required closure, so work handed between agents cannot vanish. The fleet stream next to it is an append-only log of things that happened. Both live in daemon core under `packages/server/src/server/coordination/`; wire shapes are in `packages/protocol/src/coordination/`.

Every surface goes through `WorkQueueService` (`coordination/queue/service.ts`): the agent tools, the session RPCs, the `paseo queue` CLI, delivery to the owner and the closure marker in an agent's final message. The daemon holds it in a `CoordinationRuntime` (`coordination/runtime.ts`).

## States

| State         | Open | Meaning                                                |
| ------------- | ---- | ------------------------------------------------------ |
| `pending`     | yes  | Created, nobody has claimed it                         |
| `in-progress` | yes  | Claimed; `owner` is working on it                      |
| `blocked`     | yes  | Waiting on something named in its closure              |
| `done`        | no   | Finished; the closure says what happens next           |
| `failed`      | no   | Could not be done                                      |
| `denied`      | no   | The owner refused it                                   |
| `canceled`    | no   | No longer wanted                                       |
| `handed-off`  | no   | Closed by a handoff; `handedOffTo` names the successor |

Open states move freely between each other and into any terminal state. Terminal states never move. Reopening would hide that the work was once declared finished, so follow-on work is a new item. The table is `LEGAL_TRANSITIONS` in `coordination/queue/state-machine.ts`.

An owner is an agent id or `human`. Claiming an item makes the claimant its owner. Claiming an item someone else has in progress is refused with a pointer to handoff, which anyone can call.

## Closure contract

Finishing as `done` requires a closure reason that says where the work went:

| Reason          | Target required | Use when                            |
| --------------- | --------------- | ----------------------------------- |
| `handed_off_to` | yes             | The follow-on went to another owner |
| `blocked_on`    | yes             | Something else must happen first    |
| `escalation`    | yes             | It went up to a parent or `human`   |
| `denied`        | no              | The work was refused                |
| `canceled`      | no              | The work stopped being wanted       |
| `no-follow-on`  | no              | Nothing follows                     |

`blocked` also requires a closure, and it must be `blocked_on` with a target. `denied` and `canceled` fill in their own reason when none is given. `handed-off` is reachable only through handoff. A closure on a move into `pending` or `in-progress` is refused.

This is input validation of the queue API, not a gate on anything an agent can already do. The errors are written for the caller, often an agent, to act on: each one names what to send instead.

## Surfaces

| Surface     | Where                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent tools | `queue_create`, `queue_claim`, `queue_update`, `queue_handoff`, `queue_list`, `queue_show` in `agent/tools/coordination-tools.ts`                              |
| RPCs        | `coordination.queue.{create,claim,transition,update,handoff,list,show}`, `coordination.stream.list`, and `coordination.inbox.act` (below), in `packages/protocol/src/coordination/rpc-schemas.ts` |
| CLI         | `paseo queue ls\|show\|create\|claim\|done\|block\|handoff`, with `--json`                                                                                     |
| App         | The Inbox (below), `packages/app/src/inbox/` plus a sidebar entry                                                                                              |

The calling agent is the actor for a tool. An RPC names its actor, and the daemon uses `human` when it does not. The CLI sends `--as`, else `$PASEO_AGENT_ID` (the daemon sets it in every agent's shell), else `human`.

Tool output and CLI reads are compact by default: id, title, owner, state, closure, delivery. Pass `full: true` or `--full` for whole items and every transition. Every write answers with what happened, the item's state now and the next action, so the caller never needs a second read to know what to do.

RPC errors come back in the payload as `error` and `errorCode` (`disabled`, `not_found`, `conflict`, `invalid`, `internal`), never as `rpc_error`. The CLI turns them into `QUEUE_<CODE>` errors and exits 1, the same as any failed command. It does not pre-flight a health check: OpenRig's queue CLI reported healthy daemons as down because its health deadline was shorter than the request's. The request goes out and reports its own failure.

## Delivery

Creating an item for an agent, or handing one off to an agent, sends the owner one prompt through `sendPromptToAgent`. The prompt joins a running turn rather than replacing it, the same as a finish report. It names the item and teaches the closure in two lines. The result lands on the item's `delivery`: `delivered`, or `failed` with the reason. An archived or unknown agent fails delivery instead of being woken. An item for `human` sends nothing and stays `not_attempted`; the Inbox shows it.

Delivery listens to the service's item-changed event, which fires only when a call changed something, so an idempotent repeat create never delivers twice. If a daemon dies between the create and the delivery, the next one delivers every `pending` agent item still `not_attempted` when it opens. A `failed` delivery is not retried; the item says so and waits for someone to hand it on.

## Closure marker

An agent can close the items it owns from its final message, one line per item:

```
queue: <itemId> <state> [<reason>[=<target>]]
queue: wi_123 done no-follow-on
queue: wi_123 blocked blocked_on=wi_456
```

`state` is `done`, `blocked`, `failed`, `denied` or `canceled`; the reason and target follow the closure contract above. When an agent leaves `running` and owns open items, the daemon reads its final message and applies each marker as a transition by that agent. A message with no marker changes nothing, and the item stays where it was for the stuck sweep to find.

Parsing is strict. A line that starts with `queue:` and does not fit the grammar is logged and ignored, and so are two markers for one item. A marker for an item the agent does not own, or one the closure contract rejects (a `done` with no reason), is logged and changes nothing. The parser is `coordination/queue/closure-marker.ts`.

## Storage

```
$PASEO_HOME/coordination/
├── queue/
│   ├── items/{id}.json      # one document per item, written atomically
│   ├── journal.jsonl        # transition journal and commit log
│   └── archive/{yyyy-mm}.jsonl
├── stream/
│   └── entries.jsonl
└── audit.jsonl              # every Inbox act (below), win or lose
```

Every store method is one transaction (the rule in [data-model.md](./data-model.md#store-surface-rules)). A commit appends a `begin` line holding the after-image of each item it touches and the transition rows it adds, writes each item document, then appends `commit`. Opening the store redoes any `begin` that has no `commit`. A store instance that sees its own commit fail reloads from disk before its next call, so the same redo applies without a restart. This is the workspace-labels journaled commit ([architecture.md](./architecture.md)) applied to every method.

Create is idempotent on a caller-minted id: a repeat with the same title, body, owner and tags returns the existing item, whatever its state now; a repeat with different content is a conflict. Ids must be safe file names on macOS and Windows.

Handoff closes the source as `handed-off` and creates the successor in one commit. The successor's id is derived from the source id (`deriveSuccessorId`), so a redo or a retried handoff can never mint a second successor. A daemon killed between writing the successor and closing the source finishes the commit on the next open, leaving exactly one open successor. Retrying a handoff to the same owner returns the existing pair.

`revision` increases on every write. Pass `expectedRevision` to `transition` or `update` to fail instead of overwriting a change you have not seen.

A crash mid-append can leave a partial last journal line. It never had a commit, so the reader truncates it. A bad line anywhere else is corruption and stops the open.

## Retention

The journal grows with every write, so `WorkQueueService.runRetention` compacts it. Closed items whose close is older than `closedItemDays` (default 30) move to `archive/{yyyy-mm}.jsonl` with all their transition rows, then the journal is rewritten with only the rows of items still present. Open items are never candidates, whatever their age. The archive is kept; retention moves history, it does not delete it.

Compaction appends to the archive, deletes the archived documents, then rewrites the journal. A crash after the archive append archives the same item twice on the next run; readers of the archive take the last line per item id.

## Stream

The stream (OR-A2) is the fleet event log: entries with a dotted `type`, `urgency`, `tags`, `source`, an optional `subject` and free-form `data`. The queue service appends a `queue.transition` entry for every transition, `high` urgency for `blocked`, `failed` and escalations. Append is idempotent on the entry id.

Archive is soft: an `archive` marker line hides the entry from default reads. Reads are newest first with an opaque cursor. The stream is bounded by `streamMaxEntries` and `streamMaxAgeDays`: compaction drops the oldest entries, and an append compacts on its own once the file holds twice the entry cap. The stream is a feed; the queue journal and its archive are the record.

The stream and item-changed listeners run after the queue commit. A failure in either is logged and never fails or undoes the queue write.

## Inbox

The Inbox (OR-A5, OR-H1's For-You feed adapted) is the app surface for a human's open work: `packages/app/src/inbox/`, a sidebar entry with an open-requests count badge, gated once on `server_info.features.coordinationQueue`. Two sections, both read-only reuses of the surfaces above:

- **Human requests**: open items (`pending`, `in-progress`, `blocked`) owned by `human`, oldest first (`coordination.queue.list`, `filter: { owner: "human", openOnly: true }`). `selectHumanRequests` in `inbox/model.ts`.
- **Updates**: the fleet stream, newest first (`coordination.stream.list`), unfiltered — an entry kind the app does not recognize still renders with its `summary`. Nothing is silently dropped. `selectUpdates` in `inbox/model.ts`.

Tapping a human request opens its detail with every transition. Six verbs act on it, each one RPC, `coordination.inbox.act.{request,response}`:

| Verb       | Queue call                                                | Effect                                           |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `approve`  | `transition` to `done`, closure `no-follow-on`             | Done, nothing follows                             |
| `deny`     | `transition` to `denied`                                   | Refused                                           |
| `hold`     | `transition` to `blocked`, closure `blocked_on` → `human`   | Waiting on the human                              |
| `drop`     | `transition` to `canceled`                                 | No longer wanted                                  |
| `route`    | `handoff` to an agent id (`to`), chosen from the host's agents | Hands the item to that agent                   |
| `annotate` | `update` (no field changes) plus a `coordination.inbox.annotate` stream entry carrying the note | A note, not a state change |

Every verb acts as `human` — the Inbox is the only caller. Five of the six inherit the queue's closure contract and the state machine's teaching errors for free by calling `transition` or `handoff` directly; `annotate` does not transition, so `applyInboxAct` (`coordination/inbox/act.ts`) checks the item is still open before doing anything, the same refusal every other verb already gets from the state machine. Every call, win or lose, appends one line to `$PASEO_HOME/coordination/audit.jsonl` (append-only, via the generic `jsonl-appender.ts`): actor, verb, item id, note, target, and whether it applied or was refused and why.

An item that lands on `human` — by create or by a `route`/handoff — pushes once, `alert` level, deep-linking to the item (`WorkQueueInboxPush`, `coordination/inbox/push.ts`). It rides the same item-changed listener as delivery, which fires only when a call changed something, so an idempotent repeat create never pushes twice.

## Configuration

```json
{
  "agents": {
    "coordination": {
      "enabled": false,
      "retention": { "closedItemDays": 30, "streamMaxEntries": 5000, "streamMaxAgeDays": 30 }
    }
  }
}
```

Read once at boot. Off unless `enabled` is true. Off means no `queue_*` tools, no `server_info.features.coordinationQueue`, and every `coordination.*` request answered with `errorCode: "disabled"`.

The daemon opens coordination after its monitors start, then runs retention at once and every six hours. A store that fails to open (a corrupt journal, an unreadable directory) is logged as `COORDINATION DISABLED` and the daemon runs on without it: the flag drops and every request is answered as disabled. It never fails or delays boot.

## Relation to finish reports

The queue does not replace [finish reports](./finish-reports.md). A finish obligation lives on the child's agent record and tracks one delegated turn until its report reaches the owner; it stays the wake path. A work item tracks owned work across turns, agents and handoffs. A finish moves an item only through a [closure marker](#closure-marker).
