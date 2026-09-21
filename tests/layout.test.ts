import { describe, expect, test } from "bun:test"
import { resolveRenderLib } from "@opentui/core"
import type { WidthMethod } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import stringWidth from "string-width"
import {
  composeZoneText,
  createCellMeasurer,
  DEFAULT_HIDE_FIRST,
  fitRow,
  isMetricWidget,
  measureCells,
  measureCellsPortable,
  type FittedRow,
  type FormattedWidget,
  type MetricSeparator,
  type WidgetID,
} from "../src/layout.ts"
import { METRIC_WIDGET_IDS, OVERFLOW_PRESETS, WIDGET_IDS } from "../src/options.ts"

// The engine's measurement is verified three ways: it is literally the
// renderer's native `encodeUnicode` walk, its fallback delegates to the
// declared string-width package, and — the claim that matters — a rendered
// row clips a string at exactly the cell count it reports.

const measure = createCellMeasurer()

function nativeMeasure(text: string, widthMethod: WidthMethod = "unicode"): number {
  const lib = resolveRenderLib()
  const encoded = lib.encodeUnicode(text, widthMethod)

  if (encoded === null) throw new Error(`native measurement failed for ${JSON.stringify(text)}`)

  try {
    return encoded.data.reduce((width, glyph) => width + glyph.width, 0)
  } finally {
    lib.freeUnicode(encoded)
  }
}

const MEASUREMENT_SAMPLES = [
  "",
  " ",
  "in 128k · out 4.2k · cache 93% · $0.42 · 100k (50%)",
  "\u{f115} ~/.../repo",
  "\u{f418} hoplite/delos-12bf76a7",
  "\u{e5fb} repo-feature",
  "↑128k ↓4.2k",
  "⠋",
  "■■■■■■■■",
  "⬝",
  "▰▰▰▱▱",
  "[█████░░░░░] 51%",
  "~52.4 t/s",
  "shell",
  "Running",
  "cost $0.42",
  "100k/200k context",
  "café",
  "naïve",
  "e\u0301",
  "a\u200Db",
  "日本語のディレクトリ",
  "アイウ",
  "ｶﾀｶﾅ",
  "한국어",
  "👍",
  "👍🏽",
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  "\u{1F1FA}\u{1F1F8}",
  "1\uFE0F\u20E3",
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}",
  "·",
  "|",
  "—",
  "…",
]

describe("measureCells", () => {
  test("is the renderer's native measurement for status content", () => {
    for (const sample of MEASUREMENT_SAMPLES) expect(measureCells(sample)).toBe(nativeMeasure(sample))
  })

  test("measures the curated glyph set as single cells", () => {
    for (const glyph of [
      "\u{f115}",
      "\u{f07b}",
      "\u{f07c}",
      "\u{e5fb}",
      "\u{ec7d}",
      "\u{e0a0}",
      "\u{f418}",
      "\u{f49b}",
      "↑",
      "↓",
      "⠋",
      "■",
      "⬝",
      "▰",
      "▱",
      "█",
      "░",
      "·",
      "|",
    ]) {
      expect(measureCells(glyph)).toBe(1)
    }
  })

  test("counts double-width content as two cells per grapheme", () => {
    expect(measureCells("日本語")).toBe(6)
    expect(measureCells("アイウ")).toBe(6)
    expect(measureCells("한국어")).toBe(6)
    expect(measureCells("👍")).toBe(2)
    expect(measureCells("👍🏽")).toBe(2)
    expect(measureCells("\u{1F1FA}\u{1F1F8}")).toBe(2)
  })

  test("skips combining marks and counts the empty string as zero", () => {
    expect(measureCells("e\u0301")).toBe(1)
    expect(measureCells("")).toBe(0)
  })

  test("measures with the requested width method", () => {
    expect(measureCells("\u{1F1FA}\u{1F1F8}", "unicode")).toBe(2)
    expect(measureCells("\u{1F1FA}\u{1F1F8}", "wcwidth")).toBe(1)
    expect(measureCells("1\uFE0F\u20E3", "unicode")).toBe(2)
    expect(measureCells("1\uFE0F\u20E3", "wcwidth")).toBe(1)
  })
})

describe("createCellMeasurer", () => {
  test("shares one measurer per width method", () => {
    expect(createCellMeasurer()).toBe(createCellMeasurer("unicode"))
    expect(createCellMeasurer("wcwidth")).not.toBe(createCellMeasurer("unicode"))
  })
})

describe("measureCellsPortable", () => {
  test("delegates to the declared string-width package", () => {
    for (const sample of MEASUREMENT_SAMPLES) expect(measureCellsPortable(sample)).toBe(stringWidth(sample))
  })

  test("agrees with the native measurement on status content", () => {
    for (const sample of MEASUREMENT_SAMPLES) expect(measureCellsPortable(sample)).toBe(nativeMeasure(sample))
  })

  test("strips ANSI escapes", () => {
    expect(measureCellsPortable("\u001B[31mhi\u001B[0m")).toBe(2)
    expect(measureCellsPortable("\u001B]0;title\u0007x")).toBe(1)
  })

  test("skips zero-width joiners and spaces", () => {
    expect(measureCellsPortable("a\u200Bb")).toBe(2)
    expect(measureCellsPortable("a\u200Db")).toBe(2)
  })

  test("pins the documented divergences from the native table", () => {
    // The string-width package counts the emoji-presentation BMP marks as
    // two cells; the native table counts them one. Bun's `stringWidth` agrees
    // with the native table, so only the last-resort fallback differs.
    expect(measureCellsPortable("©")).toBe(2)
    expect(nativeMeasure("©")).toBe(1)
    expect(measureCellsPortable("™")).toBe(2)
    expect(nativeMeasure("™")).toBe(1)
    // The native walk splits the UTF-8 bytes of a zero-width space into
    // visible cells; the package skips it.
    expect(measureCellsPortable("a\u200Bb")).toBe(2)
    expect(nativeMeasure("a\u200Bb")).toBe(4)
  })
})

// The strongest form of "consistent with the renderer": render each sample
// through the real OpenTUI test renderer and check that a row exactly
// `measureCells` wide shows the whole string while one cell narrower clips it.

async function renderRow(content: string, width: number): Promise<string> {
  const app = await testRender(
    () =>
      jsx("box", {
        flexDirection: "row",
        width: "100%",
        height: 1,
        children: jsx("text", { wrapMode: "none", children: content }),
      }),
    { width, height: 1 },
  )

  try {
    await app.renderOnce()

    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("measureCells against the rendered row", () => {
  test("a rendered row clips a string at exactly its measured cells", async () => {
    // One throwaway render reads the test renderer's width method, so the
    // measurement below uses precisely the method the frames are laid out with.
    const probe = await testRender(() => jsx("box", { height: 1, children: jsx("text", { children: "" }) }), {
      width: 4,
      height: 1,
    })

    const widthMethod = probe.renderer.widthMethod

    probe.renderer.destroy()
    expect(widthMethod).toBe("unicode")

    for (const sample of [
      "in 128k · out 4.2k · cache 93%",
      "\u{f115} ~/.../repo",
      "\u{f418} hoplite/delos-12bf76a7",
      "⠋ ~52.4 t/s",
      "▰▰▰▱▱ 51% context",
      "日本語ブランチ main",
      "\u{1F44D}\u{1F3FD} t/s",
      "\u{1F1FA}\u{1F1F8} flag",
      "cafe\u0301",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}",
    ]) {
      const cells = measureCells(sample, widthMethod)

      expect(cells).toBeGreaterThan(0)
      expect((await renderRow(sample, cells)).includes(sample)).toBe(true)
      expect((await renderRow(sample, cells - 1)).includes(sample)).toBe(false)
    }
  })
})

// Fixtures build formatted widgets the way `format.ts` will: exact widths from
// the shared measurer, and directory candidates ordered minimum → full.

function label(id: WidgetID, text: string): FormattedWidget {
  return { id, text, width: measure(text) }
}

/** Builds a directory widget from candidates ordered full → minimum, per the `options.ts` path-candidate contract. */
function directory(candidates: readonly string[]): FormattedWidget {
  if (candidates.length === 0) throw new Error("a directory needs at least one candidate")

  const list = candidates.map((text) => ({ text, width: measure(text) }))
  const full = list[0]

  if (full === undefined) throw new Error("a non-empty candidate list has a first entry")

  return { id: "directory", text: full.text, width: full.width, pathCandidates: list }
}

interface RowFixture {
  readonly left: readonly FormattedWidget[]
  readonly right: readonly FormattedWidget[]
}

interface RowOptions {
  readonly separator?: MetricSeparator
  readonly colonJoin?: boolean
  readonly hideFirst?: readonly string[]
}

/** Fits at a content width: the cells left after the default one-cell padding per side. */
function fitContent(
  contentWidth: number,
  left: readonly FormattedWidget[],
  right: readonly FormattedWidget[],
  options: RowOptions = {},
): FittedRow {
  return fitRow({ width: contentWidth + 2, left, right, ...options })
}

function standardRow(): RowFixture {
  return {
    left: [
      directory(["\u{f115} ~/projects/work/repo", "\u{f115} ~/.../work/repo", "\u{f115} ~/.../repo"]),
      label("branch", "\u{f418} main"),
    ],
    right: [
      label("input", "in 128k"),
      label("output", "out 4.2k"),
      label("cache", "cache 93%"),
      label("cost", "$0.42"),
      label("context", "100k (50%)"),
    ],
  }
}

describe("widget registry", () => {
  test("classifies metric widgets", () => {
    for (const id of METRIC_WIDGET_IDS) expect(isMetricWidget(id)).toBe(true)

    for (const id of WIDGET_IDS.filter((widget) => !METRIC_WIDGET_IDS.some((metric) => metric === widget))) expect(isMetricWidget(id)).toBe(false)
  })

  test("the default hide-first order is the Balanced preset", () => {
    expect(DEFAULT_HIDE_FIRST).toEqual(OVERFLOW_PRESETS.balanced)
  })
})

describe("fitRow", () => {
  test("keeps every widget, in order, with derived separators when the row is wide", () => {
    const row = standardRow()
    const fitted = fitContent(300, row.left, row.right)

    expect(fitted.hidden).toEqual([])
    expect(fitted.left.items.map((item) => item.id)).toEqual(["directory", "branch"])
    expect(fitted.right.items.map((item) => item.id)).toEqual(["input", "output", "cache", "cost", "context"])
    expect(fitted.left.joiners).toEqual([" "])
    expect(fitted.right.joiners).toEqual([" · ", " · ", " · ", " · "])
    expect(fitted.left.items[0]?.text).toBe("\u{f115} ~/projects/work/repo")
    expect(fitted.usedWidth).toBe(fitted.left.width + 1 + fitted.right.width)
    expect(fitted.usedWidth).toBeLessThanOrEqual(fitted.contentWidth)
  })

  test.each([
    ["dot", " · "],
    ["pipe", " | "],
    ["space", " "],
  ] as const)("uses the %s separator between consecutive metrics", (separator, text) => {
    const fitted = fitContent(200, [], [label("input", "in 1k"), label("output", "out 2k")], { separator })

    expect(fitted.right.joiners).toEqual([text])
    expect(fitted.usedWidth).toBe(measure("in 1k") + measure(text) + measure("out 2k"))
  })

  test("mixed boundaries take a single space", () => {
    const fitted = fitContent(200, [label("branch", "main"), label("input", "in 1k")], [])

    expect(fitted.left.joiners).toEqual([" "])
  })

  test("activity neighbors take a single space, metrics keep the separator", () => {
    const fitted = fitContent(200, [label("directory", "\u{f115} repo"), label("branch", "\u{f418} main"), label("spinner", "shell")], [
      label("input", "in 1k"),
      label("output", "out 2k"),
    ])

    expect(fitted.left.joiners).toEqual([" ", " "])
    expect(fitted.right.joiners).toEqual([" · "])
  })

  test("reserves the zone gap only when both zones have content", () => {
    const left = [label("spinner", "shell")]
    const right = [label("tps", "~52.4 t/s")]
    const both = fitContent(100, left, right)

    expect(both.usedWidth).toBe(measure("shell") + 1 + measure("~52.4 t/s"))

    const leftAlone = fitContent(100, left, [])

    expect(leftAlone.usedWidth).toBe(measure("shell"))
  })

  test("honours custom padding and zone gap", () => {
    const fitted = fitRow({
      width: 30,
      padding: 3,
      minZoneGap: 2,
      left: [label("spinner", "shell")],
      right: [label("tps", "~52.4 t/s")],
    })

    expect(fitted.contentWidth).toBe(24)
    expect(fitted.usedWidth).toBe(measure("shell") + 2 + measure("~52.4 t/s"))
    expect(fitted.padding).toBe(3)
    expect(fitted.minZoneGap).toBe(2)
  })

  test("padding can consume the whole row", () => {
    const fitted = fitRow({ width: 4, padding: 3, left: [label("spinner", "shell")], right: [] })

    expect(fitted.contentWidth).toBe(0)
    expect(fitted.left.items).toEqual([])
    expect(fitted.usedWidth).toBe(0)
  })

  test("collapses to an empty plan at tiny widths without negative widths", () => {
    for (const width of [0, 1, 2, 3, -10, Number.NaN]) {
      const fitted = fitRow({ width, left: [label("spinner", "shell")], right: [label("tps", "~52.4 t/s")] })

      expect(fitted.contentWidth).toBeGreaterThanOrEqual(0)
      expect(fitted.usedWidth).toBe(0)
      expect(fitted.left.items).toEqual([])
      expect(fitted.right.items).toEqual([])
    }
  })

  test("an empty row stays empty", () => {
    const fitted = fitRow({ width: 80, left: [], right: [] })

    expect(fitted.usedWidth).toBe(0)
    expect(fitted.hidden).toEqual([])
    expect(composeZoneText(fitted.left)).toBe("")
  })

  test("a single widget has no joiners", () => {
    const fitted = fitContent(100, [label("spinner", "⠋")], [])

    expect(fitted.left.items).toHaveLength(1)
    expect(fitted.left.joiners).toEqual([])
    expect(fitted.usedWidth).toBe(1)
  })

  test("drops widgets that would render nothing", () => {
    const fitted = fitContent(100, [label("directory", "")], [
      label("input", "in 1k"),
      { id: "output", text: "out 2k", width: 0 },
    ])

    expect(fitted.left.items).toEqual([])
    expect(fitted.right.items.map((item) => item.id)).toEqual(["input"])
    expect(fitted.right.joiners).toEqual([])
  })
})

describe("colon branch joining", () => {
  const dir = () => directory(["\u{f115} ~/projects/work/repo", "\u{f115} ~/.../repo"])

  test("joins an adjacent branch with a bare colon", () => {
    const fitted = fitContent(200, [dir(), label("branch", "main")], [], { colonJoin: true })

    expect(fitted.left.joiners).toEqual([":"])
    expect(composeZoneText(fitted.left)).toBe("\u{f115} ~/projects/work/repo:main")
  })

  test("keeps ordinary separation without the colon style", () => {
    const fitted = fitContent(200, [dir(), label("branch", "\u{f418} main")], [])

    expect(fitted.left.joiners).toEqual([" "])
    expect(composeZoneText(fitted.left)).toBe("\u{f115} ~/projects/work/repo \u{f418} main")
  })

  test("renders the bare branch when it lives elsewhere", () => {
    const fitted = fitContent(200, [dir()], [label("branch", "main")], { colonJoin: true })

    expect(fitted.right.items[0]?.text).toBe("main")
    expect(fitted.right.joiners).toEqual([])
  })

  test("renders the bare branch after overflow hides the directory", () => {
    const fitted = fitContent(measure("\u{f115} ~/.../repo") - 1, [dir(), label("branch", "main")], [], {
      colonJoin: true,
      hideFirst: ["directory"],
    })

    expect(fitted.hidden).toEqual(["directory"])
    expect(fitted.left.items.map((item) => item.id)).toEqual(["branch"])
    expect(composeZoneText(fitted.left)).toBe("main")
  })
})

describe("overflow hiding", () => {
  // A name-mode directory: one candidate, so the minimum is the full
  // representation and expansion cannot blur the hiding arithmetic.
  function nameModeRow(): RowFixture {
    return {
      left: [directory(["\u{f115} opencode2-enhanced-composer"]), label("branch", "\u{f418} main")],
      right: [
        label("input", "in 128k"),
        label("output", "out 4.2k"),
        label("cache", "cache 93%"),
        label("cost", "$0.42"),
        label("context", "100k (50%)"),
      ],
    }
  }

  const row = nameModeRow()
  const wide = fitContent(400, row.left, row.right)
  const used = wide.usedWidth
  const dot = measure(" · ")

  test("hides cost first, one widget at a time", () => {
    const fitted = fitContent(used - 1, row.left, row.right)

    expect(fitted.hidden).toEqual(["cost"])
  })

  test("continues down the priority list as the row narrows", () => {
    const afterCost = used - measure("$0.42") - dot
    const afterBranch = afterCost - measure("\u{f418} main") - 1

    expect(fitContent(afterCost - 1, row.left, row.right).hidden).toEqual(["cost", "branch"])
    expect(fitContent(afterBranch - 1, row.left, row.right).hidden).toEqual(["cost", "branch", "cache"])
  })

  test("keeps display order and zone assignment while hiding", () => {
    const afterCost = used - measure("$0.42") - dot
    const fitted = fitContent(afterCost - 1, row.left, row.right)

    expect(fitted.left.items.map((item) => item.id)).toEqual(["directory"])
    expect(fitted.right.items.map((item) => item.id)).toEqual(["input", "output", "cache", "context"])
  })

  test("a custom hide-first list decides the survivors", () => {
    const locationFirst = [
      "input",
      "output",
      "cache",
      "cost",
      "context",
      "branch",
      "directory",
      "spinner",
      "tps",
    ]

    const fitted = fitContent(used - 1, row.left, row.right, { hideFirst: locationFirst })

    expect(fitted.hidden).toEqual(["input"])
    expect(fitted.left.items.map((item) => item.id)).toEqual(["directory", "branch"])
  })

  test("widgets missing from the list are hidden after every listed one", () => {
    const fitted = fitRow({
      width: measure("main") + 2,
      left: [label("branch", "main"), label("spinner", "shell")],
      right: [],
      hideFirst: ["branch"],
    })

    expect(fitted.hidden).toEqual(["branch", "spinner"])
  })

  test("one row's overflow never touches another", () => {
    const narrow = fitContent(4, row.left, row.right)

    expect(narrow.hidden.length).toBeGreaterThan(0)
    expect(fitContent(400, row.left, row.right).hidden).toEqual([])
    expect(fitContent(4, row.left, row.right)).toEqual(narrow)
  })
})

describe("directory path expansion", () => {
  const min = "\u{f115} ~/.../repo"
  const mid = "\u{f115} ~/.../work/repo"
  const full = "\u{f115} ~/projects/work/repo"
  const tpsText = "~52.4 t/s"

  const dir = () => directory([full, mid, min])
  const tps = () => label("tps", tpsText)

  test("expands to the full representation when everything fits", () => {
    const fitted = fitContent(400, [dir()], [tps()])

    expect(fitted.left.items[0]?.text).toBe(full)
  })

  test("evaluates hiding with the directory at its minimum representation", () => {
    // At exactly the middle candidate's row width nothing is hidden, because
    // the minimum representation carried the fit and the slack raised the
    // path only to the middle candidate.
    const fitted = fitContent(measure(mid) + 1 + measure(tpsText), [dir()], [tps()])

    expect(fitted.hidden).toEqual([])
    expect(fitted.left.items[0]?.text).toBe(mid)
  })

  test("expands to the full representation at exactly the full row width", () => {
    const fitted = fitContent(measure(full) + 1 + measure(tpsText), [dir()], [tps()])

    expect(fitted.hidden).toEqual([])
    expect(fitted.left.items[0]?.text).toBe(full)
  })

  test("hides first, then spends the freed space on the path", () => {
    const usedMin = measure(min) + 1 + measure(tpsText)
    const fitted = fitContent(usedMin - 1, [dir()], [tps()])

    expect(fitted.hidden).toEqual(["tps"])
    expect(fitted.left.items[0]?.text).toBe(mid)
  })

  test("keeps the minimum when nothing longer fits", () => {
    const fitted = fitContent(measure(min) + 1, [dir()], [tps()])

    expect(fitted.hidden).toEqual(["tps"])
    expect(fitted.left.items[0]?.text).toBe(min)
  })

  test("hiding a long branch can fund the full path", () => {
    const branchText = "\u{f418} hoplite/delos-12bf76a7-feature-branch"
    const usedMin = measure(min) + 1 + measure(branchText) + 1 + measure(tpsText)
    const contentWidth = measure(full) + 1 + measure(tpsText) + 4

    // The row overflows at the minimum path, so the branch (hide-first rank 1)
    // must go; the freed cells then pay for the full path.
    expect(usedMin).toBeGreaterThan(contentWidth)

    const fitted = fitContent(contentWidth, [dir(), label("branch", branchText)], [tps()])

    expect(fitted.hidden).toEqual(["branch"])
    expect(fitted.left.items[0]?.text).toBe(full)
  })
})

describe("whole widgets at every width", () => {
  test("every plan fits, keeps whole texts, and re-derives joiners", () => {
    for (const fixture of [
      standardRow(),
      {
        left: [directory(["\u{f115} 日本語"]), label("branch", "\u{f418} hoplite/delos-12bf76a7-feature")],
        right: [label("context", "[█████░░░░░] 51%"), label("cost", "$0.42")],
      },
    ]) {
      const allowed = new Set<string>()

      for (const widget of [...fixture.left, ...fixture.right]) {
        allowed.add(widget.text)

        for (const candidate of widget.pathCandidates ?? []) allowed.add(candidate.text)
      }

      for (let contentWidth = 0; contentWidth <= 120; contentWidth += 1) {
        const fitted = fitContent(contentWidth, fixture.left, fixture.right)

        expect(fitted.contentWidth).toBe(contentWidth)
        expect(fitted.usedWidth).toBeLessThanOrEqual(fitted.contentWidth)

        for (const zone of [fitted.left, fitted.right]) {
          expect(zone.joiners).toHaveLength(Math.max(0, zone.items.length - 1))

          for (const item of zone.items) {
            expect(allowed.has(item.text)).toBe(true)
            expect(item.width).toBe(measure(item.text))
          }

          expect(measure(composeZoneText(zone))).toBe(zone.width)
        }
      }
    }
  })
})

describe("composeZoneText", () => {
  test("composes items and joiners into the zone's exact text", () => {
    const row = standardRow()
    const fitted = fitContent(400, row.left, row.right)

    expect(composeZoneText(fitted.left)).toBe("\u{f115} ~/projects/work/repo \u{f418} main")
    expect(composeZoneText(fitted.right)).toBe("in 128k · out 4.2k · cache 93% · $0.42 · 100k (50%)")
    expect(composeZoneText({ items: [], joiners: [], width: 0 })).toBe("")
  })
})
