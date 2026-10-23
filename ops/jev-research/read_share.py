#!/usr/bin/env python3
"""Read-only: what share of weighted Claude spend do file reads drive?

For every transcript touched in the window, walk the API calls in order (deduped by
message.id) and every tool result. A tool result of T tokens that enters the context
before call k is written to cache once (cache-write weight) and re-read on every later
call in the same context segment (cache-read weight) until compaction or session end.
That "residency-weighted" cost is what removing the content would have saved (upper bound:
it assumes the agent would behave identically without it).

Weights are Anthropic list-price ratios (model-independent): fresh input 1, cache write
(1h TTL) 2, cache read 0.1, output 5. Tokens for a tool result are estimated from its
characters using a chars/token ratio calibrated against the observed context growth.

Writes JSON to stdout. Touches nothing under ~/.claude or ~/.paseo.
"""
import json, os, re, sys, time, statistics
from collections import defaultdict, Counter
from datetime import datetime, timezone, timedelta

ROOT = os.path.expanduser("~/.claude/projects")
HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 72
CUTOFF = datetime.now(timezone.utc) - timedelta(hours=HOURS)
MTIME_CUTOFF = time.time() - HOURS * 3600 - 3600
FLEET_PREFIXES = (os.path.expanduser("~/.paseo/worktrees/"),)
W_IN, W_CW, W_CR, W_OUT = 1.0, 2.0, 0.1, 5.0

READ_CMD = re.compile(r"^(?:cd\s+\S+\s*&&\s*)?(?:cat|head|tail|nl|bat|less|more|sed\s+-n)\b")
SEARCH_CMD = re.compile(r"^(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|ag|ack|find|ls|fd|git\s+grep)\b")


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def classify(name, inp):
    if name == "Read":
        return "Read"
    if name in ("Grep", "Glob"):
        return "Grep/Glob"
    if name == "Bash":
        cmd = (inp or {}).get("command", "") if isinstance(inp, dict) else ""
        cmd = cmd.strip()
        if READ_CMD.match(cmd):
            return "Bash:file-read"
        if SEARCH_CMD.match(cmd):
            return "Bash:search"
        return "Bash:other"
    if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return "Edit/Write"
    if name.startswith("mcp__paseo__"):
        return "mcp:paseo"
    if name.startswith("mcp__"):
        return "mcp:other"
    if name in ("Agent", "Task"):
        return "Agent/Task"
    return "other:" + name


def result_chars(block):
    c = block.get("content")
    if isinstance(c, str):
        return len(c), 0
    n, imgs = 0, 0
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    n += len(b.get("text", ""))
                elif b.get("type") == "image":
                    imgs += 1
    return n, imgs


def iter_files():
    for dirpath, _dirs, files in os.walk(ROOT):
        for fn in files:
            if not fn.endswith(".jsonl"):
                continue
            p = os.path.join(dirpath, fn)
            try:
                if os.stat(p).st_mtime >= MTIME_CUTOFF:
                    yield p
            except OSError:
                pass


def scan(path):
    """Return per-file event list: calls and results in order, plus metadata."""
    events = []  # ("call", idx) / ("result", cat, chars, imgs, ts_in_window) / ("compact",)
    calls = {}  # msg id -> [order, model, in, cw, cr, out, ts]
    order = []
    cwd = None
    tool = {}  # tool_use_id -> (cat, name, input, ts, msg_id)
    read_meta = []
    turn_reads = Counter()  # user-prompt index -> Read count
    user_turn = 0
    msg_reads = Counter()  # assistant msg id -> Read tool_use count
    latencies = []  # (exec_ms)
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if cwd is None and d.get("cwd"):
                cwd = d["cwd"]
            t = d.get("type")
            ts = parse_ts(d["timestamp"]) if d.get("timestamp") else None
            if t == "system" and d.get("subtype") == "compact_boundary":
                events.append(("compact",))
                continue
            if t == "assistant":
                msg = d.get("message") or {}
                mid = msg.get("id") or d.get("uuid")
                u = msg.get("usage") or {}
                if mid not in calls:
                    calls[mid] = [len(order), msg.get("model", "?"), 0, 0, 0, 0, ts]
                    order.append(mid)
                    events.append(("call", mid))
                rec = calls[mid]
                rec[2] = u.get("input_tokens", 0) or 0
                rec[3] = u.get("cache_creation_input_tokens", 0) or 0
                rec[4] = u.get("cache_read_input_tokens", 0) or 0
                rec[5] = max(rec[5], u.get("output_tokens", 0) or 0)
                for b in msg.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        cat = classify(b.get("name", "?"), b.get("input"))
                        tool[b.get("id")] = (cat, b.get("name"), b.get("input"), ts, mid)
                        if b.get("name") == "Read":
                            msg_reads[mid] += 1
                            turn_reads[user_turn] += 1
            elif t == "user":
                msg = d.get("message") or {}
                content = msg.get("content")
                if isinstance(content, str) or (
                    isinstance(content, list)
                    and not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
                ):
                    user_turn += 1
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            info = tool.get(b.get("tool_use_id"))
                            cat = info[0] if info else "unknown"
                            n, imgs = result_chars(b)
                            inwin = bool(ts and ts >= CUTOFF)
                            if cat == "Read":
                                cat = "Read:image" if imgs else "Read:text"
                            events.append(("result", cat, n, imgs, inwin))
                            if info and info[1] == "Read" and inwin:
                                tur = d.get("toolUseResult")
                                rtype = tur.get("type") if isinstance(tur, dict) else "none"
                                inp = info[2] if isinstance(info[2], dict) else {}
                                partial = "offset" in inp or "limit" in inp
                                exec_ms = (ts - info[3]).total_seconds() * 1000 if (ts and info[3]) else None
                                read_meta.append((n, rtype, partial, exec_ms, bool(b.get("is_error"))))
    return cwd, events, calls, order, read_meta, turn_reads, msg_reads


def main():
    files = list(iter_files())
    agg = {"all": defaultdict(float), "fleet": defaultdict(float)}
    calls_total = {"all": Counter(), "fleet": Counter()}
    cost_total = {"all": 0.0, "fleet": 0.0}
    n_sessions = Counter()
    calib = []  # chars/token samples from single-Read context growth
    img_calib = []  # tokens per single-image Read
    buckets = {"all": defaultdict(float), "fleet": defaultdict(float)}
    read_sizes = {"all": [], "fleet": []}
    read_types = Counter()
    read_partial = Counter()
    read_errors = 0
    exec_ms = []
    per_turn_reads = []
    per_msg_reads = []
    step_gaps = []  # seconds between consecutive API calls (model step latency proxy)
    files_read = 0
    for p in files:
        try:
            cwd, events, calls, order, read_meta, turn_reads, msg_reads = scan(p)
        except Exception as e:
            sys.stderr.write(f"skip {p}: {e}\n")
            continue
        files_read += 1
        fleet = bool(cwd) and cwd.startswith(FLEET_PREFIXES)
        scopes = ["all"] + (["fleet"] if fleet else [])
        # call costs in window
        win_calls = [m for m in order if calls[m][6] and calls[m][6] >= CUTOFF]
        if not win_calls:
            continue
        for s in scopes:
            n_sessions[s] += 1
        for m in win_calls:
            _o, _model, i, cw, cr, out, _ts = calls[m]
            c = W_IN * i + W_CW * cw + W_CR * cr + W_OUT * out
            for s in scopes:
                cost_total[s] += c
                calls_total[s]["input"] += i
                calls_total[s]["cache_write"] += cw
                calls_total[s]["cache_read"] += cr
                calls_total[s]["output"] += out
        # step latency proxy
        prev = None
        for m in order:
            ts = calls[m][6]
            if ts and prev and ts >= CUTOFF:
                gap = (ts - prev).total_seconds()
                if 0 < gap < 600:
                    step_gaps.append(gap)
            prev = ts or prev
        # calibration: call k whose only new content since call k-1 is one Read result
        seq = []  # list of (call_mid, [results since previous call])
        pending = []
        for ev in events:
            if ev[0] == "call":
                seq.append((ev[1], pending))
                pending = []
            elif ev[0] == "result":
                pending.append(ev)
            elif ev[0] == "compact":
                seq.append(("__compact__", []))
        for j in range(1, len(seq)):
            mid, res = seq[j]
            pmid, _ = seq[j - 1]
            if mid == "__compact__" or pmid == "__compact__":
                continue
            if len(res) == 1 and res[0][1] == "Read:image" and res[0][3] == 1 and res[0][2] < 400:
                a, b = calls[pmid], calls[mid]
                growth = (b[2] + b[3] + b[4]) - (a[2] + a[3] + a[4])
                if 0 < growth - a[5] < 20000:
                    img_calib.append(growth - a[5])
            if len(res) == 1 and res[0][1] == "Read:text" and res[0][2] > 4000 and not res[0][3]:
                a, b = calls[pmid], calls[mid]
                growth = (b[2] + b[3] + b[4]) - (a[2] + a[3] + a[4])
                tokens = growth - a[5]
                if tokens > 500:
                    calib.append(res[0][2] / tokens)
        # residency: for each result, count later calls in the same segment
        # walk events backward counting calls until a compact boundary
        later_calls = 0
        tail = []
        for ev in reversed(events):
            if ev[0] == "compact":
                later_calls = 0
            elif ev[0] == "call":
                later_calls += 1
            elif ev[0] == "result":
                tail.append((ev, later_calls))
        for ev, k in tail:
            _, cat, chars, imgs, inwin = ev
            if not inwin or k == 0:
                continue
            tok = chars / 3.3 + imgs * 1600  # replaced below by calibrated ratio (stored raw too)
            for s in scopes:
                agg[s][cat + "|chars"] += chars
                agg[s][cat + "|imgs"] += imgs
                agg[s][cat + "|count"] += 1
                # write once, read on every later call in the segment
                agg[s][cat + "|resid_chars"] += chars * (W_CW + W_CR * (k - 1))
                agg[s][cat + "|resid_imgs"] += imgs * (W_CW + W_CR * (k - 1))
                if cat in ("Read:text", "Bash:file-read", "Bash:search"):
                    t_est = chars / 2.3
                    b = "<2k" if t_est < 2000 else "2k-8k" if t_est < 8000 else "8k-20k" if t_est < 20000 else ">20k"
                    buckets[s][cat + "|" + b + "|n"] += 1
                    buckets[s][cat + "|" + b + "|resid_chars"] += chars * (W_CW + W_CR * (k - 1))
        for n, rtype, partial, ems, err in read_meta:
            read_types[rtype] += 1
            read_partial[partial] += 1
            read_errors += err
            if ems is not None and 0 <= ems < 600000:
                exec_ms.append(ems)
            if rtype == "text":
                read_sizes["all"].append(n)
                if fleet:
                    read_sizes["fleet"].append(n)
        per_turn_reads.extend(turn_reads.values())
        per_msg_reads.extend(msg_reads.values())

    cpt = statistics.median(calib) if calib else 3.3
    img_tok = statistics.median(img_calib) if img_calib else 1600

    def pct(xs, q):
        if not xs:
            return None
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(q * len(xs)))]

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_hours": HOURS,
        "files_read": files_read,
        "sessions": dict(n_sessions),
        "chars_per_token_calibrated": {"median": cpt, "n": len(calib), "p10": pct(calib, 0.1), "p90": pct(calib, 0.9)},
        "image_tokens_calibrated": {"median": img_tok, "n": len(img_calib), "p10": pct(img_calib, 0.1), "p90": pct(img_calib, 0.9)},
        "weights": {"input": W_IN, "cache_write_1h": W_CW, "cache_read": W_CR, "output": W_OUT},
    }
    for s in ("all", "fleet"):
        cats = sorted({k.split("|")[0] for k in agg[s]})
        rows = []
        for c in cats:
            resid_tok = agg[s][c + "|resid_chars"] / cpt + agg[s][c + "|resid_imgs"] * img_tok
            rows.append({
                "category": c,
                "results": int(agg[s][c + "|count"]),
                "tokens_entering_context": round(agg[s][c + "|chars"] / cpt + agg[s][c + "|imgs"] * img_tok),
                "share_if_3_chars_per_token_pct": round(100 * (agg[s][c + "|resid_chars"] / 3.0 + agg[s][c + "|resid_imgs"] * img_tok) / cost_total[s], 2) if cost_total[s] else None,
                "residency_weighted_cost": round(resid_tok),
                "share_of_total_weighted_spend_pct": round(100 * resid_tok / cost_total[s], 2) if cost_total[s] else None,
            })
        rows.sort(key=lambda r: -r["residency_weighted_cost"])
        ct = calls_total[s]
        out[s] = {
            "raw_tokens_deduped": dict(ct),
            "cache_read_share_of_raw_tokens_pct": round(100 * ct["cache_read"] / max(1, sum(ct.values())), 2),
            "total_weighted_spend": round(cost_total[s]),
            "weighted_spend_split_pct": {
                "input": round(100 * W_IN * ct["input"] / cost_total[s], 2),
                "cache_write": round(100 * W_CW * ct["cache_write"] / cost_total[s], 2),
                "cache_read": round(100 * W_CR * ct["cache_read"] / cost_total[s], 2),
                "output": round(100 * W_OUT * ct["output"] / cost_total[s], 2),
            } if cost_total[s] else None,
            "by_category": rows,
        }
        out[s]["size_buckets"] = {k: round(v / cpt) if k.endswith("resid_chars") else int(v) for k, v in sorted(buckets[s].items())}
        out[s]["size_buckets_share_pct"] = {k.replace("|resid_chars", ""): round(100 * v / cpt / cost_total[s], 2) for k, v in sorted(buckets[s].items()) if k.endswith("resid_chars")}
        rs = read_sizes[s]
        out[s]["read_result_tokens"] = {
            "n": len(rs),
            "p50": round(pct(rs, 0.5) / cpt) if rs else None,
            "p90": round(pct(rs, 0.9) / cpt) if rs else None,
            "p99": round(pct(rs, 0.99) / cpt) if rs else None,
            "share_of_read_tokens_from_top10pct": round(
                sum(sorted(rs)[int(0.9 * len(rs)):]) / max(1, sum(rs)) * 100, 1) if rs else None,
        }
    out["read_result_types"] = dict(read_types)
    out["read_partial_offset_or_limit"] = {str(k): v for k, v in read_partial.items()}
    out["read_errors"] = read_errors
    out["read_exec_ms"] = {"n": len(exec_ms), "p50": pct(exec_ms, 0.5), "p90": pct(exec_ms, 0.9), "p99": pct(exec_ms, 0.99)}
    out["reads_per_user_turn"] = {"n_turns_with_reads": len(per_turn_reads), "p50": pct(per_turn_reads, 0.5), "p90": pct(per_turn_reads, 0.9), "p99": pct(per_turn_reads, 0.99), "max": max(per_turn_reads) if per_turn_reads else None}
    out["reads_per_assistant_message"] = {"n": len(per_msg_reads), "p50": pct(per_msg_reads, 0.5), "p90": pct(per_msg_reads, 0.9), "max": max(per_msg_reads) if per_msg_reads else None, "share_parallel_gt1_pct": round(100 * sum(1 for x in per_msg_reads if x > 1) / max(1, len(per_msg_reads)), 1)}
    out["api_step_gap_seconds"] = {"n": len(step_gaps), "p50": pct(step_gaps, 0.5), "p90": pct(step_gaps, 0.9)}
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
