/**
 * Recognizes the one shell command shape that is known to clone simulators into
 * `~/Library/Developer/XCTestDevices`: an `xcodebuild` test action against an iOS Simulator
 * destination. The janitor registers a cleanup obligation when it sees one, so a run that is
 * killed has an owner for whatever it left behind (docs/artifact-janitor.md).
 *
 * Same discipline as device-launch-commands.ts, which this shares a tokenizer with: whole argv
 * tokens, the program actually being run, no substring matching. The cost of being wrong is
 * asymmetric in the opposite direction to the device gate, though. A false positive here only
 * registers an obligation, and an obligation on its own deletes nothing — the janitor still has
 * to prove the directory is unbooted, unreferenced and unclaimed. A false negative means the
 * residue has no owner and waits for the much slower unowned sweep. So this errs towards
 * matching.
 */

import { stripCommandPrefixes, tokenizeCommandSegments } from "./device-launch-commands.js";
import type { TestArtifactSetId } from "./test-artifact-sets.js";

export interface TestRunIntent {
  /** Which artifact set this run may leave residue in. */
  setId: TestArtifactSetId;
  /** The tool that would produce it, for the obligation record and the log. */
  command: string;
}

function basename(token: string): string {
  return token.split("/").pop() ?? token;
}

/**
 * The actions that run tests and therefore clone. `build-for-testing` compiles and never boots
 * anything, so it is absent; the `test-without-building` that follows it is what clones.
 */
const TEST_ACTIONS = new Set(["test", "test-without-building"]);

/**
 * Cloning is what parallel testing does — one clone per parallel worker, named
 * `Clone N of <device>` in CoreSimulator's log. `-parallel-testing-enabled NO` turns it off and
 * the run uses the destination device directly, leaving nothing behind. Every other value, and
 * the flag being absent (Xcode decides from the scheme), is treated as "may clone".
 */
function parallelTestingDisabled(tokens: readonly string[]): boolean {
  const index = tokens.indexOf("-parallel-testing-enabled");
  const value = index >= 0 ? tokens[index + 1] : undefined;
  return value !== undefined && /^(no|false|0)$/i.test(value);
}

/**
 * A destination this run could clone from. `platform=macOS`, a physical device
 * (`platform=iOS,id=…`) and `generic/platform=iOS` all clone nothing, so only the simulator
 * platforms count. watchOS/tvOS/visionOS simulators share CoreSimulator and the same device set,
 * so they are all in.
 */
const SIMULATOR_DESTINATION = /platform\s*=\s*(?:iOS|watchOS|tvOS|visionOS|xrOS)\s+Simulator/i;

function hasSimulatorDestination(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => {
    if (token !== "-destination") return false;
    const value = tokens[index + 1];
    return value !== undefined && SIMULATOR_DESTINATION.test(value);
  });
}

function matchXcodebuildTest(tokens: readonly string[]): TestRunIntent | undefined {
  if (basename(tokens[0] ?? "") !== "xcodebuild") return undefined;
  const action = tokens.slice(1).find((token) => TEST_ACTIONS.has(token));
  if (!action) return undefined;
  if (!hasSimulatorDestination(tokens)) return undefined;
  if (parallelTestingDisabled(tokens)) return undefined;
  return { setId: "xctest-devices", command: `xcodebuild ${action}` };
}

/**
 * Every artifact set a single shell command line could leave residue in. Deduplicated by set:
 * two `xcodebuild test` invocations chained with `&&` are one obligation, because the obligation
 * is over a directory, not over a process.
 */
export function detectTestRunIntents(command: string): TestRunIntent[] {
  const bySetId = new Map<TestArtifactSetId, TestRunIntent>();
  for (const segment of tokenizeCommandSegments(command)) {
    const tokens = stripCommandPrefixes(segment);
    if (tokens.length === 0) continue;
    const intent = matchXcodebuildTest(tokens);
    if (intent && !bySetId.has(intent.setId)) bySetId.set(intent.setId, intent);
  }
  return [...bySetId.values()];
}
