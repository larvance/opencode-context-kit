/**
 * Pure logic for the context kit. No imports, no filesystem, no network, so
 * every decision the plugin makes about a request payload can be tested
 * without the OpenCode runtime.
 */

export const MARKER = "=== RESET ==="
export const BRIEF_LIMIT_CHARS = 16_000

export function messageText(message: any): string {
  if (!message) return ""
  if (typeof message.text === "string") return message.text
  const parts = message.parts ?? message.content
  if (Array.isArray(parts)) {
    return parts.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
  }
  return ""
}

/** Index of the last user message carrying the marker, or 0 when there is none. */
export function cutAtMarker(messages: any[] | undefined): number {
  const list = messages ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i] as any
    if ((m?.role ?? m?.type) !== "user") continue
    if (messageText(m).includes(MARKER)) return i
  }
  return 0
}

/** The visible message a reset posts. An empty goal means "do nothing yet". */
export function resetPrompt(goal: string): string {
  const g = (goal ?? "").trim()
  if (!g) {
    return [
      MARKER,
      "",
      "No goal was given. Acknowledge this reset in one line and stop.",
      "",
      "Everything before this marker is no longer in your context and the transcript",
      "still shows it. Do not start work, do not read files, do not ask questions.",
      "Wait for the next instruction.",
    ].join("\n")
  }
  return [
    MARKER,
    "",
    `Goal for this phase: ${g}`,
    "",
    "Everything before this marker is intentionally no longer in your context.",
    "If you need a fact from it, read the file on disk instead of asking for it.",
    "Read the project brief above, restate the goal and the single next action in",
    "five lines, then work only that. Batch shell commands. When the goal is",
    "achieved, run /close and stop.",
  ].join("\n")
}
