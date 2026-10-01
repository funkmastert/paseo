// One label per feature id, shared by the server's budget-strip fetcher
// (services/quota-fetcher/providers/jev.ts) and the app's decision popover
// (jev/jev-decisions-model.ts), so the two names never drift (docs/jev.md, "Feature 11: UI").
// `feature` travels the wire as a plain string (docs/protocol-compatibility.md), so this stays a
// loose record rather than keyed on a closed union: an id neither side names yet still renders.
export const JEV_FEATURE_LABELS: Readonly<Record<string, string>> = {
  spawnHint: "Spawn hint",
  remediationTriage: "Remediation triage",
  notificationTriage: "Finish triage",
  stallJudgment: "Stall judgment",
  compactionTiming: "Compaction timing",
  awayReply: "Away reply",
  agentTools: "Agent tools",
  askJev: "Ask JEV",
  // Feature 16, the file-read check: not a JevFeatureId yet (docs/jev.md, "Savings"), but the
  // savings ledger's JevSavingsFeature union names it, and the JEV dashboard needs its label.
  readCheck: "File-read check",
};
