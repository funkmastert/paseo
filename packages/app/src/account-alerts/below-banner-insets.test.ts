import { describe, expect, it } from "vitest";
import { contentInsets } from "./below-banner-insets";

const DEVICE_INSETS = { top: 47, right: 0, bottom: 34, left: 0 };

describe("contentInsets", () => {
  it("passes the device insets through while no account has a problem", () => {
    expect(contentInsets({ insets: DEVICE_INSETS, bannerVisible: false })).toBe(DEVICE_INSETS);
  });

  it("zeroes only the top inset below the banner while it shows", () => {
    expect(contentInsets({ insets: DEVICE_INSETS, bannerVisible: true })).toEqual({
      top: 0,
      right: 0,
      bottom: 34,
      left: 0,
    });
  });
});
