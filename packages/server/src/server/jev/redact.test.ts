import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { JevAnswer, JevQuestions, JevState } from "./contract.js";
import {
  isSecretName,
  JevExactSecretSet,
  JevRedactionError,
  redactJevRequest,
  restoreAnswerKeys,
  type JevRedactionResult,
} from "./redact.js";
import { BENIGN_TEXTS, FIXTURE_EXACT_TOKEN, SECRET_SHAPES } from "./test-utils/redact-shapes.js";

const HOME = "/Users/alex";
const MODEL = "typesafe/jev-1";
const NO_SECRETS = new JevExactSecretSet([]);
const QUESTIONS: JevQuestions = {
  done: { type: "noul", instructions: "Is the work in `state` finished?" },
};

interface RedactOptions {
  questions?: JevQuestions;
  secrets?: JevExactSecretSet;
  homeDir?: string;
  model?: string;
}

function redact(state: JevState, options: RedactOptions = {}): JevRedactionResult {
  return redactJevRequest(
    { model: options.model ?? MODEL, state, questions: options.questions ?? QUESTIONS },
    { secrets: options.secrets ?? NO_SECRETS, homeDir: options.homeDir ?? HOME },
  );
}

/** The state as sent, for a string state. */
function sentText(text: string, options: RedactOptions = {}): string {
  const { request } = redact(text, options);
  if (typeof request.state !== "string") throw new Error("state is not a string");
  return request.state;
}

function exact(...values: string[]): JevExactSecretSet {
  return new JevExactSecretSet(values.map((value) => ({ kind: "exact", value })));
}

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("redactJevRequest: line-shaped patterns in a state string", () => {
  it("redacts a PEM block and keeps the prose around it", () => {
    expect(sentText(`Found this in the repo:\n${PEM}\nShould it be rotated?`)).toBe(
      "Found this in the repo:\n[redacted:pem]\nShould it be rotated?",
    );
  });

  it("redacts a PEM block whose END was clipped away, to the end of the text", () => {
    const clipped = PEM.split("\n").slice(0, 2).join("\n");
    expect(sentText(`key:\n${clipped}`)).toBe("key:\n[redacted:pem]");
  });

  it("redacts the base64 body above an END whose BEGIN was clipped away", () => {
    const clipped = PEM.split("\n").slice(1).join("\n");
    expect(sentText(`tail of the file:\n${clipped}\ndone`)).toBe(
      "tail of the file:\n[redacted:pem]\ndone",
    );
  });

  it("redacts `export NAME=value` and `NAME=value` lines", () => {
    const text =
      "#!/bin/sh\nexport DEPLOY_TOKEN=f00dbabe-not-a-real-value\nAPI_KEY=abcdefgh1234\nrun";
    expect(sentText(text)).toBe(
      "#!/bin/sh\nexport DEPLOY_TOKEN=[redacted:assignment]\nAPI_KEY=[redacted:assignment]\nrun",
    );
  });

  it("redacts assignments in JSON, YAML and .npmrc form", () => {
    expect(sentText('{"apiKey": "k3y-v4lue-0001", "region": "us-west-2"}')).toBe(
      '{"apiKey": "[redacted:assignment]", "region": "us-west-2"}',
    );
    expect(sentText("db:\n  password: hunter2hunter2\n  host: localhost")).toBe(
      "db:\n  password: [redacted:assignment]\n  host: localhost",
    );
    expect(sentText("//registry.npmjs.org/:_authToken=0a1b2c3d4e5f6a7b")).toBe(
      "//registry.npmjs.org/:_authToken=[redacted:assignment]",
    );
  });

  it("redacts names ending in _PAT, _PASS, _PWD, _CREDENTIALS and _AUTH, and DATABASE_URL", () => {
    const names = ["GITLAB_PAT", "SMTP_PASS", "DB_PWD", "GCP_CREDENTIALS", "REGISTRY_AUTH"];
    for (const name of names) {
      expect(sentText(`${name}=value-of-${name.length}-chars`)).toBe(
        `${name}=[redacted:assignment]`,
      );
    }
    expect(sentText("DATABASE_URL=mysql://reader:s3cretpass@db.example.net/app")).toBe(
      "DATABASE_URL=[redacted:assignment]",
    );
  });

  it("leaves an assignment whose value is shorter than 8 characters", () => {
    expect(sentText("DB_PWD=abc123 and password: none")).toBe("DB_PWD=abc123 and password: none");
  });

  it("redacts every listed token prefix, in either case", () => {
    const body = "A1b2C3d4E5f6G7h8J9k0";
    const prefixes = [
      "sk-",
      "sk-ant-",
      "sk-or-",
      "sk_live_",
      "rk_live_",
      "ghp_",
      "gho_",
      "ghu_",
      "ghs_",
      "ghr_",
      "github_pat_",
      "glpat-",
      "xoxa-",
      "xoxb-",
      "xoxe-",
      "xoxp-",
      "xoxr-",
      "xoxs-",
      "ya29.",
      "tskey-",
    ];
    const tokens = [
      ...prefixes.map((prefix) => `${prefix}${body}`),
      "AKIAIOSFODNN7EXAMPLE",
      "ASIAY34FZKBOKMUTVV7A",
      "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe",
      "npm_A1b2C3d4E5f6G7h8J9k0A1b2C3d4E5f6G7h8",
      `GHP_${body}`,
    ];
    for (const token of tokens) {
      expect(sentText(`use ${token} for this`)).toBe("use [redacted:token] for this");
    }
  });

  it("leaves words that only contain a prefix", () => {
    const text = "the risk-assessment-for-the-quarter and npm_config_user_agent are fine";
    expect(sentText(text)).toBe(text);
  });

  it("redacts Authorization header values and Bearer tokens", () => {
    expect(
      sentText("curl -H 'Authorization: Basic YWxleDpodW50ZXIy' https://api.example.net"),
    ).toBe("curl -H 'Authorization: [redacted:bearer]' https://api.example.net");
    expect(sentText("sent Bearer 7f9c2ba4e88f827d61604550760585a3 upstream")).toBe(
      "sent Bearer [redacted:bearer] upstream",
    );
  });

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(sentText(`cookie session ${jwt} expired`)).toBe("cookie session [redacted:jwt] expired");
  });

  it("redacts URL userinfo and keeps the scheme and host", () => {
    expect(sentText("connect postgres://admin:hunter2hunter2@db.internal:5432/app")).toBe(
      "connect postgres://[redacted:userinfo]@db.internal:5432/app",
    );
    expect(
      sentText("origin https://x-access-token:ghs_A1b2C3d4E5f6G7h8J9k0@github.com/org/repo.git"),
    ).toBe("origin https://[redacted:userinfo]@github.com/org/repo.git");
  });

  it("redacts a high-entropy base64 run after `=` but not a git SHA or ordinary words", () => {
    expect(sentText("cookie=Nim8iS71VSQ6EYh5Bnw+bFfUp/w4+mTuK79fAvuz;")).toBe(
      "cookie=[redacted:entropy];",
    );
    const benign =
      "commit: 65267b9a2cae4c52913b53a484ce872436b5247e\nmode=interactive: the build passed";
    expect(sentText(benign)).toBe(benign);
  });

  it("writes the home prefix as ~ at a path boundary, raw, JSON-escaped or with forward slashes", () => {
    expect(sentText("edit /Users/alex/code/app/src/index.ts and /Users/alexandra/notes")).toBe(
      "edit ~/code/app/src/index.ts and /Users/alexandra/notes",
    );
    const windows = { homeDir: "C:\\Users\\alex\\" };
    expect(sentText("cwd C:\\Users\\alex\\code", windows)).toBe("cwd ~\\code");
    expect(sentText('{"cwd":"C:\\\\Users\\\\alex\\\\code"}', windows)).toBe('{"cwd":"~\\\\code"}');
    expect(sentText("cwd C:/Users/alex/code", windows)).toBe("cwd ~/code");
  });

  it("replaces email addresses with [email]", () => {
    expect(sentText("capped account alex.doe+work@example.co.uk, retry later")).toBe(
      "capped account [email], retry later",
    );
  });

  it("counts redacted values and emails, not home prefixes", () => {
    const text = `${PEM}\nexport DEPLOY_TOKEN=f00dbabe-not-a-real-value\nmail alex@example.com about /Users/alex/x`;
    expect(redact(text).count).toBe(3);
    expect(redact({ log: text, apiKey: "k3y-v4lue-0001", path: "/Users/alex/y" }).count).toBe(4);
  });
});

describe("redactJevRequest: secret shapes", () => {
  it.each(SECRET_SHAPES)("redacts $label", ({ text, needle }) => {
    const { serialized } = redact(text, { secrets: exact(FIXTURE_EXACT_TOKEN) });
    expect(serialized).not.toContain(needle);
    expect(serialized).not.toContain(JSON.stringify(needle).slice(1, -1));
  });

  it.each(BENIGN_TEXTS)("leaves $label", ({ text }) => {
    expect(sentText(text)).toBe(text);
  });

  it("redacts a secret flag's value and keeps the flag", () => {
    expect(sentText("ngrok http 80 --authtoken 2Zq8XyTbWcVdRe5fGhJk_7a1B2c3D4e5F")).toBe(
      "ngrok http 80 --authtoken [redacted:argument]",
    );
    expect(sentText("mysql -uroot -pSup3rS3cretPw app")).toBe(
      "mysql -uroot -p[redacted:argument] app",
    );
    expect(sentText("docker login -u ci -p Sup3rS3cretPw registry.example.com")).toBe(
      "docker login -u ci -p [redacted:argument] registry.example.com",
    );
    expect(sentText("aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG")).toBe(
      "aws configure set aws_secret_access_key [redacted:argument]",
    );
  });

  it("redacts a YAML value to the end of its line", () => {
    expect(sentText("db:\n  password: correct horse battery staple # rotated\n  port: 5432")).toBe(
      "db:\n  password: [redacted:assignment] # rotated\n  port: 5432",
    );
  });

  it("keeps a webhook's host", () => {
    const path = ["T0SYNTH01", "B0SYNTH02", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");
    expect(sentText(`post to https://hooks.slack.com/services/${path} now`)).toBe(
      "post to https://hooks.slack.com/services/[redacted:webhook] now",
    );
  });

  it("redacts bare base64 that looks random or encodes text, and bare 64-character hex", () => {
    const encodedText = Buffer.from("user=alex password=correct horse battery").toString("base64");
    expect(sentText(`echo ${encodedText} | base64 -d`)).toBe("echo [redacted:entropy] | base64 -d");
    expect(sentText("blob Nim8iS71VSQ6EYh5Bnw+bFfUp/w4+mTuK79fAvuzQ end")).toBe(
      "blob [redacted:entropy] end",
    );
    expect(sentText(`key ${"3f9a1c7e5b2d4f6a".repeat(4)} end`)).toBe("key [redacted:entropy] end");
  });
});

describe("redactJevRequest: structured data", () => {
  it("redacts the whole value under a secret-shaped key", () => {
    const { request, count } = redact({
      apiKey: "k3y v4lue with spaces",
      GITHUB_PAT: "value-without-a-prefix",
      pass: "short",
      note: "keep this note",
    });
    expect(request.state).toEqual({
      apiKey: "[redacted:assignment]",
      GITHUB_PAT: "[redacted:assignment]",
      pass: "short",
      note: "keep this note",
    });
    expect(count).toBe(2);
  });

  it("redacts object keys and throws when two keys become one", () => {
    expect(redact({ "/Users/alex/a.ts": 1 }).request.state).toEqual({ "~/a.ts": 1 });
    expect(() => redact({ "/Users/alex/a.ts": 1, "~/a.ts": 2 })).toThrow(JevRedactionError);
  });

  it("redacts every part of the questions and never touches the model", () => {
    const token = "ghp_A1b2C3d4E5f6G7h8J9k0";
    const questions: JevQuestions = {
      route: {
        type: "choice",
        instructions: `Which remote does ${token} belong to?`,
        criteria: { [`key ${token}`]: `described by ${token}`, other: "None of these" },
      },
      level: {
        type: "score",
        instructions: { question: "How bad is it?", evidence: `leaked ${token}` },
        criteria: ["fine", `worse: ${token}`],
      },
    };
    const model = "typesafe/jev-1 /Users/alex";
    const { request, serialized } = redact("state", { questions, model });
    expect(serialized).not.toContain(token);
    expect(request.model).toBe(model);
    expect(request.questions).toEqual({
      route: {
        type: "choice",
        instructions: "Which remote does [redacted:token] belong to?",
        criteria: {
          "key [redacted:token]": "described by [redacted:token]",
          other: "None of these",
        },
      },
      level: {
        type: "score",
        instructions: { question: "How bad is it?", evidence: "leaked [redacted:token]" },
        criteria: ["fine", "worse: [redacted:token]"],
      },
    });
  });

  it("keeps the description of a choice option whose name looks like a secret", () => {
    const questions: JevQuestions = {
      outcome: {
        type: "choice",
        instructions: "Did the tests in `output` pass?",
        criteria: { pass: "Every test passed", fail: "At least one test failed", other: "Unclear" },
      },
    };
    expect(redact("ok", { questions }).request.questions).toEqual(questions);
  });

  it("returns a request that serializes to exactly `serialized`", () => {
    const result = redact({ log: `${PEM}\nalex@example.com`, when: "2026-09-28" });
    expect(JSON.stringify(result.request)).toBe(result.serialized);
    expect(JSON.parse(result.serialized)).toEqual(result.request);
  });

  it("passes a benign state through, apart from home and email", () => {
    const state = {
      summary:
        "The build failed at step 3 because the fixture file was missing. Re-running after `npm install` fixed it.",
      files: ["/Users/alex/code/app/src/index.ts", "packages/server/src/server/jev/redact.ts"],
      code: "function total(items: Item[]): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}",
      commit: "commit: 65267b9a2cae4c52913b53a484ce872436b5247e",
      link: "https://github.com/funkmastert/paseo/pull/12",
      owner: "alex@example.com",
      attempts: 2,
    };
    const { request, count } = redact(state);
    expect(request.state).toEqual({
      ...state,
      files: ["~/code/app/src/index.ts", "packages/server/src/server/jev/redact.ts"],
      owner: "[email]",
    });
    expect(count).toBe(1);
  });
});

describe("redactJevRequest: exact values", () => {
  it("redacts the MCP bearer token inside a process command line", () => {
    const token = randomUUID();
    const commandLine = `claude --mcp-config {"mcpServers":{"paseo":{"type":"http","url":"http://127.0.0.1:6767/mcp","headers":{"Authorization":"Bearer ${token}"}}}}`;
    const { serialized } = redact({ evidence: [commandLine] }, { secrets: exact(token) });
    expect(serialized).not.toContain(token);
  });

  it("redacts a bare exact value that no pattern would catch", () => {
    const token = randomUUID();
    const line = `node mcp-bridge.js ${token} --port 6767`;
    expect(sentText(line)).toBe(line);
    expect(sentText(line, { secrets: exact(token) })).toBe(
      "node mcp-bridge.js [redacted:exact] --port 6767",
    );
  });

  it("redacts an exact value that appears JSON-escaped inside a string", () => {
    const token = randomUUID();
    const password = 'pa"ss\\word-2026';
    const secrets = exact(token, password);
    const argv = JSON.stringify([
      "claude",
      "--mcp-config",
      `{"token":"${token}","pw":${JSON.stringify(password)}}`,
    ]);
    const { serialized, count } = redact({ argv }, { secrets });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("word-2026");
    expect(count).toBe(2);
  });

  it("catches a value that only appears once the body is serialized", () => {
    const secret = "\\u0007bell-secret";
    const { request, count } = redact("\u0007bell-secret", { secrets: exact(secret) });
    expect(request.state).toBe("[redacted:exact]");
    expect(count).toBe(1);
  });

  it("throws when a substitution in the serialized body would cut an escape", () => {
    expect(() => redact('abcdefg"', { secrets: exact("abcdefg\\") })).toThrow(JevRedactionError);
  });

  it("skips values under 8 characters and counts distinct values", () => {
    const secrets = new JevExactSecretSet([
      { kind: "exact", value: "short12" },
      { kind: "exact", value: "long-enough-1" },
      { kind: "exact", value: "long-enough-1" },
      { kind: "exact", value: "long-enough-2" },
    ]);
    expect(secrets.size).toBe(2);
    expect(sentText("short12 long-enough-1", { secrets })).toBe("short12 [redacted:exact]");
  });

  it("never shows a kind that could name the secret", () => {
    const secrets = new JevExactSecretSet([
      { kind: "env:GITHUB_TOKEN", value: "value-one-1234" },
      { kind: "jev-key", value: "value-two-1234" },
    ]);
    expect(sentText("value-one-1234 value-two-1234", { secrets })).toBe(
      "[redacted:exact] [redacted:jev-key]",
    );
    expect(JSON.stringify(secrets)).toBe('{"size":2}');
  });
});

describe("restoreAnswerKeys", () => {
  const questions: JevQuestions = {
    "pick for alex@example.com": {
      type: "choice",
      instructions: "Which file in `files` should the agent read first?",
      criteria: {
        "/Users/alex/src/a.ts": "a.ts",
        "/Users/alex/src/b.ts": "b.ts",
        none: "No file in the list fits",
      },
    },
    unchanged: { type: "noul", instructions: "Is `files` empty?" },
    level: { type: "score", instructions: "How risky?", criteria: ["low", "high"] },
  };

  it("maps a redacted question id and choice keys back to the caller's", () => {
    const { request, keyMap } = redact("state", { questions });
    expect(Object.keys(request.questions)).toEqual(["pick for [email]", "unchanged", "level"]);
    expect(keyMap).toEqual({
      "pick for [email]": {
        id: "pick for alex@example.com",
        criteria: { "~/src/a.ts": "/Users/alex/src/a.ts", "~/src/b.ts": "/Users/alex/src/b.ts" },
      },
    });

    const sentAnswers: Record<string, JevAnswer> = {
      "pick for [email]": {
        type: "choice",
        choice: "~/src/b.ts",
        probabilities: { "~/src/a.ts": 0.15, "~/src/b.ts": 0.8, none: 0.05 },
        confidence: 0.8,
      },
      unchanged: { type: "noul", noul: 0.2 },
      level: {
        type: "score",
        score: 0.4,
        legend: { "0": "low", "1": "high" },
        probabilities: { "0": 0.6, "1": 0.4 },
        confidence: 0.6,
      },
    };
    expect(restoreAnswerKeys(sentAnswers, keyMap)).toEqual({
      "pick for alex@example.com": {
        type: "choice",
        choice: "/Users/alex/src/b.ts",
        probabilities: { "/Users/alex/src/a.ts": 0.15, "/Users/alex/src/b.ts": 0.8, none: 0.05 },
        confidence: 0.8,
      },
      unchanged: { type: "noul", noul: 0.2 },
      level: sentAnswers.level,
    });
  });

  it("leaves answers alone when nothing was renamed", () => {
    const answers: Record<string, JevAnswer> = { done: { type: "noul", noul: 0.9 } };
    expect(redact("state").keyMap).toEqual({});
    expect(restoreAnswerKeys(answers, {})).toEqual(answers);
  });
});

describe("isSecretName", () => {
  it.each([
    "GITHUB_TOKEN",
    "apiKey",
    "api_key",
    "_authToken",
    "password",
    "DB_PASSWORD",
    "GITLAB_PAT",
    "SMTP_PASS",
    "DB_PWD",
    "GCP_CREDENTIALS",
    "REGISTRY_AUTH",
    "SENTRY_DSN",
    "PRIVATE_KEY",
    "client-secret",
    "DATABASE_URL",
    "databaseUrl",
    "NGROK_AUTHTOKEN",
    "NPM_CONFIG_AUTHTOKEN",
    "PGPASSWORD",
    "SSHPASS",
    "APITOKEN",
    "passphrase",
    "add-authtoken",
    "aws_secret_access_key",
  ])("%s is secret-shaped", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    "HOME",
    "PATH",
    "NODE_ENV",
    "SSH_AUTH_SOCK",
    "AWS_ACCESS_KEY_ID",
    "author",
    "keyboard",
    "API_URL",
    "max_tokens",
    "maxTokens",
    "tokenCount",
    "key-file",
    "password-stdin",
  ])("%s is not", (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});

describe("redactJevRequest: hostile input", () => {
  function fill(unit: string, size: number): string {
    return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  }

  /** Deterministic noise over the characters the patterns care about. */
  function noise(size: number): string {
    const alphabet = "aA0=:@./_-\"'\\ \n\tbBeyJ~+%";
    let seed = 7;
    let text = "";
    for (let i = 0; i < size; i += 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      text += alphabet[seed % alphabet.length];
    }
    return text;
  }

  function hostileInputs(size: number): [string, string][] {
    return [
      ["one long word", fill("a", size)],
      ["a long base64 run after =", `=${fill("Ab0+", size)}`],
      ["secret names and separators", fill("token=", size)],
      ["a secret name before a sea of spaces", `token${fill(" ", size)}`],
      ["unterminated quoted values", fill('"password": "a', size)],
      ["escaped quotes", fill('\\"', size)],
      ["PEM BEGIN markers", fill("-----BEGIN PRIVATE KEY-----", size)],
      ["PEM END markers over base64", fill("QUJD\n-----END PRIVATE KEY-----\n", size)],
      ["email fragments", fill("a@b.", size)],
      ["domain labels", `a@${fill("b1.", size)}`],
      ["scheme fragments", fill("https://a:", size)],
      ["userinfo", fill("a://b:c@", size)],
      ["JWT fragments", fill("eyJaaaa.", size)],
      ["Bearer fragments", fill("Bearer ", size)],
      ["secret flags", fill("--token ", size)],
      ["secret flags with no value", fill("--password=", size)],
      ["secret flags in JSON arrays", fill('"--token","', size)],
      ["secret argument names", fill("aws_secret_access_key ", size)],
      ["mysql -p in one command", fill("mysql -p", size)],
      ["mysql commands that end at once", fill("mysql;", size)],
      ["docker logins", fill("docker login -p ", size)],
      ["YAML secret lines", fill("\npassword: a b c", size)],
      ["one YAML value of many words", `password: ${fill("ab ", size)}`],
      ["a base64 run mixing path characters", fill("Ab0+/x-", size)],
      ["a hex run", fill("0123456789abcdef", size)],
      ["many 42-character base64 runs", fill("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEF ", size)],
      ["vendor prefixes", fill("sk_test_", size)],
      ["Google refresh prefixes", fill("1//0", size)],
      ["SendGrid fragments", fill("SG.aaaaaaaaaaaaaaaa.", size)],
      ["webhook paths", fill("hooks.slack.com/services/", size)],
      ["digest prefixes", fill("sha256:", size)],
      ["noise", noise(size)],
    ];
  }

  function elapsedMs(text: string): number {
    const secrets = exact(randomUUID(), "aaaaaaaa");
    const startedAt = performance.now();
    redact(text, { secrets });
    return performance.now() - startedAt;
  }

  it.each(hostileInputs(64_000))("64 KB of %s finishes well under a second", (_name, text) => {
    expect(elapsedMs(text)).toBeLessThan(1000);
  });

  // Redaction runs before the size check, so the state can be larger than the body cap.
  it.each(hostileInputs(640_000))("640 KB of %s stays linear", (_name, text) => {
    expect(elapsedMs(text)).toBeLessThan(1000);
  });
});

describe("redactJevRequest: an argv held as an array", () => {
  // Synthetic values, built from parts so no literal here reads as a real credential.
  const ngrokToken = ["2Zq8XyTbWcVdRe5f", "GhJk_7a1B2c3D4e5F"].join("");
  const password = ["Sup3r", "S3cret", "Pw"].join("");
  const awsSecret = ["wJalrXUtnFEMI", "/K7MDENG/bPxRfiCY"].join("");

  function sentArgv(argv: string[]): unknown {
    return redact({ argv }).request.state;
  }

  it.each([
    ["a secret flag and its value", ["node", "run.js", "--password", password], password],
    ["an authtoken subcommand", ["ngrok", "config", "add-authtoken", ngrokToken], ngrokToken],
    ["mysql's attached -p", ["mysql", "-uroot", `-p${password}`, "app"], password],
    ["docker login's -p", ["docker", "login", "-u", "ci", "-p", password, "reg.example"], password],
    [
      "a secret argument name",
      ["aws", "configure", "set", "aws_secret_access_key", awsSecret],
      awsSecret,
    ],
  ])("redacts %s split across elements", (_name, argv, needle) => {
    const sent = JSON.stringify(sentArgv(argv));
    expect(sent).not.toContain(needle);
    expect(sent).toContain("[redacted:argument]");
  });

  it("keeps the flag and every other element as they were", () => {
    expect(sentArgv(["mysql", "-uroot", `-p${password}`, "app"])).toEqual({
      argv: ["mysql", "-uroot", "-p[redacted:argument]", "app"],
    });
    expect(sentArgv(["node", "run.js", "--password", password, "--verbose"])).toEqual({
      argv: ["node", "run.js", "--password", "[redacted:argument]", "--verbose"],
    });
  });

  it("reads a 40,000-element argv in linear time", () => {
    const argv = Array.from({ length: 40_000 }, (_, index) =>
      index % 2 === 0 ? "--password" : `Pw${index}x9Q!zz`,
    );
    const started = performance.now();
    const sent = JSON.stringify(sentArgv(argv));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sent).not.toContain("x9Q!");
  });

  it.each([
    [["git", "log", "--max-count", "5", "--format=%H"]],
    [["docker", "run", "-p", "8080:80", "nginx"]],
    [["ssh", "-i", "./keys/deploy", "--port", "2222", "host.example"]],
    [["openssl", "req", "--key-file", "./server.key"]],
    [["the", "token", "expired", "yesterday"]],
  ])("leaves %j unchanged", (argv) => {
    expect(sentArgv(argv)).toEqual({ argv });
  });
});
