#!/usr/bin/env python3
"""Pre-push scan: blocks a push that would publish Tyler's secrets or personal data.

Runs as a git pre-push hook (argv: remote name, remote url; stdin: one line per ref). It is wired
up two ways, because neither alone reaches every push:
  - `hook.bozeo-push-scan.*` in ~/.gitconfig, which git 2.54+ (Homebrew, the agents' PATH) runs
    in every repo, next to the repo's own hooks, and which LEFTHOOK=0 does not switch off;
  - `.git/hooks/pre-push` in the paseo repo, for Apple's git, which ignores config hooks. That
    copy runs with --from-hooks-dir and steps aside when the running git has the config hook.

Pushes to Wonderly remotes are not scanned: company repos carry company addresses legitimately
and have their own review. Everything else is.

Three layers, over every line the pushed commits add and every commit message:
  1. exact   - real secret values on this machine (JEV key, Claude Keychain tokens, GitHub,
               ngrok, Codex, push tokens, daemon keypair, secret-looking config values). Read
               fresh on each push, held in memory only, never printed.
  2. identity- Tyler's personal identifiers from ~/bozeo-ops/push-scan-identities.txt (emails,
               account handles, device serials, hostnames). That file is local only.
  3. pattern - secret formats, real-looking email addresses, phone numbers, Tailscale addresses,
               physical adb serials. Only on commits authored by Tyler's git identity (upstream
               commits are someone else's content). A line containing an obvious fake marker
               (example, fake, dummy, do-not-use, EXAMPLE, sentinel) or `push-scan:allow` is
               skipped by this layer only, and secret formats in test files are left to layer 1.
Findings print as commit, path and kind, never the value. Exit 1 blocks the push. The scan fails
closed: if it cannot read what is being pushed, the push is blocked.
"""
import hashlib, json, os, re, subprocess, sys

HOME = os.path.expanduser("~")
IDENTITIES = os.path.join(HOME, "bozeo-ops", "push-scan-identities.txt")
ZERO = "0" * 40
SKIP_REMOTE = re.compile(r"git\.wonderly\.info|github\.com[:/]wonderlydotcom/", re.I)
SKIP_PATHS = re.compile(r"(^|/)package-lock\.json$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz)$")
FAKE_MARKER = re.compile(r"example|fake|dummy|do-not-use|sentinel|placeholder|push-scan:allow", re.I)
# Secret formats in test code are fixtures (the redactor's tests are full of them); the exact layer
# still catches a real secret from this machine there. Personal-data patterns apply to tests too:
# a real address in a fixture is how the last one got in.
TEST_PATH = re.compile(r"\.(test|spec)\.|/(test-utils|__tests__|fixtures?|test-fixtures)/")
SECRET_FORMATS = {"anthropic-key", "openai-key", "typesafe-key", "github-token", "slack-token", "aws-key",
                  "notion-token", "private-key", "google-key", "expo-push-token", "jwt"}
FAKE_EMAIL = re.compile(
    r"@([a-z0-9.-]*\.)?(example|test|invalid|local|localhost|internal)(\.[a-z.]+)?$|@example\.|"
    r"@evil\.com$|^git@|noreply|@users\.noreply\.github\.com$|@getpaseo\.|@x\.|@h\.example$|@types/|"
    r"@(github\.com|gitlab\.com|bitbucket\.org)$",
    re.I,
)
PATTERNS = {
    "anthropic-key": r"sk-ant-[A-Za-z0-9_-]{20,}",
    "openai-key": r"\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{32,}",
    "typesafe-key": r"apikey_[A-Za-z0-9_-]{40,}",
    "github-token": r"\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}",
    "slack-token": r"\bxox[abposr]-[A-Za-z0-9-]{10,}",
    "aws-key": r"\bAKIA[0-9A-Z]{16}\b",
    "notion-token": r"\b(?:ntn_|secret_)[A-Za-z0-9]{30,}",
    "private-key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "google-key": r"\bAIza[0-9A-Za-z_-]{35}\b",
    "expo-push-token": r"ExponentPushToken\[[^\]]{10,}\]",
    "jwt": r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    "phone": r"(?<![\w.-])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])",
    "tailscale-ip": r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b",
    "tailnet-host": r"\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b",
    "adb-serial": r"adb\s+-s\s+(?!emulator-)(?!<)(?!\$)[A-Za-z0-9._:-]{6,}",
}
# Secret formats in test code are fixtures (the redactor's tests are full of them); the exact layer
# still catches a real secret from this machine there. Personal-data patterns apply to tests too:
# a real address in a fixture is how the last one got in.
TEST_PATH = re.compile(r"\.(test|spec)\.|/(test-utils|__tests__|fixtures?|test-fixtures)/")
SECRET_FORMATS = {"anthropic-key", "openai-key", "typesafe-key", "github-token", "slack-token", "aws-key",
                  "notion-token", "private-key", "google-key", "expo-push-token", "jwt"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def git(*args, check=True):
    r = subprocess.run(["git", *args], capture_output=True, text=True, errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {r.stderr.strip()[:200]}")
    return r.stdout


def secret_values():
    vals = set()

    def add(v):
        if isinstance(v, str) and len(v) >= 16 and " " not in v and not v.startswith(("/", "http", "~")):
            vals.add(v)

    def walk(o, key=""):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, k)
        elif isinstance(o, list):
            for v in o:
                walk(v, key)
        elif re.search(r"key|token|secret|pass|auth|cred|bearer|private", key, re.I):
            add(o.replace("Bearer ", "") if isinstance(o, str) else o)

    def load(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return None

    try:
        for line in open(os.path.join(HOME, ".config/paseo/jev.env")):
            if "=" in line:
                add(line.split("=", 1)[1].strip().strip('"'))
    except OSError:
        pass
    for d in (".claude-leader", ".claude-personal", ".claude"):
        service = "Claude Code-credentials-" + hashlib.sha256(os.path.join(HOME, d).encode()).hexdigest()[:8]
        r = subprocess.run(["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-w", "-s", service],
                           capture_output=True, text=True)
        if r.returncode == 0:
            try:
                walk(json.loads(r.stdout))
            except ValueError:
                pass
    for path in (".paseo/config.json", ".codex/auth.json", ".claude.json", ".claude-leader/.claude.json",
                 ".claude-personal/.claude.json"):
        o = load(os.path.join(HOME, path))
        if o is not None:
            walk(o)
    for path in (".paseo/push-tokens.json", ".paseo/daemon-keypair.json"):
        o = load(os.path.join(HOME, path))

        def every(x):
            if isinstance(x, dict):
                [every(v) for v in x.values()]
            elif isinstance(x, list):
                [every(v) for v in x]
            else:
                add(x)
        if o is not None:
            every(o)
    for path in ("Library/Application Support/ngrok/ngrok.yml", ".config/ngrok/ngrok.yml"):
        try:
            for line in open(os.path.join(HOME, path)):
                m = re.search(r"(?:authtoken|api_key):\s*(\S+)", line)
                if m:
                    add(m.group(1))
        except OSError:
            pass
    r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
    if r.returncode == 0:
        add(r.stdout.strip())
    return vals


def identities():
    try:
        return {l.strip() for l in open(IDENTITIES) if l.strip() and not l.startswith("#")}
    except OSError:
        return set()


def commit_ranges(remote):
    for line in sys.stdin:
        parts = line.split()
        if len(parts) != 4:
            continue
        _local_ref, local_sha, _remote_ref, remote_sha = parts
        if local_sha == ZERO:
            continue  # a deletion publishes nothing
        known = remote_sha != ZERO and subprocess.run(
            ["git", "cat-file", "-e", remote_sha + "^{commit}"], capture_output=True).returncode == 0
        yield [f"{remote_sha}..{local_sha}"] if known else [local_sha, "--not", f"--remotes={remote}"]


def scan(remote, own_emails):
    exact = secret_values()
    exact_re = re.compile("|".join(re.escape(v) for v in sorted(exact, key=len, reverse=True))) if exact else None
    ident = identities()
    ident_re = re.compile("|".join(re.escape(v) for v in sorted(ident, key=len, reverse=True)), re.I) if ident else None
    patterns = {k: re.compile(v) for k, v in PATTERNS.items()}
    findings = set()
    for rng in commit_ranges(remote):
        # --cc: a merge shows only the lines its resolution wrote, with one prefix column per parent.
        out = git("log", "-p", "--cc", "--no-color", "--no-ext-diff",
                  "--format=%x00commit %H %ae%n%B%x00", *rng)
        commit, author, path, in_msg, cols = "?", "", "(message)", False, 1
        for line in out.split("\n"):
            if line.startswith("\x00commit "):
                _, commit, author = (line[1:].split(" ", 2) + ["", ""])[:3]
                commit, path, in_msg = commit[:8], "(message)", True
                continue
            if in_msg:
                if line.endswith("\x00"):
                    in_msg = False
                    line = line[:-1]
                text = line
            elif line.startswith("diff --cc "):
                cols = 2
                continue
            elif line.startswith("diff --git "):
                cols = 1
                continue
            elif line.startswith("+++ "):
                path = line[6:] if line.startswith("+++ b/") else line[4:]
                continue
            elif line[:cols].strip("+ ") == "" and "+" in line[:cols] and not line.startswith("+++"):
                text = line[cols:]
            else:
                continue
            if SKIP_PATHS.search(path):
                continue
            if exact_re and exact_re.search(text):
                findings.add((commit, path, "real secret from this machine"))
            if ident_re and ident_re.search(text):
                findings.add((commit, path, "Tyler's personal identifier"))
            if author.lower() not in own_emails or FAKE_MARKER.search(text):
                continue
            in_test = bool(TEST_PATH.search(path))
            for kind, rx in patterns.items():
                if in_test and kind in SECRET_FORMATS:
                    continue
                if rx.search(text):
                    findings.add((commit, path, kind))
            for email in EMAIL.findall(text):
                if not FAKE_EMAIL.search(email):
                    findings.add((commit, path, "real-looking email address"))
    return findings


def main():
    remote = sys.argv[1] if len(sys.argv) > 1 else "origin"
    url = sys.argv[2] if len(sys.argv) > 2 else ""
    if "--from-hooks-dir" in sys.argv:
        # Apple's git ignores config hooks; a git that runs them will run ours from ~/.gitconfig.
        ver = re.search(r"(\d+)\.(\d+)", git("--version", check=False))
        has_config_hooks = ver and (int(ver.group(1)), int(ver.group(2))) >= (2, 54)
        if has_config_hooks and git("config", "--global", "--get", "hook.bozeo-push-scan.command", check=False).strip():
            return 0
    if SKIP_REMOTE.search(url):
        return 0
    own = {e.strip().lower() for e in (git("config", "user.email", check=False),
                                       git("config", "--global", "user.email", check=False)) if e.strip()}
    try:
        findings = scan(remote, own)
    except Exception as e:  # fail closed
        print(f"push-scan: could not scan this push ({e}); push blocked. Fix ~/bozeo-ops/push-scan.py.", file=sys.stderr)
        return 1
    if not findings:
        return 0
    print(f"push-scan: BLOCKED - {len(findings)} finding(s) would publish secrets or personal data:", file=sys.stderr)
    for commit, path, kind in sorted(findings):
        print(f"  {commit}  {path}: {kind} (value not shown)", file=sys.stderr)
    print("Replace each with a fake value (someone@example.com, emulator-5554, fake-...-do-not-use), rewrite\n"
          "the commit (amend / interactive-free rebase), then push again. Do not bypass with --no-verify.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
