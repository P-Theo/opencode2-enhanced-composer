// The published package loads the precompiled dist/tui.js through its
// `./tui` export, not src/footer.tsx. Every other render test imports the source,
// so this suite builds the bundle with the production script and imports it:
// rendering proves the transformed JSX mounts, and the signal update proves the
// precompiled memo still tracks reactive host state.
import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { ModelRef, SessionMessageAssistant, SessionMessageInfo, TokenUsageInfo } from "@opencode/client"
import { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { testRender } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import type { StatusOptionsInput } from "../src/options.js"
import { BLOCK_FRAMES } from "../src/widgets.tsx"

const root = fileURLToPath(new URL("..", import.meta.url))

const distEntry = new URL("../dist/tui.js", import.meta.url).href

const subdued = "#8c8c8c"

const TEST_MODEL: ModelRef = { id: "test-model", providerID: "test" }

interface FakeEvent {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: {
    readonly sessionID?: string
    readonly assistantMessageID?: string
    readonly ordinal?: number
    readonly delta?: string
    readonly tokens?: { readonly output: number; readonly reasoning: number }
  }
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

interface FakeSession {
  readonly tokens: TokenUsageInfo
  readonly cost: number
  readonly status: "idle" | "running"
  readonly location: { readonly directory: string }
  readonly projectID: string
  readonly model?: ModelRef
}

interface FakeContext {
  readonly options: StatusOptionsInput
  readonly renderer: { readonly widthMethod: "unicode" }
  readonly keymap: Pick<Plugin.Context["keymap"], "layer">
  readonly location: { readonly directory: string }
  readonly app: { readonly version: string }
  readonly theme: {
    readonly text: { readonly muted: string }
    readonly border: { readonly base: RGBA }
  }
  readonly storage: {
    readonly memory: (
      key: string,
      options: { readonly initial: { active: number } },
    ) => readonly [{ active: number }, (mutation: (draft: { active: number }) => void) => void]
  }
  readonly data: {
    readonly on: (type: string, handler: (event: FakeEvent) => void) => () => void
    readonly session: {
      readonly get: (id: string) => FakeSession | undefined
      readonly cost: (id: string) => number
      readonly status: (id: string) => "idle" | "running"
      readonly family: (id: string) => string[]
      readonly message: { readonly list: (id: string) => SessionMessageInfo[] }
    }
    readonly project: { readonly get: (id: string) => { readonly canonical: string } | undefined }
    readonly location: {
      readonly default: () => { readonly directory: string }
      readonly vcs: { readonly info: (ref?: { readonly directory: string }) => { branch: { current?: string } } | undefined }
      readonly model: { readonly list: () => Array<{ id: string; providerID: string; limit: { context: number; output: number } }> }
      readonly agent: { readonly list: () => ReadonlyArray<{ id: string; mode: "subagent" | "primary" | "all"; hidden: boolean; color?: string }> }
    }
  }
  readonly ui: { readonly slot: (claim: CapturedClaim) => () => void }
}

type FakeSetup = (context: FakeContext) => (() => void) | void

function start(context: FakeContext): (() => void) | void {
  // SAFETY: FakeContext covers every context member the compiled setup touches;
  // TypeScript cannot express a partial implementation of a foreign interface,
  // so the callable is narrowed through unknown — a test-double limitation, not
  // a production cast.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const setup = plugin.setup as unknown as FakeSetup

  return setup(context)
}

let plugin: Plugin.Definition

beforeAll(async () => {
  // Spawn the real build so every run tests a fresh dist/tui.js, even from a
  // clean checkout and across watch-mode reruns.
  const build = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: root, encoding: "utf8" })

  if (build.status !== 0) throw new Error(`scripts/build.mjs failed:\n${build.stderr || build.stdout}`)
  plugin = (await import(distEntry)).default
})

function usage(input: number, output = 0, reasoning = 0, read = 0, write = 0): TokenUsageInfo {
  return { input, output, reasoning, cache: { read, write } }
}

function assistantMessage(id: string, tokens: TokenUsageInfo): SessionMessageAssistant {
  return { id, time: { created: 0 }, type: "assistant", agent: "test", model: TEST_MODEL, content: [], tokens }
}

function createHarness(options: StatusOptionsInput = {}) {
  const claims: CapturedClaim[] = []
  const layers: Parameters<Plugin.Context["keymap"]["layer"]>[0][] = []
  const handlers = new Map<string, ((event: FakeEvent) => void)[]>()
  const generation = { active: 0 }
  let flush: (() => void) | undefined

  const [tokens, setTokens] = createSignal<TokenUsageInfo>(usage(8_960, 2_100, 2_100, 119_040, 0))
  const [status, setStatus] = createSignal<"idle" | "running">("idle")

  const sessions = new Map<string, FakeSession>([
    [
      "ses_test",
      {
        get tokens() {
          return tokens()
        },
        cost: 0.42,
        get status() {
          return status()
        },
        location: { directory: "/home/user/repo" },
        projectID: "p1",
        model: TEST_MODEL,
      },
    ],
  ])

  const messages = new Map<string, SessionMessageInfo[]>([
    ["ses_test", [assistantMessage("m1", usage(100_000, 0, 0, 0, 0))]],
  ])

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval

  globalThis.setInterval = (callback: () => void, _ms?: number, ..._args: any[]) => {
    flush = callback
    // A real (immediately cancelled) handle keeps the host's return type honest
    // without leaving a live interval behind.
    const handle = realSetInterval(() => {}, 60_000)

    realClearInterval(handle)

    return handle
  }

  globalThis.clearInterval = () => {
    flush = undefined
  }

  const context: FakeContext = {
    options,
    renderer: { widthMethod: "unicode" },
    keymap: { layer: (layer) => { layers.push(layer) } },
    location: { directory: "/home/user" },
    app: { version: "test" },
    theme: { text: { muted: subdued }, border: { base: RGBA.fromHex("#ff8800") } },
    storage: { memory: () => [generation, (mutation: (draft: { active: number }) => void) => mutation(generation)] as const },
    data: {
      on: (type, handler) => {
        const list = handlers.get(type) ?? []

        list.push(handler)
        handlers.set(type, list)

        return () => handlers.delete(type)
      },
      session: {
        get: (id) => sessions.get(id),
        cost: (id) => sessions.get(id)?.cost ?? 0,
        status: (id) => sessions.get(id)?.status ?? "idle",
        family: () => [],
        message: { list: (id) => messages.get(id) ?? [] },
      },
      project: { get: (id) => (id === "p1" ? { canonical: "/home/user/repo" } : undefined) },
      location: {
        default: () => ({ directory: "/home/user" }),
        vcs: { info: () => ({ branch: { current: "main" } }) },
        model: { list: () => [{ id: TEST_MODEL.id, providerID: TEST_MODEL.providerID, limit: { context: 200_000, output: 32_000 } }] },
        agent: { list: () => [] },
      },
    },
    ui: {
      slot: (claim) => {
        claims.push(claim)

        return () => {}
      },
    },
  }

  // `setup` is declared as possibly async and possibly cleanup-less; ours is
  // neither, and the render assertions fail loudly if that ever changes.
  const started = start(context)
  const cleanup = started instanceof Function ? started : () => {}

  return {
    claims,
    layers,
    setTokens,
    setStatus,
    tick: () => flush?.(),
    cleanup,
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

function claimFor(harness: ReturnType<typeof createHarness>, kind: "footer" | "composer"): CapturedClaim {
  const claim =
    kind === "footer"
      ? harness.claims.find((candidate) => candidate.replace === "prompt.footer")
      : harness.claims.find((candidate) => candidate.append === "session.composer.top")

  if (!claim) throw new Error(`no ${kind} claim registered`)

  return claim
}

describe("built entrypoint", () => {
  test("registers status rows and the app-owned settings command", async () => {
    const h = createHarness()

    expect(plugin.id).toBe("opencode2.enhanced-composer")
    expect(h.claims).toHaveLength(3)
    expect(claimFor(h, "footer").replace).toBe("prompt.footer")
    expect(claimFor(h, "composer").append).toBe("session.composer.top")
    const commandClaim = h.claims.find((candidate) => candidate.append === "app")

    if (!commandClaim) throw new Error("no app claim registered")

    const app = await testRender(() => commandClaim.render({}), { width: 70, height: 4 })
    let cleaned = false

    try {
      await app.renderOnce()
      expect(h.layers[0]?.().mode).toBe("global")
      const commands = h.layers.flatMap((layer) => layer().commands ?? [])
      const command = commands.find((candidate) => candidate.id === "opencode2.enhanced-composer.customize")

      expect(command?.title).toBe("Customize footer")
      expect(command?.palette).toBe(true)
      expect(command?.slash).toEqual({ name: "customize-footer" })
      expect(command?.bind).toBe(false)
      expect(app.captureCharFrame().trim()).toBe("")
      h.cleanup()
      cleaned = true

      // A retained command from an unloaded generation must not reopen UI.
      const enabled = command?.enabled

      expect(enabled instanceof Function ? enabled() : enabled).toBe(false)
      await command?.run()
    } finally {
      app.renderer.destroy()

      if (!cleaned) h.cleanup()
      h.restore()
    }
  })

  test("renders the footer and reacts to session usage updates", async () => {
    const h = createHarness()

    const app = await testRender(() => claimFor(h, "footer").render({ sessionID: "ses_test" }), {
      width: 100,
      height: 4,
    })

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("in 128k | out 4.2k | cache 93% | $0.42")

      // A reactive host session store pushes new usage; the precompiled memo
      // must recompute and the frame must follow without a remount.
      h.setTokens(usage(0, 10, 0, 0, 0))
      const frame = await app.waitForFrame((current) => current.includes("cache 0%"))

      expect(frame).toContain("in 0 | out 10 | cache 0%")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("renders only the spinner above the composer while running", async () => {
    const h = createHarness()

    const app = await testRender(() => claimFor(h, "composer").render({ sessionID: "ses_test" }), {
      width: 60,
      height: 2,
    })

    try {
      await app.renderOnce()
      expect(app.captureCharFrame().trim()).toBe("")

      // A running session mounts the spinner, one cell in from the left edge.
      h.setStatus("running")
      await app.waitForFrame((current) => current.includes("■"))

      const line = app.captureCharFrame().split("\n")[0] ?? ""

      expect(line.startsWith(" ■")).toBe(true)
      expect(line.trim()).toBe(BLOCK_FRAMES[0] ?? "")
      expect(line).not.toContain("t/s")

      // The compiled bundle keeps advancing the frame on its own timer.
      h.tick()
      await app.waitForFrame((current) => current.includes("■■⬝"))
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })

  test("ships shared modules and renders a custom context bar layout reactively", async () => {
    const h = createHarness({
      layout: { topLeft: ["context", "input"], bottomRight: ["directory", "branch"] },
      appearance: {
        context: { format: "tokens", bar: "slanted", label: "context" },
        directory: { icon: "none" },
        branch: "colon",
        separator: "pipe",
      },
    })

    const app = await testRender(() => claimFor(h, "composer").render({ sessionID: "ses_test" }), {
      width: 70,
      height: 4,
    })

    try {
      await app.renderOnce()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("[▰▰▰▱▱] 100k context | in 128k")
      h.setTokens(usage(2_000))
      const frame = await app.waitForFrame((current) => current.includes("in 2k"))

      expect(frame).toContain("[▰▰▰▱▱] 100k context | in 2k")
    } finally {
      app.renderer.destroy()
      h.cleanup()
      h.restore()
    }
  })
})
