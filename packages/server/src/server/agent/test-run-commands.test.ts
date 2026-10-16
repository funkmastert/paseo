import { describe, expect, test } from "vitest";
import { detectTestRunIntents } from "./test-run-commands.js";

const SIM_DESTINATION = "'platform=iOS Simulator,name=iPhone 16 Pro,OS=26.5'";

describe("detectTestRunIntents", () => {
  test("matches an xcodebuild test run against a simulator", () => {
    expect(
      detectTestRunIntents(`xcodebuild test -scheme App -destination ${SIM_DESTINATION}`),
    ).toEqual([{ setId: "xctest-devices", command: "xcodebuild test" }]);
  });

  test("matches test-without-building, which is the half that clones", () => {
    expect(
      detectTestRunIntents(
        `xcodebuild test-without-building -xctestrun A.xctestrun -destination ${SIM_DESTINATION}`,
      ),
    ).toEqual([{ setId: "xctest-devices", command: "xcodebuild test-without-building" }]);
  });

  test("matches the other simulator platforms, which share the device set", () => {
    for (const platform of ["watchOS", "tvOS", "visionOS"]) {
      expect(
        detectTestRunIntents(
          `xcodebuild test -scheme App -destination 'platform=${platform} Simulator,name=X'`,
        ),
      ).toHaveLength(1);
    }
  });

  test("ignores build-for-testing: it compiles and boots nothing", () => {
    expect(
      detectTestRunIntents(
        `xcodebuild build-for-testing -scheme App -destination ${SIM_DESTINATION}`,
      ),
    ).toEqual([]);
  });

  test("ignores a run that turned parallel testing off, which is what clones", () => {
    expect(
      detectTestRunIntents(
        `xcodebuild test -scheme App -destination ${SIM_DESTINATION} -parallel-testing-enabled NO`,
      ),
    ).toEqual([]);
    expect(
      detectTestRunIntents(
        `xcodebuild test -scheme App -destination ${SIM_DESTINATION} -parallel-testing-enabled YES`,
      ),
    ).toHaveLength(1);
  });

  test("ignores destinations that clone nothing", () => {
    expect(
      detectTestRunIntents("xcodebuild test -scheme App -destination 'platform=macOS'"),
    ).toEqual([]);
    expect(
      detectTestRunIntents(
        "xcodebuild test -scheme App -destination 'platform=iOS,id=00008120-000A1C2E3F4B'",
      ),
    ).toEqual([]);
    expect(detectTestRunIntents("xcodebuild test -scheme App")).toEqual([]);
  });

  test("ignores a command that only mentions one", () => {
    expect(detectTestRunIntents(`echo 'xcodebuild test -destination ${SIM_DESTINATION}'`)).toEqual(
      [],
    );
    expect(detectTestRunIntents("grep -rn 'xcodebuild test' docs/")).toEqual([]);
  });

  test("sees through env prefixes and a chained command", () => {
    expect(
      detectTestRunIntents(
        `cd app && NSUnbufferedIO=YES xcodebuild test -scheme App -destination ${SIM_DESTINATION} | xcpretty`,
      ),
    ).toEqual([{ setId: "xctest-devices", command: "xcodebuild test" }]);
  });

  test("collapses two test runs in one line into one obligation", () => {
    expect(
      detectTestRunIntents(
        `xcodebuild test -scheme A -destination ${SIM_DESTINATION} && xcodebuild test -scheme B -destination ${SIM_DESTINATION}`,
      ),
    ).toHaveLength(1);
  });
});
