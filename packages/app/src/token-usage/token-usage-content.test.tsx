// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effecting: creating the instance is what registers it with react-i18next.
// eslint-disable-next-line import/no-unassigned-import
import "@/i18n/i18next";
import { ContentHarness, mount, unmountAll } from "./test-support/content-harness";

const DESKTOP_WIDTH = 900;

beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  unmountAll();
});

describe("TokenUsageContent", () => {
  it("separates the unit and range controls with a visible divider between them", () => {
    const container = mount(<ContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    const unitControl = container.querySelector('[data-testid="token-usage-unit"]');
    const divider = container.querySelector('[data-testid="token-usage-controls-divider"]');
    const rangeControl = container.querySelector('[data-testid="token-usage-range"]');
    expect(unitControl).not.toBeNull();
    expect(divider).not.toBeNull();
    expect(rangeControl).not.toBeNull();
    // The divider sits in source order between the two groups, which is what keeps them from
    // reading as one row of five buttons.
    const row = divider?.parentElement;
    const children = row ? Array.from(row.children) : [];
    expect(children.indexOf(unitControl as Element)).toBeLessThan(
      children.indexOf(divider as Element),
    );
    expect(children.indexOf(divider as Element)).toBeLessThan(
      children.indexOf(rangeControl as Element),
    );
  });

  it("shows the model and role cards with fixture data", () => {
    const container = mount(<ContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    expect(container.querySelector('[data-testid="tokens-by-model-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tokens-by-role-card"]')).not.toBeNull();
    expect(container.textContent).toContain("Tokens by model");
    expect(container.textContent).toContain("Tokens by role");
  });

  it("trails the unattributed row and flags the footer", () => {
    const container = mount(<ContentHarness width={DESKTOP_WIDTH} />, DESKTOP_WIDTH);
    const rows = Array.from(container.querySelectorAll('[data-testid^="tokens-by-model-row-"]'));
    expect(rows.at(-1)?.getAttribute("data-testid")).toContain("unknown");
    expect(
      container.querySelector('[data-testid="token-usage-attribution-footer"]'),
    ).not.toBeNull();
  });

  it("shows the backfill progress banner with no rows yet", () => {
    const container = mount(
      <ContentHarness width={DESKTOP_WIDTH} variant="backfilling" />,
      DESKTOP_WIDTH,
    );
    expect(container.querySelector('[data-testid="token-usage-backfilling"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tokens-by-model-card"]')).toBeNull();
  });

  it("shows a retryable error when the payload carries one", () => {
    const onRetry = vi.fn();
    const container = mount(
      <ContentHarness width={DESKTOP_WIDTH} variant="error" onRetry={onRetry} />,
      DESKTOP_WIDTH,
    );
    const alert = container.querySelector('[data-testid="token-usage-error"]');
    expect(alert).not.toBeNull();
    expect(container.querySelector('[data-testid="tokens-by-model-card"]')).toBeNull();
    const retry = container.querySelector<HTMLElement>('[data-testid="token-usage-error-retry"]');
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the disabled state when coverage.enabled is false", () => {
    const container = mount(
      <ContentHarness width={DESKTOP_WIDTH} variant="disabled" />,
      DESKTOP_WIDTH,
    );
    expect(container.querySelector('[data-testid="token-usage-disabled"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="token-usage-empty"]')).toBeNull();
  });

  it("shows a loading row with no breakdown yet", () => {
    const container = mount(
      <ContentHarness width={DESKTOP_WIDTH} variant="loading" />,
      DESKTOP_WIDTH,
    );
    expect(container.querySelector('[data-testid="token-usage-loading"]')).not.toBeNull();
  });

  it("shows a retryable error when the query itself rejects, with no payload yet", () => {
    const onRetry = vi.fn();
    const container = mount(
      <ContentHarness width={DESKTOP_WIDTH} variant="query-error" onRetry={onRetry} />,
      DESKTOP_WIDTH,
    );
    const alert = container.querySelector('[data-testid="token-usage-query-error"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("network unreachable");
    const retry = container.querySelector<HTMLElement>(
      '[data-testid="token-usage-query-error-retry"]',
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
