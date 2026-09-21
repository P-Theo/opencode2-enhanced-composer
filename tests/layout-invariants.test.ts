// layout-invariants.test.ts — property-style verification of the fit contract.
//
// `layout.test.ts` pins the curated examples. This file drives `fitRow` with
// rows generated deterministically from seeds instead — unique widget
// distributions, custom priority lists (duplicates, omissions, unknown ids and
// an empty list), budgets from zero to roomy, tiny labels plus CJK and emoji
// content, colon joins, and multi-step path candidates — and asserts the
// invariants every legal input must satisfy:
//
//   * the composed row text is at most the content budget, measured in real
//     terminal cells by `measureCells`, never by the declared arithmetic alone;
//   * display order, zone assignment and whole labels survive; the directory
//     always renders one of its legal candidates;
//   * `hidden` is exactly the set of present widgets no longer rendered and
//     respects the priority list;
//   * joiners follow the final visible sequence, so a colon adjacency vanishes
//     the moment either side is hidden;
//   * a row whose full representation fits is never hidden or shortened;
//   * the fit is pure and deterministic.
//
// The assertions describe the contract from the outside; they never replay the
// hiding or expansion algorithm.

import { describe, expect, test } from "bun:test"
import {
  composeZoneText,
  fitRow,
  isMetricWidget,
  measureCells,
  type FittedRow,
  type FittedZone,
  type FormattedWidget,
  type MetricSeparator,
  type PathCandidate,
  type RowFitInput,
  type WidgetID,
} from "../src/layout.ts"
import { OVERFLOW_PRESETS, WIDGET_IDS } from "../src/options.ts"

/** A tiny seeded generator so every run replays exactly the same rows. */
interface Rng {
  next(): number
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  shuffle<T>(items: readonly T[]): T[]
}

function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))

  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)]

    if (item === undefined) throw new Error("cannot pick from an empty list")

    return item
  }

  const shuffle = <T,>(items: readonly T[]): T[] => {
    const copy = [...items]

    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = int(0, index)
      const current = copy[index]
      const other = copy[swap]

      if (current === undefined || other === undefined) continue

      copy[index] = other
      copy[swap] = current
    }

    return copy
  }

  return { next, int, pick, shuffle }
}

const METRIC_SEPARATORS: readonly MetricSeparator[] = ["dot", "pipe", "space"]

/**
 * Per-widget label catalogs. The set crosses plain ASCII, single cells (tiny
 * rows), CJK double-width text and emoji, so the generated rows exercise the
 * measurement the engine's arithmetic depends on.
 */
const WIDGET_TEXTS: Readonly<Record<Exclude<WidgetID, "directory">, readonly string[]>> = {
  spinner: ["⠋", "■", "Running", "日本語"],
  branch: ["main", "\u{f418} main", "機能/日本語", "🦀 feature", "a", "feature/日本語-✨"],
  input: ["in 128k", "入力 42", "↑1", "a"],
  output: ["out 4.2k", "出力 日本語", "↓2", "b"],
  cache: ["cache 93%", "キャッシュ 12%", "c", "👍"],
  cost: ["$0.42", "費用 ¥9", "$1", "0"],
  context: ["100k (50%)", "文脈 7%", "[█░] 3%", "日"],
  tps: ["~52.4 t/s", "速度 3 t/s", "🚀 t/s", "8"],
  bgagent: ["↓1 agent", "1 agent", "b"],
}

const DIRECTORY_NAMES = ["repo", "日本語", "プロジェクト", "🦀-tool", "src", "a"]

const DIRECTORY_PARENTS = ["projects", "work", "delos", "日", "β", "src"]

/**
 * A directory widget with candidates ordered full → minimum, as the
 * `options.ts` path-candidate contract requires. Sometimes it is name mode: a
 * single legal representation.
 */
function randomDirectory(rng: Rng): FormattedWidget {
  if (rng.next() < 0.25) {
    const name = rng.pick(DIRECTORY_NAMES)
    const width = measureCells(name)

    return { id: "directory", text: name, width, pathCandidates: [{ text: name, width }] }
  }

  const finalName = rng.pick(DIRECTORY_NAMES)
  let full = "~/"
  const depth = rng.int(1, 3)

  for (let index = 0; index < depth; index += 1) full += `${rng.pick(DIRECTORY_PARENTS)}/`

  full += finalName

  // Full first; the shorter whole-segment representations follow longest
  // first. Every variant keeps the final directory name intact.
  const variants = new Map<string, number>()

  variants.set(full, measureCells(full))
  variants.set(`~/.../${finalName}`, measureCells(`~/.../${finalName}`))
  variants.set(`.../${finalName}`, measureCells(`.../${finalName}`))
  variants.set(finalName, measureCells(finalName))

  const shortened: PathCandidate[] = []

  for (const [text, width] of variants) {
    if (text === full) continue

    shortened.push({ text, width })
  }

  shortened.sort((left, right) => right.width - left.width)

  const candidates: PathCandidate[] = [{ text: full, width: measureCells(full) }, ...shortened]
  const chosen = candidates[0]

  if (chosen === undefined) throw new Error("a directory needs a full candidate")

  return { id: "directory", text: chosen.text, width: chosen.width, pathCandidates: candidates }
}

function randomWidget(id: WidgetID, rng: Rng): FormattedWidget {
  if (id === "directory") return randomDirectory(rng)

  const text = rng.pick(WIDGET_TEXTS[id])

  return { id, text, width: measureCells(text) }
}

/** The documented priority semantics: first occurrence ranks, absent ids rank last. */
function randomHideFirst(rng: Rng): readonly string[] {
  const mode = rng.int(0, 5)

  if (mode === 0) return OVERFLOW_PRESETS.balanced

  if (mode === 1) return OVERFLOW_PRESETS["usage-first"]

  if (mode === 2) return OVERFLOW_PRESETS["location-first"]

  if (mode === 3) return rng.shuffle(WIDGET_IDS)

  if (mode === 5) return []

  // A partial list, sometimes with a duplicate and always with an unknown id:
  // duplicates keep their first position, unknown ids are ignored, and omitted
  // widgets are hidden after every listed one.
  const shuffled = rng.shuffle(WIDGET_IDS)
  const listed: string[] = []
  const take = rng.int(1, shuffled.length)

  for (let index = 0; index < take; index += 1) {
    const id = shuffled[index]

    if (id !== undefined) listed.push(id)
  }

  const first = listed[0]

  if (first !== undefined && rng.next() < 0.5) listed.splice(1, 0, first)

  listed.push("not-a-widget")

  return listed
}

interface RowSpec {
  readonly width: number
  readonly left: readonly FormattedWidget[]
  readonly right: readonly FormattedWidget[]
  readonly padding?: number
  readonly minZoneGap?: number
  readonly separator?: MetricSeparator
  readonly colonJoin?: boolean
  readonly hideFirst?: readonly string[]
}

/** One input widget that the engine must consider: text and width both render. */
interface PresentWidget {
  readonly widget: FormattedWidget
  readonly zone: "left" | "right"
  readonly fullText: string
  readonly fullWidth: number
  /** The legal directory representations: valid candidates, or the full text fallback. */
  readonly legalCandidates: readonly PathCandidate[]
}

interface GeneratedRow {
  readonly input: RowFitInput
  readonly left: readonly FormattedWidget[]
  readonly right: readonly FormattedWidget[]
  readonly present: readonly PresentWidget[]
  readonly separator: MetricSeparator
  readonly colonJoin: boolean
  readonly padding: number
  readonly minZoneGap: number
  readonly hideFirst: readonly string[]
}

function nonNegativeCells(value: number | undefined, fallback: number): number {
  const floored = Math.floor(value ?? fallback)

  return Number.isFinite(floored) && floored > 0 ? floored : 0
}

function collectPresent(into: PresentWidget[], widgets: readonly FormattedWidget[], zone: "left" | "right"): void {
  for (const widget of widgets) {
    // Same absence rule as the engine: a widget that would render nothing is
    // not present at all, so it can never be reported as hidden.
    if (widget.text === "" || widget.width <= 0) continue

    const declared: PathCandidate[] = []

    if (widget.id === "directory") {
      for (const candidate of widget.pathCandidates ?? []) {
        if (candidate.text !== "" && candidate.width > 0) declared.push(candidate)
      }
    }

    into.push({
      widget,
      zone,
      fullText: widget.text,
      fullWidth: widget.width,
      legalCandidates: declared.length > 0 ? declared : [{ text: widget.text, width: widget.width }],
    })
  }
}

/** Resolves a row spec into the exact input and the metadata the assertions need. */
function makeRow(spec: RowSpec): GeneratedRow {
  const padding = nonNegativeCells(spec.padding, 1)
  const minZoneGap = nonNegativeCells(spec.minZoneGap, 1)
  const separator = spec.separator ?? "dot"
  const colonJoin = spec.colonJoin ?? false
  const hideFirst = spec.hideFirst ?? OVERFLOW_PRESETS.balanced

  const input: RowFitInput = {
    width: spec.width,
    padding,
    minZoneGap,
    separator,
    colonJoin,
    hideFirst,
    left: spec.left,
    right: spec.right,
  }

  const present: PresentWidget[] = []

  collectPresent(present, spec.left, "left")
  collectPresent(present, spec.right, "right")

  return { input, left: spec.left, right: spec.right, present, separator, colonJoin, padding, minZoneGap, hideFirst }
}

function generateRow(rng: Rng): GeneratedRow {
  const pool = rng.shuffle(WIDGET_IDS)
  const count = rng.int(0, pool.length)
  const chosen = pool.slice(0, count)
  const split = rng.int(0, count)
  const left: FormattedWidget[] = []
  const right: FormattedWidget[] = []

  for (const [index, id] of chosen.entries()) {
    const widget = randomWidget(id, rng)

    if (index < split) left.push(widget)
    else right.push(widget)
  }

  return makeRow({
    width: rng.int(0, 88),
    padding: rng.int(0, 2),
    minZoneGap: rng.int(0, 2),
    separator: rng.pick(METRIC_SEPARATORS),
    colonJoin: rng.next() < 0.45,
    hideFirst: randomHideFirst(rng),
    left,
    right,
  })
}

const SEPARATOR_TEXT: Readonly<Record<Extract<MetricSeparator, string>, string>> = { dot: " · ", pipe: " | ", space: " " }

/** The documented joiner rule, applied to the final visible sequence. */
function expectedJoiner(left: WidgetID, right: WidgetID, separator: MetricSeparator, colonJoin: boolean): string {
  if (colonJoin && left === "directory" && right === "branch") return ":"

  if (isMetricWidget(left) && isMetricWidget(right)) return separator instanceof Object ? separator.text : SEPARATOR_TEXT[separator]

  return " "
}

/** The documented priority semantics: first occurrence ranks, absent ids rank last. */
function hideRanks(hideFirst: readonly string[]): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>()

  for (const [index, id] of hideFirst.entries()) {
    if (!ranks.has(id)) ranks.set(id, index)
  }

  return ranks
}

function visibleIdsOf(plan: FittedRow): string[] {
  const ids: string[] = []

  for (const item of plan.left.items) ids.push(item.id)

  for (const item of plan.right.items) ids.push(item.id)

  return ids
}

/** The row at every widget's full representation, with no hiding at all. */
function fullRowWidth(row: GeneratedRow): number {
  const zoneWidth = (zone: "left" | "right"): number => {
    const widgets: PresentWidget[] = []

    for (const present of row.present) {
      if (present.zone === zone) widgets.push(present)
    }

    let width = 0

    for (const [index, present] of widgets.entries()) {
      const previous = widgets[index - 1]

      if (previous !== undefined) {
        width += measureCells(expectedJoiner(previous.widget.id, present.widget.id, row.separator, row.colonJoin))
      }

      width += present.fullWidth
    }

    return width
  }

  const left = zoneWidth("left")
  const right = zoneWidth("right")
  const gap = left > 0 && right > 0 ? row.minZoneGap : 0

  return left + gap + right
}

/** The composed row text is at most the budget, in real terminal cells. */
function assertBudget(row: GeneratedRow, plan: FittedRow): void {
  const width = nonNegativeCells(row.input.width, 0)

  expect(plan.contentWidth).toBe(Math.max(0, width - row.padding * 2))
  expect(plan.padding).toBe(row.padding)
  expect(plan.minZoneGap).toBe(row.minZoneGap)

  const leftText = composeZoneText(plan.left)
  const rightText = composeZoneText(plan.right)
  const leftCells = measureCells(leftText)
  const rightCells = measureCells(rightText)
  const gap = leftText !== "" && rightText !== "" ? plan.minZoneGap : 0

  // The declared zone widths must agree with the text the renderer would draw,
  // and the drawn row must be inside the budget.
  expect(plan.left.width).toBe(leftCells)
  expect(plan.right.width).toBe(rightCells)
  expect(plan.usedWidth).toBe(leftCells + gap + rightCells)
  expect(plan.usedWidth).toBeLessThanOrEqual(plan.contentWidth)
}

/** Order, zone assignment, whole labels, legal directory candidates, joiners. */
function assertStructure(row: GeneratedRow, plan: FittedRow): void {
  const hiddenSet = new Set<string>(plan.hidden)
  const presentIds: string[] = []

  for (const present of row.present) presentIds.push(present.widget.id)

  const visible = visibleIdsOf(plan)

  expect(new Set(visible).size).toBe(visible.length)
  expect(new Set(plan.hidden).size).toBe(plan.hidden.length)

  for (const id of visible) expect(presentIds).toContain(id)

  for (const id of plan.hidden) expect(presentIds).toContain(id)

  const expectedSurvivors: string[] = []

  for (const id of presentIds) {
    if (!hiddenSet.has(id)) expectedSurvivors.push(id)
  }

  expectedSurvivors.sort()

  const sortedVisible = [...visible].sort()

  expect(sortedVisible).toEqual(expectedSurvivors)

  const leftExpected: WidgetID[] = []
  const rightExpected: WidgetID[] = []

  for (const present of row.present) {
    if (hiddenSet.has(present.widget.id)) continue

    if (present.zone === "left") leftExpected.push(present.widget.id)
    else rightExpected.push(present.widget.id)
  }

  expect(plan.left.items.map((item) => item.id)).toEqual(leftExpected)
  expect(plan.right.items.map((item) => item.id)).toEqual(rightExpected)

  assertJoiners(row, plan.left)
  assertJoiners(row, plan.right)
  assertItems(row, plan)
}

function assertJoiners(row: GeneratedRow, zone: FittedZone): void {
  expect(zone.joiners).toHaveLength(Math.max(0, zone.items.length - 1))

  for (let index = 0; index + 1 < zone.items.length; index += 1) {
    const left = zone.items[index]
    const right = zone.items[index + 1]

    if (left === undefined || right === undefined) continue

    expect(zone.joiners[index]).toBe(expectedJoiner(left.id, right.id, row.separator, row.colonJoin))
  }

  const colonNeighbor = zone.items.some(
    (item, index) => item.id === "directory" && zone.items[index + 1]?.id === "branch",
  )

  expect(zone.joiners.includes(":")).toBe(row.colonJoin && colonNeighbor)
}

function assertItems(row: GeneratedRow, plan: FittedRow): void {
  const byId = new Map<string, PresentWidget>()

  for (const present of row.present) byId.set(present.widget.id, present)

  for (const item of [...plan.left.items, ...plan.right.items]) {
    const present = byId.get(item.id)

    expect(present).toBeDefined()

    if (present === undefined) continue

    expect(item.width).toBe(measureCells(item.text))

    if (item.id === "directory") {
      const legal = present.legalCandidates.some(
        (candidate) => candidate.text === item.text && candidate.width === item.width,
      )

      expect(legal).toBe(true)
    } else {
      expect(item.text).toBe(present.fullText)
      expect(item.width).toBe(present.fullWidth)
    }
  }
}

/** Hidden is exactly the removal set, and priority order is never inverted. */
function assertPriority(row: GeneratedRow, plan: FittedRow): void {
  const ranks = hideRanks(row.hideFirst)
  const rankOf = (id: string): number => ranks.get(id) ?? Number.MAX_SAFE_INTEGER
  const hiddenRanks: number[] = []

  for (const id of plan.hidden) hiddenRanks.push(rankOf(id))

  for (let index = 1; index < hiddenRanks.length; index += 1) {
    const previous = hiddenRanks[index - 1]
    const current = hiddenRanks[index]

    if (previous === undefined || current === undefined) continue

    expect(previous).toBeLessThanOrEqual(current)
  }

  const visible = visibleIdsOf(plan)

  if (hiddenRanks.length > 0 && visible.length > 0) {
    const highestHidden = Math.max(...hiddenRanks)
    const lowestVisible = Math.min(...visible.map((id) => rankOf(id)))

    expect(highestHidden).toBeLessThanOrEqual(lowestVisible)
  }
}

/** A full row that already fits must come back whole. */
function assertFullFit(row: GeneratedRow, plan: FittedRow): void {
  const fullWidth = fullRowWidth(row)

  if (fullWidth > plan.contentWidth) return

  expect(plan.hidden).toEqual([])
  expect(plan.usedWidth).toBe(fullWidth)

  const byId = new Map<string, PresentWidget>()

  for (const present of row.present) byId.set(present.widget.id, present)

  for (const item of [...plan.left.items, ...plan.right.items]) {
    const present = byId.get(item.id)

    if (present === undefined) continue

    expect(item.text).toBe(present.fullText)
    expect(item.width).toBe(present.fullWidth)
  }
}

/** The fit is deterministic and does not mutate the caller's widgets. */
function assertPurity(row: GeneratedRow, plan: FittedRow): void {
  const before = JSON.stringify({ left: row.left, right: row.right })

  expect(fitRow(row.input)).toEqual(plan)
  expect(JSON.stringify({ left: row.left, right: row.right })).toBe(before)
}

function jsonRow(row: GeneratedRow): string {
  return JSON.stringify({
    width: row.input.width,
    padding: row.padding,
    minZoneGap: row.minZoneGap,
    separator: row.separator,
    colonJoin: row.colonJoin,
    hideFirst: row.hideFirst,
    left: row.left,
    right: row.right,
  })
}

interface Coverage {
  hidden: number
  unhidden: number
  shortened: number
  colonJoined: number
  empty: number
}

function measureCoverage(row: GeneratedRow, plan: FittedRow, coverage: Coverage): void {
  if (plan.hidden.length > 0) coverage.hidden += 1
  else coverage.unhidden += 1

  const items = [...plan.left.items, ...plan.right.items]

  for (const present of row.present) {
    if (present.widget.id !== "directory") continue

    const shown = items.find((item) => item.id === "directory")

    if (shown !== undefined && shown.text !== present.fullText) coverage.shortened += 1
  }

  if (plan.left.joiners.includes(":") || plan.right.joiners.includes(":")) coverage.colonJoined += 1

  if (items.length === 0) coverage.empty += 1
}

function forEachGeneratedRow(
  seed: number,
  iterations: number,
  check: (row: GeneratedRow, plan: FittedRow) => void,
): Coverage {
  const rng = createRng(seed)
  const coverage: Coverage = { hidden: 0, unhidden: 0, shortened: 0, colonJoined: 0, empty: 0 }

  for (let index = 0; index < iterations; index += 1) {
    const row = generateRow(rng)
    const plan = fitRow(row.input)

    measureCoverage(row, plan, coverage)

    try {
      check(row, plan)
    } catch (error) {
      const detail = error instanceof Error ? error.message : "assertion failed"

      throw new Error(`seed ${seed}, iteration ${index}: ${jsonRow(row)}\n${detail}`)
    }
  }

  return coverage
}

function label(id: WidgetID, text: string): FormattedWidget {
  return { id, text, width: measureCells(text) }
}

function directoryWidget(candidates: readonly string[]): FormattedWidget {
  const list: PathCandidate[] = []

  for (const text of candidates) list.push({ text, width: measureCells(text) })

  const full = list[0]

  if (full === undefined) throw new Error("a directory needs at least one candidate")

  return { id: "directory", text: full.text, width: full.width, pathCandidates: list }
}

/** A row dense with CJK, emoji, colon joins and a three-step path. */
function wideFixture() {
  return {
    left: [
      directoryWidget(["\u{f115} ~/プロジェクト/日本語-repo", "\u{f115} ~/.../日本語-repo", "日本語-repo"]),
      label("branch", "\u{f418} 機能/日本-✨"),
      label("spinner", "zsh"),
    ],
    right: [
      label("input", "in 128k"),
      label("output", "出力 4.2k"),
      label("cache", "cache 93%"),
      label("cost", "$0.42"),
      label("context", "[██░░] 50%"),
      label("tps", "🚀 52.4 t/s"),
    ],
  }
}

describe("fitRow generated rows", () => {
  test("composed row text never exceeds the content budget", () => {
    const coverage = forEachGeneratedRow(0x1a70_0001, 160, (row, plan) => {
      assertBudget(row, plan)
    })

    expect(coverage.hidden).toBeGreaterThan(0)
    expect(coverage.unhidden).toBeGreaterThan(0)
    expect(coverage.empty).toBeGreaterThan(0)
  })

  test("zones, order, whole labels and legal directory candidates survive", () => {
    const coverage = forEachGeneratedRow(0x1a70_0022, 160, (row, plan) => {
      assertStructure(row, plan)
    })

    expect(coverage.shortened).toBeGreaterThan(0)
    expect(coverage.colonJoined).toBeGreaterThan(0)
    expect(coverage.hidden).toBeGreaterThan(0)
  })

  test("hidden is exactly the removals, in priority order; fitting rows stay whole", () => {
    const coverage = forEachGeneratedRow(0x1a70_0003, 160, (row, plan) => {
      assertPriority(row, plan)
      assertFullFit(row, plan)
    })

    expect(coverage.hidden).toBeGreaterThan(0)
    expect(coverage.unhidden).toBeGreaterThan(0)
  })

  test("the fit is deterministic and does not mutate its input widgets", () => {
    forEachGeneratedRow(0x1a70_0004, 60, (row, plan) => {
      assertPurity(row, plan)
    })
  })
})

describe("fitRow across every width", () => {
  test("a dense CJK/emoji row satisfies the full contract at every budget", () => {
    const fixture = wideFixture()

    for (let width = 0; width <= 96; width += 1) {
      for (const colonJoin of [false, true]) {
        const row = makeRow({
          width,
          padding: 1,
          minZoneGap: 1,
          separator: "dot",
          colonJoin,
          hideFirst: OVERFLOW_PRESETS.balanced,
          left: fixture.left,
          right: fixture.right,
        })

        const plan = fitRow(row.input)

        assertBudget(row, plan)
        assertStructure(row, plan)
        assertPriority(row, plan)
        assertFullFit(row, plan)
      }
    }
  })
})

describe("present widgets and candidates", () => {
  test("widgets that would render nothing are absent, never hidden", () => {
    const plan = fitRow({
      width: 40,
      padding: 1,
      minZoneGap: 1,
      hideFirst: ["spinner", "branch", "tps", "cost", "output", "input"],
      left: [
        { id: "spinner", text: "", width: 0 },
        { id: "branch", text: "", width: 12 },
        label("directory", "repo"),
      ],
      right: [
        { id: "tps", text: "x", width: 0 },
        { id: "cost", text: "", width: 3 },
        label("input", "in 1"),
      ],
    })

    expect(plan.hidden).toEqual([])
    expect(plan.left.items.map((item) => item.id)).toEqual(["directory"])
    expect(plan.right.items.map((item) => item.id)).toEqual(["input"])
    expect(composeZoneText(plan.left)).toBe("repo")
    expect(composeZoneText(plan.right)).toBe("in 1")
  })

  test("directory candidates that render nothing are not selectable", () => {
    const legalText = "日本語-repo"
    const legalWidth = measureCells(legalText)

    const plan = fitRow({
      width: 40,
      padding: 1,
      left: [
        {
          id: "directory",
          text: legalText,
          width: legalWidth,
          pathCandidates: [
            { text: "", width: 0 },
            { text: legalText, width: legalWidth },
          ],
        },
      ],
      right: [],
    })

    expect(plan.left.items.map((item) => item.text)).toEqual([legalText])

    // A candidate list with nothing usable falls back to the widget's own
    // representation, which is the full selected form.
    const fallback = fitRow({
      width: 40,
      padding: 1,
      left: [{ id: "directory", text: "src", width: measureCells("src"), pathCandidates: [{ text: "", width: 0 }] }],
      right: [],
    })

    expect(fallback.left.items.map((item) => item.text)).toEqual(["src"])
  })

  test("duplicate priority entries keep their first position and unknown ids are ignored", () => {
    const input = label("input", "in 128k")
    const cost = label("cost", "$0.42")
    const budget = measureCells("in 128k") + 1

    const plan = fitRow({
      width: budget + 2,
      padding: 1,
      left: [],
      right: [input, cost],
      hideFirst: ["ghost", "cost", "cost", "input"],
    })

    expect(plan.hidden).toEqual(["cost"])
    expect(plan.right.items.map((item) => item.id)).toEqual(["input"])
  })

  test("an empty priority list still hides deterministically in display order", () => {
    const plan = fitRow({
      width: measureCells("a") + 2,
      padding: 1,
      left: [label("branch", "b"), label("spinner", "s")],
      right: [],
      hideFirst: [],
    })

    expect(plan.left.items.map((item) => item.id)).toEqual(["spinner"])
    expect(plan.hidden).toEqual(["branch"])
  })
})

describe("colon adjacency disappearing", () => {
  const branchText = "\u{f418} main"
  const minDirectoryText = "日本語"

  function colonRow(budget: number, hideFirst: readonly string[]): GeneratedRow {
    return makeRow({
      width: budget + 2,
      padding: 1,
      minZoneGap: 1,
      colonJoin: true,
      hideFirst,
      left: [
        directoryWidget(["\u{f115} ~/projects/日本語", "\u{f115} ~/.../日本語", minDirectoryText]),
        label("branch", branchText),
      ],
      right: [],
    })
  }

  test("an adjacent directory and branch join with a bare colon", () => {
    const row = colonRow(200, [])
    const plan = fitRow(row.input)

    expect(plan.hidden).toEqual([])
    expect(plan.left.items.map((item) => item.id)).toEqual(["directory", "branch"])
    expect(plan.left.joiners).toEqual([":"])
    expect(composeZoneText(plan.left)).toBe(`\u{f115} ~/projects/日本語:${branchText}`)
  })

  test("hiding the directory leaves the branch bare, with no colon and no leading space", () => {
    const row = colonRow(measureCells(branchText), ["directory"])
    const plan = fitRow(row.input)

    expect(plan.hidden).toEqual(["directory"])
    expect(plan.left.items.map((item) => item.id)).toEqual(["branch"])
    expect(plan.left.joiners).toEqual([])
    expect(composeZoneText(plan.left)).toBe(branchText)
    expect(composeZoneText(plan.left).includes(":")).toBe(false)
  })

  test("hiding the branch leaves the directory alone, with no dangling colon", () => {
    const row = colonRow(measureCells(minDirectoryText), ["branch"])
    const plan = fitRow(row.input)

    expect(plan.hidden).toEqual(["branch"])
    expect(plan.left.items.map((item) => item.id)).toEqual(["directory"])
    expect(plan.left.items[0]?.text).toBe(minDirectoryText)
    expect(plan.left.joiners).toEqual([])
    expect(composeZoneText(plan.left).includes(":")).toBe(false)
  })

  test("a directory and branch that are not adjacent take ordinary spaces", () => {
    const row = makeRow({
      width: 200,
      padding: 1,
      colonJoin: true,
      hideFirst: [],
      left: [
        directoryWidget(["\u{f115} ~/projects/日本語", minDirectoryText]),
        label("input", "in 128k"),
        label("branch", branchText),
      ],
      right: [],
    })

    const plan = fitRow(row.input)

    expect(plan.left.items.map((item) => item.id)).toEqual(["directory", "input", "branch"])
    expect(plan.left.joiners).toEqual([" ", " "])
    expect(composeZoneText(plan.left).includes(":")).toBe(false)
  })

  test("zones never colon-join across the zone gap", () => {
    const row = makeRow({
      width: 200,
      padding: 1,
      colonJoin: true,
      hideFirst: [],
      left: [directoryWidget(["\u{f115} ~/projects/日本語", minDirectoryText])],
      right: [label("branch", branchText)],
    })

    const plan = fitRow(row.input)

    expect(plan.left.joiners).toEqual([])
    expect(plan.right.joiners).toEqual([])
    expect(composeZoneText(plan.left).includes(":")).toBe(false)
    expect(composeZoneText(plan.right).includes(":")).toBe(false)
  })
})
