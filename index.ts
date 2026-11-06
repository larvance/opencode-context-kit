import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRIEF_LIMIT_CHARS, MARKER, cutAtMarker, resetPrompt } from "./core.ts"

/**
 * Two cheap-context features in one plugin:
 *
 *   reset  - a visible marker in the transcript that cuts what the model sees,
 *            without deleting history from the UI.
 *   brief  - a compiled project brief that is injected into the system prompt
 *            every request, so the model never re-derives what the project is.
 *
 * Both are local-only: no network, no storage outside the project directory.
 * The payload decisions live in core.ts, which has no imports and is tested
 * directly in test/.
 */

const LOG = join(homedir(), ".local/share/opencode/context-plugin.log")

function log(line: string) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function contextFiles(root: string) {
  const dir = join(root, ".opencode", "context")
  return {
    dir,
    notes: join(dir, "notes.md"),
    brief: join(dir, "BRIEF.md"),
    meta: join(dir, "meta.json"),
    ensure() {
      mkdirSync(dir, { recursive: true })
      if (!existsSync(this.notes)) writeFileSync(this.notes, "# Raw notes\n\n")
      return this
    },
  }
}

function readBrief(root: string): { text: string; stale: boolean } {
  const f = contextFiles(root)
  if (!existsSync(f.brief)) return { text: "", stale: false }
  let text = readFileSync(f.brief, "utf8")
  if (text.length > BRIEF_LIMIT_CHARS) {
    text = text.slice(0, BRIEF_LIMIT_CHARS) + "\n\n[truncated: brief exceeds the injected budget]"
  }
  let stale = false
  try {
    stale = existsSync(f.notes) && statSync(f.notes).mtimeMs > statSync(f.brief).mtimeMs
  } catch {}
  return { text, stale }
}

export default Plugin.define({
  id: "context-kit",
  async setup(ctx) {
    // The plugin may be loaded for a broader location than the session that is
    // asking, so resolve the project root per session and fall back to the load
    // location only when the session cannot be read.
    const rootFor = async (sessionID: string): Promise<string> => {
      try {
        const s: any = await ctx.session.get({ sessionID })
        const d = s?.directory ?? s?.data?.directory ?? s?.location?.directory
        if (typeof d === "string" && d) return d
      } catch {}
      return ctx.location.directory
    }
    log(`loaded root=${ctx.location.directory}`)

    // --- commands -----------------------------------------------------------
    await ctx.command.transform((editor) => {
      editor.add({
        name: "reset",
        description: "Cut what the model sees from here on; history stays visible",
        execute: async ({ sessionID, prompt, delivery }) => {
          const goal = (prompt.text ?? "").replace(/^\/reset\s*/i, "").trim()
          log(`reset session=${sessionID} goal_chars=${goal.length}`)
          await ctx.session.prompt({ ...prompt, sessionID, text: resetPrompt(goal), delivery })
        },
      })

      editor.add({
        name: "brief",
        description: "Compiled project brief: add <note> | build | reset",
        execute: async ({ sessionID, prompt, delivery }) => {
          const root = await rootFor(sessionID)
          const args = (prompt.text ?? "").replace(/^\/brief\s*/i, "").trim()
          const [sub, ...rest] = args.split(/\s+/)
          const files = contextFiles(root).ensure()

          if (sub === "add") {
            const note = rest.join(" ").trim()
            if (!note) return
            appendFileSync(files.notes, `- ${new Date().toISOString().slice(0, 10)}: ${note}\n`)
            log(`brief add chars=${note.length}`)
            return
          }

          if (sub === "reset") {
            writeFileSync(files.notes, "# Raw notes\n\n")
            if (existsSync(files.brief)) writeFileSync(files.brief, "")
            writeFileSync(files.meta, JSON.stringify({ resetAt: new Date().toISOString() }, null, 2))
            log("brief reset")
            return
          }

          // default: build
          const text = [
            "Compile the project brief. Work only on that and stop when it is written.",
            "",
            `1. Read ${files.notes}`,
            "2. Inspect the project structure with a few targeted commands: top-level",
            "   directories, build and test entry points, the main module of each",
            "   subsystem, and any conventions file (README, AGENTS.md, CONTRIBUTING).",
            `3. Write ${files.brief} in markdown, at most 120 lines, covering:`,
            "   - what this project is, in two sentences",
            "   - how it is built, run and tested, with exact commands",
            "   - the module map: three to ten paths and one line each",
            "   - conventions that a newcomer would violate otherwise",
            "   - invariants and gotchas, including anything surprising you found",
            `4. Write ${files.meta} with builtAt, model and the paths you inspected.`,
            "",
            "Do not summarise file contents line by line. Prefer durable facts over detail.",
            "Do not read other projects.",
          ].join("\n")
          log(`brief build requested session=${sessionID}`)
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
      log("commands registered: reset, brief")
    })

    // --- request hook -------------------------------------------------------
    await ctx.session.hook("context", async (event) => {
      try {
        const root = await rootFor(event.sessionID)
        const messages = event.messages ?? []

        const cut = cutAtMarker(messages)
        if (cut > 0) messages.splice(0, cut)

        const brief = readBrief(root)
        if (brief.text.trim()) {
          event.system.push({
            type: "text",
            text:
              "# Project brief (compiled, do not re-derive)\n\n" +
              (brief.stale ? "> Note: raw notes changed after this brief was built; it may be stale.\n\n" : "") +
              brief.text,
          })
        }

        log(`request session=${event.sessionID} root=${root} dropped=${cut} kept=${messages.length} brief_chars=${brief.text.length}`)
      } catch (error) {
        log(`hook error ${String(error)}`)
      }
    })
  },
})
