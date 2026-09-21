// Stage 3B dialog tests: keyboard flows over real rendering. The dialog is
// mounted with a fake host context (captured key layer and dialog API) and a
// fixture settings store, so every assertion is about what the user sees and
// what the save boundary receives — movement, hiding, reordering, appearance
// cycling, the live preview's scenarios, and the Save/Cancel/conflict/error
// lifecycle that must always keep the draft.
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { RGBA } from "@opentui/core"
import type { KeyEvent } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { DEFAULT_STATUS_OPTIONS, resolveStatusOptions, WIDGET_IDS, type NormalizedStatusOptions } from "../src/options.ts"
import { openStatusSettings, StatusSettingsDialog } from "../src/settings.tsx"
import {
  createCliStatusOptionsStore,
  type StatusSettingsEntry,
  type StatusSettingsReadResult,
  type StatusSettingsSaveInput,
  type StatusSettingsSaveResult,
  type StatusSettingsStore,
} from "../src/settings-model.ts"

const BLOCK_SPINNER = /■⬝/u

interface LayerCommand {
  readonly bind?: string | false
  readonly run?: (input?: string, event?: KeyEvent) => void | false | Promise<void>
}

interface CapturedLayer {
  readonly input: () => { readonly mode?: string; readonly commands?: readonly LayerCommand[] }
}

interface CapturedShow {
  readonly render: () => JSX.Element
  readonly onClose?: () => void
}

interface FakeHost {
  readonly context: Plugin.Context
  /** The same shared instance the host hands the dialog; editing must not mutate it. */
  readonly themeBase: RGBA
  readonly shows: CapturedShow[]
  readonly sizes: Array<{ readonly size?: string; readonly centered?: boolean }>
  readonly alerts: Array<{ readonly title: string; readonly message: string }>
  readonly commands: () => readonly LayerCommand[]
  readonly clearCount: () => number
}

function createFakeHost(): FakeHost {
  const layers: CapturedLayer[] = []
  const shows: CapturedShow[] = []
  const sizes: Array<{ readonly size?: string; readonly centered?: boolean }> = []
  const alerts: Array<{ readonly title: string; readonly message: string }> = []
  const themeBase = RGBA.fromHex("#dddddd")
  const themeMuted = RGBA.fromHex("#888888")
  let clears = 0

  const fake = {
    options: {},
    app: { version: "2.0.11", channel: "stable" },
    renderer: { widthMethod: "unicode" },
    theme: {
      text: { muted: themeMuted, base: themeBase },
      border: { base: RGBA.fromHex("#555555") },
    },
    ui: {
      dialog: {
        show: (render: () => JSX.Element, onClose?: () => void) => {
          shows.push({ render, onClose })
        },
        set: (options: { readonly size?: string; readonly centered?: boolean }) => {
          sizes.push(options)
        },
        clear: () => {
          clears += 1
        },
        alert: async (options: { readonly title: string; readonly message: string }) => {
          alerts.push(options)
        },
      },
      format: {
        path: (value: string) => value.replace("/home/ada", "~"),
      },
    },
    keymap: {
      layer: (input: CapturedLayer["input"]) => {
        layers.push({ input })
      },
    },
  }

  return {
    // SAFETY: the fake covers every context member the dialog touches; the host
    // members it omits are unreachable on this path.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double
    context: fake as unknown as Plugin.Context,
    themeBase,
    shows,
    sizes,
    alerts,
    commands: () => layers.at(-1)?.input().commands ?? [],
    clearCount: () => clears,
  }
}

interface StoreState {
  reads: number
  saves: StatusSettingsSaveInput[]
  readResult: StatusSettingsReadResult
  saveResults: StatusSettingsSaveResult[]
}

interface DialogHarness {
  readonly frame: () => string
  readonly press: (key: string) => Promise<void>
  readonly typeText: (text: string) => Promise<void>
  readonly paste: (text: string) => Promise<void>
  readonly inputKey: (key: string) => Promise<void>
  readonly resize: (width: number, height: number) => Promise<void>
  readonly clickAt: (x: number, y: number) => Promise<void>
  /** Waits until the rendered frame contains a marker, for the real store's async read. */
  readonly waitFor: (text: string) => Promise<void>
  /** Waits for a completed save to close the dialog, for the real store's async write. */
  readonly waitForClose: () => Promise<void>
  /** Clicks the first frame line containing the marker, for mouse flows. */
  readonly clickLine: (marker: string) => Promise<void>
  /** Sends wheel events over the dialog body, for mouse flows. */
  readonly scroll: (direction: "up" | "down", times?: number) => Promise<void>
  readonly state: StoreState
  readonly saved: readonly NormalizedStatusOptions[]
  readonly host: FakeHost
  readonly closes: () => number
  readonly destroy: () => void
}

const ENTRY: StatusSettingsEntry = { specifier: "opencode2-enhanced-composer", index: 0, options: {}, enabled: true }

const PATH = "/home/ada/.config/opencode/cli.json"

const SAVED_OPTIONS = resolveStatusOptions({ appearance: { separator: "pipe" } }).options

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function mountDialog(input: {
  readonly entries?: readonly StatusSettingsEntry[]
  readonly saveResults?: readonly StatusSettingsSaveResult[]
  readonly height?: number
  readonly width?: number
  readonly store?: StatusSettingsStore
}): Promise<DialogHarness> {
  const host = createFakeHost()

  const state: StoreState = {
    reads: 0,
    saves: [],
    readResult: { status: "read", state: { path: PATH, entries: input.entries ?? [] } },
    saveResults: [...(input.saveResults ?? [])],
  }

  const store: StatusSettingsStore =
    input.store ??
    {
      read: async () => {
        state.reads += 1

        return state.readResult
      },
      save: async (saveInput) => {
        state.saves.push(saveInput)

        return state.saveResults.shift() ?? { status: "saved", options: SAVED_OPTIONS }
      },
    }

  const saved: NormalizedStatusOptions[] = []
  let closes = 0
  let resolveClose: (() => void) | undefined

  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve
  })

  const app = await testRender(
    () => (
      <StatusSettingsDialog
        context={host.context}
        store={store}
        fallback={DEFAULT_STATUS_OPTIONS}
        onSaved={(options) => saved.push(options)}
        requestClose={() => {
          closes += 1
          resolveClose?.()
        }}
      />
    ),
    // Mouse reporting must be on for the mock mouse to reach the dialog, the
    // same way the host's `"mouse": true` gates it in production.
    { width: input.width ?? 100, height: input.height ?? 36, useMouse: true },
  )

  await app.renderOnce()
  await app.renderOnce()

  return {
    frame: () => app.captureCharFrame(),
    resize: async (width, height) => {
      app.resize(width, height)
      await app.renderOnce()
      await app.renderOnce()
      await app.renderOnce()
    },
    clickAt: async (x, y) => {
      await app.mockMouse.click(x, y)
      await app.renderOnce()
    },
    typeText: async (text) => {
      await app.mockInput.typeText(text)
      await app.renderOnce()
    },
    paste: async (text) => {
      await app.mockInput.pasteBracketedText(text)
      await app.renderOnce()
    },
    inputKey: async (key) => {
      app.mockInput.pressKey(key)
      await app.renderOnce()
    },
    press: async (key) => {
      const command = host.commands().find((candidate) => candidate.bind === key)

      if (command === undefined) throw new Error(`no key binding: ${key}`)
      void command.run?.()
      await settle()
      await app.renderOnce()
    },
    waitFor: async (text) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await settle()
        await app.renderOnce()

        if (app.captureCharFrame().includes(text)) return
      }

      throw new Error(`timed out waiting for ${text}`)
    },
    waitForClose: () =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for dialog close")), 1000)

        void closed.then(() => {
          clearTimeout(timeout)
          resolve()
        })
      }),
    clickLine: async (marker) => {
      const lines = app.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes(marker))

      if (y === -1) throw new Error(`no frame line contains: ${marker}`)
      await app.mockMouse.click(4, y)
      await settle()
      await app.renderOnce()
    },
    scroll: async (direction, times = 1) => {
      for (let index = 0; index < times; index += 1) await app.mockMouse.scroll(50, 15, direction)
      await settle()
      await app.renderOnce()
    },
    state,
    saved,
    host,
    closes: () => closes,
    destroy: () => app.renderer.destroy(),
  }
}

/** The bordered preview block, for assertions about the rendered sample row. */
function previewBlock(frame: string): string {
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes("┌─Preview") || line.includes("┌─preview"))

  if (start === -1) return ""

  const end = lines.findIndex((line, index) => index > start && line.includes("└"))

  return lines.slice(start, end === -1 ? start + 7 : end + 1).join("\n")
}

/** Walks down until the frame shows the marker, so catalog changes cannot silently shift a counted walk. */
async function walkTo(app: DialogHarness, marker: string): Promise<void> {
  for (let step = 0; step < 40; step++) {
    if (app.frame().includes(marker)) return

    await app.press("down")
  }

  throw new Error(`Could not reach ${marker}`)
}

async function focusAppearance(app: DialogHarness, title: string): Promise<void> {
  await app.press("2")

  await walkTo(app, `› ${title}:`)
}

/** The first frame line carrying a control row, for value-column and description assertions. */
function rowLine(frame: string, label: string): string {
  return frame.split("\n").find((line) => line.includes(`${label}:`)) ?? ""
}

describe("custom appearance inputs", () => {
  test("cycles into inline editing, types shortcut characters, previews and saves", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Directory icon")
      const before = rowLine(app.frame(), "Directory icon")

      // Cycling onto `custom` selects it like a preset: the row shows the
      // empty custom value and the normal keys stay bound.
      await app.press("left")
      expect(rowLine(app.frame(), "Directory icon")).toContain("empty custom")
      expect(app.frame()).toContain("enter edit")
      expect(app.host.commands().map((command) => command.bind)).toContain("left")
      // Enter opens the editor; the input lives in the value column, starting
      // where the preset's `‹` starts, with the description visible beside it.
      await app.press("return")
      expect(app.frame()).toContain("enter accept")
      expect(rowLine(app.frame(), "Directory icon").indexOf("custom")).toBe(before.indexOf("‹"))
      expect(rowLine(app.frame(), "Directory icon")).toContain("Which folder symbol to show.")
      expect(app.host.commands().map((command) => command.bind)).not.toContain("s")
      expect(app.host.commands().map((command) => command.bind)).not.toContain("left")
      await app.typeText("sl123 []")
      expect(app.frame()).toContain("sl123 []")
      expect(previewBlock(app.frame())).toContain("sl123 [] app")
      expect(app.state.saves).toHaveLength(0)
      await app.press("return")
      expect(app.frame()).toContain("sl123 [] custom")
      expect(app.frame()).toContain("1 unsaved")
      await app.press("s")
      expect(app.state.saves[0]?.patch.appearance?.directory?.icon).toEqual({ text: "sl123 []" })
    } finally {
      app.destroy()
    }
  })

  test("editing never dims the host's shared theme colors", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Directory icon")
      await app.press("left")
      await app.press("return")
      await app.paste("📁")
      await app.press("return")
      // The faded input band is a clone; the theme's own base color must keep
      // full alpha or every piece of host text drawn with it turns muted.
      expect(app.host.themeBase.toInts()).toEqual([0xdd, 0xdd, 0xdd, 0xff])
    } finally {
      app.destroy()
    }
  })

  test("pastes emoji, edits with the native cursor and cancels locally", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Directory icon")
      await app.press("left")
      await app.press("return")
      await app.paste("🧑🏽‍💻")
      expect(previewBlock(app.frame())).toContain("🧑🏽‍💻 app")
      await app.inputKey("ARROW_LEFT")
      await app.typeText("A")
      expect(previewBlock(app.frame())).toContain("A🧑🏽‍💻 app")
      await app.inputKey("DELETE")
      expect(previewBlock(app.frame())).toContain("A app")
      await app.press("escape")
      expect(app.closes()).toBe(0)
      // Esc backs out of the editor to the hovered selection: the empty custom
      // the cycle applied, with the emoji text discarded.
      expect(rowLine(app.frame(), "Directory icon")).toContain("empty custom")
      expect(app.frame()).toContain("1 unsaved")
      expect(previewBlock(app.frame())).not.toContain("A app")
      expect(app.frame()).not.toContain("editing custom text")
    } finally {
      app.destroy()
    }
  })

  test("edits token labels as a pair and Ctrl+S accepts both inputs", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Token labels")
      await app.press("left")
      await app.press("return")
      await app.paste("📥")
      await app.press("tab")
      await app.paste("📤")
      expect(previewBlock(app.frame())).toContain("📥 128k")
      expect(previewBlock(app.frame())).toContain("📤 4.2k")
      await app.press("shift+tab")
      await app.typeText(" in")
      await app.press("ctrl+s")
      expect(app.state.saves[0]?.patch.appearance?.tokens).toEqual({ input: "📥 in", output: "📤" })
      expect(app.closes()).toBe(1)
    } finally {
      app.destroy()
    }
  })

  test("editing one field in a multi-input control does not clear an error from an invalid field", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Token labels")
      await app.press("left")
      await app.press("return")

      await app.typeText("\u2028")
      expect(app.frame()).toContain("Use valid single-line text")

      await app.press("tab")
      await app.typeText("out")
      expect(app.frame()).toContain("Use valid single-line text")

      await app.press("ctrl+s")
      expect(app.state.saves).toHaveLength(0)

      await app.press("shift+tab")
      await app.inputKey("BACKSPACE")
      await app.typeText("in")
      expect(app.frame()).not.toContain("Use valid single-line text")
      await app.press("ctrl+s")
      expect(app.state.saves[0]?.patch.appearance?.tokens).toEqual({ input: "in", output: "out" })
      expect(app.closes()).toBe(1)
    } finally {
      app.destroy()
    }
  })

  test("rejects invalid paste before native sanitization and recovers on valid input", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Directory icon")
      await app.press("left")
      await app.press("return")

      for (const text of ["one\ntwo", "\u001b[31mred", "\t", "\u2028"]) {
        await app.paste(text)
        expect(app.frame()).toContain("Use valid single-line text")
        await app.press("ctrl+s")
        expect(app.state.saves).toHaveLength(0)
      }

      await app.paste("📁")
      expect(app.frame()).not.toContain("Use valid single-line text")
      await app.press("ctrl+s")
      expect(app.state.saves[0]?.patch.appearance?.directory?.icon).toEqual({ text: "📁" })
    } finally {
      app.destroy()
    }
  })

  test("reopens custom text, accepts empty text and cycles back to presets", async () => {
    const app = await mountDialog({ entries: [{ ...ENTRY, options: { appearance: { branch: { text: "🌿" } } } }] })

    try {
      await focusAppearance(app, "Branch")
      expect(app.frame()).toContain("🌿 custom")
      await app.press("return")
      await app.inputKey("BACKSPACE")
      await app.press("return")
      expect(app.frame()).toContain("empty custom")
      await app.press("right")
      expect(app.frame()).toContain("\u{e0a0}")
      await app.press("s")
      expect(app.state.saves[0]?.patch.appearance?.branch).toBe("e0a0")
    } finally {
      app.destroy()
    }
  })

  test("cycling away from custom keeps the text for the next hover", async () => {
    const app = await mountDialog({ entries: [{ ...ENTRY, options: { appearance: { branch: { text: "🌿" } } } }] })

    try {
      await focusAppearance(app, "Branch")
      await app.press("right")
      expect(app.frame()).toContain("\u{e0a0}")
      // Hovering back onto `custom` restores the text that cycling away kept.
      await app.press("left")
      expect(app.frame()).toContain("🌿 custom")
      expect(app.frame()).toContain("enter edit")
      expect(app.host.commands().map((command) => command.bind)).toContain("left")
      await app.press("return")
      await app.inputKey("BACKSPACE")
      await app.typeText("A")
      await app.press("return")
      expect(app.frame()).toContain("A custom")
      await app.press("s")
      expect(app.state.saves[0]?.patch.appearance?.branch).toEqual({ text: "A" })
    } finally {
      app.destroy()
    }
  })

  test("preserves literal separator spacing", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Separator")
      await app.press("right")
      await app.press("right")
      expect(rowLine(app.frame(), "Separator")).toContain("empty custom")
      await app.press("return")
      await app.paste(" ⚡ ")
      await app.press("return")
      expect(app.frame()).toContain('" ⚡ " custom')
      expect(previewBlock(app.frame())).toContain(" ⚡ ")
      await app.press("s")
      expect(app.state.saves[0]?.patch.appearance?.separator).toEqual({ text: " ⚡ " })
    } finally {
      app.destroy()
    }
  })

  test("long input stays on one row at minimum size and is saved without truncation", async () => {
    const app = await mountDialog({ entries: [ENTRY], width: 60, height: 20 })
    const text = "日本語🧑🏽‍💻".repeat(150)

    try {
      await focusAppearance(app, "Directory icon")
      await app.press("left")
      await app.press("return")
      await app.paste(text)
      const frame = app.frame()

      expect(frame).toContain("Directory icon:")
      expect(frame).toContain("Save changes")
      expect(frame).toContain("ctrl+s save")
      expect(frame.trimEnd().split("\n").length).toBeLessThanOrEqual(20)
      await app.press("ctrl+s")
      expect(app.state.saves[0]?.patch.appearance?.directory?.icon).toEqual({ text })
    } finally {
      app.destroy()
    }
  })

  test.each([
    ["Worktree marker", "worktree"],
    ["Cache", "cache"],
    ["Cost", "cost"],
    ["Background agent", "bgagent"],
  ] as const)("saves custom text for %s", async (title, field) => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, title)

      for (let step = 0; step < 4 && !rowLine(app.frame(), title).includes("custom"); step++) await app.press("right")

      await app.press("return")
      await app.paste("★")
      await app.press("ctrl+s")
      expect(app.state.saves[0]?.patch.appearance?.[field]).toEqual({ text: "★" })
    } finally {
      app.destroy()
    }
  })

  test("canceling token edits restores both labels and preserves other draft edits", async () => {
    const app = await mountDialog({ entries: [{ ...ENTRY, options: { appearance: { tokens: { input: "in", output: "out" } } } }] })

    try {
      await focusAppearance(app, "Spinner")
      await app.press("right")
      await focusAppearance(app, "Token labels")
      await app.press("return")
      await app.typeText("put")
      await app.press("tab")
      await app.typeText("put")
      await app.press("escape")
      expect(app.frame()).toContain("in / out custom")
      expect(app.frame()).toContain("1 unsaved")
      await app.press("s")
      expect(app.state.saves[0]?.changed).toEqual(["appearance.spinner"])
    } finally {
      app.destroy()
    }
  })

  test("a failed custom save keeps the accepted text for retry", async () => {
    const app = await mountDialog({ entries: [ENTRY], saveResults: [{ status: "error", message: "Disk unavailable" }] })

    try {
      await focusAppearance(app, "Directory icon")
      await app.press("left")
      await app.press("return")
      await app.paste("📁")
      await app.press("ctrl+s")
      expect(app.frame()).toContain("Disk unavailable")
      await app.press("escape")
      await focusAppearance(app, "Directory icon")
      expect(app.frame()).toContain("📁 custom")
      await app.press("s")
      expect(app.state.saves[1]?.patch.appearance?.directory?.icon).toEqual({ text: "📁" })
    } finally {
      app.destroy()
    }
  })

  test("resize preserves the edit buffer and blocks saving invisible inputs", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Directory icon")
      await app.press("left")
      await app.press("return")
      await app.paste("📁")
      await app.resize(45, 18)
      expect(app.frame()).toContain("Terminal too small")
      await app.press("ctrl+s")
      expect(app.state.saves).toHaveLength(0)
      await app.resize(80, 24)
      expect(app.frame()).toContain("editing custom text")
      await app.typeText("★")
      await app.press("ctrl+s")
      expect(app.state.saves[0]?.patch.appearance?.directory?.icon).toEqual({ text: "📁★" })
    } finally {
      app.destroy()
    }
  })

  test("mouse focuses either token input and Cancel remains reachable after invalid paste", async () => {
    const app = await mountDialog({ entries: [ENTRY] })

    try {
      await focusAppearance(app, "Token labels")
      await app.press("left")
      await app.press("return")
      const line = rowLine(app.frame(), "Token labels")
      const valueStart = line.indexOf("Token labels:") + 17
      const value = line.slice(valueStart)
      const y = app.frame().split("\n").findIndex((candidate) => candidate.includes("Token labels:"))

      // Both inputs sit inside the 25-cell value column: click just past each
      // inline label to focus that field.
      await app.clickAt(valueStart + value.indexOf("out ") + 5, y)
      await app.typeText("output")
      await app.clickAt(valueStart + value.indexOf("in ") + 3, y)
      await app.typeText("input")
      expect(previewBlock(app.frame())).toContain("input 128k")
      expect(previewBlock(app.frame())).toContain("output 4.2k")
      expect(rowLine(app.frame(), "Token labels")).toContain("How to label input and output tokens.")
      await app.paste("bad\ntext")
      const actionY = app.frame().split("\n").findIndex((line) => line.includes("Save changes"))

      await app.clickAt(24, actionY)
      expect(app.frame()).not.toContain("editing custom text")
      await app.press("return")
      expect(app.closes()).toBe(1)
      expect(app.state.saves).toHaveLength(0)
    } finally {
      app.destroy()
    }
  })
})

describe("dialog render", () => {
  test("shows the title, the config path, the preview, and the layout rows", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })
    const frame = dialog.frame()

    expect(frame).toContain("Customize footer")
    expect(frame).toContain("no unsaved changes")
    expect(frame).not.toContain("cli.json")
    // The sample data behind the preview row is `previewSnapshot`'s "running"
    // project scenario, rendered with the default appearance.
    expect(frame).toContain("in 128k | out 4.2k | cache 61% | $0.42 | [▰▰▰▱▱] 100k context")
    expect(frame).toContain("~52.4 t/s")
    expect(frame).toContain("Layout")
    expect(frame).not.toContain("Shell sample")
    expect(frame).toContain("l preview worktree")
    expect(frame).not.toContain("Option")
    expect(frame).not.toContain("Selection")
    expect(frame).not.toContain("Description")
    expect(frame).toContain("Arrange widgets around the prompt.")
    expect(frame).toContain("› spinner")
    expect(frame).toContain("Top Left")
    expect(frame).toContain("Bottom Left")
    expect(frame).not.toContain("[Layout]")
    expect(frame).not.toContain("entry  opencode2-enhanced-composer")
    expect(previewBlock(frame)).toContain("Type a message")

    dialog.destroy()
  })

  test("the key layer is modal and binds the editor keys", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })
    const layer = dialog.host.commands()

    expect(dialog.host.shows).toHaveLength(0)
    expect(layer.map((command) => command.bind)).toEqual([
      "tab",
      "shift+tab",
      "up",
      "down",
      "left",
      "right",
      "return",
      "space",
      "[",
      "]",
      "shift+left",
      "shift+right",
      "pageup",
      "pagedown",
      "l",
      "1",
      "2",
      "3",
      "ctrl+s",
      "s",
      "escape",
    ])

    dialog.destroy()
  })

  test("moves a widget corner and hides it with space", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("right")

    const moved = dialog.frame()

    expect(moved).toContain("› spinner")
    expect(previewBlock(moved)).toContain("~52.4 t/s")

    await dialog.press("space")

    const frame = dialog.frame()

    expect(frame).toContain("› spinner")
    expect(frame).toContain("Hidden")
    expect(frame).toContain("Activity indicator while a task is running.")
    expect(previewBlock(frame)).not.toMatch(BLOCK_SPINNER)

    dialog.destroy()
  })

  test("reorders within a corner with the bracket keys and follows the widget", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("down")
    await dialog.press("down")
    await dialog.press("down")

    expect(dialog.frame()).toContain("› directory")

    await dialog.press("]")

    // The cursor stays on directory after the swap, so repeated `]` walks it
    // down without an `up`/`down` between each step.
    expect(dialog.frame()).toContain("› directory")

    await dialog.press("]")

    expect(dialog.frame()).toContain("› directory")

    await dialog.press("[")

    expect(dialog.frame()).toContain("› directory")

    dialog.destroy()
  })

  test("enter on a widget jumps to its appearance controls", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("return")

    const frame = dialog.frame()

    expect(frame).toContain("Appearance")
    expect(frame).toContain("› Spinner:")
    expect(frame).toContain("■⬝ blocks")
    expect(frame).toContain("Directory icon:")
    expect(frame).not.toContain("Bottom Left")

    dialog.destroy()
  })

  test("cycles appearance choices and the preview follows", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("return")

    expect(dialog.frame()).toContain("› Spinner:")

    await dialog.press("right")

    expect(dialog.frame()).toContain("Running text")

    await walkTo(dialog, "› Separator:")

    expect(dialog.frame()).toContain("› Separator:")

    await dialog.press("left")

    const frame = dialog.frame()

    expect(frame).toContain("· dot")
    expect(previewBlock(frame)).toContain(" · ")
    expect(frame).toContain("2 unsaved")

    dialog.destroy()
  })

  test("context text and bar are separate controls", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("return")

    await walkTo(dialog, "› Context:")

    expect(dialog.frame()).toContain("› Context:")
    expect(dialog.frame()).toContain("Context bar:")

    await dialog.press("right")

    expect(previewBlock(dialog.frame())).toContain("[▰▰▰▱▱] 100k (50%)")

    await dialog.press("right")

    expect(dialog.frame()).toContain("50%")
    expect(previewBlock(dialog.frame())).toContain("[▰▰▰▱▱] 50%")

    await dialog.press("right")

    expect(dialog.frame()).toContain("100k/200k")
    expect(previewBlock(dialog.frame())).toContain("[▰▰▰▱▱] 100k/200k")

    await dialog.press("down")

    expect(dialog.frame()).toContain("› Context bar:")

    await dialog.press("right")

    expect(dialog.frame()).toContain("off")
    expect(previewBlock(dialog.frame())).toContain("100k/200k")
    expect(previewBlock(dialog.frame())).not.toContain("[▰▰▰▱▱]")

    // The order row sits after the label; with the bar back on, cycling it
    // rearranges the preview.
    await dialog.press("left")

    expect(previewBlock(dialog.frame())).toContain("[▰▰▰▱▱] 100k/200k")

    await dialog.press("down")
    await dialog.press("down")

    expect(dialog.frame()).toContain("› Context order:")

    await dialog.press("right")
    await dialog.press("right")

    expect(previewBlock(dialog.frame())).toContain("100k/200k [▰▰▰▱▱]")

    dialog.destroy()
  })

  test("cycles overflow presets and editing one switches to custom", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("3")

    expect(dialog.frame()).toContain("› Preset:")
    expect(dialog.frame()).toContain("balanced")

    await dialog.press("right")

    expect(dialog.frame()).toContain("usage-first")

    await dialog.press("down")

    const heading = dialog.frame()

    // The list sits under the preset control that produces it.
    expect(heading).toContain("Hide order (hide first ↓ hide last)")
    expect(heading).toContain("› branch")

    await dialog.press("]")

    const frame = dialog.frame()
    const list = frame.slice(frame.indexOf("Hide order (hide first ↓ hide last)"))

    expect(frame).toContain("custom")
    // The cursor follows the moved widget, so branch is now second in the list.
    expect(list.indexOf("directory")).toBeLessThan(list.indexOf("branch"))
    expect(list).toContain("› branch")

    dialog.destroy()
  })

  test("the overflow section shows names alone under its direction heading", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("3")

    const frame = dialog.frame()
    const list = frame.slice(frame.indexOf("Hide order (hide first ↓ hide last)"))

    expect(frame).toContain("› Preset:")
    expect(frame).toContain("‹ balanced ›")
    expect(list).toContain("cost")
    // The widget descriptions stay in the Layout section; the overflow list
    // shows the names alone.
    expect(list).not.toContain("Total cost for this session.")
    expect(list).not.toContain("Current Git branch.")

    dialog.destroy()
  })

  test("a priority reorder hands the custom preset and list to the save", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("3")
    await dialog.press("down")

    await dialog.press("]")

    const frame = dialog.frame()

    expect(frame).toContain("custom")
    expect(frame).toContain("1 unsaved")

    await dialog.press("s")

    const input = dialog.state.saves[0]

    expect(input?.changed).toEqual(["overflow.preset"])
    expect(input?.patch.overflow?.preset).toBe("custom")
    expect(input?.patch.overflow?.hideFirst?.[0]).toBe("branch")
    expect(input?.patch.overflow?.hideFirst?.[1]).toBe("cost")
    expect(input?.patch.overflow?.hideFirst).toHaveLength(WIDGET_IDS.length)

    dialog.destroy()
  })

  test("the location shortcut updates the preview sample without moving focus or dirtying settings", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("2")
    await dialog.press("l")

    const wide = dialog.frame()

    expect(wide).toContain("l preview project")
    expect(wide.indexOf("l preview project")).toBeGreaterThan(wide.indexOf("Save changes"))
    expect(wide).toContain("› Spinner:")
    expect(wide).toContain("no unsaved changes")
    expect(previewBlock(wide)).toMatch(BLOCK_SPINNER)
    expect(previewBlock(wide)).toContain("\u{e5fb}")
    expect(previewBlock(wide)).toContain("$0.42")
    expect(previewBlock(wide)).toContain("Type a message")

    await dialog.press("l")

    expect(dialog.frame()).toContain("l preview worktree")
    expect(dialog.frame()).toContain("› Spinner:")
    await dialog.press("s")
    expect(dialog.state.saves[0]?.changed).toEqual([])

    dialog.destroy()
  })

  test("a short dialog windows the section body around the cursor", async () => {
    const dialog = await mountDialog({ entries: [ENTRY], height: 26 })

    const first = dialog.frame()
    const previewLines = previewBlock(first).split("\n")

    expect(first).toContain("Above the prompt. Sessions only.")
    expect(first).toContain("› spinner")
    expect(first).not.toContain("Hidden")
    expect(previewLines).toHaveLength(5)
    expect(previewLines[4]).toMatch(/^\s*└─+┘\s*$/u)

    for (let index = 0; index < 40; index += 1) await dialog.press("down")

    const scrolled = dialog.frame()

    expect(scrolled).toContain("bgagent")
    expect(scrolled).not.toContain("Top Left")
    expect(scrolled).toContain("› Reset defaults")
    expect(scrolled).toContain("enter run")
    expect(scrolled).toContain("tab settings")
    expect(scrolled).toContain("esc cancel")

    dialog.destroy()
  })

  test("section shortcuts preserve edits and leave focus on an actionable row", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("2")
    await dialog.press("right")
    await dialog.press("3")
    expect(dialog.frame()).toContain("› Preset:")
    await dialog.press("1")
    expect(dialog.frame()).toContain("› spinner")
    await dialog.press("2")
    expect(dialog.frame()).toContain("Running text")
    expect(dialog.frame()).toContain("1 unsaved")
    await dialog.press("s")
    expect(dialog.state.saves[0]?.patch.appearance?.spinner).toBe("text")
    dialog.destroy()
  })

  test("narrow dialogs retain focused descriptions, actions, and keyboard help", async () => {
    for (const [width, height] of [[60, 20], [80, 24]]) {
      const dialog = await mountDialog({ entries: [ENTRY], width, height })

      await dialog.press("2")
      const frame = dialog.frame()

      expect(frame).toContain("› Spinner:")
      expect(frame).toContain("How the spinner looks while a task is running.")
      expect(frame).toContain("Save changes")
      expect(frame).toContain("esc cancel")
      expect(frame).toContain("[2] Appearance")
      expect(frame).not.toContain("Description")
      await dialog.press("right")
      expect(dialog.frame()).toContain("Running text")
      dialog.destroy()
    }
  })

  test("a wrapped legend wraps whole hints, never a stranded separator", async () => {
    const dialog = await mountDialog({ entries: [ENTRY], width: 60, height: 24 })

    // The widget legend is the longest, so it stacks at this width with the
    // universal hints right-aligned below it. Neither continuation line may start with " · ".
    const frame = dialog.frame()
    const lines = frame.split("\n")

    expect(frame).toContain("esc cancel")
    expect(frame).toContain("l preview worktree")
    expect(lines.every((line) => !/^\s*·/u.test(line))).toBe(true)
    dialog.destroy()
  })

  test("the small-screen fallback permits closing but prevents invisible edits", async () => {
    const dialog = await mountDialog({ entries: [ENTRY], width: 50, height: 18 })

    expect(dialog.frame()).toContain("Terminal too small")
    await dialog.press("s")
    expect(dialog.state.saves).toHaveLength(0)
    await dialog.press("escape")
    expect(dialog.closes()).toBe(1)
    dialog.destroy()
  })

  test("escape closes a compact dialog even when its target panel is open", async () => {
    const dialog = await mountDialog({
      entries: [ENTRY, { ...ENTRY, index: 1, specifier: "opencode2-enhanced-composer@next" }],
      width: 50,
      height: 18,
    })

    await dialog.press("escape")

    expect(dialog.closes()).toBe(1)
    dialog.destroy()
  })
})

describe("mouse support", () => {
  test("clicking a row focuses it; clicking the focused row cycles its value", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.waitFor("› spinner")
    // The Spinner control starts below the fold: jump to it, step back so it
    // stays visible, then drive it with clicks alone.
    await dialog.press("return")
    await dialog.press("up")

    expect(dialog.frame()).toContain("Spinner:")
    expect(dialog.frame()).not.toContain("› Spinner:")

    await dialog.clickLine("Spinner:")

    expect(dialog.frame()).toContain("› Spinner:")

    await dialog.clickLine("Spinner:")

    expect(dialog.frame()).toContain("1 unsaved")

    dialog.destroy()
  })

  test("clicking a widget twice jumps to its appearance control", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.waitFor("› spinner")
    await dialog.press("down")
    await dialog.clickLine("spinner")

    expect(dialog.frame()).toContain("› spinner")

    await dialog.clickLine("spinner")

    expect(dialog.frame()).toContain("› Spinner:")

    dialog.destroy()
  })

  test("the wheel scrolls the list while the cursor stays put", async () => {
    const dialog = await mountDialog({ entries: [ENTRY], height: 26 })

    await dialog.waitFor("› spinner")
    await dialog.press("return")

    for (let index = 0; index < 40 && !dialog.frame().includes("› Context:"); index += 1) {
      await dialog.press("down")
    }

    expect(dialog.frame()).toContain("› Context:")

    for (let index = 0; index < 10 && dialog.frame().includes("› Context:"); index += 1) {
      await dialog.scroll("down")
    }

    expect(dialog.frame()).not.toContain("› Context:")

    // Scroll back toward the cursor until it reappears; the view parks
    // where the wheel leaves it, so returning takes its own steps.
    for (let index = 0; index < 10 && !dialog.frame().includes("› Context:"); index += 1) {
      await dialog.scroll("up")
    }

    expect(dialog.frame()).toContain("› Context:")

    // The cursor never moved: the row still takes keyboard input.
    await dialog.press("right")

    expect(dialog.frame()).toContain("100k (50%)")

    dialog.destroy()
  })

  test("clicking a visible row keeps the view and only moves focus", async () => {
    const dialog = await mountDialog({ entries: [ENTRY], height: 26 })

    await dialog.waitFor("› spinner")
    await dialog.press("return")

    for (let index = 0; index < 40 && !dialog.frame().includes("› Context:"); index += 1) {
      await dialog.press("down")
    }

    // Park the view below the cursor; the cursor stays on Context.
    for (let index = 0; index < 10 && dialog.frame().includes("› Context:"); index += 1) {
      await dialog.scroll("down")
    }

    expect(dialog.frame()).not.toContain("› Context:")

    const bodyLines = (): readonly string[] => {
      const lines = dialog.frame().split("\n")
      const top = lines.findIndex((line) => line.includes("└"))
      const bottom = lines.findIndex((line) => line.includes("Save changes"))

      return lines.slice(top + 1, bottom)
    }

    // Notes and headers never contain a colon; a `Title:` line is a focusable
    // control or preset row.
    const target = bodyLines()
      .map((line) => line.trim())
      .find((line) => line.includes(":"))

    if (target === undefined) throw new Error("no clickable row in view")
    const label = target.slice(0, target.indexOf(":") + 1)

    // The marker gutter is four columns wide after the dialog padding.
    const content = (lines: readonly string[]): readonly string[] => lines.map((line) => line.slice(6))
    const before = content(bodyLines())

    await dialog.clickLine(label)

    // Only the focus marker moved; the view is untouched.
    expect(content(bodyLines())).toEqual(before)
    expect(dialog.frame()).toContain(`› ${label}`)

    dialog.destroy()
  })

  test("clicking an action focuses it; clicking again runs it", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.waitFor("› spinner")
    await dialog.clickLine("Save changes")

    expect(dialog.frame()).toContain("› Save changes")
    expect(dialog.state.saves).toHaveLength(0)

    await dialog.clickLine("Save changes")

    expect(dialog.state.saves).toHaveLength(1)
    expect(dialog.closes()).toBe(1)

    dialog.destroy()
  })

  test("tab cycles between settings and actions without an invisible preview focus stop", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.waitFor("› spinner")
    await dialog.press("tab")
    expect(dialog.frame()).toContain("› Save changes")
    await dialog.press("l")
    expect(dialog.frame()).toContain("› Save changes")
    expect(dialog.frame()).toContain("l preview project")
    await dialog.press("tab")
    expect(dialog.frame()).toContain("› spinner")
    await dialog.press("up")
    expect(dialog.frame()).toContain("› spinner")

    dialog.destroy()
  })

  test("clicking a panel entry focuses it; clicking again adopts it", async () => {
    const second: StatusSettingsEntry = {
      specifier: "file:///home/ada/plugins/opencode2-enhanced-composer",
      index: 4,
      options: {},
      enabled: true,
    }

    const dialog = await mountDialog({ entries: [ENTRY, second] })

    await dialog.waitFor("Choose the entry to update")
    await dialog.clickLine("file:///")

    expect(dialog.frame()).toContain("› file:///home/ada/plugins/opencode2-enhanced-composer")

    await dialog.clickLine("file:///")

    const frame = dialog.frame()

    expect(frame).not.toContain("Choose the entry to update")
    expect(frame).toContain("› spinner")

    dialog.destroy()
  })
})

describe("save lifecycle", () => {
  test("save sends the draft's changed fields and applies the stored options", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("right")
    await dialog.press("s")

    expect(dialog.state.saves).toHaveLength(1)

    const input = dialog.state.saves[0]

    expect(input?.target).toBe(ENTRY)
    expect(input?.changed).toContain("layout.topLeft")
    expect(input?.changed).toContain("layout.topRight")
    expect(input?.patch.layout?.topLeft).toEqual(["bgagent"])
    expect(input?.patch.layout?.topRight).toEqual(["tps", "spinner"])
    expect(input?.patch.layout?.bottomLeft).toEqual(["directory", "branch"])
    expect(input?.patch.layout?.bottomRight).toEqual(["input", "output", "cache", "cost", "context"])
    expect(input?.force).toBe(false)
    expect(dialog.saved).toEqual([SAVED_OPTIONS])
    expect(dialog.closes()).toBe(1)

    dialog.destroy()
  })

  test("a clean save still persists the entry", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("ctrl+s")

    expect(dialog.state.saves).toHaveLength(1)
    expect(dialog.state.saves[0]?.changed).toEqual([])
    expect(dialog.saved).toHaveLength(1)

    dialog.destroy()
  })

  test("no entry asks before creating one", async () => {
    const dialog = await mountDialog({ entries: [] })

    await dialog.press("s")

    expect(dialog.frame()).toContain("Create a new entry")
    expect(dialog.state.saves).toHaveLength(0)

    await dialog.press("return")

    expect(dialog.state.saves).toHaveLength(1)
    expect(dialog.state.saves[0]?.target).toBeUndefined()

    dialog.destroy()
  })

  test("several matching entries ask which one to update", async () => {
    const second: StatusSettingsEntry = {
      specifier: "file:///home/ada/plugins/opencode2-enhanced-composer",
      index: 4,
      options: {},
      enabled: true,
    }

    const dialog = await mountDialog({ entries: [ENTRY, second] })

    expect(dialog.frame()).toContain("Choose the entry to update")
    expect(dialog.frame()).toContain("› opencode2-enhanced-composer")
    expect(dialog.frame()).toContain("file:///home/ada/plugins/opencode2-enhanced-composer")

    await dialog.press("down")
    await dialog.press("return")

    await dialog.press("right")
    await dialog.press("s")

    expect(dialog.state.saves[0]?.target).toBe(second)

    dialog.destroy()
  })

  test("a conflict is reported with both values and can keep the draft", async () => {
    const dialog = await mountDialog({
      entries: [ENTRY],
      saveResults: [
        {
          status: "conflict",
          fields: ["appearance.spinner"],
          current: resolveStatusOptions({ appearance: { spinner: "text" } }).options,
        },
      ],
    })

    await dialog.press("return")
    await dialog.press("left")
    await dialog.press("s")

    const frame = dialog.frame()

    expect(frame).toContain("These settings changed on disk")
    expect(frame).toContain("spinner style  yours: ⠋ braille · file: Running text")
    expect(frame).toContain("› Keep my changes")

    await dialog.press("return")

    expect(dialog.state.saves).toHaveLength(2)
    expect(dialog.state.saves[1]?.force).toBe(true)
    expect(dialog.saved).toHaveLength(1)

    dialog.destroy()
  })

  test("using the file's values keeps every other edit", async () => {
    const dialog = await mountDialog({
      entries: [ENTRY],
      saveResults: [
        {
          status: "conflict",
          fields: ["appearance.spinner"],
          current: resolveStatusOptions({ appearance: { spinner: "text" } }).options,
        },
      ],
    })

    await dialog.press("return")
    await dialog.press("right")
    await dialog.press("down")
    await dialog.press("right")
    await dialog.press("s")

    expect(dialog.state.saves).toHaveLength(1)

    await dialog.press("down")
    await dialog.press("return")

    const frame = dialog.frame()

    expect(frame).toContain("1 unsaved")
    expect(previewBlock(frame)).toContain("Running")
    expect(dialog.state.saves).toHaveLength(1)

    dialog.destroy()
  })

  test("a stale target re-offers the freshly read entries and keeps the draft", async () => {
    const dialog = await mountDialog({
      entries: [ENTRY],
      saveResults: [{ status: "stale", state: { path: PATH, entries: [] } }],
    })

    await dialog.press("right")
    await dialog.press("s")

    expect(dialog.frame()).toContain("The file changed while saving; pick the entry to update.")
    expect(dialog.frame()).toContain("Create a new opencode2-enhanced-composer entry")

    await dialog.press("escape")

    expect(dialog.frame()).toContain("2 unsaved")
    expect(dialog.frame()).toContain("Layout")

    dialog.destroy()
  })

  test("a failed save keeps the draft and can retry", async () => {
    const dialog = await mountDialog({
      entries: [ENTRY],
      saveResults: [
        { status: "error", message: "The config file is read-only" },
        { status: "error", message: "The config file is still read-only" },
      ],
    })

    await dialog.press("right")
    await dialog.press("s")

    expect(dialog.frame()).toContain("The config file is read-only")

    await dialog.press("escape")

    expect(dialog.frame()).toContain("2 unsaved")

    await dialog.press("s")

    expect(dialog.state.saves).toHaveLength(2)
    expect(dialog.frame()).toContain("The config file is still read-only")

    dialog.destroy()
  })

  test("reset restores the documented defaults in the draft without saving", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("right")

    expect(dialog.frame()).toContain("2 unsaved")

    await dialog.press("tab")

    expect(dialog.frame()).toContain("› Save changes")

    await dialog.press("right")
    await dialog.press("right")

    expect(dialog.frame()).toContain("› Reset defaults")

    await dialog.press("return")

    const frame = dialog.frame()

    expect(frame).toContain("no unsaved changes")
    expect(frame).toContain("spinner")
    expect(frame).toContain("Defaults loaded; Save to apply.")
    expect(dialog.state.saves).toHaveLength(0)

    dialog.destroy()
  })

  test("a disabled entry warns that saving won't enable the plugin", async () => {
    const disabled: StatusSettingsEntry = {
      specifier: "-opencode2-enhanced-composer",
      index: 2,
      options: {},
      enabled: false,
    }

    const dialog = await mountDialog({ entries: [ENTRY, disabled] })

    expect(dialog.frame()).toContain("disabled · saving won't enable the plugin")

    await dialog.press("down")
    await dialog.press("return")

    const frame = dialog.frame()

    expect(frame).toContain("saving won't enable it")

    dialog.destroy()
  })

  test("escape cancels without saving", async () => {
    const dialog = await mountDialog({ entries: [ENTRY] })

    await dialog.press("right")
    await dialog.press("escape")

    expect(dialog.state.saves).toHaveLength(0)
    expect(dialog.closes()).toBe(1)

    dialog.destroy()
  })
})

function pressKey(host: FakeHost, key: string): void {
  const command = host.commands().find((candidate) => candidate.bind === key)

  if (command === undefined) throw new Error(`no key binding: ${key}`)
  void command.run?.()
}

async function withConfigFixture(run: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "enhanced-composer-open-"))
  const previous = process.env.OPENCODE_CONFIG_DIR

  process.env.OPENCODE_CONFIG_DIR = join(root, "config")

  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

async function withInlineCliConfig(content: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.OPENCODE_CLI_CONFIG_CONTENT

  if (content === undefined) delete process.env.OPENCODE_CLI_CONFIG_CONTENT
  else process.env.OPENCODE_CLI_CONFIG_CONTENT = content

  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CLI_CONFIG_CONTENT
    else process.env.OPENCODE_CLI_CONFIG_CONTENT = previous
  }
}

describe("openStatusSettings", () => {
  test("treats an empty config directory as unset", async () => {
    const previous = process.env.OPENCODE_CONFIG_DIR

    process.env.OPENCODE_CONFIG_DIR = ""

    try {
      const host = createFakeHost()

      openStatusSettings(host.context)
      expect(host.shows).toHaveLength(1)
      expect(host.sizes).toEqual([{ size: "xlarge", centered: true }])
      expect(host.alerts).toEqual([])

      host.shows[0]?.onClose?.()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })

  test("blocks inline plugin overrides without exposing their contents", async () => {
    const inlineConfig = '{ "plugins": ["private-plugin"] }'

    await withInlineCliConfig(inlineConfig, async () => {
      const host = createFakeHost()

      openStatusSettings(host.context)
      await settle()

      expect(host.shows).toHaveLength(0)
      expect(host.sizes).toHaveLength(0)
      expect(host.alerts).toEqual([
        {
          title: "Customize footer unavailable",
          message:
            "OpenCode is using OPENCODE_CLI_CONFIG_CONTENT to override plugins. Update or unset that environment variable, then restart OpenCode before customizing the footer.",
        },
      ])
      expect(host.alerts[0]?.message).not.toContain("private-plugin")
    })
  })

  test("blocks plugin overrides alongside unrecognized config schema values", async () => {
    await withInlineCliConfig('{ "plugins": [], "theme": { "mode": "high-contrast" } }', async () => {
      const host = createFakeHost()

      openStatusSettings(host.context)
      await settle()

      expect(host.shows).toHaveLength(0)
      expect(host.alerts).toHaveLength(1)
    })
  })

  test("allows inline config without a plugins override", async () => {
    await withInlineCliConfig('{ "theme": { "mode": "dark" } }', async () => {
      const host = createFakeHost()

      openStatusSettings(host.context)

      expect(host.alerts).toHaveLength(0)
      expect(host.shows).toHaveLength(1)

      host.shows[0]?.onClose?.()
    })
  })

  test("sets the dialog size, shows once, and clears on cancel", async () => {
    await withConfigFixture(async () => {
      const host = createFakeHost()

      openStatusSettings(host.context)
      openStatusSettings(host.context)

      expect(host.sizes).toEqual([{ size: "xlarge", centered: true }])
      expect(host.shows).toHaveLength(1)

      const show = host.shows[0]

      if (show === undefined) throw new Error("no dialog shown")

      const app = await testRender(show.render, { width: 100, height: 36 })

      await app.renderOnce()
      await app.renderOnce()

      pressKey(host, "escape")
      await settle()

      expect(host.clearCount()).toBe(1)

      app.renderer.destroy()

      // The host's own close notification releases the single-open guard.
      show.onClose?.()
      openStatusSettings(host.context)

      expect(host.shows).toHaveLength(2)

      // Leave no session open for the next test.
      host.shows[1]?.onClose?.()
    })
  })

  test("a dialog the host already closed cannot clear a newer dialog", async () => {
    await withConfigFixture(async () => {
      const host = createFakeHost()

      openStatusSettings(host.context)

      const first = host.shows[0]

      if (first === undefined) throw new Error("no dialog shown")

      const app = await testRender(first.render, { width: 100, height: 36 })

      await app.renderOnce()
      await app.renderOnce()

      // The host replaced or dismissed the dialog without this editor asking.
      first.onClose?.()
      pressKey(host, "escape")
      await settle()

      expect(host.clearCount()).toBe(0)

      openStatusSettings(host.context)

      expect(host.shows).toHaveLength(2)

      // Leave no session open for the next test.
      host.shows[1]?.onClose?.()

      app.renderer.destroy()
    })
  })
})

async function writeConfigFixture(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf8")
}

describe("live flow", () => {
  test("retargeting a moved entry preserves unedited external settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "enhanced-composer-retarget-"))
    const path = join(root, "cli.json")

    await writeConfigFixture(path, JSON.stringify({ plugins: [ENTRY.specifier] }))

    const store = createCliStatusOptionsStore({
      identity: { packageName: ENTRY.specifier, directory: join(root, "plugin") },
      environment: { home: root, opencodeConfigDir: root },
    })

    const dialog = await mountDialog({ store })

    try {
      await dialog.waitFor("› spinner")
      await dialog.press("return")
      await dialog.press("right")
      await writeConfigFixture(path, JSON.stringify({
        plugins: ["another-plugin", {
          package: ENTRY.specifier,
          options: { appearance: { separator: "dot" }, refreshHz: 4 },
        }],
      }))
      await dialog.press("s")
      await dialog.waitFor("The file changed while saving")
      await dialog.press("return")
      await dialog.press("s")
      await dialog.waitForClose()

      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        plugins: ["another-plugin", {
          package: ENTRY.specifier,
          options: { appearance: { separator: "dot", spinner: "text" }, refreshHz: 4 },
        }],
      })
      expect(dialog.saved[0]?.appearance.separator).toBe("dot")
    } finally {
      dialog.destroy()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("custom inputs save to disk and reopen for editing", async () => {
    const root = await mkdtemp(join(tmpdir(), "enhanced-composer-custom-ui-"))

    try {
      const path = join(root, ".config", "opencode", "cli.json")

      await writeConfigFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { refreshHz: 4 } }] }))

      const store = createCliStatusOptionsStore({
        identity: { packageName: "opencode2-enhanced-composer", directory: join(root, "plugin") },
        environment: { home: root },
      })

      const dialog = await mountDialog({ store })

      try {
        await dialog.waitFor("› spinner")
        await focusAppearance(dialog, "Directory icon")
        await dialog.press("left")
        await dialog.press("return")
        await dialog.paste("📁")
        await dialog.press("ctrl+s")
        await dialog.waitForClose()
        expect(dialog.saved[0]?.appearance.directory.icon).toEqual({ text: "📁" })
      } finally {
        dialog.destroy()
      }

      const text = await readFile(path, "utf8")

      expect(text).toContain('"refreshHz": 4')
      const reopened = await mountDialog({ store })

      try {
        await reopened.waitFor("› spinner")
        await focusAppearance(reopened, "Directory icon")
        expect(reopened.frame()).toContain("📁 custom")
        expect(reopened.frame()).toContain("no unsaved changes")
        await reopened.press("return")
        await reopened.paste("★")
        await reopened.press("escape")
        expect(reopened.frame()).toContain("📁 custom")
        expect(await readFile(path, "utf8")).toBe(text)
      } finally {
        reopened.destroy()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reordering priorities on an empty entry saves a valid custom preset and reopens cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "enhanced-composer-live-"))

    try {
      const path = join(root, ".config", "opencode", "cli.json")

      await writeConfigFixture(
        path,
        JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { refreshHz: 4 } }] }),
      )

      const store = createCliStatusOptionsStore({
        identity: { packageName: "opencode2-enhanced-composer", directory: join(root, "plugin") },
        environment: { home: root },
      })

      const dialog = await mountDialog({ store })

      await dialog.waitFor("› spinner")

      // Jump to the overflow section's first priority row and move it.
      await dialog.press("3")
      await dialog.press("down")

      await dialog.press("]")

      expect(dialog.frame()).toContain("custom")
      expect(dialog.frame()).toContain("1 unsaved")

      await dialog.press("s")
      await dialog.waitForClose()

      expect(dialog.saved).toHaveLength(1)
      expect(dialog.saved[0]?.overflow.preset).toBe("custom")
      expect(dialog.saved[0]?.overflow.hideFirst[0]).toBe("branch")
      expect(dialog.closes()).toBe(1)

      // What the host reads when the editor is reopened: a complete custom
      // preset and no diagnostics, with the unrelated option intact.
      const read = await store.read()

      if (read.status !== "read") throw new Error(`expected a read, got ${read.status}`)
      const resolution = resolveStatusOptions(read.state.entries[0]?.options ?? {})
      const text = await readFile(path, "utf8")

      expect(resolution.diagnostics).toEqual([])
      expect(resolution.options.overflow.preset).toBe("custom")
      expect(resolution.options.overflow.hideFirst[0]).toBe("branch")
      expect(text).toContain('"hideFirst"')
      expect(text).toContain('"refreshHz": 4')

      dialog.destroy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("disposal", () => {
  test("a save that resolves after unmounting still applies its options and clears nothing", async () => {
    const host = createFakeHost()
    const saved: NormalizedStatusOptions[] = []
    let closes = 0
    let releaseSave: ((result: StatusSettingsSaveResult) => void) | undefined
    let saves = 0

    const store: StatusSettingsStore = {
      read: async () => ({ status: "read", state: { path: PATH, entries: [ENTRY] } }),
      save: async () => {
        saves += 1

        return new Promise<StatusSettingsSaveResult>((resolve) => {
          releaseSave = resolve
        })
      },
    }

    const [mounted, setMounted] = createSignal(true)

    const app = await testRender(
      () => (
        <Show when={mounted()}>
          <StatusSettingsDialog
            context={host.context}
            store={store}
            fallback={DEFAULT_STATUS_OPTIONS}
            onSaved={(options) => saved.push(options)}
            requestClose={() => {
              closes += 1
            }}
          />
        </Show>
      ),
      { width: 100, height: 36 },
    )

    await app.renderOnce()
    await app.renderOnce()

    pressKey(host, "right")
    await settle()
    pressKey(host, "s")
    await settle()

    expect(saves).toBe(1)

    // The dialog closes while the save is in flight.
    setMounted(false)
    await app.renderOnce()

    releaseSave?.({ status: "saved", options: SAVED_OPTIONS })
    await settle()
    await app.renderOnce()

    // The write already landed, so the caller still receives the merged
    // options even though the dialog is gone; the dead dialog must not close
    // anything or touch its own signals.
    expect(saved).toEqual([SAVED_OPTIONS])
    expect(closes).toBe(0)

    app.renderer.destroy()
  })
})
