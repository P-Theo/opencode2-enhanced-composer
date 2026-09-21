// Stage 2A tests: the formatting layer is pure, so every case is a direct
// function call with a local measure — no host context, no tracker, and no
// module mocks. Coverage: the numeric semantics, the curated appearance
// catalog, the path-candidate chain, explicit availability, both context
// bars, and parity with the visual widgets whose plain strings formatting
// duplicates to stay free of TUI imports.

import { describe, expect, test } from "bun:test"
import type {
  ContextBarStyle,
  ContextStatus,
  LocationStatus,
  MeasureTextWidth,
  StatusAppearance,
  StatusSnapshot,
} from "../src/options.ts"
import { createCellMeasurer } from "../src/layout.ts"
import {
  contextBarFill as widgetsContextBarFill,
  contextBarText as widgetsContextBarText,
  spinnerCellWidth,
  spinnerRepresentativeText as widgetsSpinnerRepresentativeText,
} from "../src/widgets.tsx"
import {
  GLYPH_BRANCH,
  GLYPH_BRANCH_DEVICON,
  GLYPH_DATABASE,
  GLYPH_FOLDER_CLOSED,
  GLYPH_FOLDER_OPEN,
  GLYPH_FOLDER_OPEN_O,
  GLYPH_IN,
  GLYPH_OUT,
  GLYPH_ROBOT,
  GLYPH_WORKTREE,
  GLYPH_WORKTREE_ALT,
  SPINNER_TEXT,
  branchGlyph,
  cacheShare,
  contextBar,
  directoryCandidates,
  directoryName,
  folderGlyph,
  formatBranchName,
  formatBackgroundAgent,
  formatCachePercentage,
  formatContext,
  formatCost,
  formatInputTokens,
  formatMoney,
  formatOutputTokens,
  formatPercent,
  formatTokens,
  formatWidgets,
  spinnerRepresentativeText,
  worktreeGlyph,
} from "../src/format.ts"

const codePointWidth: MeasureTextWidth = (text) => Array.from(text).length

const HOME = "/home/user"

const APPEARANCE: StatusAppearance = {
  spinner: "braille",
  directory: { format: "name", icon: "f115" },
  branch: "f418",
  worktree: "e5fb",
  tokens: "words",
  cache: "text",
  cost: "currency",
  bgagent: "arrow",
  context: { format: "tokens-percent", bar: "slanted", label: "none", order: "bar-text-label" },
  separator: "dot",
}

const PATH_APPEARANCE: StatusAppearance = {
  ...APPEARANCE,
  directory: { format: "path", icon: "f115" },
}

function makeLocation(overrides: Partial<LocationStatus> = {}): LocationStatus {
  return { directory: `${HOME}/projects/repo`, home: HOME, branch: "main", worktree: false, ...overrides }
}

const SNAPSHOT: StatusSnapshot = {
  sessionID: "ses_test",
  running: true,
  location: makeLocation(),
  metrics: {
    input: 128_000,
    output: 4_200,
    cacheShare: 93,
    cost: 0.42,
    context: { tokens: 100_000, limit: 200_000, percent: 50 },
  },
  tps: { label: "~52.4 t/s" },
  background: { agents: 0 },
}

describe("formatTokens", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [1_050, "1.1k"],
    [2_200, "2.2k"],
    [128_000, "128k"],
    [999_400, "999k"],
    [999_499, "999k"],
    [999_500, "1M"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
    [150_000_000, "150M"],
  ])("formats %i as %s", (value, expected) => {
    expect(formatTokens(value)).toBe(expected)
  })
})

describe("formatPercent", () => {
  test.each([
    [93, "93"],
    [93.4, "93.4"],
    [99.2, "99.2"],
    [0, "0"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected)
  })
})

describe("formatMoney", () => {
  test.each([
    [0.42, "$0.42"],
    [0, "$0.00"],
    [1, "$1.00"],
    [12.5, "$12.50"],
    [1_234.5, "$1,234.50"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatMoney(value)).toBe(expected)
  })
})

describe("cacheShare", () => {
  test.each([
    [1_000, 992, 99.2],
    [1_000, 988, 98.8],
    [1_000, 934, 93.4],
    [1_000, 930, 93],
  ])("keeps one decimal so close reads stay distinct", (input, cacheRead, expected) => {
    expect(cacheShare(input, cacheRead)).toBe(expected)
  })

  test("reports zero when there was no input to read from", () => {
    expect(cacheShare(0, 0)).toBe(0)
    expect(cacheShare(0, 500)).toBe(0)
  })
})

describe("glyph selection", () => {
  test("maps every curated folder icon", () => {
    expect(folderGlyph("f115")).toBe(GLYPH_FOLDER_OPEN_O)
    expect(folderGlyph("f07b")).toBe(GLYPH_FOLDER_CLOSED)
    expect(folderGlyph("f07c")).toBe(GLYPH_FOLDER_OPEN)
    expect(folderGlyph("none")).toBeUndefined()
  })

  test("maps every curated branch style", () => {
    expect(branchGlyph("e0a0")).toBe(GLYPH_BRANCH_DEVICON)
    expect(branchGlyph("f418")).toBe(GLYPH_BRANCH)
    expect(branchGlyph("colon")).toBeUndefined()
  })

  test("maps every curated worktree marker", () => {
    expect(worktreeGlyph("e5fb")).toBe(GLYPH_WORKTREE)
    expect(worktreeGlyph("ec7d")).toBe(GLYPH_WORKTREE_ALT)
    expect(worktreeGlyph("none")).toBeUndefined()
  })
})

describe("spinner representative text", () => {
  test("each face has a representative text of its exact width", () => {
    expect(spinnerRepresentativeText("braille")).toBe("⠋")
    expect(spinnerRepresentativeText("blocks")).toBe("■⬝⬝⬝⬝⬝⬝⬝")
    expect(spinnerRepresentativeText("text")).toBe(SPINNER_TEXT)
    expect(codePointWidth(spinnerRepresentativeText("braille"))).toBe(1)
    expect(codePointWidth(spinnerRepresentativeText("blocks"))).toBe(8)
    expect(codePointWidth(spinnerRepresentativeText("text"))).toBe(7)
  })
})

describe("token labels", () => {
  test("words label the compact numbers", () => {
    expect(formatInputTokens(128_000, "words")).toBe("in 128k")
    expect(formatOutputTokens(4_200, "words")).toBe("out 4.2k")
  })

  test("arrows replace the words", () => {
    expect(formatInputTokens(128_000, "arrows")).toBe(`${GLYPH_IN}128k`)
    expect(formatOutputTokens(4_200, "arrows")).toBe(`${GLYPH_OUT}4.2k`)
  })
})

describe("cache label", () => {
  test("words, glyph and none all keep the percentage", () => {
    expect(formatCachePercentage(93, "text")).toBe("cache 93%")
    expect(formatCachePercentage(93, "f49b")).toBe(`${GLYPH_DATABASE} 93%`)
    expect(formatCachePercentage(93, "none")).toBe("93%")
  })

  test("keeps the one-decimal precision", () => {
    expect(formatCachePercentage(99.2, "text")).toBe("cache 99.2%")
    expect(formatCachePercentage(98.8, "none")).toBe("98.8%")
  })
})

describe("cost", () => {
  test("currency and labeled forms", () => {
    expect(formatCost(0.42, "currency")).toBe("$0.42")
    expect(formatCost(0.42, "labeled")).toBe("cost $0.42")
  })

  test("a known zero cost stays displayable", () => {
    expect(formatCost(0, "currency")).toBe("$0.00")
    expect(formatCost(0, "labeled")).toBe("cost $0.00")
  })
})

describe("background markers", () => {
  test("every subagent style shows its running count", () => {
    expect(formatBackgroundAgent("arrow", 1)).toBe(`${GLYPH_OUT}1 agent`)
    expect(formatBackgroundAgent("arrow", 3)).toBe(`${GLYPH_OUT}3 agents`)
    expect(formatBackgroundAgent("ec20", 2)).toBe(`${GLYPH_ROBOT} 2 agents`)
    expect(formatBackgroundAgent("text", 1)).toBe("1 agent")
    expect(formatBackgroundAgent("text", 2)).toBe("2 agents")
  })
})

describe("contextBar", () => {
  test("draws the plan's examples at their fixed sizes", () => {
    expect(contextBar(0.51, "solid")).toBe("[█████░░░░░]")
    expect(contextBar(0.51, "slanted")).toBe("[▰▰▰▱▱]")
    expect(contextBar(0.51, "solid")).toHaveLength(12)
    expect(contextBar(0.51, "slanted")).toHaveLength(7)
  })

  const BAR_CASES: ReadonlyArray<readonly [number, ContextBarStyle, string]> = [
    [0, "solid", "[░░░░░░░░░░]"],
    [0.049, "solid", "[░░░░░░░░░░]"],
    [0.05, "solid", "[█░░░░░░░░░]"],
    [0.44, "solid", "[████░░░░░░]"],
    [0.5, "solid", "[█████░░░░░]"],
    [1, "solid", "[██████████]"],
    [1.5, "solid", "[██████████]"],
    [-0.5, "solid", "[░░░░░░░░░░]"],
    [0, "slanted", "[▱▱▱▱▱]"],
    [0.2, "slanted", "[▰▱▱▱▱]"],
    [0.3, "slanted", "[▰▰▱▱▱]"],
    [1, "slanted", "[▰▰▰▰▰]"],
    [1.4, "slanted", "[▰▰▰▰▰]"],
  ]

  test.each(BAR_CASES)("fills %s of the %s bar as %s", (ratio, style, expected) => {
    expect(contextBar(ratio, style)).toBe(expected)
  })

  test("a non-finite ratio reads as an empty bar", () => {
    expect(contextBar(Number.NaN, "solid")).toBe("[░░░░░░░░░░]")
    expect(contextBar(Number.NaN, "slanted")).toBe("[▱▱▱▱▱]")
  })
})

describe("formatContext", () => {
  const usage: ContextStatus = { tokens: 100_000, limit: 200_000, percent: 50 }

  test("every text format without a bar", () => {
    expect(formatContext(usage, { format: "tokens", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k")
    expect(formatContext(usage, { format: "tokens-percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k (50%)")
    expect(formatContext(usage, { format: "percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("50%")
    expect(formatContext(usage, { format: "tokens-limit", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k/200k")
    expect(formatContext(usage, { format: "off", bar: "off", label: "none", order: "bar-text-label" })).toBe("")
  })

  test("the bar prefixes the full text when both are on", () => {
    expect(formatContext(usage, { format: "tokens", bar: "solid", label: "none", order: "bar-text-label" })).toBe("[█████░░░░░] 100k")
    expect(formatContext(usage, { format: "tokens-percent", bar: "solid", label: "none", order: "bar-text-label" })).toBe("[█████░░░░░] 100k (50%)")
    expect(formatContext(usage, { format: "percent", bar: "solid", label: "none", order: "bar-text-label" })).toBe("[█████░░░░░] 50%")
    expect(formatContext(usage, { format: "tokens-limit", bar: "slanted", label: "none", order: "bar-text-label" })).toBe("[▰▰▰▱▱] 100k/200k")
    expect(formatContext(usage, { format: "off", bar: "slanted", label: "none", order: "bar-text-label" })).toBe("[▰▰▰▱▱]")
  })

  test("labels are suffixes on text and bar-only forms", () => {
    expect(formatContext(usage, { format: "tokens", bar: "off", label: "ctx", order: "bar-text-label" })).toBe("100k ctx")
    expect(formatContext(usage, { format: "tokens", bar: "off", label: "context", order: "bar-text-label" })).toBe("100k context")
    expect(formatContext(usage, { format: "tokens-percent", bar: "off", label: "ctx", order: "bar-text-label" })).toBe("100k (50%) ctx")
    expect(formatContext(usage, { format: "percent", bar: "off", label: "ctx", order: "bar-text-label" })).toBe("50% ctx")
    expect(formatContext(usage, { format: "tokens-limit", bar: "off", label: "context", order: "bar-text-label" })).toBe("100k/200k context")
    expect(formatContext(usage, { format: "tokens-percent", bar: "slanted", label: "context", order: "bar-text-label" })).toBe("[▰▰▰▱▱] 100k (50%) context")
    expect(formatContext(usage, { format: "off", bar: "slanted", label: "context", order: "bar-text-label" })).toBe("[▰▰▰▱▱] context")
  })

  test("formats requiring a limit fall back to the token count with the label", () => {
    const unknown: ContextStatus = { tokens: 100_000, limit: undefined, percent: undefined }

    expect(formatContext(unknown, { format: "tokens-percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k")
    expect(formatContext(unknown, { format: "percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k")
    expect(formatContext(unknown, { format: "tokens-limit", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k")
    expect(formatContext(unknown, { format: "tokens-percent", bar: "solid", label: "none", order: "bar-text-label" })).toBe("100k")
    expect(formatContext(unknown, { format: "tokens-limit", bar: "solid", label: "ctx", order: "bar-text-label" })).toBe("100k ctx")
    expect(formatContext(unknown, { format: "off", bar: "solid", label: "none", order: "bar-text-label" })).toBe("")
  })

  test("a zero limit is as unknown as a missing one", () => {
    const zero: ContextStatus = { tokens: 100_000, limit: 0, percent: undefined }

    expect(formatContext(zero, { format: "tokens-percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("100k")
    expect(formatContext(zero, { format: "tokens", bar: "solid", label: "none", order: "bar-text-label" })).toBe("100k")
  })

  test("a missing percentage is derived with the existing rounding", () => {
    const derived: ContextStatus = { tokens: 1_325, limit: 8_000, percent: undefined }

    expect(formatContext(derived, { format: "tokens-percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("1.3k (17%)")
    expect(formatContext(derived, { format: "percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("17%")
  })

  test("a provided percentage is honored as the computed value", () => {
    const provided: ContextStatus = { tokens: 1_000, limit: undefined, percent: 42 }

    expect(formatContext(provided, { format: "tokens-percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("1k (42%)")
    expect(formatContext(provided, { format: "percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("42%")
    // The bar needs the limit itself for its fill, not just a percentage.
    expect(formatContext(provided, { format: "tokens", bar: "solid", label: "none", order: "bar-text-label" })).toBe("1k")
  })

  test("overflow keeps the true token count beside a full bar", () => {
    const overflowing: ContextStatus = { tokens: 210_000, limit: 200_000, percent: 105 }

    expect(formatContext(overflowing, { format: "tokens", bar: "solid", label: "none", order: "bar-text-label" })).toBe("[██████████] 210k")
    expect(formatContext(overflowing, { format: "tokens-percent", bar: "off", label: "none", order: "bar-text-label" })).toBe("210k (105%)")
    expect(formatContext(overflowing, { format: "tokens-limit", bar: "off", label: "none", order: "bar-text-label" })).toBe("210k/200k")
  })

  test("every order arranges the present pieces with single spaces", () => {
    const full = { format: "tokens-percent", bar: "slanted", label: "ctx" } as const

    expect(formatContext(usage, { ...full, order: "bar-text-label" })).toBe("[▰▰▰▱▱] 100k (50%) ctx")
    expect(formatContext(usage, { ...full, order: "bar-label-text" })).toBe("[▰▰▰▱▱] ctx 100k (50%)")
    expect(formatContext(usage, { ...full, order: "text-bar-label" })).toBe("100k (50%) [▰▰▰▱▱] ctx")
    expect(formatContext(usage, { ...full, order: "text-label-bar" })).toBe("100k (50%) ctx [▰▰▰▱▱]")
    expect(formatContext(usage, { ...full, order: "label-bar-text" })).toBe("ctx [▰▰▰▱▱] 100k (50%)")
    expect(formatContext(usage, { ...full, order: "label-text-bar" })).toBe("ctx 100k (50%) [▰▰▰▱▱]")
  })

  test("absent pieces are skipped keeping relative order", () => {
    const unknown: ContextStatus = { tokens: 100_000, limit: undefined, percent: undefined }

    // No limit: the bar drops out, text falls back to the bare count.
    expect(formatContext(unknown, { format: "tokens-percent", bar: "slanted", label: "ctx", order: "text-bar-label" })).toBe("100k ctx")
    // Text off: the remaining bar and label keep their relative order.
    expect(formatContext(usage, { format: "off", bar: "slanted", label: "ctx", order: "label-text-bar" })).toBe("ctx [▰▰▰▱▱]")
    expect(formatContext(usage, { format: "off", bar: "slanted", label: "ctx", order: "bar-label-text" })).toBe("[▰▰▰▱▱] ctx")
    // Label none: orders differing only by the label collapse to the same text.
    expect(formatContext(usage, { format: "tokens", bar: "slanted", label: "none", order: "text-bar-label" })).toBe("100k [▰▰▰▱▱]")
  })
})

describe("directoryName", () => {
  test("returns the last path segment", () => {
    expect(directoryName("/home/user/projects/repo", "/home/user")).toBe("repo")
    expect(directoryName("/home/user/projects/repo/", "/home/user")).toBe("repo")
  })

  test("collapses the home directory to a tilde", () => {
    expect(directoryName("/home/user", "/home/user")).toBe("~")
  })

  test("keeps the root path", () => {
    expect(directoryName("/", "/home/user")).toBe("/")
  })

  test("uses Windows separators independently of the host platform", () => {
    expect(directoryName("C:\\Users\\ada\\repo\\", "C:\\Users\\ada")).toBe("repo")
  })

  test("keeps backslashes in POSIX directory names", () => {
    expect(directoryName("/tmp/foo\\bar/", "/tmp")).toBe("foo\\bar")
  })
})

describe("directoryCandidates", () => {
  test("name mode shows the whole name as its only candidate", () => {
    const candidates = directoryCandidates(makeLocation(), APPEARANCE, codePointWidth)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toEqual({ text: `${GLYPH_FOLDER_OPEN_O} repo`, width: codePointWidth(`${GLYPH_FOLDER_OPEN_O} repo`) })
  })

  test("name mode collapses home to the tilde", () => {
    const candidates = directoryCandidates(makeLocation({ directory: HOME }), APPEARANCE, codePointWidth)

    expect(candidates[0]?.text).toBe(`${GLYPH_FOLDER_OPEN_O} ~`)
  })

  test.each([
    ["/home/user/projects/work/repo", HOME, ["~/projects/work/repo", "~/.../work/repo", "~/.../repo"]],
    ["/home/otheruser/projects/repo", HOME, ["/home/otheruser/projects/repo", "/.../otheruser/projects/repo", "/.../projects/repo", "/.../repo"]],
    // Eliding the three-character `srv` is width-neutral, so that form drops out.
    ["/srv/worktrees/repo-feature", HOME, ["/srv/worktrees/repo-feature", "/.../repo-feature"]],
    ["C:\\Users\\ada\\projects\\work\\repo", "C:/Users/ada", ["~/projects/work/repo", "~/.../work/repo", "~/.../repo"]],
    ["\\\\server\\share\\projects\\work\\repo", HOME, ["//server/share/projects/work/repo", "//server/share/.../work/repo", "//server/share/.../repo"]],
  ])("path mode elides whole leading segments for %s", (directory, home, expectedPaths) => {
    const candidates = directoryCandidates(
      makeLocation({ directory, home, branch: undefined }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual(
      expectedPaths.map((path) => `${GLYPH_FOLDER_OPEN_O} ${path}`),
    )
  })

  test("candidates carry their measured widths", () => {
    const paths = ["~/projects/work/repo", "~/.../work/repo", "~/.../repo"]

    const candidates = directoryCandidates(
      makeLocation({ directory: "/home/user/projects/work/repo" }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(candidates.map((candidate) => candidate.width)).toEqual(
      paths.map((path) => codePointWidth(`${GLYPH_FOLDER_OPEN_O} ${path}`)),
    )
  })

  test("paths without intermediate segments yield a single candidate", () => {
    const inHome = directoryCandidates(makeLocation({ directory: `${HOME}/repo` }), PATH_APPEARANCE, codePointWidth)
    const atRoot = directoryCandidates(makeLocation({ directory: "/srv" }), PATH_APPEARANCE, codePointWidth)

    expect(inHome).toHaveLength(1)
    expect(atRoot).toHaveLength(1)
  })

  test("home itself and the filesystem root never suggest omitted segments", () => {
    const home = directoryCandidates(makeLocation({ directory: HOME }), PATH_APPEARANCE, codePointWidth)
    const root = directoryCandidates(makeLocation({ directory: "/" }), PATH_APPEARANCE, codePointWidth)

    expect(home[0]?.text).toBe(`${GLYPH_FOLDER_OPEN_O} ~`)
    expect(root[0]?.text).toBe(`${GLYPH_FOLDER_OPEN_O} /`)
  })

  test("trailing separators change nothing", () => {
    const withSlash = directoryCandidates(
      makeLocation({ directory: "/home/user/projects/repo/" }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    const without = directoryCandidates(
      makeLocation({ directory: "/home/user/projects/repo" }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(withSlash.map((candidate) => candidate.text)).toEqual(without.map((candidate) => candidate.text))
  })

  test("a home with a trailing separator still anchors the tilde", () => {
    const candidates = directoryCandidates(
      makeLocation({ directory: `${HOME}/repo`, home: `${HOME}/` }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(candidates[0]?.text).toBe(`${GLYPH_FOLDER_OPEN_O} ~/repo`)
  })

  test("the final directory name is never cut, however long", () => {
    const long = "an-extremely-long-directory-name-that-will-not-fit-anywhere"

    const candidates = directoryCandidates(
      makeLocation({ directory: `${HOME}/projects/${long}` }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(candidates.length).toBeGreaterThan(1)

    for (const candidate of candidates) expect(candidate.text.endsWith(long)).toBe(true)
  })

  test("non-ASCII components elide as whole segments", () => {
    const candidates = directoryCandidates(
      makeLocation({ directory: `${HOME}/projets/données` }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      `${GLYPH_FOLDER_OPEN_O} ~/projets/données`,
      `${GLYPH_FOLDER_OPEN_O} ~/.../données`,
    ])
  })

  test("candidates that would not shorten the path are excluded", () => {
    const shortSegment = directoryCandidates(
      makeLocation({ directory: `${HOME}/a/bb/repo` }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    const equalSegment = directoryCandidates(
      makeLocation({ directory: `${HOME}/abc/repo` }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(shortSegment.map((candidate) => candidate.text)).toEqual([
      `${GLYPH_FOLDER_OPEN_O} ~/a/bb/repo`,
      `${GLYPH_FOLDER_OPEN_O} ~/.../repo`,
    ])
    expect(equalSegment.map((candidate) => candidate.text)).toEqual([`${GLYPH_FOLDER_OPEN_O} ~/abc/repo`])
  })

  test("exclusion follows the measured width, not the string length", () => {
    const directory = `${HOME}/日日/repo`

    const wideAware: MeasureTextWidth = (text) => {
      let width = 0

      for (const character of Array.from(text)) {
        if (/[\u4e00-\u9fff]/u.test(character)) width += 2
        else width += 1
      }

      return width
    }

    // Nine code points either way, so a code-point measure keeps only the
    // full path; a wcwidth-style measure sees the ideographs as double-wide
    // and keeps the elided form as strictly narrower.
    expect(directoryCandidates(makeLocation({ directory }), PATH_APPEARANCE, codePointWidth)).toHaveLength(1)
    expect(
      directoryCandidates(makeLocation({ directory }), PATH_APPEARANCE, wideAware).map((candidate) => candidate.text),
    ).toEqual([`${GLYPH_FOLDER_OPEN_O} ~/日日/repo`, `${GLYPH_FOLDER_OPEN_O} ~/.../repo`])
  })

  test("a worktree marker replaces the ordinary folder decoration", () => {
    const candidates = directoryCandidates(
      makeLocation({ directory: "/srv/worktrees/repo-feature", worktree: true }),
      APPEARANCE,
      codePointWidth,
    )

    expect(candidates[0]?.text).toBe(`${GLYPH_WORKTREE} repo-feature`)
  })

  test("the alternate worktree marker is selectable", () => {
    const appearance: StatusAppearance = { ...APPEARANCE, worktree: "ec7d" }
    const candidates = directoryCandidates(makeLocation({ worktree: true }), appearance, codePointWidth)

    expect(candidates[0]?.text).toBe(`${GLYPH_WORKTREE_ALT} repo`)
  })

  test("worktree marker none falls back to the ordinary folder appearance", () => {
    const appearance: StatusAppearance = { ...APPEARANCE, worktree: "none" }
    const candidates = directoryCandidates(makeLocation({ worktree: true }), appearance, codePointWidth)

    expect(candidates[0]?.text).toBe(`${GLYPH_FOLDER_OPEN_O} repo`)
  })

  test("worktree marker none falls back to a custom icon", () => {
    const appearance: StatusAppearance = {
      ...APPEARANCE,
      worktree: "none",
      directory: { format: "name", icon: { text: "📁" } },
    }

    const candidates = directoryCandidates(makeLocation({ worktree: true }), appearance, codePointWidth)

    expect(candidates[0]?.text).toBe("📁 repo")
  })

  test("no ordinary folder icon never suppresses a selected worktree marker", () => {
    const appearance: StatusAppearance = {
      ...APPEARANCE,
      directory: { format: "name", icon: "none" },
    }

    const worktree = directoryCandidates(makeLocation({ worktree: true }), appearance, codePointWidth)
    const ordinary = directoryCandidates(makeLocation({ worktree: false }), appearance, codePointWidth)

    expect(worktree[0]?.text).toBe(`${GLYPH_WORKTREE} repo`)
    expect(ordinary[0]?.text).toBe("repo")
  })

  test("every curated folder icon decorates the path", () => {
    const base = makeLocation({ directory: `${HOME}/projects/repo` })

    const f115 = directoryCandidates(
      base,
      { ...APPEARANCE, directory: { format: "path", icon: "f115" } },
      codePointWidth,
    )

    const f07b = directoryCandidates(
      base,
      { ...APPEARANCE, directory: { format: "path", icon: "f07b" } },
      codePointWidth,
    )

    const f07c = directoryCandidates(
      base,
      { ...APPEARANCE, directory: { format: "path", icon: "f07c" } },
      codePointWidth,
    )

    expect(f115[0]?.text).toBe(`${GLYPH_FOLDER_OPEN_O} ~/projects/repo`)
    expect(f07b[0]?.text).toBe(`${GLYPH_FOLDER_CLOSED} ~/projects/repo`)
    expect(f07c[0]?.text).toBe(`${GLYPH_FOLDER_OPEN} ~/projects/repo`)
  })

  test("a path without a root or home anchor is kept whole", () => {
    const candidates = directoryCandidates(
      makeLocation({ directory: "relative/repo", home: "" }),
      PATH_APPEARANCE,
      codePointWidth,
    )

    expect(candidates.map((candidate) => candidate.text)).toEqual([`${GLYPH_FOLDER_OPEN_O} relative/repo`])
  })
})

describe("formatBranchName", () => {
  test("glyph styles decorate the whole branch name", () => {
    expect(formatBranchName("hoplite/delos-12bf76a7", "f418")).toBe(`${GLYPH_BRANCH} hoplite/delos-12bf76a7`)
    expect(formatBranchName("main", "e0a0")).toBe(`${GLYPH_BRANCH_DEVICON} main`)
  })

  test("the colon style renders the bare name", () => {
    expect(formatBranchName("main", "colon")).toBe("main")
  })
})

describe("formatWidgets", () => {
  test("formats every available widget of a running session", () => {
    const widgets = formatWidgets(SNAPSHOT, APPEARANCE, codePointWidth)
    const directory = { text: `${GLYPH_FOLDER_OPEN_O} repo`, width: codePointWidth(`${GLYPH_FOLDER_OPEN_O} repo`) }

    expect(widgets.spinner).toEqual({ id: "spinner", text: "⠋", width: codePointWidth("⠋") })
    expect(widgets.directory).toEqual({ id: "directory", ...directory, pathCandidates: [directory] })
    expect(widgets.branch).toEqual({ id: "branch", text: `${GLYPH_BRANCH} main`, width: codePointWidth(`${GLYPH_BRANCH} main`) })
    expect(widgets.input).toEqual({ id: "input", text: "in 128k", width: codePointWidth("in 128k") })
    expect(widgets.output).toEqual({ id: "output", text: "out 4.2k", width: codePointWidth("out 4.2k") })
    expect(widgets.cache).toEqual({ id: "cache", text: "cache 93%", width: codePointWidth("cache 93%") })
    expect(widgets.cost).toEqual({ id: "cost", text: "$0.42", width: codePointWidth("$0.42") })
    expect(widgets.context).toEqual({ id: "context", text: "[▰▰▰▱▱] 100k (50%)", width: codePointWidth("[▰▰▰▱▱] 100k (50%)") })
    expect(widgets.tps).toEqual({ id: "tps", text: "~52.4 t/s", width: codePointWidth("~52.4 t/s") })
  })

  test("an idle session has no spinner", () => {
    const widgets = formatWidgets({ ...SNAPSHOT, running: false }, APPEARANCE, codePointWidth)

    expect(widgets.spinner).toBeUndefined()
  })

  test("the blocks spinner reserves its eight cells", () => {
    const widgets = formatWidgets(SNAPSHOT, { ...APPEARANCE, spinner: "blocks" }, codePointWidth)

    expect(widgets.spinner).toEqual({ id: "spinner", text: "■⬝⬝⬝⬝⬝⬝⬝", width: codePointWidth("■⬝⬝⬝⬝⬝⬝⬝") })
  })

  test("a session without usage shows its zeros, including zero cost", () => {
    const widgets = formatWidgets(
      { ...SNAPSHOT, metrics: { input: 0, output: 0, cacheShare: 0, cost: 0, context: undefined } },
      APPEARANCE,
      codePointWidth,
    )

    expect(widgets.input).toEqual({ id: "input", text: "in 0", width: codePointWidth("in 0") })
    expect(widgets.output).toEqual({ id: "output", text: "out 0", width: codePointWidth("out 0") })
    expect(widgets.cache).toEqual({ id: "cache", text: "cache 0%", width: codePointWidth("cache 0%") })
    expect(widgets.cost).toEqual({ id: "cost", text: "$0.00", width: codePointWidth("$0.00") })
    expect(widgets.context).toBeUndefined()
  })

  test("a home screen without a session invents no session metrics", () => {
    const widgets = formatWidgets(
      {
        sessionID: undefined,
        running: false,
        location: makeLocation({ branch: undefined }),
        metrics: undefined,
        tps: undefined,
        background: { agents: 0 },
      },
      APPEARANCE,
      codePointWidth,
    )

    expect(widgets.directory).toBeDefined()
    expect(widgets.branch).toBeUndefined()
    expect(widgets.input).toBeUndefined()
    expect(widgets.output).toBeUndefined()
    expect(widgets.cache).toBeUndefined()
    expect(widgets.cost).toBeUndefined()
    expect(widgets.context).toBeUndefined()
    expect(widgets.tps).toBeUndefined()
  })

  test("a missing location hides the directory and the branch", () => {
    const widgets = formatWidgets({ ...SNAPSHOT, location: undefined }, APPEARANCE, codePointWidth)

    expect(widgets.directory).toBeUndefined()
    expect(widgets.branch).toBeUndefined()
  })

  test("an empty branch string is as missing as an absent one", () => {
    const widgets = formatWidgets({ ...SNAPSHOT, location: makeLocation({ branch: "" }) }, APPEARANCE, codePointWidth)

    expect(widgets.branch).toBeUndefined()
  })

  test("an absent rate is unavailable rather than a placeholder", () => {
    const widgets = formatWidgets({ ...SNAPSHOT, tps: undefined }, APPEARANCE, codePointWidth)

    expect(widgets.tps).toBeUndefined()
  })

  test("appearance choices flow through the snapshot", () => {
    const appearance: StatusAppearance = {
      ...APPEARANCE,
      spinner: "text",
      tokens: "arrows",
      cache: "f49b",
      cost: "labeled",
      context: { format: "tokens", bar: "slanted", label: "context", order: "bar-text-label" },
    }

    const widgets = formatWidgets(SNAPSHOT, appearance, codePointWidth)

    expect(widgets.spinner).toEqual({ id: "spinner", text: SPINNER_TEXT, width: 7 })
    expect(widgets.input?.text).toBe(`${GLYPH_IN}128k`)
    expect(widgets.output?.text).toBe(`${GLYPH_OUT}4.2k`)
    expect(widgets.cache?.text).toBe(`${GLYPH_DATABASE} 93%`)
    expect(widgets.cost?.text).toBe("cost $0.42")
    expect(widgets.context?.text).toBe("[▰▰▰▱▱] 100k context")
  })

  test("both text and bar off hides the context widget", () => {
    const widgets = formatWidgets(SNAPSHOT, { ...APPEARANCE, context: { format: "off", bar: "off", label: "none", order: "bar-text-label" } }, codePointWidth)

    expect(widgets.context).toBeUndefined()
  })

  test("path mode carries the candidate chain on the directory widget", () => {
    const widgets = formatWidgets(SNAPSHOT, PATH_APPEARANCE, codePointWidth)

    expect(widgets.directory?.pathCandidates?.map((candidate) => candidate.text)).toEqual([
      `${GLYPH_FOLDER_OPEN_O} ~/projects/repo`,
      `${GLYPH_FOLDER_OPEN_O} ~/.../repo`,
    ])
    expect(widgets.directory?.text).toBe(`${GLYPH_FOLDER_OPEN_O} ~/projects/repo`)
    expect(widgets.directory?.width).toBe(codePointWidth(`${GLYPH_FOLDER_OPEN_O} ~/projects/repo`))
  })

  test("widths come from the injected measure", () => {
    const doubleWidth: MeasureTextWidth = (text) => 2 * codePointWidth(text)
    const widgets = formatWidgets(SNAPSHOT, APPEARANCE, doubleWidth)

    expect(widgets.tps?.width).toBe(doubleWidth("~52.4 t/s"))
    expect(widgets.directory?.width).toBe(doubleWidth(`${GLYPH_FOLDER_OPEN_O} repo`))
  })

  test("the subagent marker shows only while subagents run, with its count", () => {
    const active = formatWidgets({ ...SNAPSHOT, background: { agents: 2 } }, APPEARANCE, codePointWidth)

    expect(active.bgagent?.text).toBe(`${GLYPH_OUT}2 agents`)

    const single = formatWidgets({ ...SNAPSHOT, background: { agents: 1 } }, APPEARANCE, codePointWidth)

    expect(single.bgagent?.text).toBe(`${GLYPH_OUT}1 agent`)

    const styled = formatWidgets(
      { ...SNAPSHOT, background: { agents: 1 } },
      { ...APPEARANCE, bgagent: "text" },
      codePointWidth,
    )

    expect(styled.bgagent?.text).toBe("1 agent")

    const idle = formatWidgets(SNAPSHOT, APPEARANCE, codePointWidth)

    expect(idle.bgagent).toBeUndefined()
  })
})

describe("parity with the visual widgets", () => {
  test("the spinner representative text and width match the live visuals", () => {
    const cellMeasure = createCellMeasurer()

    for (const visual of ["braille", "blocks", "text"] as const) {
      expect(spinnerRepresentativeText(visual)).toBe(widgetsSpinnerRepresentativeText(visual))
      expect(spinnerCellWidth(visual)).toBe(cellMeasure(spinnerRepresentativeText(visual)))
    }
  })

  test("the context bar matches the widget bar at every fill boundary", () => {
    for (const ratio of [0, 0.05, 0.2, 0.24, 0.25, 0.46, 0.5, 0.51, 1, 1.4, Number.NaN]) {
      for (const style of ["solid", "slanted"] as const) {
        expect(contextBar(ratio, style)).toBe(widgetsContextBarText(widgetsContextBarFill(ratio, style), style))
      }
    }
  })
})
