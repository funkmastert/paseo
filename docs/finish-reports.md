# Finish reports

A delegated agent owes the agent that asked for it a report when it finishes, errors, is
cancelled or is closed. The obligation is derived, not declared: `create_agent` with
`notifyOnFinish` (the default for agent-scoped creation) arms it, and so does `send_agent_prompt`
in the background. The child never has to cooperate.

The report used to exist only as an in-memory subscription (`setupFinishNotification`), which a
daemon restart dropped. Shutdown closes every agent and nothing restarts a child that was mid-turn,
so the child sat closed, its parent was never told, and the [done janitor](done-janitor.md)
archived it three days later. `FinishObligationService`
(`packages/server/src/server/agent/finish-obligation-service.ts`) makes the report durable. The
rules it applies are pure functions in `finish-obligation.ts`.

## Where it lives

On the child's own record, `finishObligations` in `$PASEO_HOME/agents/.../{agentId}.json`: one
entry per owner. See [data-model.md](data-model.md#1-agent-record). There is no separate store and
no log to replay: the ladder's position (attempts, rung, next attempt) is the record itself, so a
restarted daemon continues exactly where the last one stopped.

`AgentStorage.updateFinishObligations` is the only write that changes the field. Every other write
carries the stored value forward, because callers build records by spreading one they read earlier
and their copy can be stale by the time the per-agent write queue runs it. A list a daemon cannot
parse is dropped rather than failing the record, so a downgrade hides no agents.

The in-memory watcher stays the fast path. It notices the outcome, and the service records it on
the record before trying delivery. Each arm bumps a `generation`; a watcher from an older arm stands
down, so a re-prompt never produces two reports.

## Shutdown and restart

The service is told before `closeAllAgents` runs. A watcher that then sees its child close leaves
the report owed instead of reporting "was closed", which is what it reported before and which was
wrong: the child did not end, the daemon did.

On start the service rebuilds its index from every record, before anything can arm or load an
agent. A child still owing a report is not loaded, so nothing watches it. The sweep finds it
stopped and **parks** it; after `parkedGraceMs` (2 minutes) the sweep reports for it:
"stopped before reporting", with instructions to read its activity and resume it with
`send_agent_prompt` rather than start another agent. Each such report can start a turn in its
owner, and a restart produces them all in one sweep, so they go through the daemon's shared resume
pace ([resource-monitor.md](resource-monitor.md#child-admission-and-resume-pacing)) and the sweep
waits for them. Reports of an outcome seen live are not paced. The grace period gives a parent that resumes
its child on its own a chance to do so first. A child seen running again is unparked and gets a
watcher. A child whose turn was waiting for an admission slot when the daemon stopped is never
parked: its held prompt is re-sent after the restart, so it counts as working until then, and
telling the parent to resume it would send it the work twice.

A parked child that is loaded and idle, and did run in this process, is reported as finished, and
one in `error` as errored: its watcher missed the edge, but the outcome is plain. Loaded and idle
without having run in this process means it was loaded after a restart, which is not a finish.

The child's last answer is captured into the obligation when the outcome is recorded. After a
restart the child is not loaded, and a report built then would otherwise arrive without it.

## The ladder

Bounded, and every step is logged.

1. **Owner.** Delivered at once when the outcome is recorded. On failure it is retried every
   `retryIntervalMs` (5 minutes), `maxOwnerAttempts` (3) times in all.
2. **Orchestrator.** The nearest non-archived agent above the owner, found by walking parent
   labels. It gets the report prefixed with who it was for and why that failed. One attempt, and
   the rung has one retry interval to find it reachable.
3. **Operator.** One `urgent` push ([notification-policy.md](notification-policy.md)) (`data.reason: "finish_report_undelivered"`, outside the closed
   `attentionReason` enum), and the child is flagged for attention without a second, generic push.
   Terminal whether or not the push itself went out.

An owner that is archived releases the report: whoever archived it ended that tree, and the child
keeps its result on its own record. A `create_agent` report is also released when the child is
detached from that parent.

Delivery failure means `sendPromptToAgent` threw: the owner could not be loaded, its session is
gone. A turn the provider refuses after it started (a capped account) fails asynchronously and is
not seen here. Account failover already handles that case: its resume prompt tells the owner to
answer the message that failed.

### Gating on lifecycle

Reports are sent with `activeTurnBehavior: "steer"`, which steers only when a turn is active. On an
idle agent it starts a turn. For a report that is the intent, since the owner has to act on it,
but it is decided explicitly by `gateDelivery` before every send:

| Target                    | Gate          | Result                                      |
| ------------------------- | ------------- | ------------------------------------------- |
| running                   | `steer`       | joins the active turn                       |
| idle, closed, not loaded  | `wake`        | starts a turn, loading the agent first      |
| initializing              | `wait`        | next sweep, within the rung's time budget   |
| `error` on an account cap | `wait`        | account failover is about to move it        |
| other `error`             | `wake`        | a new turn is how an errored agent recovers |
| archived or gone          | `unreachable` | owner: released; orchestrator: next rung    |

A `wait` never waits forever: once the rung's budget runs out (3 intervals at the owner, 1 at the
orchestrator) the report moves up.

## Successors

Two ways work moves to another agent id, and the report follows both.

- **Owner side.** Account failover retires an agent it imports by labelling it
  `paseo.account-failover.migrated-to=<newId>` without archiving it. A report sent there would wake
  a conversation on the capped account that nobody reads, so delivery follows `migrated-to` to the
  live end.
- **Child side.** A successor inherits the obligation when the work it carries on has not been
  reported as finished. That includes work already reported as "errored" or "stopped": the
  successor is the one that will finish, and the owner is owed that. The successor is recognised by
  its `handoff-from` label on first sight, and by the sweep through the same lookup account failover
  uses (`findExistingSuccessor`), which also catches a `paseo import` onto the same session without
  the label. The predecessor's entry records `transferredTo`, so this happens once. The report
  names both ids: "Agent B, which took over from A, finished."

  An inherited obligation keeps `requireParentOwnership` only if the successor has the same parent
  label. A successor made by hand usually has none, which is how `b0758585` finished a task whose
  parent never heard.

An **in-place move** keeps the id, so nothing is inherited, but the owner was already told
"errored" when the cap hit. `AccountFailoverMonitor` calls `carryOver` after the resume prompt,
which re-arms the report so the owner hears again when the work finishes. The "errored" report says
this is coming when the error is a cap and failover is enabled, so the owner does not relaunch the
work in the meantime.

## What the panel shows

`owedFinishReport` on the agent snapshot (`packages/protocol/src/agent-types.ts`), present only for
the two states worth an orchestrator's eye:

- `parked`: stopped while still owing its report.
- `undelivered`: the report is owed but delivery has failed at least once, or it is past the owner
  rung.

A child that is simply working carries nothing. `state` is an open string so a later state parses
on old apps; the app reads anything but `parked` as undelivered. The orchestration panel pins such a
row whatever its age and badges it "Owes report" or "Report undelivered"
([orchestration-panel.md](orchestration-panel.md#what-the-default-view-shows)). The field is live on
loaded agents (mirrored by the service) and projected from the record for closed ones.

## Testing

`finish-reports.e2e.test.ts` stops a real daemon with a child mid-turn, starts a fresh one on the
same `PASEO_HOME`, and drives the sweep with an injected clock. It covers the parked report after
a restart, a retry count that survives a restart before escalating to the orchestrator, the
operator push, and a hand-made successor. `finish-obligation.test.ts` covers the rules.
