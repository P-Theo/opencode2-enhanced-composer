// Render tests for the shared status row: a fitted plan from `layout.ts`
// renders exactly as fitted — items and joiners verbatim, no added spacing,
// no truncation, no wrapping — the spinner item's live substitution animates
// through the row's own lifecycle, empty rows collapse, and the
// measured-row-width discipline keeps a host-reduced row width ahead of the
// raw terminal size while staying reactive to resizes.
import { describe, expect, test } from "bun:test"
import { stringWidth } from "bun"
import { RGBA } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import type { JSX } from "@opentui/solid"
import { testRender } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { fitRow, type FittedItem, type FittedRow, type FittedZone, type FormattedWidget, type WidgetID } from "../src/layout.ts"
import { blockCells } from "../src/widgets.tsx"
import { type SpinnerRender, StatusRow, type StatusRowTheme, useRowWidth } from "../src/status-row.tsx"

const THEME = { subdued: "#888888" } satisfies StatusRowTheme

const BASE = RGBA.fromHex("#ff8800")

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

/** The row's spinner timer is observable through the scheduling globals. */
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

async function renderRow(node: () => JSX.Element, width = 40, height = 3): Promise<TestRendererSetup> {
  const app = await testRender(node, { width, height })

  await app.renderOnce()

  return app
}

function frameLines(app: TestRendererSetup): string[] {
  return app.captureCharFrame().split("\n")
}

function contentLineCount(app: TestRendererSetup): number {
  return frameLines(app).filter((line) => line.trim() !== "").length
}

function widget(id: WidgetID, text: string): FormattedWidget {
  return { id, text, width: stringWidth(text) }
}

function item(id: WidgetID, text: string): FittedItem {
  return { id, text, width: stringWidth(text) }
}

function zone(items: readonly FittedItem[], joiners: readonly string[] = []): FittedZone {
  const width =
    items.reduce((sum, piece) => sum + piece.width, 0) + joiners.reduce((sum, joiner) => sum + stringWidth(joiner), 0)

  return { items, joiners, width }
}

/** A hand-built plan for render-level cases `fitRow` would never emit. */
function handRow(left: FittedZone, right: FittedZone = zone([]), padding = 1): FittedRow {
  const gap = left.items.length > 0 && right.items.length > 0 ? 1 : 0
  const usedWidth = left.width + gap + right.width

  return { left, right, padding, minZoneGap: 1, contentWidth: usedWidth, usedWidth, hidden: [] }
}

/**
 * The production wiring in miniature: measure the row, fit against the
 * measured width, render the fitted plan, and feed the row's own measurement
 * back. `parentWidth` is the host container's width — changing it models a
 * host-UI change such as a sidebar closing that never resizes the terminal.
 */
function MeasuredRow(props: {
  readonly parentWidth: () => number
  readonly left: ReadonlyArray<FormattedWidget>
  readonly spinner?: SpinnerRender
}) {
  const source = useRowWidth()
  const fitted = createMemo(() => fitRow({ width: source.width(), left: props.left, right: [] }))

  return (
    <box width={props.parentWidth()} flexDirection="column">
      <StatusRow row={fitted()} theme={THEME} spinner={props.spinner} onSizeChange={source.onSizeChange} />
      <text fg={THEME.subdued} wrapMode="none">{`w=${source.width()}`}</text>
    </box>
  )
}

describe("StatusRow render", () => {
  test("renders a real fitted plan: items and joiners verbatim, zones on their edges", async () => {
    const row = fitRow({
      width: 40,
      left: [widget("directory", "\u{f115} repo"), widget("branch", "\u{e0a0} main")],
      right: [widget("input", "in 128k"), widget("output", "out 4.2k")],
    })

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} />)

    try {
      const line = frameLines(app)[0] ?? ""

      // One padding cell, then the left zone: directory, space joiner, branch.
      expect(line.indexOf("\u{f115} repo \u{e0a0} main")).toBe(1)
      // The right zone keeps the metric separator and ends against the padding.
      expect(line.trimEnd().endsWith("in 128k · out 4.2k")).toBe(true)
      expect(contentLineCount(app)).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders joiners exactly and adds no spacing of its own", async () => {
    const dash = handRow(zone([item("directory", "ab"), item("branch", "cd")], ["-"]))
    const none = handRow(zone([item("directory", "ab"), item("branch", "cd")], [""]))

    const app = await renderRow(() => (
      <box flexDirection="column">
        <StatusRow row={dash} theme={THEME} />
        <StatusRow row={none} theme={THEME} />
      </box>
    ))

    try {
      const lines = frameLines(app)

      expect(lines[0]).toContain(" ab-cd")
      expect(lines[1]).toContain(" abcd")
    } finally {
      app.renderer.destroy()
    }
  })

  test("honors the padding the fit assumed", async () => {
    const row = handRow(zone([item("directory", "repo")]), zone([]), 3)

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} />)

    try {
      expect((frameLines(app)[0] ?? "").indexOf("repo")).toBe(3)
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a left-only plan without a right zone", async () => {

    const app = await renderRow(() => <StatusRow row={handRow(zone([item("directory", "repo")]))} theme={THEME} />)

    try {
      const line = frameLines(app)[0] ?? ""

      expect(line.indexOf("repo")).toBe(1)
      expect(line.trimEnd()).toBe(" repo")
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders a right-only plan right-aligned", async () => {

    const app = await renderRow(() => (
      <StatusRow row={handRow(zone([]), zone([item("tps", "~52.4 t/s")]))} theme={THEME} />
    ))

    try {
      const line = frameLines(app)[0] ?? ""

      expect(line.indexOf("~52.4 t/s")).toBe(40 - 1 - "~52.4 t/s".length)
    } finally {
      app.renderer.destroy()
    }
  })

  test("collapses an empty plan to nothing", async () => {

    const app = await renderRow(() => <StatusRow row={handRow(zone([]), zone([]))} theme={THEME} />)

    try {
      expect(app.captureCharFrame().trim()).toBe("")
    } finally {
      app.renderer.destroy()
    }
  })

  test("colors items and joiners with the theme's subdued color", async () => {

    const app = await renderRow(() => (
      <StatusRow row={handRow(zone([item("directory", "ab"), item("branch", "cd")], ["-"]))} theme={THEME} />
    ))

    try {
      const spans = (app.captureSpans().lines[0]?.spans ?? []).filter((span) => span.text.trim() !== "")

      for (const span of spans) expect(span.fg.equals(RGBA.fromHex(THEME.subdued))).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("never wraps and keeps a one-line height, even for an unfitted plan", async () => {
    const long = "x".repeat(60)

    const app = await renderRow(
      () => <StatusRow row={handRow(zone([item("directory", long)]), zone([item("tps", "end")]))} theme={THEME} />,
      20,
      3,
    )

    try {
      expect(contentLineCount(app)).toBe(1)
      expect((frameLines(app)[0] ?? "").startsWith(" x")).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("StatusRow spinner substitution", () => {
  test("substitutes the live braille face for the fitted spinner item", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "braille", base: BASE }
    const row = handRow(zone([item("spinner", "⠋"), item("directory", "repo")], [" "]), zone([item("tps", "~52.4 t/s")]))

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} spinner={spinner} />)

    try {
      const spans = (app.captureSpans().lines[0]?.spans ?? []).filter((span) => span.text.trim() !== "")
      const glyph = spans.find((span) => ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].includes(span.text))

      expect(timers.spy.created).toBe(1)
      expect(glyph?.fg.equals(BASE)).toBe(true)
      expect(frameLines(app)[0]?.trimEnd().endsWith("~52.4 t/s")).toBe(true)
      expect(contentLineCount(app)).toBe(1)

      timers.tick()
      await app.renderOnce()

      const advanced = (app.captureSpans().lines[0]?.spans ?? []).find((span) => span.text === "⠙")

      expect(advanced?.fg.equals(BASE)).toBe(true)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("substitutes the block face as eight cells", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "blocks", base: BASE }
    const row = handRow(zone([item("spinner", "■⬝⬝⬝⬝⬝⬝⬝")]))

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} spinner={spinner} />)

    try {
      const spans = (app.captureSpans().lines[0]?.spans ?? []).filter((span) => /[■⬝]/u.test(span.text))

      expect(spans.map((span) => span.text).join("")).toBe("■⬝⬝⬝⬝⬝⬝⬝")
      expect(spans.reduce((sum, span) => sum + span.width, 0)).toBe(8)
      expect(spans.some((span) => span.text.includes("■") && span.fg.equals(blockCells(0, BASE)[0]!.color))).toBe(true)
      expect(timers.spy.created).toBe(1)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("substitutes the static text face without scheduling anything", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "text", base: BASE }
    const row = handRow(zone([item("spinner", "Running")]))

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} spinner={spinner} />)

    try {
      const line = frameLines(app)[0] ?? ""

      expect(line.indexOf("Running")).toBe(1)
      expect(timers.spy.created).toBe(0)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("renders the representative text, unanimated, without a spinner descriptor", async () => {
    const timers = patchTimers()
    const row = handRow(zone([item("spinner", "⠋")]))

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} />)

    try {
      const spans = (app.captureSpans().lines[0]?.spans ?? []).filter((span) => span.text.trim() !== "")

      expect(spans[0]?.text).toBe("⠋")
      expect(spans[0]?.fg.equals(RGBA.fromHex(THEME.subdued))).toBe(true)
      expect(timers.spy.created).toBe(0)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("substitutes a spinner placed in the right zone", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "braille", base: BASE }
    const row = handRow(zone([item("directory", "repo")]), zone([item("spinner", "⠋")]))

    const app = await renderRow(() => <StatusRow row={row} theme={THEME} spinner={spinner} />)

    try {
      const line = frameLines(app)[0] ?? ""

      expect(timers.spy.created).toBe(1)
      expect(line.trimEnd().endsWith("⠋")).toBe(true)
      expect(line.indexOf("repo")).toBe(1)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("drops the timer when a refit hides the spinner", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "braille", base: BASE }

    const [current, setCurrent] = createSignal<FittedRow>(
      handRow(zone([item("spinner", "⠋"), item("directory", "repo")], [" "]), zone([item("tps", "~52.4 t/s")])),
    )

    const app = await renderRow(() => <StatusRow row={current()} theme={THEME} spinner={spinner} />)

    try {
      expect(timers.spy.created).toBe(1)

      setCurrent(handRow(zone([item("directory", "repo")]), zone([item("tps", "~52.4 t/s")])))
      await app.renderOnce()

      expect(timers.spy.cleared).toBe(1)
      expect(frameLines(app)[0]?.includes("⠋")).toBe(false)
      expect(frameLines(app)[0]?.trimEnd().endsWith("~52.4 t/s")).toBe(true)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("keeps exactly one timer across collapse and recovery, without churn on refits", async () => {
    const timers = patchTimers()
    const [parentWidth, setParentWidth] = createSignal(1)
    const spinner: SpinnerRender = { visual: "braille", base: BASE }

    const app = await renderRow(
      () => <MeasuredRow parentWidth={parentWidth} left={[widget("spinner", "⠋")]} spinner={spinner} />,
      40,
      3,
    )

    try {
      // The narrow host width cannot fit even the one-cell spinner, so the
      // row collapses and its measurement shell keeps reporting the width.
      // The spinner item is gone, so no timer may stay behind.
      await app.renderOnce()
      expect(timers.spy.created).toBe(1)
      expect(timers.spy.created - timers.spy.cleared).toBe(0)

      // The host expands: the spinner comes back with exactly one timer.
      setParentWidth(30)
      await app.renderOnce()
      await app.renderOnce()
      expect(frameLines(app)[0]).toContain("⠋")
      expect(timers.spy.created - timers.spy.cleared).toBe(1)

      // A refit that keeps the spinner must not restart its interval.
      const created = timers.spy.created

      setParentWidth(35)
      await app.renderOnce()
      await app.renderOnce()
      expect(timers.spy.created).toBe(created)
      expect(timers.spy.created - timers.spy.cleared).toBe(1)

      // Collapsing again clears it, and the row stays timer-free.
      setParentWidth(1)
      await app.renderOnce()
      await app.renderOnce()
      expect(timers.spy.created - timers.spy.cleared).toBe(0)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }

    expect(timers.spy.created - timers.spy.cleared).toBe(0)
  })

  test("keeps a descriptor timer-free while no spinner item survives", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "braille", base: BASE }

    const app = await renderRow(() => (
      <StatusRow row={handRow(zone([item("directory", "repo")]))} theme={THEME} spinner={spinner} />
    ))

    try {
      expect(timers.spy.created).toBe(0)
    } finally {
      app.renderer.destroy()
      timers.restore()
    }
  })

  test("cleans the timer up when the row unmounts", async () => {
    const timers = patchTimers()
    const spinner: SpinnerRender = { visual: "braille", base: BASE }

    const app = await renderRow(() => (
      <StatusRow row={handRow(zone([item("spinner", "⠋")]))} theme={THEME} spinner={spinner} />
    ))

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

describe("row width measurement", () => {
  test("reports the row's own width through onSizeChange", async () => {
    const [rowWidth, setRowWidth] = createSignal(0)

    const app = await renderRow(() => (
      <StatusRow
        row={handRow(zone([item("directory", "repo")]))}
        theme={THEME}
        onSizeChange={function (this: { readonly width: number }) {
          setRowWidth(this.width)
        }}
      />
    ))

    try {
      expect(rowWidth()).toBe(40)
    } finally {
      app.renderer.destroy()
    }
  })

  test("respects a host UI that reduces the row's space", async () => {
    const [rowWidth, setRowWidth] = createSignal(0)

    const app = await renderRow(
      () => (
        <box width={30}>
          <StatusRow
            row={handRow(zone([item("directory", "repo")]))}
            theme={THEME}
            onSizeChange={function (this: { readonly width: number }) {
              setRowWidth(this.width)
            }}
          />
        </box>
      ),
      40,
      3,
    )

    try {
      expect(rowWidth()).toBe(30)
    } finally {
      app.renderer.destroy()
    }
  })

  test("recovers when the host width expands after overflow emptied the row", async () => {
    const [parentWidth, setParentWidth] = createSignal(12)
    const directory = "a-really-long-directory-name"

    const app = await renderRow(
      () => <MeasuredRow parentWidth={parentWidth} left={[widget("directory", directory)]} />,
      40,
      3,
    )

    try {
      // The first pass fits against the terminal fallback; the second refits
      // against the measured narrow host width and hides every item. The
      // probe landing on line 0 also proves the empty row collapses: the
      // measurement shell takes no height.
      await app.renderOnce()
      expect(frameLines(app)[0]).toContain("w=12")
      expect(frameLines(app)[0]).not.toContain(directory)

      // The sidebar closes: the host box expands while the terminal stays 40
      // and no resize event fires. The always-mounted shell reports the new
      // width, the refit fits the directory again, and the row comes back.
      setParentWidth(40)
      await app.renderOnce()
      await app.renderOnce()

      expect(frameLines(app)[0]).toContain(directory)
      expect(frameLines(app)[1]).toContain("w=40")
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("useRowWidth", () => {
  function WidthProbe(props: { row: () => FittedRow }) {
    const source = useRowWidth()

    return (
      <box flexDirection="column" width="100%">
        <StatusRow row={props.row()} theme={THEME} onSizeChange={source.onSizeChange} />
        <text fg={THEME.subdued} wrapMode="none">{`w=${source.width()}`}</text>
      </box>
    )
  }

  test("measures the row and stays reactive to terminal resizes", async () => {
    const [current] = createSignal<FittedRow>(handRow(zone([item("directory", "repo")]), zone([item("tps", "~52.4 t/s")])))

    const app = await renderRow(() => <WidthProbe row={current} />)

    try {
      expect(frameLines(app)[1]).toContain("w=40")

      app.resize(25, 3)
      await app.renderOnce()
      expect(frameLines(app)[1]).toContain("w=25")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps a host-reduced row width ahead of the raw terminal size", async () => {
    const [current] = createSignal<FittedRow>(handRow(zone([item("directory", "repo")])))

    const app = await renderRow(
      () => (
        <box width={30}>
          <WidthProbe row={current} />
        </box>
      ),
      40,
      4,
    )

    try {
      // The measurement lands during the first render pass; the reactive
      // accessor repaints on the next one.
      await app.renderOnce()
      expect(frameLines(app)[1]).toContain("w=30")
    } finally {
      app.renderer.destroy()
    }
  })
})
