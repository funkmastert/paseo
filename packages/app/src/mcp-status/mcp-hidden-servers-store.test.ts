// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useMcpHiddenServerNames, useMcpHiddenServersStore } from "./mcp-hidden-servers-store";

function hiddenOn(serverId: string): string[] | undefined {
  return useMcpHiddenServersStore.getState().hiddenByServerId[serverId];
}

beforeEach(() => {
  useMcpHiddenServersStore.setState({ hiddenByServerId: {} });
});

describe("useMcpHiddenServersStore", () => {
  it("hides a name once, however many times it is hidden", () => {
    const { hide } = useMcpHiddenServersStore.getState();
    hide("host-a", "figma");
    const afterFirst = useMcpHiddenServersStore.getState();

    hide("host-a", "figma");

    expect(hiddenOn("host-a")).toEqual(["figma"]);
    // Nothing changed, so nothing re-renders.
    expect(useMcpHiddenServersStore.getState()).toBe(afterFirst);
  });

  it("keeps each host's list to itself", () => {
    const { hide } = useMcpHiddenServersStore.getState();
    hide("host-a", "figma");
    hide("host-b", "slack");

    expect(hiddenOn("host-a")).toEqual(["figma"]);
    expect(hiddenOn("host-b")).toEqual(["slack"]);
  });

  it("unhides one name and leaves the others hidden", () => {
    const { hide, unhide } = useMcpHiddenServersStore.getState();
    hide("host-a", "figma");
    hide("host-a", "slack");
    hide("host-a", "claude.ai Robinhood");

    unhide("host-a", ["slack"]);

    expect(hiddenOn("host-a")).toEqual(["figma", "claude.ai Robinhood"]);
  });

  it("returns the same state when asked to unhide a name it does not have", () => {
    const { hide, unhide } = useMcpHiddenServersStore.getState();
    hide("host-a", "figma");
    const before = useMcpHiddenServersStore.getState();

    unhide("host-a", ["linear"]);
    unhide("host-unknown", ["figma"]);

    expect(useMcpHiddenServersStore.getState()).toBe(before);
  });
});

describe("useMcpHiddenServerNames", () => {
  it("returns one shared empty list for no host and for a host with nothing hidden", () => {
    const none = renderHook(() => useMcpHiddenServerNames(null)).result.current;
    const unknown = renderHook(() => useMcpHiddenServerNames("host-unknown")).result.current;

    expect(none).toEqual([]);
    // The same array, so a memo keyed on it does not rebuild the strip's model.
    expect(unknown).toBe(none);
  });

  it("returns the host's own list", () => {
    useMcpHiddenServersStore.getState().hide("host-a", "figma");

    const { result } = renderHook(() => useMcpHiddenServerNames("host-a"));

    expect(result.current).toEqual(["figma"]);
  });
});
