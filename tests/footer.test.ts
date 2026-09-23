// Stage 3A production-integration tests. The formatting, fitting, and row
// rendering units live in their own suites (`format.test.ts`, `layout.test.ts`,
// `status-row.test.tsx`); this file pins what `footer.tsx` owns: the
// host-derived context scan, the setup wiring (claims, tracker subscriptions,
// throttle timer), and the rendered slots — widget-driven rows from real
// options, alternate corners, reordering and hiding, overflow by priority,
// path shortening, whole-branch hiding, colon joining, context bars, zero
// cost, home
// behavior, resize, and session switches.
import { describe, expect, test } from "bun:test"
import type { ModelRef, SessionMessageAssistant, SessionMessageInfo, TokenUsageInfo } from "@opencode/client"
import { RGBA } from "@opentui/core"
import type { WidthMethod } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { testRender } from "@opentui/solid"
import { homedir } from "node:os"
import { createSignal } from "solid-js"
import { DEFAULT_LAYOUT, type StatusOptionsInput } from "../src/options.ts"
import { DEFAULT_TPS_OPTIONS, type TpsOptionsInput } from "../src/tps.ts"
import { GLYPH_BRANCH, GLYPH_FOLDER_CLOSED, GLYPH_FOLDER_OPEN, GLYPH_FOLDER_OPEN_O as GLYPH_FOLDER, GLYPH_WORKTREE } from "../src/format.ts"
import { measureCells } from "../src/layout.ts"
import definition, { backgroundUsage, contextUsage, lastAssistantWithUsage } from "../src/footer.tsx"
import { BLOCK_FRAMES } from "../src/widgets.tsx"

const TEST_MODEL: ModelRef = { id: "test-model", providerID: "test" }

function usage(input: number, output = 0, reasoning = 0, read = 0, write = 0): TokenUsageInfo {
  return { input, output, reasoning, cache: { read, write } }
}

function assistantMessage(id: string, tokens: TokenUsageInfo, model: ModelRef = TEST_MODEL): SessionMessageAssistant {
  return { id, time: { created: 0 }, type: "assistant", agent: "test", model, content: [], tokens }
}

function compactionMessage(id: string): SessionMessageInfo {
  return { id, time: { created: 0 }, type: "compaction", status: "completed", reason: "auto", summary: "", recent: "" }
}

describe("contextUsage", () => {
  const models = [{ id: "test-model", providerID: "test", limit: { context: 8_000 } }]

  test("sums the last assistant message after the last completed compaction", () => {
    const messages: SessionMessageInfo[] = [
      assistantMessage("m1", usage(10, 0)),
      compactionMessage("c1"),
      assistantMessage("m2", usage(1_000, 200, 100, 20, 5)),
    ]

    expect(contextUsage(messages, models)).toEqual({ tokens: 1_325, limit: 8_000, percent: 17 })
  })

  test("stops at the revert boundary", () => {
    const messages: SessionMessageInfo[] = [assistantMessage("m1", usage(500, 0)), assistantMessage("m2", usage(900, 0))]

    expect(contextUsage(messages, undefined, "m2")).toEqual({ tokens: 500, limit: undefined, percent: undefined })
  })

  test("returns nothing without a usable message", () => {
    expect(contextUsage([], undefined)).toBeUndefined()
    expect(contextUsage([assistantMessage("m1", usage(0, 0))], undefined)).toBeUndefined()
  })

  test("keeps the token count when the model is unknown", () => {
    expect(contextUsage([assistantMessage("m1", usage(2_000, 0))], [])).toEqual({
      tokens: 2_000,
      limit: undefined,
      percent: undefined,
    })
  })

  test("treats a zero model limit as unknown", () => {
    expect(contextUsage([assistantMessage("m1", usage(2_000, 0))], [{ ...models[0]!, limit: { context: 0 } }])).toEqual({
      tokens: 2_000,
      limit: undefined,
      percent: undefined,
    })
  })

  test("lastAssistantWithUsage skips messages after an unknown boundary", () => {
    expect(lastAssistantWithUsage([assistantMessage("m1", usage(1, 0))], "missing")).toBeUndefined()
  })
})

describe("backgroundUsage", () => {
  const parents = new Map<string, string | undefined>([
    ["ses_child1", "ses_test"],
    ["ses_child2", "ses_test"],
    ["ses_idle_child", "ses_test"],
    ["ses_sibling", "ses_other"],
    ["ses_grandchild", "ses_child1"],
  ])

  const get = (id: string): { readonly parentID?: string } | undefined => {
    if (!parents.has(id)) return undefined

    return { parentID: parents.get(id) }
  }

  const status = (running: readonly string[]) => (id: string): "idle" | "running" =>
    running.includes(id) ? "running" : "idle"

  const family = ["ses_test", "ses_child1", "ses_child2", "ses_idle_child", "ses_sibling", "ses_grandchild", "ses_other"]

  test("counts running direct children and nothing else", () => {
    const running = ["ses_test", "ses_child1", "ses_child2", "ses_sibling", "ses_grandchild", "ses_other"]

    expect(backgroundUsage("ses_test", family, get, status(running))).toEqual({ agents: 2 })
  })

  test("idle children, unknown sessions, and an empty family count nothing", () => {
    expect(backgroundUsage("ses_test", family, get, status([]))).toEqual({ agents: 0 })
    expect(backgroundUsage("ses_test", [], get, status(["ses_child1"]))).toEqual({ agents: 0 })
    expect(backgroundUsage("ses_test", ["ses_ghost"], get, status(["ses_ghost"]))).toEqual({ agents: 0 })
  })
})

// setup wiring: the reactive path cannot be rendered headlessly, but the parts
// that matter (the claims registered, the tracker subscriptions and throttle
// timer) are observable through a fake context and a patched setInterval.

/** The event fields `setup` reads; the harness emits nothing else. */
interface FakeEvent {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: {
    readonly sessionID?: string
    readonly assistantMessageID?: string
    readonly id?: string
    readonly delta?: string
    readonly ordinal?: number
    readonly text?: string
    readonly tokens?: { readonly output: number; readonly reasoning: number }
  }
}

interface TimerSpy {
  intervalMs: number
  cleared: number
  created: number
}

interface Generation {
  active: number
}

interface FakeTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

interface FakeModel {
  readonly id: string
  readonly providerID: string
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
}

interface FakeAgent {
  readonly id: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden: boolean
  readonly color?: string
}

interface FakeProject {
  readonly canonical: string
  readonly sandboxes?: readonly string[]
}

interface FakeSession {
  readonly tokens: FakeTokens
  readonly cost: number
  readonly status: "idle" | "running"
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly projectID: string
  readonly model?: ModelRef
  readonly parentID?: string
  readonly revert?: { readonly messageID: string }
}

interface ClaimInput {
  readonly sessionID?: string
  readonly showDetails?: boolean
}

interface CapturedClaim {
  readonly replace?: "prompt.footer"
  readonly append?: "session.composer.top" | "app"
  readonly render: (input: ClaimInput) => JSX.Element
}

interface FakeData {
  readonly on: (type: string, handler: (event: FakeEvent) => void) => () => void
  readonly session: {
    readonly get: (id: string) => FakeSession | undefined
    readonly cost: (id: string) => number
    readonly status: (id: string) => "idle" | "running"
    readonly family: (id: string) => string[]
    readonly message: { readonly list: (id: string) => SessionMessageInfo[] }
  }
  readonly project: { readonly get: (id: string) => FakeProject | undefined }
  readonly location: {
    readonly default: () => { readonly directory: string }
    readonly vcs: { readonly info: (ref?: { readonly directory: string }) => { branch: { current?: string } } | undefined }
    readonly model: { readonly list: (ref?: { readonly directory: string }) => FakeModel[] | undefined }
    readonly agent: { readonly list: (ref?: { readonly directory: string }) => ReadonlyArray<FakeAgent> }
  }
}

/**
 * The slice of the host context `setup` actually touches. Member signatures
 * mirror the SDK's, so the real `Context` remains assignable to this and a
 * renamed or re-shaped host member fails to compile instead of being erased.
 */
interface FakeContext {
  readonly options: StatusOptionsInput & TpsOptionsInput
  readonly location: { readonly directory: string }
  readonly app: { readonly version: string }
  readonly renderer: { readonly widthMethod: WidthMethod }
  readonly theme: {
    readonly text: { readonly muted: string }
    readonly border: { readonly base: RGBA }
    readonly hue?: { readonly accent: { readonly 200: RGBA } }
    readonly categorical?: readonly { readonly 200: RGBA }[]
  }
  readonly storage: {
    readonly memory: (
      key: string,
      options: { readonly initial: Generation },
    ) => readonly [Generation, (mutation: (draft: Generation) => void) => void]
  }
  readonly data: FakeData
  readonly ui: { readonly slot: (claim: CapturedClaim) => () => void }
}

// SAFETY: `FakeContext` covers every context member `setup` touches; the host
// members it omits are unreachable on this path. TypeScript cannot express
// "partial implementation of a foreign interface", so the parameter is narrowed
// through `unknown` — a test-double limitation, not a production cast.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const setupWithFakeContext = definition.setup as unknown as (
  context: FakeContext,
) => ReturnType<typeof definition.setup>

function createHarness(options: StatusOptionsInput & TpsOptionsInput = {}, agentColor?: string) {
  const claims: CapturedClaim[] = []
  const handlers = new Map<string, ((event: FakeEvent) => void)[]>()
  const generation: Generation = { active: 0 }
  const timer: TimerSpy = { intervalMs: 0, cleared: 0, created: 0 }
  const intervals: Array<{ handle: ReturnType<typeof setInterval>; callback: () => void }> = []
  let eventID = 0

  const models: FakeModel[] = []

  const state = {
    sessions: new Map<string, FakeSession>(),
    messages: new Map<string, SessionMessageInfo[]>(),
    families: new Map<string, string[]>(),
    models,
    projects: new Map<string, FakeProject>(),
    branches: new Map<string, string>(),
    defaultLocation: { directory: "/home/user" },
  }

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval

  globalThis.setInterval = (callback: () => void, ms?: number, ..._args: any[]) => {
    timer.intervalMs = ms ?? 0
    timer.created += 1
    // A real (immediately cancelled) handle keeps the host's return type honest
    // without leaving a live interval behind.
    const handle = realSetInterval(() => {}, 60_000)

    realClearInterval(handle)
    intervals.push({ handle, callback })

    return handle
  }

  globalThis.clearInterval = (handle) => {
    timer.cleared += 1
    const index = intervals.findIndex((entry) => entry.handle === handle)

    if (index >= 0) intervals.splice(index, 1)
  }

  const data: FakeData = {
    on: (type, handler) => {
      const list = handlers.get(type) ?? []

      list.push(handler)
      handlers.set(type, list)

      return () => handlers.delete(type)
    },
    session: {
      get: (id) => state.sessions.get(id),
      cost: (id) => state.sessions.get(id)?.cost ?? 0,
      status: (id) => state.sessions.get(id)?.status ?? "idle",
      family: (id) => state.families.get(id) ?? [],
      message: { list: (id) => state.messages.get(id) ?? [] },
    },
    project: { get: (id) => state.projects.get(id) },
    location: {
      default: () => state.defaultLocation,
      vcs: {
        info: (ref) => {
          if (!ref) return undefined
          const branch = state.branches.get(ref.directory)

          return branch === undefined ? undefined : { branch: { current: branch } }
        },
      },
      model: { list: () => state.models },
      agent: {
        list: () =>
          agentColor ? [{ id: "test", mode: "primary", hidden: false, color: agentColor }] : [],
      },
    },
  }

  const context: FakeContext = {
    options,
    location: state.defaultLocation,
    app: { version: "test" },
    renderer: { widthMethod: "unicode" },
    theme: {
      text: { muted: "#888888" },
      border: { base: RGBA.fromHex("#ff8800") },
      hue: { accent: { 200: RGBA.fromHex("#3388ff") } },
      categorical: [{ 200: RGBA.fromHex("#e57837") }],
    },
    storage: { memory: () => [generation, (mutation: (draft: Generation) => void) => mutation(generation)] as const },
    data,
    ui: {
      slot: (claim) => {
        claims.push(claim)

        return () => {}
      },
    },
  }

  // `setup` is declared as possibly async and possibly cleanup-less; ours is
  // neither, and the timer assertions fail loudly if that ever changes.
  const started = setupWithFakeContext(context)
  const cleanup = started instanceof Function ? started : () => {}

  return {
    claims,
    state,
    timer,
    subscribed: (type: string) => handlers.has(type),
    emit: (type: string, data_: FakeEvent["data"], created = Date.now(), id = `evt_${eventID++}`) => {
      for (const handler of handlers.get(type) ?? []) handler({ id, type, created, data: data_ })
    },
    tick: () => {
      for (const entry of intervals.slice()) entry.callback()
    },
    cleanup,
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

function seedSession(h: ReturnType<typeof createHarness>, id: string, overrides: Partial<FakeSession> = {}): FakeSession {
  const location = overrides.location ?? { directory: "/home/user/repo" }

  const session: FakeSession = {
    tokens: usage(8_960, 2_100, 2_100, 119_040, 0),
    cost: 0.42,
    status: "idle",
    location,
    projectID: "p1",
    model: TEST_MODEL,
    ...overrides,
  }

  h.state.sessions.set(id, session)
  h.state.projects.set("p1", { canonical: location.directory, sandboxes: [] })
  h.state.branches.set(location.directory, "main")
  h.state.models.push({
    id: TEST_MODEL.id,
    providerID: TEST_MODEL.providerID,
    limit: { context: 200_000, output: 32_000 },
  })
  h.state.messages.set(id, [assistantMessage("m1", usage(100_000, 0, 0, 0, 0))])

  return session
}

function seed(h: ReturnType<typeof createHarness>, overrides: Partial<FakeSession> = {}): FakeSession {
  return seedSession(h, "ses_test", overrides)
}

function claimFor(h: ReturnType<typeof createHarness>, kind: "footer" | "composer"): CapturedClaim {
  const claim =
    kind === "footer"
      ? h.claims.find((candidate) => candidate.replace === "prompt.footer")
      : h.claims.find((candidate) => candidate.append === "session.composer.top")

  if (!claim) throw new Error(`no ${kind} claim registered`)

  return claim
}

/** A slot input whose members read through getters, so a mounted claim's props stay reactive. */
function reactiveFooterInput(sessionID: () => string | undefined): ClaimInput {
  return {
    get sessionID() {
      return sessionID()
    },
    get showDetails() {
      return false
    },
  }
}

async function renderClaim(
  h: ReturnType<typeof createHarness>,
  kind: "footer" | "composer",
  input: ClaimInput,
  width: number,
  height = 4,
) {
  const app = await testRender(() => claimFor(h, kind).render(input), { width, height })

  await app.renderOnce()

  return app
}

describe("plugin setup", () => {
  test("claims the footer and the composer row", () => {
    const h = createHarness()

    expect(definition.id).toBe("opencode2.enhanced-composer")
    expect(h.claims).toHaveLength(3)
    expect(claimFor(h, "footer").replace).toBe("prompt.footer")
    expect(claimFor(h, "composer").append).toBe("session.composer.top")

    h.cleanup()
    h.restore()
  })

  test("wires the tracker to the stream events and the refresh timer", () => {
    const h = createHarness()

    for (const type of [
      "session.execution.started",
      "session.text.delta",
      "session.reasoning.delta",
      "session.tool.input.delta",
      "session.step.started",
      "session.step.streamed",
      "session.step.ended",
      "session.execution.succeeded",
      "session.idle",
      "session.deleted",
    ])
      expect(h.subscribed(type)).toBe(true)

    // Wiring alone starts nothing; the first event starts the throttle timer.
    expect(h.timer.created).toBe(0)
    h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, 1_000)
    expect(h.timer.created).toBe(1)
    expect(h.timer.intervalMs).toBe(1000 / DEFAULT_TPS_OPTIONS.refreshHz)

    h.cleanup()
    expect(h.timer.cleared).toBe(1)
    h.restore()
  })

  test("honours the refreshHz option for the throttle timer", () => {
    const h = createHarness({ refreshHz: 4 })

    h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, 1_000)
    expect(h.timer.intervalMs).toBe(250)

    h.cleanup()
    h.restore()
  })
})

describe("built render", () => {
  test("draws the default arrangement: location left, the metrics right", async () => {
    const h = createHarness()

    seed(h)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo ${GLYPH_BRANCH} main`)
      expect(frame).toContain("in 128k | out 4.2k | cache 93% | $0.42 | [▰▰▰▱▱] 100k context")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("shows zero cost and zero usage for a fresh session", async () => {
    const h = createHarness()

    seed(h, { tokens: usage(0, 0, 0, 0, 0), cost: 0 })
    h.state.messages.set("ses_test", [])

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain("in 0 | out 0 | cache 0% | $0.00")
      expect(frame).not.toContain("100k")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("the composer row marks running subagents with their count", async () => {
    const h = createHarness()

    seed(h, { status: "running" })
    h.state.messages.set("ses_test", [])
    h.state.sessions.set("ses_child1", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "running",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_test",
    })
    h.state.sessions.set("ses_child2", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "running",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_test",
    })
    h.state.families.set("ses_test", ["ses_test", "ses_child1", "ses_child2"])

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 40)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain("2 agents")
    } finally {
      app.renderer.destroy()
    }

    h.state.sessions.set("ses_child1", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "idle",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_test",
    })
    h.state.sessions.set("ses_child2", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "idle",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_test",
    })

    const quiet = await renderClaim(h, "composer", { sessionID: "ses_test" }, 40)

    try {
      const frame = quiet.captureCharFrame()

      expect(frame).not.toContain("agent")
    } finally {
      quiet.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("the composer row ignores siblings, parents, and grandchildren", async () => {
    const h = createHarness()

    seed(h, { status: "idle" })
    h.state.messages.set("ses_test", [])
    h.state.sessions.set("ses_child", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "running",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_test",
    })
    h.state.sessions.set("ses_sibling", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "running",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_other",
    })
    h.state.sessions.set("ses_grandchild", {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      status: "running",
      location: { directory: "/home/user/repo" },
      projectID: "p1",
      model: { id: "test-model", providerID: "test" },
      parentID: "ses_child",
    })
    h.state.families.set("ses_test", ["ses_test", "ses_child", "ses_sibling", "ses_grandchild"])

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 40)

    try {
      expect(app.captureCharFrame()).toContain("1 agent")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("overflow hides whole widgets by priority, never changing representations", async () => {
    const h = createHarness()

    seed(h)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 50)

    try {
      const frame = app.captureCharFrame()

      // Balanced order hides cost, then branch, then cache; the survivors keep
      // their selected word forms — no automatic glyph fallback exists.
      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).toContain("in 128k | out 4.2k")
      expect(frame).toContain("[▰▰▰▱▱] 100k context")
      expect(frame).not.toContain("$0.42")
      expect(frame).not.toContain("cache")
      expect(frame).not.toContain("main")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("an extremely narrow row keeps only the last-priority widget, then empties", async () => {
    const h = createHarness()

    seed(h)

    // The context widget is the last survivor; padding takes one cell per
    // side, so it fits at exactly its own width, and hides one cell short.
    const contextText = "[▰▰▰▱▱] 100k context"
    const narrow = await renderClaim(h, "footer", { sessionID: "ses_test" }, measureCells(contextText) + 2)

    try {
      expect(narrow.captureCharFrame().trim()).toBe(contextText)
    } finally {
      narrow.renderer.destroy()
    }

    const empty = await renderClaim(h, "footer", { sessionID: "ses_test" }, measureCells(contextText) + 1)

    try {
      expect(empty.captureCharFrame().trim()).toBe("")
    } finally {
      empty.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("refits when the terminal resizes", async () => {
    const h = createHarness()

    seed(h)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      expect(app.captureCharFrame()).toContain("$0.42")

      app.resize(45, 4)
      await app.renderOnce()

      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).toContain("in 128k")
      expect(frame).toContain("[▰▰▰▱▱] 100k context")
      expect(frame).not.toContain("$0.42")
      expect(frame).not.toContain("out 4.2k")
      expect(frame).not.toContain("cache 93%")
      expect(frame).not.toContain("main")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("path mode shortens by whole segments; a minimum that cannot fit hides the widget", async () => {
    const deep = `${homedir()}/projects/work/repo`

    const h = createHarness({
      layout: { topLeft: [], topRight: [], bottomLeft: ["directory"], bottomRight: [] },
      appearance: { directory: { format: "path" } },
    })

    seed(h, { location: { directory: deep } })

    // Padding takes one cell per side: the minimum candidate fits at exactly
    // its own width, and the directory hides entirely one cell short of it
    // rather than cut inside the final name.
    const shortest = `${GLYPH_FOLDER} ~/.../repo`
    const shortened = await renderClaim(h, "footer", { sessionID: "ses_test" }, measureCells(shortest) + 2)

    try {
      const frame = shortened.captureCharFrame()

      expect(frame).toContain(shortest)
      expect(frame).not.toContain("~/projects")
      expect(frame).not.toContain("~/.../work")
    } finally {
      shortened.renderer.destroy()
    }

    const hidden = await renderClaim(h, "footer", { sessionID: "ses_test" }, measureCells(shortest) + 1)

    try {
      expect(hidden.captureCharFrame().trim()).toBe("")
    } finally {
      hidden.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("a branch is hidden whole, never truncated", async () => {
    const h = createHarness({ layout: { topLeft: [], topRight: [], bottomLeft: ["directory", "branch"], bottomRight: [] } })

    seed(h)
    h.state.branches.set("/home/user/repo", "hoplite/delos-12bf76a7")

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 20)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).not.toContain("hoplite")
      expect(frame).not.toContain("delos")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("colon style joins an adjacent directory and stays bare without one", async () => {
    const joined = createHarness({ appearance: { branch: "colon" } })

    seed(joined)

    const app = await renderClaim(joined, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo:main`)
      expect(frame).not.toContain(GLYPH_BRANCH)
    } finally {
      app.renderer.destroy()
      joined.cleanup()
      joined.restore()
    }

    const bare = createHarness({ layout: { topLeft: [], topRight: [], bottomLeft: ["branch"], bottomRight: [] }, appearance: { branch: "colon" } })

    seed(bare)

    const bareApp = await renderClaim(bare, "footer", { sessionID: "ses_test" }, 40)

    try {
      expect(bareApp.captureCharFrame().trim()).toBe("main")
    } finally {
      bareApp.renderer.destroy()
      bare.cleanup()
      bare.restore()
    }

    const split = createHarness({
      layout: { topLeft: [], topRight: [], bottomLeft: ["directory"], bottomRight: ["branch"] },
      appearance: { branch: "colon" },
    })

    seed(split)

    const splitApp = await renderClaim(split, "footer", { sessionID: "ses_test" }, 40)

    try {
      const frame = splitApp.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).toContain("main")
      expect(frame).not.toContain("repo:main")
    } finally {
      splitApp.renderer.destroy()
      split.cleanup()
      split.restore()
    }
  })

  test("widgets can move to other corners", async () => {
    const h = createHarness({
      layout: { topLeft: ["directory"], topRight: ["branch"], bottomLeft: ["input"], bottomRight: ["cost"] },
    })

    seed(h)

    const footer = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = footer.captureCharFrame()

      expect(frame).toContain("in 128k")
      expect(frame).toContain("$0.42")
      expect(frame).not.toContain(GLYPH_FOLDER)
    } finally {
      footer.renderer.destroy()
    }

    const composer = await renderClaim(h, "composer", { sessionID: "ses_test" }, 100)

    try {
      const frame = composer.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).toContain(`${GLYPH_BRANCH} main`)
    } finally {
      composer.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("zone order is display order", async () => {
    const h = createHarness({
      layout: { topLeft: [], topRight: [], bottomLeft: [], bottomRight: ["context", "cost"] },
    })

    seed(h)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      expect(app.captureCharFrame()).toContain("100k context | $0.42")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("a widget omitted from every zone is hidden", async () => {
    const h = createHarness({
      layout: { topLeft: [], topRight: [], bottomLeft: ["directory"], bottomRight: ["input", "output"] },
    })

    seed(h)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).toContain("in 128k | out 4.2k")
      expect(frame).not.toContain("main")
      expect(frame).not.toContain("cache")
      expect(frame).not.toContain("$0.42")
      expect(frame).not.toContain("100k")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("a top-only layout empties the footer and fills the composer row", async () => {
    const h = createHarness({
      layout: { topLeft: ["directory", "branch"], topRight: ["input"], bottomLeft: [], bottomRight: [] },
    })

    seed(h)

    const footer = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      expect(footer.captureCharFrame().trim()).toBe("")
    } finally {
      footer.renderer.destroy()
    }

    const composer = await renderClaim(h, "composer", { sessionID: "ses_test" }, 100)

    try {
      const frame = composer.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo ${GLYPH_BRANCH} main`)
      expect(frame).toContain("in 128k")
    } finally {
      composer.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("a footer-only layout empties the composer row", async () => {
    const h = createHarness({
      layout: { topLeft: [], topRight: [], bottomLeft: ["directory"], bottomRight: ["cost"] },
    })

    seed(h)

    const composer = await renderClaim(h, "composer", { sessionID: "ses_test" }, 100)

    try {
      expect(composer.captureCharFrame().trim()).toBe("")
    } finally {
      composer.renderer.destroy()
    }

    const footer = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = footer.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo`)
      expect(frame).toContain("$0.42")
    } finally {
      footer.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test.each([
    [{ format: "tokens", bar: "solid", label: "none" }, "[█████░░░░░] 100k"],
    [{ format: "tokens", bar: "slanted", label: "none" }, "[▰▰▰▱▱] 100k"],
    [{ format: "tokens", bar: "solid", label: "context" }, "[█████░░░░░] 100k context"],
    [{ format: "tokens-limit", bar: "off", label: "none" }, "100k/200k"],
    [{ format: "percent", bar: "off", label: "none" }, "50%"],
    [{ format: "percent", bar: "slanted", label: "ctx" }, "[▰▰▰▱▱] 50% ctx"],
    [{ format: "tokens", bar: "off", label: "ctx" }, "100k ctx"],
  ] satisfies ReadonlyArray<readonly [Record<string, string>, string]>)(
    "context appearance %j renders as %s",
    async (context, expected) => {
      const h = createHarness({ appearance: { context } })

      seed(h)

      const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

      try {
        expect(app.captureCharFrame()).toContain(expected)
      } finally {
        app.renderer.destroy()
        h.cleanup()
        h.restore()
      }
    },
  )

  test("the home screen shows the location and invents no session metrics", async () => {
    const h = createHarness()

    h.state.branches.set("/home/user", "main")

    const app = await renderClaim(h, "footer", { sessionID: undefined }, 60)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} user ${GLYPH_BRANCH} main`)
      // The row holds exactly the location: no session metrics are invented
      // for the sessionless home screen. (An `in ` substring check would
      // false-positive on the padded `main ` text.)
      expect(frame.trim()).toBe(`${GLYPH_FOLDER} user ${GLYPH_BRANCH} main`)
      expect(frame).not.toContain("$")
      expect(frame).not.toContain("t/s")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("the footer follows the prompt's session", async () => {
    const h = createHarness()

    seedSession(h, "ses_a")
    seedSession(h, "ses_b", { tokens: usage(2_000, 500), cost: 1.23 })
    h.state.messages.set("ses_b", [assistantMessage("m1", usage(50_000, 0, 0, 0, 0))])

    const [sessionID, setSessionID] = createSignal<string | undefined>("ses_a")
    const app = await renderClaim(h, "footer", reactiveFooterInput(sessionID), 100)

    try {
      expect(app.captureCharFrame()).toContain("$0.42")
      expect(app.captureCharFrame()).toContain("in 128k")

      setSessionID("ses_b")
      await app.renderOnce()

      const frame = app.captureCharFrame()

      expect(frame).toContain("$1.23")
      expect(frame).toContain("in 2k")
      expect(frame).not.toContain("$0.42")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test.each([
    {
      label: "a nested worktree",
      directory: "/home/user/repo/.worktrees/feature",
      canonical: "/home/user/repo",
      sandboxes: ["/home/user/repo/.worktrees/feature"],
      branch: "feature",
      expected: `${GLYPH_WORKTREE} feature ${GLYPH_BRANCH} feature`,
    },
    {
      label: "a directory below the canonical root",
      directory: "/home/user/repo/packages",
      canonical: "/home/user/repo",
      sandboxes: ["/home/user/repo"],
      branch: "main",
      expected: `${GLYPH_FOLDER} packages ${GLYPH_BRANCH} main`,
    },
    {
      label: "the canonical root",
      directory: "/home/user/repo",
      canonical: "/home/user/repo",
      sandboxes: ["/home/user/repo/.worktrees/feature"],
      branch: "main",
      expected: `${GLYPH_FOLDER} repo ${GLYPH_BRANCH} main`,
    },
    {
      label: "an external worktree",
      directory: "/srv/worktrees/repo-feature",
      canonical: "/home/user/repo",
      sandboxes: ["/srv/worktrees/repo-feature"],
      branch: "feature",
      expected: `${GLYPH_WORKTREE} repo-feature ${GLYPH_BRANCH} feature`,
    },
    {
      label: "an external worktree absent from the inventory",
      directory: "/srv/worktrees/repo-feature",
      canonical: "/home/user/repo",
      sandboxes: [],
      branch: "feature",
      expected: `${GLYPH_WORKTREE} repo-feature ${GLYPH_BRANCH} feature`,
    },
    {
      label: "an external directory when sandbox metadata is missing",
      directory: "/srv/worktrees/repo-feature",
      canonical: "/home/user/repo",
      branch: "feature",
      expected: `${GLYPH_WORKTREE} repo-feature ${GLYPH_BRANCH} feature`,
    },
  ] satisfies ReadonlyArray<{
    readonly label: string
    readonly directory: string
    readonly canonical: string
    readonly sandboxes?: readonly string[]
    readonly branch: string
    readonly expected: string
  }>)("uses project worktree metadata", async (scenario) => {
    const h = createHarness()

    seed(h, { location: { directory: scenario.directory } })

    const project =
      scenario.sandboxes === undefined
        ? { canonical: scenario.canonical }
        : { canonical: scenario.canonical, sandboxes: scenario.sandboxes }

    h.state.projects.set("p1", project)
    h.state.branches.set(scenario.directory, scenario.branch)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      expect(app.captureCharFrame()).toContain(scenario.expected)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test.each([
    [{ icon: "f07b" }, `${GLYPH_FOLDER_CLOSED} repo`],
    [{ icon: "f07c" }, `${GLYPH_FOLDER_OPEN} repo`],
    [{ icon: "none" }, "repo"],
  ] satisfies ReadonlyArray<readonly [Record<string, string>, string]>)(
    "the curated folder icon %j renders as %s",
    async (directory, expected) => {
      const h = createHarness({ appearance: { directory } })

      seed(h)

      const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

      try {
        expect(app.captureCharFrame()).toContain(expected)
      } finally {
        app.renderer.destroy()
        h.cleanup()
        h.restore()
      }
    },
  )

  test.each([
    ["📁", "📁 repo"],
    ["\u{f07e}", "\u{f07e} repo"],
  ] satisfies ReadonlyArray<readonly [string, string]>)("a custom directory icon %s renders as %s", async (text, expected) => {
    const h = createHarness({ appearance: { directory: { icon: { text } } } })

    seed(h)

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      expect(app.captureCharFrame()).toContain(expected)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("draws the spinner at the left of the footer when placed there", async () => {
    const h = createHarness({ layout: { ...DEFAULT_LAYOUT, topLeft: ["directory", "branch"], bottomLeft: ["spinner", "bgagent"] } })

    seed(h, { status: "running" })

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = app.captureCharFrame()
      const line = frame.split("\n")[0] ?? ""

      // Spinner left, stats right; the location lives above the composer now.
      expect(BLOCK_FRAMES.some((glyph) => line.startsWith(` ${glyph}`))).toBe(true)
      expect(frame).toContain("[▰▰▰▱▱] 100k context")
      expect(frame).not.toContain(`${GLYPH_FOLDER} repo`)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("shows the location above the composer when the spinner is in the footer", async () => {
    const h = createHarness({ layout: { ...DEFAULT_LAYOUT, topLeft: ["directory", "branch"], bottomLeft: ["spinner", "bgagent"] } })

    seed(h, { status: "running" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      const frame = app.captureCharFrame()

      expect(frame).toContain(`${GLYPH_FOLDER} repo ${GLYPH_BRANCH} main`)
      expect(BLOCK_FRAMES.some((glyph) => frame.includes(glyph))).toBe(false)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("paints the block scanner with the agent colour", async () => {
    const h = createHarness({
      appearance: { spinner: "blocks" },
      layout: { ...DEFAULT_LAYOUT, topLeft: ["directory", "branch"], bottomLeft: ["spinner", "bgagent"] },
    })

    seed(h, { status: "running" })

    const app = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const spans = app.captureSpans().lines[0]?.spans ?? []
      const blockSpans = spans.filter((span) => /[■⬝]/u.test(span.text))

      expect(blockSpans.length).toBeGreaterThan(0)
      // The active cell must carry the agent colour, not the subdued text one.
      expect(blockSpans.some((span) => span.text.includes("■") && !span.fg.equals(RGBA.fromHex("#888888")))).toBe(true)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("omitting the spinner from the layout hides it without moving anything else", async () => {
    const h = createHarness({ layout: { ...DEFAULT_LAYOUT, topLeft: ["directory", "branch"], bottomLeft: ["bgagent"] } })

    seed(h, { status: "running" })

    const footer = await renderClaim(h, "footer", { sessionID: "ses_test" }, 100)

    try {
      const frame = footer.captureCharFrame()

      expect(frame).toContain("[▰▰▰▱▱] 100k context")
      expect(BLOCK_FRAMES.some((glyph) => frame.includes(glyph))).toBe(false)
    } finally {
      footer.renderer.destroy()
    }

    const composer = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      expect(composer.captureCharFrame()).toContain(`${GLYPH_FOLDER} repo ${GLYPH_BRANCH} main`)
    } finally {
      composer.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("the static text spinner shows Running without scheduling anything", async () => {
    const h = createHarness({ appearance: { spinner: "text" } })

    seed(h, { status: "running" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      expect(app.captureCharFrame()).toContain("Running")
      expect(h.timer.created).toBe(0)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("shows only the spinner above the composer while running", async () => {
    const h = createHarness()

    seed(h, { status: "running" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      const line = app.captureCharFrame().split("\n")[0] ?? ""

      // One cell of gutter, then the spinner; the row holds nothing else.
      expect(line.startsWith(` ${BLOCK_FRAMES[0] ?? ""}`)).toBe(true)
      expect(line.trim()).toBe(BLOCK_FRAMES[0] ?? "")

      // The frame still advances on the spinner timer.
      h.tick()
      await app.renderOnce()
      const advanced = app.captureCharFrame().split("\n")[0] ?? ""

      expect(advanced.trim()).toBe(BLOCK_FRAMES[1] ?? "")
      expect(advanced).not.toContain("t/s")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("shows the rate right-aligned and keeps the frozen average", async () => {
    const h = createHarness()

    seed(h, { status: "running" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("t/s")

      // One exact step: 40 generated tokens over a one-second stream.
      h.emit("session.execution.started", { sessionID: "ses_test" }, 1_000)
      h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, 1_000)
      h.emit("session.text.started", { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0 }, 1_000)
      h.emit(
        "session.text.delta",
        { sessionID: "ses_test", assistantMessageID: "m1", ordinal: 0, delta: "hello" },
        1_000,
      )
      h.emit("session.step.streamed", { sessionID: "ses_test", assistantMessageID: "m1" }, 2_000)
      h.emit(
        "session.step.ended",
        { sessionID: "ses_test", assistantMessageID: "m1", tokens: { output: 40, reasoning: 0 } },
        2_000,
      )
      h.emit("session.execution.succeeded", { sessionID: "ses_test" }, 2_000)

      // The throttle timer bumps the version signal the rate memo reads.
      h.tick()
      await app.renderOnce()

      const line = app.captureCharFrame().split("\n")[0] ?? ""

      expect(line).toContain("~40.0 t/s")
      expect(line.trimEnd().endsWith("~40.0 t/s")).toBe(true)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("shows no rate when the tracker has no observable duration", async () => {
    const h = createHarness()

    seed(h, { status: "running" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      await app.renderOnce()

      // A step that settles exact tokens without a stream or content boundary
      // freezes a null rate; the row must not print the `— t/s` placeholder.
      h.emit("session.execution.started", { sessionID: "ses_test" }, 1_000)
      h.emit("session.step.started", { sessionID: "ses_test", assistantMessageID: "m1" }, 1_000)
      h.emit(
        "session.step.ended",
        { sessionID: "ses_test", assistantMessageID: "m1", tokens: { output: 40, reasoning: 0 } },
        2_000,
      )
      h.emit("session.execution.succeeded", { sessionID: "ses_test" }, 2_000)
      h.tick()
      await app.renderOnce()

      const line = app.captureCharFrame().split("\n")[0] ?? ""

      expect(line).not.toContain("t/s")
      expect(line).not.toContain("—")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("draws nothing above the composer while idle", async () => {
    const h = createHarness()

    seed(h, { status: "idle" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      expect(app.captureCharFrame().trim()).toBe("")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test.each([
    ["#12ab34", "#12ab34"],
    ["accent", "#3388ff"],
    ["custom", "#e57837"],
  ] satisfies ReadonlyArray<readonly [string, string]>)("uses agent color %s for the block spinner", async (agentColor, expected) => {
    const h = createHarness({ appearance: { spinner: "blocks" } }, agentColor)

    seed(h, { status: "running" })

    const app = await renderClaim(h, "composer", { sessionID: "ses_test" }, 60, 2)

    try {
      const spans = app.captureSpans().lines[0]?.spans ?? []

      expect(spans.some((span) => span.text.includes("■") && span.fg.equals(RGBA.fromHex(expected)))).toBe(true)
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })
})
