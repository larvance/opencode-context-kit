import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRIEF_LIMIT_CHARS, MARKER, cutAtMarker, resetPrompt } from "../core.ts"

// The plugin imports the runtime's plugin module. Resolve it to a local
// identity stub so the real adapter can be loaded and driven here.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@opencode/plugin") {
      return { url: new URL("./support/opencode-plugin.mjs", import.meta.url).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

const freshRoot = () => mkdtempSync(join(tmpdir(), "context-kit-"))

async function load(root: string) {
  const added: any[] = []
  const prompted: any[] = []
  let hook: ((event: any) => Promise<void>) | undefined
  const ctx = {
    location: { directory: root },
    command: { transform: async (fn: any) => fn({ add: (c: any) => added.push(c) }) },
    session: {
      get: async () => ({ directory: root }),
      prompt: async (p: any) => { prompted.push(p) },
      hook: async (name: string, fn: any) => { if (name === "context") hook = fn },
    },
  }
  const mod: any = await import("../index.ts")
  await mod.default.setup(ctx)
  assert.ok(hook, "the adapter must register a context hook")
  return { added, prompted, hook: hook as (event: any) => Promise<void> }
}

const user = (text: string) => ({ role: "user", parts: [{ text }] })

test("cutAtMarker keeps the marker and everything after it", () => {
  const messages = [
    user("before one"),
    { role: "assistant", parts: [{ text: "reply one" }] },
    user("before two"),
    { role: "assistant", parts: [{ text: "reply two" }] },
    user(`${MARKER}\n\nGoal for this phase: something`),
    { role: "assistant", parts: [{ text: "after" }] },
  ]
  assert.equal(cutAtMarker(messages), 4)
  const hooked = messages.slice()
  hooked.splice(0, cutAtMarker(hooked))
  assert.equal(hooked.length, 2)
  assert.match(hooked[0].parts[0].text, /Goal for this phase: something/)
})

test("cutAtMarker ignores a marker inside an assistant message", () => {
  const messages = [user("hello"), { role: "assistant", parts: [{ text: MARKER }] }]
  assert.equal(cutAtMarker(messages), 0)
})

test("cutAtMarker uses the last user marker, so the transcript can be cut twice", () => {
  const messages = [
    user(`${MARKER} first`),
    user("middle"),
    user(`${MARKER} second`),
    { role: "assistant", parts: [{ text: "tail" }] },
  ]
  assert.equal(cutAtMarker(messages), 2)
})

test("cutAtMarker reads both string and part-shaped content", () => {
  assert.equal(cutAtMarker([{ role: "user", text: "x" }, { role: "user", text: MARKER }]), 1)
  assert.equal(cutAtMarker([{ type: "user", content: [{ text: MARKER }] }]), 0)
})

test("an empty goal asks for an acknowledgement and no work", () => {
  const text = resetPrompt("")
  assert.match(text, /No goal was given/)
  assert.match(text, /Acknowledge this reset/)
  assert.doesNotMatch(text, /Goal for this phase/)
  assert.doesNotMatch(text, /run \/close/)
})

test("a goal is echoed and keeps the work instructions", () => {
  const text = resetPrompt("ship the queue endpoint")
  assert.match(text, /Goal for this phase: ship the queue endpoint/)
  assert.match(text, /run \/close and stop/)
})

test("the adapter registers reset and brief", async () => {
  const { added } = await load(freshRoot())
  assert.deepEqual(added.map((c) => c.name), ["reset", "brief"])
})

test("/reset with no argument posts the acknowledgement prompt", async () => {
  const { added, prompted } = await load(freshRoot())
  const reset = added.find((c) => c.name === "reset")
  await reset.execute({ sessionID: "ses_test", prompt: { text: "/reset" }, delivery: "queue" })
  assert.equal(prompted.length, 1)
  assert.match(prompted[0].text, /No goal was given/)
})

test("/reset with a goal posts that goal", async () => {
  const { added, prompted } = await load(freshRoot())
  const reset = added.find((c) => c.name === "reset")
  await reset.execute({ sessionID: "ses_test", prompt: { text: "/reset finish the plugin" }, delivery: "queue" })
  assert.match(prompted[0].text, /Goal for this phase: finish the plugin/)
})

test("the hook drops exactly what precedes the marker in a real payload", async () => {
  const { hook } = await load(freshRoot())
  const messages = [
    user("old turn"),
    { role: "assistant", parts: [{ text: "old reply" }, { text: "tool noise" }] },
    user("older turn"),
    { role: "assistant", parts: [{ text: "old reply 2" }] },
    user(`${MARKER}\n\nGoal for this phase: prove it`),
  ]
  const event = { sessionID: "ses_test", messages, system: [] }
  await hook(event)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].parts[0].text.includes(MARKER), true)
  assert.equal(event.system.length, 0, "no brief file means no injected block")
})

test("a payload without a marker is untouched", async () => {
  const { hook } = await load(freshRoot())
  const messages = [user("one"), { role: "assistant", parts: [{ text: "two" }] }, user("three")]
  await hook({ sessionID: "ses_test", messages, system: [] })
  assert.equal(messages.length, 3)
})

test("the compiled brief is injected into the system block", async () => {
  const root = freshRoot()
  mkdirSync(join(root, ".opencode", "context"), { recursive: true })
  writeFileSync(join(root, ".opencode", "context", "BRIEF.md"), "# Project\n\nA test project.\n")
  const { hook } = await load(root)
  const event: any = { sessionID: "ses_test", messages: [user("hi")], system: [] }
  await hook(event)
  assert.equal(event.system.length, 1)
  assert.match(event.system[0].text, /A test project/)
  assert.doesNotMatch(event.system[0].text, /may be stale/)
})

test("a brief newer than the notes is not stale, an older one is", async () => {
  const root = freshRoot()
  const dir = join(root, ".opencode", "context")
  mkdirSync(dir, { recursive: true })
  const brief = join(dir, "BRIEF.md")
  const notes = join(dir, "notes.md")
  writeFileSync(brief, "brief body")
  writeFileSync(notes, "# Raw notes")
  utimesSync(brief, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
  const { hook } = await load(root)
  const fresh: any = { sessionID: "ses_test", messages: [], system: [] }
  await hook(fresh)
  assert.doesNotMatch(fresh.system[0].text, /may be stale/)

  utimesSync(notes, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000))
  const stale: any = { sessionID: "ses_test", messages: [], system: [] }
  await hook(stale)
  assert.match(stale.system[0].text, /may be stale/)
})

test("an oversized brief is truncated to the injected budget", async () => {
  const root = freshRoot()
  const dir = join(root, ".opencode", "context")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "BRIEF.md"), "x".repeat(BRIEF_LIMIT_CHARS + 5_000))
  const { hook } = await load(root)
  const event: any = { sessionID: "ses_test", messages: [], system: [] }
  await hook(event)
  assert.match(event.system[0].text, /\[truncated: brief exceeds the injected budget\]/)
  assert.ok(event.system[0].text.length < BRIEF_LIMIT_CHARS + 200)
})
