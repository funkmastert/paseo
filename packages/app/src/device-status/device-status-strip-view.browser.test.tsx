import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceStatusUpdateMessage } from "@getpaseo/protocol/messages";
import { buildDeviceStatusStripModel } from "./device-status-model";
import type { DeviceStatusStripViewProps } from "./device-status-strip-view";
// Side-effecting: creating the instance is what registers it with react-i18next, so the strip
// renders its real copy rather than raw keys.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";

const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => layout.compact,
}));

// The real Switch animates theme colours through Reanimated, which the unistyles stub can't
// feed; the strip's own behaviour is what is under test.
vi.mock("@/components/ui/switch", () => ({
  Switch: (props: { value: boolean; testID?: string; accessibilityLabel?: string }) => (
    <div role="switch" aria-checked={props.value} data-testid={props.testID}>
      {props.accessibilityLabel}
    </div>
  ),
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
});

// The view builds its menu icons at module scope, so React has to be global before it loads.
vi.stubGlobal("React", React);
const { DeviceStatusStripView } = await import("./device-status-strip-view");

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  layout.compact = false;
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "320px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

type Payload = DeviceStatusUpdateMessage["payload"];

// Fake ids throughout.
const PAYLOAD: Payload = {
  enabled: true,
  dryRun: false,
  totalSlots: 3,
  slotsPerPlatform: 2,
  used: 2,
  devices: [
    {
      platform: "ios",
      deviceId: "00000000-0000-0000-0000-000000000001",
      name: "iPhone 17 Pro",
      state: "running",
      attribution: "lease",
      agentId: "agent-1",
      heldForSeconds: 120,
      runningForSeconds: 7_200,
    },
    {
      platform: "android",
      deviceId: "yonderly_pixel",
      state: "running",
      attribution: "none",
      heldForSeconds: 3_600,
      runningForSeconds: 3_600,
    },
  ],
  waiting: [],
  blocked: [],
  physicalBlocked: [
    {
      agentId: "agent-2",
      command: "adb install",
      message: "held",
      dryRun: false,
      at: "2026-10-01T00:00:00.000Z",
    },
  ],
  physicalDevices: [
    {
      id: "00008000-00000000000FAKE1",
      platform: "ios",
      name: "iPhone 16e",
      transport: "network",
      connected: true,
      reserved: false,
    },
  ],
  generatedAt: "2026-10-01T00:00:00.000Z",
};

function renderStrip(overrides: Partial<DeviceStatusStripViewProps> = {}) {
  const props: DeviceStatusStripViewProps = {
    model: buildDeviceStatusStripModel(PAYLOAD, { "agent-1": "Build the login screen" }),
    canManage: true,
    expanded: true,
    onToggleExpanded: vi.fn(),
    enforceToggle: { canToggle: true, pending: false, onValueChange: vi.fn() },
    onOpenAgent: vi.fn(),
    onRelease: vi.fn(async () => undefined),
    onSetReservation: vi.fn(async () => undefined),
    onShutdown: vi.fn(async () => undefined),
    ...overrides,
  };
  return { container: mount(<DeviceStatusStripView {...props} />), props };
}

function text(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

describe("DeviceStatusStripView", () => {
  it("names a simulator by its simctl name, with the short UDID after it", () => {
    const { container } = renderStrip();
    expect(text(container, "device-status-row-00000000-0000-0000-0000-000000000001")).toContain(
      "Simulator · iPhone 17 Pro · 00000000",
    );
  });

  it("says how long a device has been held and how long it has run", () => {
    const { container } = renderStrip();
    const row = text(container, "device-status-row-00000000-0000-0000-0000-000000000001");
    expect(row).toContain("Held by Build the login screen");
    expect(row).toContain("Held 2m");
    expect(row).toContain("Running 2h00m");
    expect(text(container, "device-status-row-yonderly_pixel")).toContain("Free");
  });

  it("opens the holding agent when its name is tapped", () => {
    const { container, props } = renderStrip();
    const link = container.querySelector<HTMLElement>(
      '[data-testid="device-status-holder-agent-1"]',
    );
    act(() => link?.click());
    expect(props.onOpenAgent).toHaveBeenCalledWith("agent-1");
  });

  it("shows a Wi-Fi iPhone in the Physical group as Wi-Fi", () => {
    const { container } = renderStrip();
    const row = text(container, "device-status-physical-row-00008000-00000000000FAKE1");
    expect(row).toContain("iPhone 16e");
    expect(row).toContain("Wi-Fi");
    expect(row).toContain("FAKE1".slice(-4));
  });

  it("counts the physical gate's refusals with the rest", () => {
    const { container } = renderStrip();
    expect(text(container, "device-status-blocked")).toBe("1 recent refusal");
  });

  it("a dry run's records read as would-have-been-refused, not refusals", () => {
    const { container } = renderStrip({
      model: buildDeviceStatusStripModel({
        ...PAYLOAD,
        dryRun: true,
        physicalBlocked: [{ ...PAYLOAD.physicalBlocked![0]!, dryRun: true }],
      }),
    });
    expect(text(container, "device-status-blocked")).toBe("1 launch would have been refused");
  });

  it("the Enforce switch is on while enforcing and off in dry run", () => {
    const enforcing = renderStrip().container;
    expect(text(enforcing, "device-status-mode-header")).toContain("Enforce");
    const enforcingSwitch = enforcing.querySelector('[data-testid="device-status-enforce-switch"]');
    expect(enforcingSwitch?.getAttribute("aria-checked")).toBe("true");

    const dryRun = renderStrip({
      model: buildDeviceStatusStripModel({ ...PAYLOAD, dryRun: true }),
    }).container;
    const dryRunSwitch = dryRun.querySelector('[data-testid="device-status-enforce-switch"]');
    expect(dryRunSwitch?.getAttribute("aria-checked")).toBe("false");
  });
});
