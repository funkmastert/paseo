import { describe, expect, it, vi } from "vitest";
import { TOOLS_DENIED_LABEL } from "../shared/role-policy-schema";
import { createParentToolProfiles, type PaseoAgentsApi } from "./parent-profiles";

interface FakeAgent {
  id: string;
  labels?: Record<string, string>;
}

function fakePaseo(pages: FakeAgent[][], onList?: () => void) {
  const list = vi.fn(async (options?: { page?: { cursor?: string } }) => {
    onList?.();
    const index = options?.page?.cursor ? Number(options.page.cursor) : 0;
    const entries = (pages[index] ?? []).map((agent) => ({ agent }));
    const hasMore = index + 1 < pages.length;
    return { entries, pageInfo: { nextCursor: hasMore ? String(index + 1) : null, prevCursor: null, hasMore } };
  });
  return { paseo: { agents: { list } } as unknown as PaseoAgentsApi, list };
}

describe("createParentToolProfiles", () => {
  it("reports an agent it saw created, with the denials the hook recorded on it", async () => {
    const { paseo } = fakePaseo([[]]);
    const profiles = createParentToolProfiles(paseo);
    await profiles.warm();

    profiles.note("a1", { [TOOLS_DENIED_LABEL]: "Edit,Write,Bash" });

    expect(profiles.lookup("a1")).toEqual({ status: "known", denied: ["Edit", "Write", "Bash"] });
  });

  it("treats a missing label as genuinely unrestricted, not as an unknown", async () => {
    const { paseo } = fakePaseo([[]]);
    const profiles = createParentToolProfiles(paseo);
    await profiles.warm();

    profiles.note("a1", {});

    expect(profiles.lookup("a1")).toEqual({ status: "known", denied: [] });
  });

  it("picks up agents that predate the plugin from the directory sweep", async () => {
    const { paseo } = fakePaseo([[{ id: "old", labels: { [TOOLS_DENIED_LABEL]: "Write" } }]]);
    const profiles = createParentToolProfiles(paseo);

    await profiles.warm();

    expect(profiles.lookup("old")).toEqual({ status: "known", denied: ["Write"] });
  });

  it("pages through the whole directory", async () => {
    const { paseo } = fakePaseo([
      [{ id: "p1", labels: { [TOOLS_DENIED_LABEL]: "Write" } }],
      [{ id: "p2", labels: { [TOOLS_DENIED_LABEL]: "Bash" } }],
    ]);
    const profiles = createParentToolProfiles(paseo);

    await profiles.warm();

    expect(profiles.lookup("p2")).toEqual({ status: "known", denied: ["Bash"] });
  });

  it("prefers the create-time record over a label that could have been edited since", async () => {
    const { paseo } = fakePaseo([[{ id: "a1", labels: {} }]]);
    const profiles = createParentToolProfiles(paseo);
    profiles.note("a1", { [TOOLS_DENIED_LABEL]: "Write" });

    await profiles.warm();

    expect(profiles.lookup("a1")).toEqual({ status: "known", denied: ["Write"] });
  });

  it("reports cold, not unknown, before any sweep has succeeded", () => {
    const { paseo } = fakePaseo([[]]);
    const profiles = createParentToolProfiles(paseo);

    expect(profiles.lookup("nobody")).toEqual({ status: "cold" });
  });

  it("stays cold when the directory cannot be read, rather than claiming an agent is absent", async () => {
    const list = vi.fn(async () => {
      throw new Error("daemon unreachable");
    });
    const profiles = createParentToolProfiles({ agents: { list } } as unknown as PaseoAgentsApi);

    await profiles.warm();

    expect(profiles.lookup("nobody")).toEqual({ status: "cold" });
  });

  it("reports unknown once the directory loaded and the agent still is not in it", async () => {
    const { paseo } = fakePaseo([[{ id: "a1" }]]);
    const profiles = createParentToolProfiles(paseo);

    await profiles.warm();

    expect(profiles.lookup("ghost")).toEqual({ status: "unknown" });
  });

  it("rate-limits the re-sweep a miss triggers, so a hot create loop cannot flood the daemon", async () => {
    let clock = 0;
    const { paseo, list } = fakePaseo([[{ id: "a1" }]]);
    const profiles = createParentToolProfiles(paseo, { now: () => clock });
    await profiles.warm();
    expect(list).toHaveBeenCalledTimes(1);

    profiles.lookup("ghost");
    profiles.lookup("ghost");
    await profiles.warm();
    expect(list).toHaveBeenCalledTimes(1);

    clock += 10_001;
    await profiles.warm();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("ignores junk in the label rather than passing it through as a tool name", async () => {
    const { paseo } = fakePaseo([[]]);
    const profiles = createParentToolProfiles(paseo);
    await profiles.warm();

    profiles.note("a1", { [TOOLS_DENIED_LABEL]: "Bash, ,Write(*), Edit " });

    expect(profiles.lookup("a1")).toEqual({ status: "known", denied: ["Bash", "Edit"] });
  });
});
