import { describe, expect, it } from "vitest";
import { openRenameProjectForm } from "./rename-project-form-model";

function form(overrides: Partial<Parameters<typeof openRenameProjectForm>[0]> = {}) {
  return openRenameProjectForm({
    path: "projects/checkout-redesign.md",
    currentTitle: "Checkout redesign",
    otherProjectTitles: ["On-site recording", "Legacy import"],
    ...overrides,
  });
}

describe("RenameProjectForm", () => {
  it("cannot submit an empty title", () => {
    const f = form();
    f.setTitle("");
    expect(f.getState().canSubmit).toBe(false);
    expect(f.getState().error).toBeNull();
  });

  it("rejects a title that collides with another project, case-insensitively", () => {
    const f = form();
    f.setTitle("on-site recording");
    const state = f.getState();
    expect(state.canSubmit).toBe(false);
    expect(state.error?.message).toBeTruthy();
  });

  it("allows a new, non-colliding title", () => {
    const f = form();
    f.setTitle("Checkout redesign v2");
    expect(f.getState().canSubmit).toBe(true);
    expect(f.getState().error).toBeNull();
    expect(f.submission).toEqual({
      path: "projects/checkout-redesign.md",
      title: "Checkout redesign v2",
    });
  });

  it("disables submit when the title is unchanged", () => {
    const f = form();
    expect(f.getState().canSubmit).toBe(false);
  });

  it("surfaces a submit error the daemon reports and clears it on the next edit", () => {
    const f = form();
    f.setTitle("Something new");
    f.setSubmitError({ message: "Another project already has this title." });
    expect(f.getState().error?.message).toBe("Another project already has this title.");
    f.setTitle("Something newer");
    expect(f.getState().error).toBeNull();
  });
});
