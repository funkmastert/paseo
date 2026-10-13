---
title: A command-text gate must read a target it can't resolve as "could be any device", never "no device"
date: 2026-10-13
category: security-issues
module: device-leases
problem_type: security_issue
component: tooling
symptoms:
  - "agents sharing one leased phone install their builds over each other, and the install gate refuses none of it"
  - "the leader's command was one line shaped like `S=FAKESERIAL001; adb -s $S install -r -d app.apk`"
  - "a physical device's status shows held 0s for a lease held for minutes"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [device-leases, install-gate, adb, shell-parsing, fail-closed, command-text-gate]
---

# A command-text gate must read a target it can't resolve as "could be any device", never "no device"

## Problem

The physical-device install gate read the device target in a command as literal text. `S=FAKESERIAL001; adb -s $S install app.apk` named a device called `$S`. No connected device had that id, so the gate took the "names a device I don't see, nothing to protect" branch and allowed it. The shell then expanded `$S` to the leased phone's serial, and agents installed over each other's builds. Fixed in PR #30.

## Symptoms

- Two agents' builds replace each other on one leased phone, with no refusal in either transcript.
- The offending command assigns the serial to a variable first, in the same line, and passes the variable to `-s`.
- Separately, the status strip shows "held 0s" for a lease held for minutes. `device_status_update` only pushed on a lease-table change, so a quietly held lease kept its bind-time `heldForSeconds`.

## What Didn't Work

Each early attempt inside #30 closed one shape and left the fail-open default in place for the next (session history).

- **Resolving bare `NAME=value` only (round 1).** `export S=…; adb -s $S install` still slipped through, because `export` was the first token and assignment collection stopped there. So did `$(adb devices | awk …)`, backticks, `${S:-x}`, and a variable set in an earlier tool call. Every shape the resolver didn't cover still fell into "no matching device, so allow". No resolver covers every shell shape, so the fix has to be failing closed on whatever stays unresolved.
- **Tokenizing `$(…)` like any other text.** A `|` or space inside the substitution split the command into fragments. The install then produced zero intents and was invisible to the gate, before target resolution even ran.
- **The first atomic-span scanner.** An unterminated `$(` or backtick scanned to the end of the string and swallowed a later `&& adb install` into one token. That is the same zero-intent bypass from the other direction.
- **Auto-binding the lone phone.** The first fail-closed fallback bound the only connected phone when the target was unresolved. It ignored emulators: `-s $X` can just as well name an emulator adb can reach, so binding the phone would either lease a device the command never touches or refuse a command headed for an emulator.

## Solution

The rules now live in [device-leases.md, "What the gate checks"](../../device-leases.md#what-the-gate-checks). In short:

1. Resolve what the shell would resolve from the same line: `NAME=value`, including after a flagless `export`/`declare`/`local`/`readonly` (`collectVariableAssignments`, `packages/server/src/server/agent/device-install-commands.ts:73`).
2. Mark any target that still holds shell syntax as unresolved: a `$`, a backtick, or xargs' `{}` (`UNEXPANDED_SHELL_SYNTAX`, `device-install-commands.ts:60`).
3. Never send an unresolved target down the literal-name branch (`physical-device-lease-manager.ts:559`). It goes to the ambiguity logic instead. One reachable device, emulators counted, means that device: bind it if free, refuse if held. More than one is refused with "Name the device literally" (`physical-device-lease-manager.ts:584-594`). It never gets the plain-adb "adb picks for itself" exemption, because `-s $X` already picked.
4. Keep `$(…)` and backtick spans as one token in `tokenizeCommandSegments` (`packages/server/src/server/agent/device-launch-commands.ts:87`). An unterminated span falls back to ordinary tokenization instead of eating the rest of the line.
5. Strip `xargs` and its flags in `stripCommandPrefixes` (`device-launch-commands.ts:180`), so `… | xargs adb -s FAKESERIAL001 install` reaches the same matchers as a direct call.

The held-time fix: each resource-monitor sweep now pushes a fresh status snapshot while a lease is held, unless that sweep already pushed one.

## Why This Works

A command-text gate sees text, never the shell that runs it. A literal name it can't find connected really does point at nothing it protects. A name it can't read points at a device it can't identify, which can be the one another agent holds. The two looked identical to the matcher: a string with no matching connected device. Splitting them, and treating the unreadable one like an untargeted command, closes the bypass for every shell shape at once, including ones nobody listed.

## Prevention

- For any gate that parses command text, decide explicitly what an unresolvable value means, and make it the restrictive answer when the action can't be undone. An install overwrite can't be caught after the fact. Two other gates in this repo choose the permissive answer on purpose:
  - The emulator launch cap fails open on uncertainty ([device-leases.md, "Enforcement"](../../device-leases.md#enforcement)). Its process scan catches an extra emulator a sweep later.
  - The catastrophe gate passes values it can't see ([catastrophe-gate.md, "Known gaps"](../../catastrophe-gate.md#known-gaps)) because its scope is two actions only.
- Replay the real incident's command shape in a test, not only parser unit cases. `physical-device-lease-manager.test.ts` replays the leader's one-liner, `$(…)` with an inner `|`, `xargs` with and without `{}`, and an unresolved target with an emulator running. `device-install-commands.test.ts` covers the `export`/`declare`/`readonly` forms, and `device-launch-commands.test.ts` covers unterminated `$(` and backtick spans.
- Known gaps, still open: a variable set in an earlier, separate tool call (the gate sees one command line at a time), and `sh -c '…'` wrappers.
- Installs onto an emulator or simulator another agent holds were closed in a follow-up: `DeviceLeaseManager.gateInstall` (`device-lease-manager.ts`) applies the same rules to running devices, including the `ambiguousWithPhones` mirror of this gate's `ambiguousWithEmulators`.

## Related Issues

- [guard-every-return-path-key-on-true-signal.md](guard-every-return-path-key-on-true-signal.md): the same class of bug in the classifier, where a guard read a field whose meaning changed per path.
- [pager-cap-exhaustion-must-fail-not-succeed-silently.md](../logic-errors/pager-cap-exhaustion-must-fail-not-succeed-silently.md): an unknown state recorded as success.
