# Project knowledge base

One local knowledge base, shared by every agent session and Tyler's own Knowledge screen. A project is an initiative Tyler starts with an agent — it may span several repos — and its note holds the links, decisions, rules and status for that initiative. The point: a fresh agent given a loose reference ("the project where we did X") finds the links and decisions without Tyler re-pasting them.

It is built on [Basic Memory](https://github.com/basicmachines-co/basic-memory): plain Markdown notes, indexed into a knowledge graph, versioned however Tyler already versions his files. See [glossary.md](glossary.md) for **Knowledge project** and **Inbox** as product terms.

Off by default. See [Turning it on](#turning-it-on) for what Tyler does after a build lands this feature.

## Shape of the system

- **The daemon writes.** Every create, join, record, rename, merge and view-edit goes through one write path (`packages/server/src/server/knowledge-base/note-store.ts`). Basic Memory never writes a note; it only indexes the directory and answers search.
- **`KnowledgeBaseService`** (`packages/server/src/server/knowledge-base/service.ts`) owns project resolution, creation, dedupe, join, record, rename and merge. It is the one thing that knows which agent and workspace belong to which project.
- **Four agent tools** (`kb_search`, `kb_open`, `kb_create`, `kb_record`) on the `paseo` MCP catalog (`packages/server/src/server/agent/tools/knowledge-base-tools.ts`) are how any provider reaches the service — not Basic Memory's own MCP server, which the gateway can broker to Claude only.
- **`kb.*` RPCs** (`packages/protocol/src/knowledge-base/rpc-schemas.ts`) are the app's read/edit surface: the Knowledge screen (sidebar row, Command Center entry) browses, reads, edits and searches notes, and shows the graph.
- **The Basic Memory sidecar** (`packages/server/src/server/knowledge-base/basic-memory-sidecar.ts`) is a daemon-supervised stdio child process the daemon talks MCP to, for indexing and search only.

## The note format

A project is one file at `projects/<slug>.md`. The Inbox is one file at `inbox.md`. Frontmatter carries `title`, `type` (`project` or `inbox`), `permalink`, `tags`, `aliases` and `created`. A project's sections are fixed and in this order: `## Summary`, `## Links`, `## Decisions`, `## Rules`, `## Status`, `## Sessions`, `## Related`.

Entries are Basic Memory observations, one per line:

```
- [figma] https://figma.com/file/... (2026-10-07)
- [decision] Store users as a joined table — simpler migration than embedding them
```

A category in brackets, then text, then an optional date or `— why` suffix. Basic Memory indexes each line as its own fact, so a flag name, ticket key or Figma URL is searchable on its own (`packages/server/src/server/knowledge-base/note-format.ts`).

Parsing and serializing preserve every frontmatter key and section the code does not itself own, in their original order, so an edit made in Obsidian round-trips byte-for-byte. A daemon write checks the file's `modifiedAt` before writing and refuses (a conflict, not a silent overwrite) when it has changed since the write's caller last read it.

## The write path, and why it is the only one

Filing a pasted link, an agent's `kb_record`, Tyler's edit in the view, a rename, a merge — all of them call `NoteStore.write` (`packages/server/src/server/knowledge-base/note-store.ts`). That gives the feature three things a Basic-Memory-writes design would not:

- Link filing keeps working when Basic Memory is down, because filing never depends on Python being up.
- The secret scrub (below) sits at one choke point for everything the daemon ever writes, instead of being re-implemented per writer.
- Filing and the view's tests run without a Python process at all.

Basic Memory still owns the format, the index and the graph: it watches the notes directory (1 s debounce) and answers `search_notes`; backlinks and the graph come from the daemon's own wiki-link scan instead (`extractWikiLinkTargets` in `note-format.ts`). Basic Memory's own frontmatter write-back is switched off in its environment (below), so it never writes a note out from under the daemon.

## Project resolution

A session's project is resolved once, at agent create, in this order — never by a model call:

1. An explicit `paseo.kb-project` label (`KB_PROJECT_LABEL`, `packages/protocol/src/agent-labels.ts`) — its value is the project's slug.
2. The parent agent's project, if it has one.
3. A tagged worktree workspace's project. A workspace is tagged only the first time an agent joins from it, and only when it is a `worktree` — a local checkout or a plain directory usually hosts more than one initiative.

Resolution runs after every `before("agent.create")` plugin hook has set its labels, and before the agent's first launch — the session-start summary (below) is built from whichever project this resolves to. A session that matches none of the three stays untagged; its pasted links go to the Inbox until an agent calls `kb_open` or `kb_create` during the session, at which point the Inbox entries this session filed move into the opened or created project.

Dedupe on `kb_create`, under one knowledge-base lock, in this order:

1. A `figma`, `ticket` or `pr` link this session already filed sits in exactly one existing project: join it.
2. A project's normalized title or alias equals the new title (lowercased, punctuation and platform words like iOS/Android/web/desktop/app removed): return it as a candidate, create nothing.
3. Basic Memory's hybrid vector search on the title and summary returns projects scoring at or above `0.7` (`BASIC_MEMORY_DEDUPE_MIN_SCORE`, `packages/server/src/server/knowledge-base/basic-memory-client.ts`): return the top three as candidates, create nothing.
4. Otherwise create.

`confirmNew: true` on `kb_create` skips rules 2 and 3. Sharing a parent never joins two sessions to the same project by itself — a parent fans out unrelated work — but a child created after its parent already has a project inherits it through rule 2 above.

## Link capture: what is and isn't filed

The daemon scans only **human-typed** prompt text for `http(s)` URLs: the app's send path, and the initial prompt on agent create. Agent-to-agent prompts are never scanned — those links were Tyler's, in the parent's session, and were filed there already. A link an agent produces itself is filed by the agent, with `kb_record`.

Not filed: loopback and private-network hosts (`localhost`, `127.0.0.1`, `10.x`, `172.16-31.x`, `192.168.x`, link-local) — noise from a dev server on the same machine. A link already present in the target note is not filed twice.

Extraction and every wiki-link pattern in this feature are linear: a single global match with no nested or optional-inside-repeated quantifier, each with a 640 KB hostile-input timing test under 100 ms (`packages/server/src/server/knowledge-base/link-capture.ts`, `note-format.ts`). A backtracking pattern here froze the daemon once before (2026-10-06); this is the fix, not a guideline.

## The secret scrub

Every write goes through `scrub.ts` before it reaches disk:

- A URL loses its userinfo and any query parameter whose name looks like a secret (`token`, `key`, `secret`, `sig`/`signature`, `password`, `auth`, `code`, `x-amz-*`). If a token-shaped string is still in the URL after that — in the path, say — the whole URL is dropped rather than filed half-scrubbed.
- Free text (an agent's `kb_record`, Tyler's edit, a summary) has every token-shaped span replaced with `[redacted]`, using the same token patterns `agent/snapshot-secret-filter.ts` uses elsewhere, so the two scrubbers can't drift apart.
- A write reports how many spans it removed; the view surfaces that count to Tyler.

Only URLs are filed from human prompts — never the surrounding text — so a token pasted next to a link is never read into a note in the first place.

## Local-only enforcement

Nothing about the knowledge base leaves the Mac:

- The sidecar's environment sets `BASIC_MEMORY_FORCE_LOCAL=true`, `BASIC_MEMORY_CLOUD_MODE=false`, `BASIC_MEMORY_AUTO_UPDATE=false`, `BASIC_MEMORY_NO_PROMOS=true`, and strips any `BASIC_MEMORY_*` variable the daemon's own process happened to inherit, so an ambient cloud key or project-home setting never reaches the child (`buildBasicMemoryEnv`, `basic-memory-sidecar.ts`).
- `BASIC_MEMORY_CONFIG_DIR` points inside the notes directory (`<notesDir>/.bozeo/basic-memory`), never at the user's home; `BASIC_MEMORY_DISABLE_PERMALINKS=true` stops Basic Memory from writing a permalink into a note's frontmatter on its own.
- The sidecar talks MCP over **stdio**, not HTTP — nothing binds a port, so there is nothing on the machine's network surface to disable.
- Semantic search (on by default, `knowledgeBase.basicMemory.semanticSearch`) downloads a small embedding model from Hugging Face the first time it runs. That is an inbound download only: no note content is sent anywhere to get it. Set `semanticSearch: false` to skip it entirely.

## The AGPL boundary

Basic Memory is AGPL-3.0. The daemon runs it as a separate local process and talks to it only by invoking its command line (`project add`, `--version`, `mcp`) and speaking MCP over stdio — it is never imported, vendored, forked or linked into this repo. That keeps the two programs at arm's length: Bozeo's own license is unaffected, and the AGPL's network clause (which reaches a modified version offered to others over a network) doesn't reach a program that only shells out to an unmodified one. The repo carries no Basic Memory code — only the command line that starts it.

## Inside the notes directory

`knowledgeBase.notesDir` (default `<PASEO_HOME>/knowledge`) holds:

- `inbox.md` and `projects/<slug>.md` — the Markdown notes themselves; this is what to point an Obsidian vault at.
- `.bozeo/assignments.json` — each agent's session-start summary snapshot and each tagged workspace's project (`packages/server/src/server/knowledge-base/assignments.ts`). Basic Memory skips dot-directories when it indexes, so this file and the one below are invisible to it.
- `.bozeo/basic-memory/` — the sidecar's isolated config directory: its own `config.json` (which Basic Memory project is registered where), its SQLite index, and the downloaded embedding model cache. A `.gitignore` inside it (written by the sidecar) keeps all of this out of git — it rebuilds from the notes on first run.

## Config keys

```json
{
  "knowledgeBase": {
    "enabled": false,
    "notesDir": "/path/to/notes",
    "basicMemory": {
      "command": "basic-memory",
      "semanticSearch": true
    }
  }
}
```

Every key is optional and defaults as shown; an absent section is the same as `enabled: false`. A section that fails to parse (wrong-typed field, unknown key) disables the feature and logs why, instead of rejecting the rest of `config.json` — the `agents.jev` pattern (`packages/server/src/server/knowledge-base/config.ts`). The Basic Memory version pin (currently `0.23.2`), the Basic Memory project name, and the session-start summary's 800-character cap are code constants, not config.

The section is in `RELOADABLE_PATHS`, so `paseo daemon reload` picks up a change without a restart — though it does not currently list `knowledgeBase` in its `appliedPaths` output, so a reload applies it silently. It is also in `MACHINE_JOBS_OFF`, so no scratch or test daemon starts Basic Memory unless a test asks for it.

## What an agent sees

While the feature is on, every agent gets four tool definitions (`kb_search`, `kb_open`, `kb_create`, `kb_record`) and one fixed guidance paragraph, under 120 tokens, appended to its system prompt (`KNOWLEDGE_BASE_GUIDANCE`, `packages/server/src/server/agent/knowledge-base-prompt.ts`). The text never varies per agent, so it costs no extra prompt-cache rebuild beyond the one that comes from switching the feature on or off.

An agent resolved to a project at create also gets a stored summary snapshot: the title, the `## Summary` paragraph, how many links and decisions the note holds, and a pointer to `kb_open` for the rest — capped at 800 characters, taken once, and appended on every relaunch so the prompt stays identical across resume and reload. Copilot over ACP reads neither system-prompt field, so for it the snapshot rides on the agent's first prompt instead, chained after refocus.

An agent may only write (`kb_record`) into a project it opened or created this session — not an arbitrary one a prompt names — because notes feed future agents' context and a prompt-injected "record this" must not be able to poison a project the session never touched.

## Doctor and setup

`paseo doctor` includes a `knowledgeBase.basicMemory` check when the section is enabled: whether the notes directory is writable, whether the configured binary resolves, and its version against the pin — read through `uv tool list`, never by running `basic-memory` itself (even `--version` initializes its config directory as a side effect without the sidecar's lockdown environment, which doctor must never do). See [doctor.md](doctor.md).

`paseo kb setup` finds `uv`, prints the per-OS install line when it is missing, otherwise runs `uv tool install basic-memory==<pin> --prerelease=allow` and prints the resolved binary path and the config block to add. See [install.md](install.md#set-up-the-knowledge-base).

## Turning it on

After a build lands this feature, it ships switched off. To turn it on:

1. `paseo kb setup` — installs the pinned Basic Memory release.
2. Add the `knowledgeBase` config block above to `config.json`, with `enabled: true`.
3. `paseo daemon reload`.
4. `paseo kb seed "<project name>" [--hint <text>]` for each project active now — one seed agent per name, reading a bounded set of sources (the matching repos' `docs/plans` and auto-memory files, `~/bozeo-ops` briefs and state, and Bozeo's own agent history through the `paseo` tools), filing what it finds through the same `kb_*` tools, citing a source on every entry, and ending with a recall self-check (`packages/cli/src/commands/kb/seed-brief.ts`). Project names are command arguments, never code — no Wonderly initiative name lives in this repo.
5. Check the seeded projects in the Knowledge screen.
