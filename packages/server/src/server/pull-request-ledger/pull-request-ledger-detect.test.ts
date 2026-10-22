import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "../agent/agent-sdk-types.js";
import { detectPullRequestCreation } from "./pull-request-ledger-detect.js";

function shell(command: string, output: string): ToolCallDetail {
  return { type: "shell", command, output, exitCode: 0 };
}

function unknown(input: unknown, output: unknown): ToolCallDetail {
  return { type: "unknown", input, output };
}

describe("detectPullRequestCreation", () => {
  it("parses a gh pr create success output", () => {
    const output = [
      "Creating pull request for feat/widgets into main in acme/widgets",
      "",
      "https://github.com/acme/widgets/pull/42",
    ].join("\n");
    expect(detectPullRequestCreation("Bash", shell("gh pr create --fill", output))).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      forge: "github",
    });
  });

  it("parses a tea pulls create success output against a Gitea-style path", () => {
    const output = "https://git.example.com/acme/widgets/pulls/7";
    expect(detectPullRequestCreation("Bash", shell("tea pulls create --title x", output))).toEqual({
      host: "git.example.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 7,
      url: "https://git.example.com/acme/widgets/pulls/7",
      forge: "gitea",
    });
  });

  it("parses a gh api POST to /pulls with a JSON body in the output", () => {
    const output = JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/9" });
    const command = "gh api repos/acme/widgets/pulls -X POST -f title=x -f head=feat -f base=main";
    expect(detectPullRequestCreation("Bash", shell(command, output))).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      forge: "github",
    });
  });

  it("does not treat a bare GET to /pulls as a creation", () => {
    const output = JSON.stringify([{ html_url: "https://github.com/acme/widgets/pull/1" }]);
    expect(
      detectPullRequestCreation("Bash", shell("gh api repos/acme/widgets/pulls", output)),
    ).toBeNull();
  });

  it("parses an MCP create_pull_request tool result", () => {
    const result = detectPullRequestCreation(
      "mcp__github__create_pull_request",
      unknown(
        { owner: "acme", repo: "widgets" },
        { html_url: "https://github.com/acme/widgets/pull/13", number: 13 },
      ),
    );
    expect(result).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 13,
      url: "https://github.com/acme/widgets/pull/13",
      forge: "github",
    });
  });

  it("returns null for gh pr list", () => {
    const output = "widgets  feat/x  open\nother  feat/y  open";
    expect(detectPullRequestCreation("Bash", shell("gh pr list", output))).toBeNull();
  });

  it("returns null for a failed gh pr create with no URL in the output", () => {
    const output = "pull request create failed: GraphQL error";
    expect(detectPullRequestCreation("Bash", shell("gh pr create --fill", output))).toBeNull();
  });

  it("returns null for malformed JSON in an unknown tool's output", () => {
    const result = detectPullRequestCreation(
      "mcp__github__create_pull_request",
      unknown({}, "{not json"),
    );
    expect(result).toBeNull();
  });

  it("returns null for a non-shell, non-unknown detail", () => {
    const detail: ToolCallDetail = { type: "read", filePath: "/tmp/x" };
    expect(detectPullRequestCreation("Read", detail)).toBeNull();
  });
});
