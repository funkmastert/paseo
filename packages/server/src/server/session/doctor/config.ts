import { finding, type DoctorCheck } from "./context.js";

/**
 * `agents.*` and most other sections are `.strict()`: a key the running build does not know fails
 * the whole config load, and the daemon does not come back up. New keys go in `config.json` only
 * after the daemon that reads them is running (docs/done-janitor.md).
 */
export const configCheck: DoctorCheck = {
  id: "config.keys",
  category: "config",
  timeoutMs: 5_000,
  async run(ctx) {
    if (ctx.rawConfigError) {
      return [
        finding("config.keys", "config", "fail", "config.json cannot be read", {
          detail: ctx.rawConfigError,
          why: "The daemon refuses to start with a config it cannot parse.",
          fix: "Fix or restore config.json (backups sit next to it as config.json.bak-*).",
        }),
      ];
    }
    if (!ctx.rawConfig) {
      return [
        finding("config.keys", "config", "ok", "No config.json; the daemon runs on defaults"),
      ];
    }
    const owner = ctx.facts.configSchemaOwner;
    const issues = ctx.facts.validateConfig(ctx.rawConfig);
    const out = [];
    if (issues.length === 0) {
      out.push(finding("config.keys", "config", "ok", `config.json is accepted by ${owner}`));
    } else {
      const unknown = issues.filter((issue) => issue.unknownKey !== undefined);
      const other = issues.filter((issue) => issue.unknownKey === undefined);
      out.push(
        finding(
          "config.keys",
          "config",
          "fail",
          `config.json has ${issues.length} problem(s) ${owner} rejects`,
          {
            detail: [
              ...unknown.map(
                (issue) =>
                  `unknown key ${[issue.path, issue.unknownKey].filter(Boolean).join(".")}`,
              ),
              ...other.map((issue) => `${issue.path || "(root)"}: ${issue.message}`),
            ].join("\n"),
            why: "The next daemon start (or `paseo daemon reload`) refuses this file, and a restart then leaves no daemon running.",
            fix: `Remove or correct the key(s) above in ${ctx.paseoHome}/config.json. A key from a newer build belongs there only once the daemon has that build.`,
          },
        ),
      );
    }
    if (ctx.facts.source === "cli") {
      out.push(
        finding(
          "config.keys.scope",
          "config",
          "warn",
          "Config keys were checked against this CLI's schema, not the daemon's",
          {
            detail:
              "The running daemon predates `daemon.doctor.request`, so it could not check its own schema. A key this CLI knows and the daemon does not is not caught.",
            why: "That is the case that breaks a daemon: a key written for a newer build than the one running.",
            fix: "Update the daemon (relaunch Bozeo on the new build), then re-run `paseo doctor`.",
          },
        ),
      );
    }
    return out;
  },
};
