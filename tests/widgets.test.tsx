// Render and behavior tests for the visual widget primitives: the spinner
// faces, the static text face and animation
// lifecycle, the fixed-size context bars, and the curated glyph set's actual
// render widths — measured by the renderer itself, not by string length.
import { describe, expect, test } from "bun:test"
import { stringWidth } from "bun"
import { RGBA } from "@opentui/core"
import type { CapturedSpan } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { JSX } from "@opentui/solid"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import {
  BLOCK_FRAMES,
  BRAILLE_FRAMES,
  blockCells,
  blockScannerFrames,
  type ContextBarStyle,
  contextBarCellCount,
  contextBarCells,
  contextBarFill,
  contextBarText,
  CONTEXT_BAR_SLANTED_CELLS,
  CONTEXT_BAR_SOLID_CELLS,
  deriveInactiveColor,
  deriveTrailColors,
  SPINNER_INTERVAL_MS,
  SPINNER_TEXT_LABEL,
  SpinnerGlyph,
  spinnerCellWidth,
  spinnerFrameCount,
  spinnerRepresentativeText,
  type SpinnerVisual,
  useSpinnerFrame,
} from "../src/widgets.tsx"

const BASE = RGBA.fromHex("#ff8800")

// The trail-bloom assertions need a base with headroom below 1.0.
const TRAIL_BASE = RGBA.fromHex("#804400")

interface TimerSpy {
  intervalMs: number
  cleared: number
  created: number
}

interface PatchedTimers {
  readonly spy: TimerSpy
  readonly tick: () => void
  readonly restore: () => void
}

/**
 * The spinner timer is observable only through the globals it schedules on,
 * so the tests patch `setInterval`/`clearInterval` the way `footer.test.ts`
 * does: every created interval is recorded (and immediately backed by a real
 * cancelled handle so the return type stays honest), `tick` fires the live
 * callbacks, and `restore` puts the globals back.
 */
function patchTimers(): PatchedTimers {
  const spy: TimerSpy = { intervalMs: 0, cleared: 0, created: 0 }
  const intervals: Array<{ handle: ReturnType<typeof setInterval>; callback: () => void }> = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval

  globalThis.setInterval = (callback: () => void, ms?: number, ..._args: any[]) => {
    spy.intervalMs = ms ?? 0
    spy.created += 1
    // A real (immediately cancelled) handle keeps the host's return type honest
    // without leaving a live interval behind.
    const handle = realSetInterval(() => {}, 60_000)

    realClearInterval(handle)
    intervals.push({ handle, callback })

    return handle
  }

  globalThis.clearInterval = (handle) => {
    spy.cleared += 1
    const index = intervals.findIndex((entry) => entry.handle === handle)

    if (index >= 0) intervals.splice(index, 1)
  }

  return {
    spy,
    tick: () => {
      for (const entry of intervals.slice()) entry.callback()
    },
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

async function renderWidget(node: () => JSX.Element, width = 20, height = 3): Promise<TestRendererSetup> {
  const app = await testRender(node, { width, height })

  await app.renderOnce()

  return app
}

function contentSpans(app: TestRendererSetup): CapturedSpan[] {
  return (app.captureSpans().lines[0]?.spans ?? []).filter((span) => span.text.trim() !== "")
}

function firstContentSpan(app: TestRendererSetup): CapturedSpan {
  const span = contentSpans(app)[0]

  if (!span) throw new Error("no content span rendered")

  return span
}

describe("blockScannerFrames", () => {
  test("sweeps the head across the eight cells", () => {
    const frames = blockScannerFrames()

    expect(frames).toHaveLength(33) // 8 + 9 + 7 + 9

    for (const frame of frames) expect(frame).toHaveLength(8)
    expect(frames[0]).toBe("■⬝⬝⬝⬝⬝⬝⬝")
    expect(BRAILLE_FRAMES).toHaveLength(10)
  })
})

describe("block scanner colors", () => {
  test("derives a six-step trail with a brighter second step", () => {
    const colors = deriveTrailColors(TRAIL_BASE)

    expect(colors).toHaveLength(6)
    expect(colors[0]?.a).toBe(1)
    expect(colors[1]?.a).toBeCloseTo(0.9, 2)
    expect(colors[1]!.r).toBeGreaterThan(TRAIL_BASE.r)
    expect(colors[5]!.a).toBeLessThan(colors[2]!.a)
    expect(deriveInactiveColor(TRAIL_BASE, 0.6).a).toBeCloseTo(0.6, 2)
  })

  test("colors the lead cell with the trail head and the rest with the faded base", () => {
    const cells = blockCells(0, TRAIL_BASE)
    const colors = deriveTrailColors(TRAIL_BASE)

    expect(cells).toHaveLength(8)
    expect(cells[0]?.char).toBe("■")
    expect(cells[0]!.color.equals(colors[0]!)).toBe(true)
    expect(cells[1]?.char).toBe("⬝")
    expect(cells[1]!.color.a).toBeLessThan(0.6)
  })
})

describe("spinner surface", () => {
  test("reports each face's cell width", () => {
    expect(spinnerCellWidth("braille")).toBe(1)
    expect(spinnerCellWidth("blocks")).toBe(8)
    expect(spinnerCellWidth("text")).toBe(7)
  })

  test("reports each face's frame count", () => {
    expect(spinnerFrameCount("braille")).toBe(10)
    expect(spinnerFrameCount("blocks")).toBe(33)
    expect(spinnerFrameCount("text")).toBe(1)
  })

  test("the static label is the catalog's Running text", () => {
    expect(SPINNER_TEXT_LABEL).toBe("Running")
  })

  test("carries a representative text at exactly the face's width", () => {
    const cases: ReadonlyArray<readonly [SpinnerVisual, string]> = [
      ["braille", BRAILLE_FRAMES[0] ?? ""],
      ["blocks", BLOCK_FRAMES[0] ?? ""],
      ["text", SPINNER_TEXT_LABEL],
    ]

    for (const [visual, text] of cases) {
      expect(spinnerRepresentativeText(visual)).toBe(text)
      expect(stringWidth(spinnerRepresentativeText(visual))).toBe(spinnerCellWidth(visual))
    }
  })
})

describe("SpinnerGlyph render", () => {
  test("renders the braille face as one agent-colored cell", async () => {
    const app = await renderWidget(() => <SpinnerGlyph visual="braille" frameIndex={0} base={BASE} />)

    try {
      const span = firstContentSpan(app)

      expect(span.text).toBe(BRAILLE_FRAMES[0] ?? "")
      expect(span.width).toBe(1)
      expect(span.fg.equals(BASE)).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders any braille frame index", async () => {
    const app = await renderWidget(() => <SpinnerGlyph visual="braille" frameIndex={4} base={BASE} />)

    try {
      expect(firstContentSpan(app).text).toBe(BRAILLE_FRAMES[4] ?? "")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders the block face as eight cells with the trail head on the lead", async () => {
    const app = await renderWidget(() => <SpinnerGlyph visual="blocks" frameIndex={0} base={BASE} />)

    try {
      const spans = (app.captureSpans().lines[0]?.spans ?? []).filter((span) => /[■⬝]/u.test(span.text))
      const text = spans.map((span) => span.text).join("")

      expect(text).toBe(BLOCK_FRAMES[0] ?? "")
      expect(spans.reduce((sum, span) => sum + span.width, 0)).toBe(8)
      expect(spans.some((span) => span.text.includes("■") && span.fg.equals(blockCells(0, BASE)[0]!.color))).toBe(
        true,
      )
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders the static text face in the agent color", async () => {
    const app = await renderWidget(() => <SpinnerGlyph visual="text" frameIndex={0} base={BASE} />)

    try {
      const span = firstContentSpan(app)

      expect(span.text).toBe(SPINNER_TEXT_LABEL)
      expect(span.width).toBe(7)
      expect(span.fg.equals(BASE)).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("useSpinnerFrame lifecycle", () => {
  function FrameProbe(props: { visual: () => SpinnerVisual | undefined }) {
    const frame = useSpinnerFrame(props.visual)

    return (
      <Show when={props.visual()}>
        {(visual: () => SpinnerVisual) => <SpinnerGlyph visual={visual()} frameIndex={frame()} base={BASE} />}
      </Show>
    )
  }

  test("advances an animated face on the host-matched cadence", async () => {
    const timers = patchTimers()
    const [visual] = createSignal<SpinnerVisual | undefined>("braille")
    const app = await renderWidget(() => <FrameProbe visual={visual} />)

    try {
      expect(timers.spy.created).toBe(1)
      expect(timers.spy.intervalMs).toBe(SPINNER_INTERVAL_MS)
      expect(firstContentSpan(app).text).toBe(BRAILLE_FRAMES[0] ?? "")

      timers.tick()
      await app.renderOnce()
      expect(firstContentSpan(app).text).toBe(BRAILLE_FRAMES[1] ?? "")

      // A full cycle wraps back to the first frame.
      for (let tick = 0; tick < 9; tick += 1) timers.tick()
      await app.renderOnce()
      expect(firstContentSpan(app).text).toBe(BRAILLE_FRAMES[0] ?? "")
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("keeps the static text face timer-free", async () => {
    const timers = patchTimers()
    const [visual] = createSignal<SpinnerVisual | undefined>("text")
    const app = await renderWidget(() => <FrameProbe visual={visual} />)

    try {
      expect(timers.spy.created).toBe(0)
      expect(firstContentSpan(app).text).toBe(SPINNER_TEXT_LABEL)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("keeps a hidden spinner timer-free", async () => {
    const timers = patchTimers()
    const [visual] = createSignal<SpinnerVisual | undefined>(undefined)
    const app = await renderWidget(() => <FrameProbe visual={visual} />)

    try {
      expect(timers.spy.created).toBe(0)
      expect(app.captureCharFrame().trim()).toBe("")
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("drops the timer when the spinner disappears and remakes it for a new face", async () => {
    const timers = patchTimers()
    const [visual, setVisual] = createSignal<SpinnerVisual | undefined>("braille")
    const app = await renderWidget(() => <FrameProbe visual={visual} />)

    try {
      expect(timers.spy.created).toBe(1)

      setVisual(undefined)
      await app.renderOnce()
      expect(timers.spy.cleared).toBe(1)
      expect(timers.spy.created).toBe(1)
      expect(app.captureCharFrame().trim()).toBe("")

      setVisual("blocks")
      await app.renderOnce()
      expect(timers.spy.created).toBe(2)
      expect((app.captureSpans().lines[0]?.spans ?? []).some((span) => span.text.includes("■"))).toBe(true)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("cleans the timer up when the widget unmounts", async () => {
    const timers = patchTimers()
    const [visual] = createSignal<SpinnerVisual | undefined>("braille")
    const app = await renderWidget(() => <FrameProbe visual={visual} />)

    try {
      expect(timers.spy.created).toBe(1)
      expect(timers.spy.cleared).toBe(0)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }

    expect(timers.spy.cleared).toBe(1)
  })
})

describe("context bars", () => {
  test("expose the two fixed sizes", () => {
    expect(CONTEXT_BAR_SOLID_CELLS).toBe(10)
    expect(CONTEXT_BAR_SLANTED_CELLS).toBe(5)
    expect(contextBarCellCount("solid")).toBe(10)
    expect(contextBarCellCount("slanted")).toBe(5)
  })

  test.each([
    [0.51, "solid", 5],
    [0.55, "solid", 6],
    [0.05, "solid", 1],
    [0.049, "solid", 0],
    [0.5, "slanted", 3],
    [0.34, "slanted", 2],
    [1.2, "solid", 10],
    [-1, "slanted", 0],
    [Number.NaN, "solid", 0],
  ] satisfies ReadonlyArray<readonly [number, ContextBarStyle, number]>)(
    "fills a ratio of %p as %i %s cells",
    (ratio: number, style: ContextBarStyle, expected: number) => {
      expect(contextBarFill(ratio, style)).toBe(expected)
    },
  )

  test.each([
    [5, "solid", "█████░░░░░"],
    [0, "solid", "░░░░░░░░░░"],
    [10, "solid", "██████████"],
    [3, "slanted", "▰▰▰▱▱"],
    [0, "slanted", "▱▱▱▱▱"],
    [5, "slanted", "▰▰▰▰▰"],
    [99, "slanted", "▰▰▰▰▰"],
    [-5, "solid", "░░░░░░░░░░"],
  ] satisfies ReadonlyArray<readonly [number, ContextBarStyle, string]>)(
    "renders %i %s cells as %s",
    (fill: number, style: ContextBarStyle, expected: string) => {
      expect(contextBarCells(fill, style)).toBe(expected)
    },
  )

  test("brackets the cell run", () => {
    expect(contextBarText(5, "solid")).toBe("[█████░░░░░]")
    expect(contextBarText(5, "solid")).toHaveLength(12)
    expect(contextBarText(3, "slanted")).toBe("[▰▰▰▱▱]")
    expect(contextBarText(3, "slanted")).toHaveLength(7)
  })

  test("renders both bars at their fixed widths", async () => {
    const app = await renderWidget(() => (
      <box flexDirection="column">
        <text fg="#888888" wrapMode="none">
          {contextBarText(5, "solid")}
        </text>
        <text fg="#888888" wrapMode="none">
          {contextBarText(3, "slanted")}
        </text>
      </box>
    ))

    try {
      const lines = app.captureSpans().lines
      const solid = (lines[0]?.spans ?? []).find((span) => span.text.includes("█"))
      const slanted = (lines[1]?.spans ?? []).find((span) => span.text.includes("▰"))

      expect(solid?.width).toBe(12)
      expect(slanted?.width).toBe(7)
    } finally {
      app.renderer.destroy()
    }
  })
})

// glyph render widths: the curated catalog measured by the actual renderer,
// cross-checked against Bun's `stringWidth` — the same measurement OpenTUI's
// own core uses on its JS side. A wide CJK control proves the path is real
// rather than "everything is one cell".

describe("glyph render widths", () => {
  const GLYPHS: ReadonlyArray<readonly [string, number]> = [
    ["\u{f115}", 1], // nf-fa-folder_open_o — default directory icon
    ["\u{f07b}", 1], // nf-fa-folder
    ["\u{f07c}", 1], // nf-fa-folder_open
    ["\u{e0a0}", 1], // nf-pl-branch — powerline branch
    ["\u{f418}", 1], // nf-oct-git_branch — default branch icon
    ["\u{e5fb}", 1], // nf-custom-folder_git_branch — default worktree marker
    ["\u{ec7d}", 1], // nf-cod-worktree_small — alternate worktree marker
    ["\u{f49b}", 1], // nf-fa-database — cache glyph
    ["↑", 1], // input arrow token label
    ["↓", 1], // output arrow token label
    ["·", 1], // dot separator
    ["|", 1], // pipe separator
    ["■", 1], // block scanner active cell
    ["⬝", 1], // block scanner inactive cell
    ["█", 1], // solid bar fill
    ["░", 1], // solid bar empty
    ["▰", 1], // slanted bar fill
    ["▱", 1], // slanted bar empty
    ["⠋", 1], // braille frame
    ["⠙", 1], // braille frame
    ["日", 2], // wide control
  ]

  test("every curated glyph renders as its measured cell count", async () => {
    const app = await renderWidget(
      () => (
        <box flexDirection="column">
          {GLYPHS.map(([glyph]: readonly [string, number]) => (
            <text fg="#888888" wrapMode="none">
              {glyph}
            </text>
          ))}
        </box>
      ),
      10,
      GLYPHS.length + 1,
    )

    try {
      for (const [index, [glyph, expected]] of GLYPHS.entries()) {
        const span = (app.captureSpans().lines[index]?.spans ?? []).find((candidate) => candidate.text === glyph)

        expect(span?.width, `glyph ${JSON.stringify(glyph)} (U+${glyph.codePointAt(0)!.toString(16)})`).toBe(expected)
        expect(stringWidth(glyph)).toBe(expected)
      }
    } finally {
      app.renderer.destroy()
    }
  })
})
