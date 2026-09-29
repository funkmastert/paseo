#!/usr/bin/env python3
"""Secret scan for files about to be vendored or committed. Prints only file:line:kind, never the
matched text, so running it can't leak what it finds. Exit 1 if anything matched.

  python3 ~/bozeo-ops/secret-scan.py <file-or-dir>...
"""
import math
import os
import re
import sys

PATTERNS = [
    ("anthropic-key", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    ("openai-key", re.compile(r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("notion-token", re.compile(r"\b(?:secret_|ntn_)[A-Za-z0-9]{30,}")),
    ("ngrok-authtoken", re.compile(r"\b[0-9][A-Za-z0-9]{20,}_[A-Za-z0-9]{15,}\b")),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}")),
    ("bearer", re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]{20,}")),
    ("assignment", re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|authtoken)\b\s*[:=]\s*[\"']?[A-Za-z0-9/+_.-]{16,}")),
]
LONG = re.compile(r"[A-Za-z0-9+/_-]{32,}")


def entropy(s):
    counts = {c: s.count(c) for c in set(s)}
    return -sum(n / len(s) * math.log2(n / len(s)) for n in counts.values())


def scan(path):
    hits = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for n, line in enumerate(fh, 1):
                kinds = [k for k, rx in PATTERNS if rx.search(line)]
                if not kinds and any(entropy(m) > 4.5 for m in LONG.findall(line)):
                    kinds = ["high-entropy"]
                hits += [f"{path}:{n}:{k}" for k in kinds]
    except OSError as e:
        hits.append(f"{path}:0:unreadable({e.errno})")
    return hits


def files(args):
    for a in args:
        if os.path.isdir(a):
            for d, _, names in os.walk(a):
                for name in sorted(names):
                    yield os.path.join(d, name)
        else:
            yield a


hits = [h for f in files(sys.argv[1:]) for h in scan(f)]
print("\n".join(hits) if hits else "no hits")
sys.exit(1 if hits else 0)
