# opencode-context-kit

Two features that keep a long OpenCode session cheap without losing anything
you can see.

## 1. `reset` — a cut, not a clear

Type `/reset <goal>` in any session. A visible `=== RESET ===` message is
posted, and the plugin drops every message before the last marker from the
outgoing model request only. The transcript in the UI is untouched; the payload
is not.

With no goal, the marker itself says what to do:

```
/reset
```

```
=== RESET ===

No goal was given. Acknowledge this reset in one line and stop.
...
```

Add a goal and it asks for that goal back, plus the next action, before any
work starts:

```
/reset ship the queue endpoint
```

The cut takes effect on the next request. Only user messages can carry a
marker, so quoting `=== RESET ===` in a model reply or in a file does not cut
anything.

## 2. `brief` — compiled context, injected once

```
/brief add the staging host is reachable over the tunnel
/brief build
/brief reset
```

`add` appends a raw note, with no model call. `build` asks the agent to compile
`.opencode/context/BRIEF.md` from the notes plus a short inspection of the
project. The brief is then pushed into the system prompt of every request, so
the model never re-derives what the project is. It is capped at 16k characters
and marked stale when the notes are newer than the brief.

## Storage

```
<project>/.opencode/context/notes.md   raw notes, append-only
<project>/.opencode/context/BRIEF.md   compiled brief, injected
<project>/.opencode/context/meta.json  build metadata
```

All local. No network calls, nothing outside the project directory.

## Install

Clone or copy this directory, then add it to `plugins` in `opencode.json`:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-context-kit"]
}
```

Restart OpenCode. A successful load writes
`loaded root=<directory>` to `~/.local/share/opencode/context-plugin.log`.

## Tests

The payload decisions live in `core.ts`, which has no imports and no
filesystem access. `test/` drives it and the real adapter through a stub of the
plugin module, so the cut and the brief injection are checked without a running
OpenCode process.

```sh
npm test        # node --test, Node 22.15 or newer
```

## Layout

| Path | Role |
| --- | --- |
| `index.ts` | plugin adapter: commands, hooks, filesystem |
| `core.ts` | pure payload logic: marker cut, prompt text |
| `test/` | node:test suites and the plugin-module stub |
