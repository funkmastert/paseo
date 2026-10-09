# Codex workers

A daemon-launched Codex child agent is a worker running under full guard coverage: the catastrophe gate, the native build gate, the device cap, and the physical-device install gate. Codex children have guards and are subject to caps; otherwise they work like any other agent.

## Binary discovery

The daemon finds Codex in this order:

1. PATH — any `codex` command available in the shell
2. ChatGPT bundle — `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (macOS) or `~/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (user-installed, macOS)
3. Microsoft Store package `OpenAI.Codex_*` (Windows only)
4. `agents.providers.codex.command` in config — overrides all of the above

If none of these work, the error lists every path searched. Configure `agents.providers.codex.command` to specify a custom path.

## Platform notes

### macOS

The daemon probes `/Applications/ChatGPT.app` and `~/Applications/ChatGPT.app`. Both are checked.

### Windows

The Microsoft Store package `OpenAI.Codex_*` is the standard source. The daemon scans `%LOCALAPPDATA%\Packages` for packages starting with that prefix, sorted by name, and probes each candidate.

If the ChatGPT desktop app bundles Codex on Windows, that path will be added; this has not yet been verified on Windows builds.

### Known gaps

- Interactive shell input typed during a running Codex turn gets no PreToolUse hook event. The same gap Claude has: a tool call is visible when you press Enter, not as you type.

## Codex guard health

Before any worker child is routed to Codex, a self-test proves the guard works: one ordinary command must run, and one canary command must be denied. The test runs at daemon startup, daily, and whenever the Codex binary version changes.

If the guard health is `red` or `unknown`, Codex refs are unusable for children.

## Limitations and future work

- Guarding `apply_patch` and MCP calls awaits follow-up work.
- Adding newly ranked models to pools automatically is deferred.
