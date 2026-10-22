import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "../agent/agent-sdk-types.js";
import { detectPullRequestCreation } from "./pull-request-ledger-detect.js";

function shell(command: string, output: string, exitCode: number | null = 0): ToolCallDetail {
  return { type: "shell", command, output, exitCode };
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
    const output = JSON.stringify({
      html_url: "https://github.com/acme/widgets/pull/9",
      number: 9,
    });
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

  it("parses a curl POST to a Gitea /api/v1/.../pulls collection endpoint", () => {
    const output = JSON.stringify({
      html_url: "https://git.wonderly.info/acme/widgets/pulls/11",
      number: 11,
    });
    const command =
      'curl -X POST https://git.wonderly.info/api/v1/repos/acme/widgets/pulls -d \'{"title":"x"}\'';
    expect(detectPullRequestCreation("Bash", shell(command, output))).toEqual({
      host: "git.wonderly.info",
      repoOwner: "acme",
      repoName: "widgets",
      number: 11,
      url: "https://git.wonderly.info/acme/widgets/pulls/11",
      forge: "gitea",
    });
  });

  it("does not treat a bare GET to /pulls as a creation", () => {
    const output = JSON.stringify([{ html_url: "https://github.com/acme/widgets/pull/1" }]);
    expect(
      detectPullRequestCreation("Bash", shell("gh api repos/acme/widgets/pulls", output)),
    ).toBeNull();
  });

  it("does not treat a chained creation as detected when the command exits non-zero", () => {
    const output = [
      "pull request create failed: a pull request for branch feat/x already exists:",
      "https://github.com/acme/widgets/pull/40",
    ].join("\n");
    expect(detectPullRequestCreation("Bash", shell("gh pr create --fill", output, 1))).toBeNull();
  });

  it("detects gh pr create chained after a cd with &&", () => {
    const output = "https://github.com/acme/widgets/pull/42";
    expect(
      detectPullRequestCreation("Bash", shell("cd /repo/widgets && gh pr create --fill", output)),
    ).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      forge: "github",
    });
  });

  it("detects gh pr create chained after a push with &&", () => {
    const output = "https://github.com/acme/widgets/pull/43";
    expect(
      detectPullRequestCreation(
        "Bash",
        shell("git push -u origin HEAD && gh pr create --fill", output),
      ),
    ).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 43,
      url: "https://github.com/acme/widgets/pull/43",
      forge: "github",
    });
  });

  it("detects gh pr create prefixed with an env var assignment", () => {
    const output = "https://github.com/acme/widgets/pull/44";
    expect(
      detectPullRequestCreation("Bash", shell("GH_TOKEN=x gh pr create --fill", output)),
    ).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 44,
      url: "https://github.com/acme/widgets/pull/44",
      forge: "github",
    });
  });

  it("detects gh pr create prefixed with env setting a var", () => {
    const output = "https://github.com/acme/widgets/pull/46";
    expect(
      detectPullRequestCreation("Bash", shell("env GH_TOKEN=x gh pr create --fill", output)),
    ).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 46,
      url: "https://github.com/acme/widgets/pull/46",
      forge: "github",
    });
  });

  it("detects gh pr create prefixed with sudo", () => {
    const output = "https://github.com/acme/widgets/pull/47";
    expect(detectPullRequestCreation("Bash", shell("sudo gh pr create --fill", output))).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 47,
      url: "https://github.com/acme/widgets/pull/47",
      forge: "github",
    });
  });

  it("detects gh pr create wrapped in sh -c", () => {
    const output = "https://github.com/acme/widgets/pull/45";
    expect(
      detectPullRequestCreation("Bash", shell("bash -lc 'gh pr create --fill'", output)),
    ).toEqual({
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 45,
      url: "https://github.com/acme/widgets/pull/45",
      forge: "github",
    });
  });

  it("detects tea pulls create chained after a cd with &&", () => {
    const output = "https://git.example.com/acme/widgets/pulls/8";
    expect(
      detectPullRequestCreation("Bash", shell("cd /repo && tea pulls create --title x", output)),
    ).toEqual({
      host: "git.example.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 8,
      url: "https://git.example.com/acme/widgets/pulls/8",
      forge: "gitea",
    });
  });

  it("does not match gh pr create inside unrelated text", () => {
    const output = "no pull request found";
    expect(detectPullRequestCreation("Bash", shell("echo 'gh pr create'", output))).toBeNull();
  });

  it("does not treat a comment POST on an existing PR as a creation", () => {
    const output = JSON.stringify({
      html_url: "https://github.com/acme/widgets/pull/5#issuecomment-1",
      id: 1,
    });
    const command = "gh api repos/acme/widgets/pulls/5/comments -f body=hi";
    expect(detectPullRequestCreation("Bash", shell(command, output))).toBeNull();
  });

  it("does not treat a review POST on an existing PR as a creation", () => {
    const output = JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/5", id: 1 });
    const command = "gh api repos/acme/widgets/pulls/5/reviews -X POST -f event=APPROVE";
    expect(detectPullRequestCreation("Bash", shell(command, output))).toBeNull();
  });

  it("does not treat a PATCH edit on an existing PR as a creation", () => {
    const output = JSON.stringify({
      html_url: "https://github.com/acme/widgets/pull/5",
      number: 5,
    });
    const command = "gh api -X PATCH repos/acme/widgets/pulls/5 -f state=closed";
    expect(detectPullRequestCreation("Bash", shell(command, output))).toBeNull();
  });

  it("does not treat a Gitea comment POST as a creation", () => {
    const output = JSON.stringify({
      html_url: "https://git.wonderly.info/acme/widgets/pulls/5#issuecomment-1",
    });
    const command =
      'curl -X POST https://git.wonderly.info/api/v1/repos/acme/widgets/pulls/5/comments -d \'{"body":"hi"}\'';
    expect(detectPullRequestCreation("Bash", shell(command, output))).toBeNull();
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
