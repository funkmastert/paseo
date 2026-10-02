/**
 * Secret shapes the redactor must catch and benign text it must leave alone (JEV foundation
 * review, M3). Every value is synthetic and assembled from parts, so no literal in this file
 * matches a secret scanner's pattern.
 */

interface RedactionShape {
  label: string;
  text: string;
  /** For a secret shape, the part that must not survive, raw or JSON-escaped. */
  needle: string;
}

/** Stands in for `agentMcpAuthToken`: the shapes run with it as an exact value. */
export const FIXTURE_EXACT_TOKEN = "9f3c1a7e-2b4d-4e8f-a1c6-7d5e3b2a9c10";

function join(...parts: string[]): string {
  return parts.join("");
}

const PEM_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";
const BASE64_SK_ANT = Buffer.from(
  join("sk-", "ant-api03-", "SYNTHETICSYNTHETICSYNTHETIC0000"),
).toString("base64");
const NGROK = join("2Zq8XyTbWcVdRe5fGhJkLmNpQr", "_", "7a1B2c3D4e5F6g7H8i9J0kLmN");
const NOTION_NEW = join("ntn", "_", "4b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f");
const NOTION_OLD = join("secret", "_", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4Cd");
const STRIPE_TEST = join("sk", "_test_", "51Hs8dK2eZvKYlo2C0aBcDeFgHiJkLmNoPqRsTu");
const STRIPE_RESTRICTED = join("rk", "_test_", "51Hs8dK2eZvKYlo2C0aBcDeFgHiJkLm");
const SLACK_HOOK_PATH = join("T0SYNTH01/", "B0SYNTH02/", "AbCdEfGhIjKlMnOpQrStUvWx");
const SLACK_HOOK = join("https://hooks.", "slack.com/services/", SLACK_HOOK_PATH);
const SLACK_APP = join("xapp", "-1-A0SYNTH01-1234567890123-", "abcdef0123456789abcdef0123456789");
const LINEAR = join("lin", "_api_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd");
const FIGMA = join("figd", "_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcdEF");
const GRAFANA = join("glsa", "_", "AbCdEfGhIjKlMnOpQrStUvWxYz012345", "_", "0a1b2c3d");
const HEX_KEY = "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a";
const DIGITALOCEAN = join("dop", "_v1_", HEX_KEY);
const SENDGRID = join(
  "SG",
  ".",
  "AbCdEfGhIjKlMnOpQrStUv",
  ".",
  "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG",
);
const GOOGLE_REFRESH = join("1//", "0gSYNTHETICabcdefGHIJKLmnopqrSTUVwxyz0123456789");
const AWS_SECRET = join("wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYSYNTHETICKEY");
const GITHUB = join("ghp", "_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
const PASSWORD = "Sup3rS3cretPw";

/** The review's 30 shapes, in its order. 16 survived redaction when it was written. */
const REVIEW_SECRET_SHAPES: RedactionShape[] = [
  {
    label: "PEM block",
    text: `key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\nAAAAAAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----\n`,
    needle: PEM_BODY,
  },
  {
    label: "KEY=value in serialized JSON string",
    text: JSON.stringify({ env: join("OPENAI_API_KEY=", "sk-proj-", "SYNTHETIC0000000000000000") }),
    needle: "SYNTHETIC0000000000000000",
  },
  {
    label: "bearer in ps argv",
    text: "curl -H 'Authorization: Bearer abcDEF0123456789abcDEF0123' https://x",
    needle: "abcDEF0123456789abcDEF0123",
  },
  {
    label: "MCP token by exact value in argv",
    text: `claude --mcp-config {"headers":{"x":"${FIXTURE_EXACT_TOKEN}"}}`,
    needle: FIXTURE_EXACT_TOKEN,
  },
  {
    label: "Anthropic sk-ant",
    text: join("k sk-", "ant-api03-", "AbCdEfGhIjKlMnOpQrStUv-0123"),
    needle: "AbCdEfGhIjKlMnOpQrStUv",
  },
  {
    label: "OpenAI sk-proj",
    text: join("k sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUv0123"),
    needle: "AbCdEfGhIjKlMnOpQrStUv",
  },
  {
    label: "OpenRouter sk-or-v1",
    text: join("k sk-", "or-v1-", "0123456789abcdef0123456789abcdef"),
    needle: "0123456789abcdef0123456789abcdef",
  },
  { label: "GitHub ghp_", text: `k ${GITHUB}`, needle: GITHUB },
  {
    label: "GitHub github_pat_",
    text: join("k github", "_pat_", "11AbCdEfG0123456789_AbCdEfGhIjKlMnOp"),
    needle: "AbCdEfGhIjKlMnOp",
  },
  {
    label: "ngrok authtoken, argv form",
    text: `ngrok config add-authtoken ${NGROK}`,
    needle: NGROK,
  },
  {
    label: "ngrok authtoken, flag form",
    text: `ngrok http 80 --authtoken ${NGROK}`,
    needle: NGROK,
  },
  { label: "ngrok authtoken, yaml", text: `authtoken: ${NGROK}`, needle: NGROK },
  { label: "Notion ntn_, prose", text: `the notion key is ${NOTION_NEW}`, needle: NOTION_NEW },
  { label: "Notion ntn_, flag form", text: `--token ${NOTION_NEW}`, needle: NOTION_NEW },
  { label: "Notion secret_, prose", text: `use ${NOTION_OLD} for notion`, needle: NOTION_OLD },
  { label: "Stripe sk_test_", text: `k ${STRIPE_TEST}`, needle: STRIPE_TEST },
  { label: "Linear lin_api_", text: `k ${LINEAR}`, needle: LINEAR },
  { label: "Figma figd_", text: `k ${FIGMA}`, needle: FIGMA },
  { label: "Slack webhook URL", text: `post to ${SLACK_HOOK}`, needle: "AbCdEfGhIjKlMnOpQrStUvWx" },
  {
    label: "base64'd sk-ant, bare",
    text: `echo ${BASE64_SK_ANT} | base64 -d`,
    needle: BASE64_SK_ANT,
  },
  { label: "base64'd sk-ant, after =", text: `X=${BASE64_SK_ANT}`, needle: BASE64_SK_ANT },
  {
    label: "AWS secret, argv",
    text: `aws configure set aws_secret_access_key ${AWS_SECRET}`,
    needle: AWS_SECRET,
  },
  {
    label: "AWS secret, assignment",
    text: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
    needle: AWS_SECRET,
  },
  { label: "hex key, bare", text: `key material ${HEX_KEY}`, needle: HEX_KEY },
  { label: "PGPASSWORD=", text: `PGPASSWORD=${PASSWORD}!`, needle: `${PASSWORD}!` },
  {
    label: "password with spaces",
    text: "password: correct horse battery staple",
    needle: "horse battery staple",
  },
  { label: "--password flag", text: `mysql -u root --password ${PASSWORD}`, needle: PASSWORD },
  { label: "-p flag", text: `mysql -uroot -p${PASSWORD}`, needle: PASSWORD },
  {
    label: "git credential url token only",
    text: `https://${GITHUB}@github.com/x/y`,
    needle: GITHUB,
  },
  {
    label: "Google OAuth refresh 1//",
    text: `refresh ${GOOGLE_REFRESH}`,
    needle: "SYNTHETICabcdefGHIJKLmnopqrSTUVwxyz",
  },
];

/** The rest of the coverage the fix asked for: more vendors, flag forms and env names. */
const MORE_SECRET_SHAPES: RedactionShape[] = [
  { label: "ngrok authtoken, v2 command", text: `ngrok authtoken ${NGROK}`, needle: NGROK },
  { label: "ngrok authtoken, prose", text: `my ngrok token is ${NGROK} ok`, needle: NGROK },
  {
    label: "ngrok authtoken, --authtoken=",
    text: `ngrok http 80 --authtoken=${NGROK}`,
    needle: NGROK,
  },
  {
    label: "ngrok authtoken, indented yaml",
    text: `version: "2"\nagent:\n  authtoken: ${NGROK}\n`,
    needle: NGROK,
  },
  {
    label: "Notion secret_, flag form",
    text: `notion-cli --token ${NOTION_OLD}`,
    needle: NOTION_OLD,
  },
  {
    label: "Notion ntn_, in a curl header",
    text: `curl -H "Notion-Token: ${NOTION_NEW}"`,
    needle: NOTION_NEW,
  },
  { label: "Stripe rk_test_", text: `k ${STRIPE_RESTRICTED}`, needle: STRIPE_RESTRICTED },
  { label: "Slack xapp-", text: `k ${SLACK_APP}`, needle: SLACK_APP },
  { label: "Grafana glsa_", text: `k ${GRAFANA}`, needle: GRAFANA },
  { label: "DigitalOcean dop_v1_", text: `k ${DIGITALOCEAN}`, needle: DIGITALOCEAN },
  { label: "SendGrid SG.", text: `k ${SENDGRID}`, needle: SENDGRID },
  {
    label: "Slack webhook URL in JSON",
    text: JSON.stringify({ webhook: SLACK_HOOK, channel: "#ops" }),
    needle: "AbCdEfGhIjKlMnOpQrStUvWx",
  },
  { label: "--token=", text: `cli deploy --token=${PASSWORD}42`, needle: `${PASSWORD}42` },
  { label: "--api-key", text: `tool --api-key ${PASSWORD}42 run`, needle: `${PASSWORD}42` },
  {
    label: "--client-secret, quoted",
    text: `oauth-cli --client-secret "${PASSWORD} with spaces"`,
    needle: "with spaces",
  },
  {
    label: "--password in a JSON argv array",
    text: JSON.stringify(["mysql", "--password", `${PASSWORD}42`]),
    needle: `${PASSWORD}42`,
  },
  {
    label: "docker login -p",
    text: `docker login -u ci -p ${PASSWORD} registry.example.com`,
    needle: PASSWORD,
  },
  {
    label: "mysqldump -p, quoted",
    text: `mysqldump -uroot -p'${PASSWORD} x' app`,
    needle: PASSWORD,
  },
  { label: "sshpass -p", text: `sshpass -p ${PASSWORD} ssh deploy@build-box`, needle: PASSWORD },
  {
    label: "npm config set _authToken",
    text: `npm config set _authToken ${PASSWORD}42`,
    needle: `${PASSWORD}42`,
  },
  {
    label: "password with spaces, indented yaml",
    text: "db:\n  host: localhost\n  password: correct horse battery staple\n  port: 5432",
    needle: "horse battery staple",
  },
  { label: "NGROK_AUTHTOKEN=", text: `NGROK_AUTHTOKEN=${PASSWORD}42`, needle: `${PASSWORD}42` },
  {
    label: "NPM_CONFIG_AUTHTOKEN=",
    text: `NPM_CONFIG_AUTHTOKEN=${PASSWORD}42`,
    needle: `${PASSWORD}42`,
  },
  { label: "SSHPASS=", text: `SSHPASS=${PASSWORD} sshpass -e ssh host`, needle: PASSWORD },
  { label: "APITOKEN=", text: `APITOKEN=${PASSWORD}42`, needle: `${PASSWORD}42` },
  { label: "STRIPE_SECRET=", text: `STRIPE_SECRET=${PASSWORD}42`, needle: `${PASSWORD}42` },
  { label: "NOTION_TOKEN=", text: `export NOTION_TOKEN=${PASSWORD}42`, needle: `${PASSWORD}42` },
  { label: "DEPLOY_KEY=", text: `DEPLOY_KEY=${PASSWORD}42 ./deploy.sh`, needle: `${PASSWORD}42` },
  { label: "passphrase=", text: `passphrase=${PASSWORD}42`, needle: `${PASSWORD}42` },
];

/** Credentials in shell command lines, which `recent` sends (read-check egress review 2, E1). */
const COMMAND_SECRET_SHAPES: RedactionShape[] = [
  { label: "curl -u", text: `curl -u admin:${PASSWORD} https://api.example.com`, needle: PASSWORD },
  { label: "curl --user", text: `curl --user admin:${PASSWORD} https://x`, needle: PASSWORD },
  { label: "curl -sSu", text: `curl -sSu "admin:${PASSWORD}" https://x`, needle: PASSWORD },
  { label: "curl -u attached", text: `curl -uadmin:${PASSWORD} https://x`, needle: PASSWORD },
  {
    label: "curl --proxy-user",
    text: `curl --proxy-user ops:${PASSWORD} https://x`,
    needle: PASSWORD,
  },
  { label: "curl -u token as user", text: `curl -u ${PASSWORD}: https://x`, needle: PASSWORD },
  { label: "curl -u, short", text: "curl -u admin:pw1 https://x", needle: "pw1" },
  { label: "http -a", text: `http -a admin:${PASSWORD} example.com`, needle: PASSWORD },
  { label: "https --auth", text: `https --auth admin:${PASSWORD} example.com`, needle: PASSWORD },
  { label: "xh -a", text: `xh -a admin:${PASSWORD} example.com`, needle: PASSWORD },
  { label: "redis-cli -a", text: `redis-cli -h cache -a ${PASSWORD} ping`, needle: PASSWORD },
  { label: "redis-cli -a, short", text: "redis-cli -a pw12 ping", needle: "pw12" },
  {
    label: "redis URL, no user",
    text: `redis-cli -u redis://:${PASSWORD}@cache:6379`,
    needle: PASSWORD,
  },
  { label: "mysql -p attached, short", text: "mysql -uroot -phunter2 app", needle: "hunter2" },
  { label: "mysql --password=", text: "mysql -uroot --password=hunter2 app", needle: "hunter2" },
  { label: "wget --password=", text: "wget --password=hunter2 https://x", needle: "hunter2" },
  { label: "--http-password", text: "wget --http-password hunter2 https://x", needle: "hunter2" },
  { label: "psql URL", text: "psql postgresql://app:hunter2@db/app", needle: "hunter2" },
  { label: "psql keyword", text: 'psql "host=db user=app password=hunter2"', needle: "hunter2" },
  { label: "PGPASSWORD=", text: "PGPASSWORD=abc123 psql -h db", needle: "abc123" },
  {
    label: "DB_PASSWORD= before a command",
    text: "DB_PASSWORD=hunter2 npm start",
    needle: "hunter2",
  },
  {
    label: "DB_PASS= in recent",
    text: "tool Bash `DB_PASS=s3cr3t! node seed.js`",
    needle: "s3cr3t!",
  },
  {
    label: "git clone with a token",
    text: `git clone https://admin:${PASSWORD}@git.example.com/r.git`,
    needle: PASSWORD,
  },
  { label: "sshpass -p, short", text: "sshpass -p hunter2 ssh host", needle: "hunter2" },
  {
    label: "-H Authorization",
    text: "curl -H 'Authorization: Basic YWRtaW46cHc=' https://x",
    needle: "YWRtaW46cHc=",
  },
  { label: "-H X-Api-Key", text: 'curl -H "X-Api-Key: abc123" https://x', needle: "abc123" },
  {
    label: "--header Cookie",
    text: "curl --header 'Cookie: sid=abc123' https://x",
    needle: "sid=abc123",
  },
  { label: "--token=", text: "gh api --token=ab12cd https://x", needle: "ab12cd" },
  { label: "--api-key", text: "tool --api-key ab12cd run", needle: "ab12cd" },
  {
    label: "ldapsearch -w",
    text: "ldapsearch -x -D cn=admin -w hunter2 -b dc=x",
    needle: "hunter2",
  },
  {
    label: "openssl -passin",
    text: "openssl rsa -in k.pem -passin pass:hunter2",
    needle: "hunter2",
  },
];

/** Values a copied `.env` or a local config file kept (read-check egress review 2, E4–E5). */
const FILE_SECRET_SHAPES: RedactionShape[] = [
  {
    label: "a password with spaces",
    text: "ADMIN_PASSWORD=correct horse battery",
    needle: "horse battery",
  },
  { label: "password = phrase", text: "password = correct horse battery", needle: "horse battery" },
  { label: "a salt", text: "ENCRYPTION_SALT=Qx7pL2vN9mK4", needle: "Qx7pL2vN9mK4" },
  { label: "PRIVATE=", text: `PRIVATE=${PASSWORD}`, needle: PASSWORD },
  { label: "a signing key", text: `{"Jwt":{"Signing":"${PASSWORD}"}}`, needle: PASSWORD },
  { label: "private_key_id", text: `"private_key_id": "${PASSWORD}"`, needle: PASSWORD },
  { label: "PHP define", text: `define('DB_PASSWORD', '${PASSWORD}');`, needle: PASSWORD },
  {
    label: "a WordPress salt",
    text: "define('AUTH_KEY', 'q8#Lz|v@p!2W;xR^m0>kE7$yT-cN4/hU');",
    needle: "q8#Lz|v@p!2W",
  },
  { label: "an htpasswd hash", text: `admin:$apr1$${PASSWORD}`, needle: PASSWORD },
];

export const SECRET_SHAPES: RedactionShape[] = [
  ...REVIEW_SECRET_SHAPES,
  ...MORE_SECRET_SHAPES,
  ...COMMAND_SECRET_SHAPES,
  ...FILE_SECRET_SHAPES,
];

const NPM_INTEGRITY = join(
  "sha512-",
  "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
);

/** Text that carries no secret and must reach JEV unchanged (home `/Users/alex`). */
export const BENIGN_TEXTS: Omit<RedactionShape, "needle">[] = [
  {
    label: "a long absolute path",
    text: "/Users/x/paseo-worktrees/jev-foundation/packages/server/src/server/jev/redact.ts",
  },
  {
    label: "a path with capitals and digits",
    text: "open /Users/alexandra/Projects/Server2/src/main/java/com/example/App.java",
  },
  {
    label: "a simulator path with a UUID",
    text: "/Users/x/Library/Developer/CoreSimulator/Devices/9F3C1A7E-2B4D-4E8F-A1C6-7D5E3B2A9C10/data",
  },
  {
    label: "a Windows path",
    text: "C:\\Users\\x\\paseo-worktrees\\jev-foundation\\packages\\server\\src\\server\\jev\\redact.ts",
  },
  {
    label: "git SHAs, full and short",
    text: "commit 65267b9a2cae4c52913b53a484ce872436b5247e\n65267b9 fix(jev): redact more shapes",
  },
  {
    label: "a UUID agent id",
    text: "agent 0d8f5c2a-7b1e-4c3d-9a6f-2e4b8c1d7f90 finished; parent 5b2e9d4c-1a3f-4e6b-8c7d-9f0a1b2c3d4e",
  },
  { label: "model ids", text: "claude-opus-5-5 and claude-haiku-4-5-20251001" },
  {
    label: "ordinary URLs",
    text: "see https://github.com/funkmastert/paseo/pull/12 and https://example.com/api/v1/organizations/members/permissions/settings/advanced?page=2",
  },
  {
    label: "camelCase identifiers",
    text: "handleV2AgentStreamEventForTimelineRowsInWorkspace calls AbstractSingletonProxyFactoryBean2ForHTTPRequestsV3",
  },
  {
    label: "long English prose",
    text: "The build failed at step three because the fixture file was missing from the checkout. Re-running after installing the dependencies fixed it, and the flaky timeline test passed on the second attempt without any change to the code under test.",
  },
  {
    label: "prose that names secrets without values",
    text: "Set the GITHUB_TOKEN environment variable, then rotate the api_key in the dashboard. The token expired and the password reset email never arrived.",
  },
  { label: "--model", text: "claude --model claude-opus-5-5 --max-tokens 4000 -p 'hello'" },
  { label: "--max-tokens=", text: "run --max-tokens=128000 --max-output-tokens 32000" },
  {
    label: "flags whose value is a path",
    text: "ssh-add --key-file ./keys/deploy.pem && tool --ssh-key ~/.ssh/id_ed25519 --private-key /etc/ssl/private/server-key.pem",
  },
  { label: "a flag whose value is a variable", text: "gh api --token $GITHUB_TOKEN repos" },
  {
    label: "docker login reading the password from stdin",
    text: "docker login --password-stdin -u ci registry.example.com",
  },
  {
    label: "-p outside a password command",
    text: "mkdir -p packages/server/src/server/jev/fixtures && docker run -p 8080:80 nginx && gcc -pedantic-errors -pthread main.c",
  },
  { label: "mysql -p that prompts", text: "mysql -u root -p app_production_database" },
  {
    label: "TypeScript fields named like secrets",
    text: "interface Config {\n  apiKey: string | null;\n  maxTokens: number;\n}",
  },
  {
    label: "content digests",
    text: `image node@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n"integrity": "${NPM_INTEGRITY}"`,
  },
  { label: "a token count", text: '{"tokenCount": "12345678", "max_tokens": "4000"}' },
  {
    label: "paths as JSON and YAML values",
    text: JSON.stringify({
      cwd: "/Users/x/paseo-worktrees/jev-foundation",
      file: "app/src/main/java/com/wonderly/MainActivity.kt",
      device:
        "/Users/x/Library/Developer/CoreSimulator/Devices/9F3C1A7E-2B4D-4E8F-A1C6-7D5E3B2A9C10/data",
    }).concat("\npath: Sources/PaseoApp/Features/Timeline/Views2"),
  },
  { label: "a log line with an auth key", text: "auth: user logged in successfully" },
  { label: "docker --user with ids", text: "docker run --user 1000:1000 -v $PWD:/src node" },
  {
    label: "curl without credentials",
    text: "curl -sSL https://example.com/install.sh -o install.sh",
  },
  { label: "a comparison", text: "if (token == null) return;\nif (password === other) fail();" },
  { label: "an HTTPie request", text: "http GET example.com/api Accept:application/json" },
  {
    label: "a header without a credential",
    text: "curl -H 'Content-Type: application/json' https://x",
  },
];
