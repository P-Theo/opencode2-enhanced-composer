// opencode2-enhanced-composer — the overflow and layout engine
//
// One pure function sits between formatting and rendering. `fitRow` takes the
// widgets a row wants to show — each already formatted to its selected
// representation, carrying exact cell widths and, for the directory, its path
// candidates — and returns the plan that actually fits: which widgets
// survived, the directory's chosen path length, and the exact joiners between
// neighbors. Rendering consumes the plan verbatim; it never truncates, wraps,
// or makes another hiding decision, so the fit and the render cannot
// disagree.
//
// The rules implemented here are the settled product decisions:
//
//   * Both zones of a row are fitted together against the row's content width
//     (total width minus padding on each side). When both zones have content,
//     the minimum gap between them is reserved before anything else.
//   * Overflow hides whole widgets in `hideFirst` order (hide first → hide
//     last). Priority is independent of display order and is matched only
//     against widgets actually present in the row. If even the last survivor
//     cannot fit, it is hidden too; a row may legitimately end up empty.
//   * Fitting first places the directory at its minimum allowed path
//     representation, hides widgets until the row fits, and then spends the
//     remaining space expanding the directory toward its full selected
//     representation. Branch names and final directory names are never cut
//     mid-text: a widget is shown whole or hidden.
//   * Separators are derived from the final visible sequence: consecutive
//     metric widgets take the selected separator (` · `, ` | ` or ` `), every
//     other boundary takes a single space, and a colon-style branch joins an
//     immediately preceding directory as `dir:branch` with no spaces. Hiding
//     a neighbor re-derives the joiners, so no leading, trailing, or dangling
//     separator can survive.
//
// Measurement is terminal cells, never JavaScript string length; the
// measurement section below documents why the renderer's own width method is
// the only exact answer.
//
// The widget registry, the metric separator enum, the path-candidate shape
// and the Balanced priority order all come from `options.ts` — the shared
// configuration contract — so this engine and the configuration can never
// drift apart.

import { resolveRenderLib } from "@opentui/core"
import type { RenderLib, WidthMethod } from "@opentui/core"
import stringWidth from "string-width"
import { METRIC_WIDGET_IDS, OVERFLOW_PRESETS } from "./options.js"
import type { MetricSeparator, PathCandidate, WidgetID } from "./options.js"

export type { MetricSeparator, PathCandidate, WidgetID } from "./options.js"

export type { WidthMethod } from "@opentui/core"

// The renderer lays out `<text>` through its native core: every TextBuffer is
// created with the renderer's width method and measured by the same
// `encodeUnicode` table walk (`RenderLib.encodeUnicode`, the call behind
// `CliRenderer.widthMethod`, default "unicode"). The primary measurement IS
// that native call, with the width method as a parameter: production passes
// the live renderer's choice (`useRenderer().widthMethod` inside a slot
// component), the preview passes its own renderer's, and tests pass the same
// default. `resolveRenderLib` is public `@opentui/core` API, and the host's
// runtime plugin support rewrites the bare specifier to the TUI's own copy,
// so this measures with the exact tables the running renderer uses.
//
// Two fallbacks keep measurement total when the native core cannot load:
// Bun's `stringWidth` (the installed core's own JS-side choice under Bun,
// which agrees with the native table on all realistic content), then the
// declared `string-width@7.2.0` — the exact package the installed core
// bundles as its own JS fallback. Only the native path is exact for every
// width method; the fallbacks approximate the default "unicode" method.

/** The renderer's own default; `CliRenderer.widthMethod` reports the live choice. */
const DEFAULT_WIDTH_METHOD: WidthMethod = "unicode"

/**
 * Measures a string's terminal cell width: the implementation of the
 * `MeasureTextWidth` contract `options.ts` declares for the whole pipeline.
 */
export type CellMeasurer = (text: string) => number

/** Matches the host's event-deduplication cap: bounded, and the hot set refills immediately. */
const MEASURER_CACHE_LIMIT = 4_096

const measurers = new Map<WidthMethod, CellMeasurer>()

/**
 * The shared measurer for a width method. One instance is cached per method so
 * production, preview and tests reuse a single memo — a row re-measures the
 * same labels, glyphs and separators many times while hiding and expanding.
 * `format.ts` computes the widths it attaches to formatted widgets with the
 * same measurer, so the whole pipeline measures through one implementation.
 */
export function createCellMeasurer(widthMethod: WidthMethod = DEFAULT_WIDTH_METHOD): CellMeasurer {
  const existing = measurers.get(widthMethod)

  if (existing !== undefined) return existing

  const cache = new Map<string, number>()

  const measurer: CellMeasurer = (text: string): number => {
    const cached = cache.get(text)

    if (cached !== undefined) return cached

    const width = measureUncached(text, widthMethod)

    if (cache.size >= MEASURER_CACHE_LIMIT) cache.clear()
    cache.set(text, width)

    return width
  }

  measurers.set(widthMethod, measurer)

  return measurer
}

/** Measures one string with the shared measurer for `widthMethod`. */
export function measureCells(text: string, widthMethod: WidthMethod = DEFAULT_WIDTH_METHOD): number {
  return createCellMeasurer(widthMethod)(text)
}

function measureUncached(text: string, widthMethod: WidthMethod): number {
  const native = nativeStringWidth(text, widthMethod)

  if (native !== undefined) return native

  if (bunStringWidth !== undefined) return bunStringWidth(text)

  return measureCellsPortable(text)
}

let nativeLib: RenderLib | undefined

let nativeLibUnavailable = false

/**
 * The renderer's measurement itself. Failure to load the native core — or a
 * throwing call — selects a fallback instead of breaking every row; once the
 * native path has failed it stays off for the process lifetime.
 */
function nativeStringWidth(text: string, widthMethod: WidthMethod): number | undefined {
  if (nativeLibUnavailable) return undefined

  if (nativeLib === undefined) {
    try {
      nativeLib = resolveRenderLib()
    } catch {
      nativeLibUnavailable = true

      return undefined
    }
  }

  const lib = nativeLib

  try {
    const encoded = lib.encodeUnicode(text, widthMethod)

    if (encoded === null) return undefined

    try {
      let width = 0

      for (const glyph of encoded.data) width += glyph.width

      return width
    } finally {
      lib.freeUnicode(encoded)
    }
  } catch {
    nativeLibUnavailable = true

    return undefined
  }
}

interface BunRuntime {
  readonly stringWidth?: (text: string) => number
}

// SAFETY: `globalThis.Bun` is untyped in this module's context; the local
// shape states the one member read, and the undefined check in
// `measureUncached` keeps an absent runtime out of the call. This is the same
// lookup the installed core's JS-side `stringWidth` performs
// (`globalThis.Bun?.stringWidth ?? stringWidth`).
const bunRuntime = (globalThis as { readonly Bun?: BunRuntime }).Bun

const bunStringWidth = bunRuntime?.stringWidth

/**
 * The last-resort measurement: the declared `string-width@7.2.0`, the exact
 * package the installed `@opentui/core` bundles as its own JS-side fallback.
 * Exported so its agreement with the native measurement stays tested. Known,
 * accepted divergence from the native table: it counts the emoji-presentation
 * BMP marks (© ™ ® and kin) as two cells where the native table counts them
 * one, and it skips a zero-width space the native walk mis-splits. Custom
 * text can include these characters; native measurement remains preferred.
 */
export function measureCellsPortable(text: string): number {
  return stringWidth(text)
}

// The registry lives in `options.ts` — the configuration contract's own module
// — and this engine consumes it directly so the two can never drift: the same
// widget ids, the same metric class (the separator rule is a layout concern,
// so the class helper lives here), and the same Balanced order for the
// fallback priority list.

const METRIC_WIDGETS = new Set<string>(METRIC_WIDGET_IDS)

/** Metric widgets take the selected separator between each other; every other boundary is a single space. */
export function isMetricWidget(id: string): boolean {
  return METRIC_WIDGETS.has(id)
}

/**
 * The fitting engine's fallback hide-first order when a row is fitted without
 * an explicit list: the Balanced preset, straight from the configuration
 * contract. Production and the preview always pass the normalized
 * `overflow.hideFirst`, which carries a list for every preset.
 */
export const DEFAULT_HIDE_FIRST: readonly WidgetID[] = OVERFLOW_PRESETS.balanced

// What `format.ts` produces per widget and what `fitRow` consumes. Raw values
// stay behind this boundary: a formatted widget is the selected
// representation already resolved to text, with the exact cell width of that
// text. Widths are authoritative for fitting — they must be computed with the
// shared `createCellMeasurer`, so the fit and the render measure identically.
//
// `options.ts` re-exports this contract as a type; production and preview
// consume the same fitted items, joiners, and geometry.

/**
 * A widget ready for fitting.
 *
 * `text` is the widget's full selected representation — labels, glyphs,
 * values, brackets, everything — without any inter-widget separator. `width`
 * is the exact cell width of `text`.
 *
 * `pathCandidates` is supplied for the directory widget only: its allowed
 * representations ordered from the full selected representation (first,
 * equal to `text`/`width`) down to the minimum allowed one (last), exactly as
 * `options.ts`'s `PathCandidate` contract documents them. Candidates shorten
 * by whole path segments and always keep the final directory name, so the
 * engine can only ever choose a complete candidate. A directory in
 * folder-name mode has a single candidate. Other widgets render whole or
 * hide, so they carry no candidates.
 *
 * The spinner carries a representative text of its exact width (a braille
 * frame, the block row, or `Running`); the row renderer substitutes the live
 * visuals for the same id and width.
 */
export interface FormattedWidget {
  readonly id: WidgetID
  readonly text: string
  readonly width: number
  readonly pathCandidates?: readonly PathCandidate[]
}

const SEPARATOR_TEXTS = { dot: " · ", pipe: " | ", space: " " } as const

/** One cell of breathing room on each side of a row, matching the current footer. */
export const DEFAULT_ROW_PADDING = 1

/** The minimum gap kept between two non-empty zones of the same row. */
export const DEFAULT_ZONE_GAP = 1

/**
 * One row to fit: the widgets that would render if space allowed, in display
 * order, per zone. Unavailable widgets are simply absent — availability is
 * decided before fitting, by the caller and `format.ts`.
 */
export interface RowFitInput {
  /** The row's total cell width as the host reports it (measured row width, terminal width as fallback). */
  readonly width: number
  /** Horizontal padding on each side of the row. Default 1. */
  readonly padding?: number
  /** Minimum gap reserved between two non-empty zones. Default 1. */
  readonly minZoneGap?: number
  /** Separator between consecutive metric widgets. Default `dot`. */
  readonly separator?: MetricSeparator
  /** True when the branch appearance is colon style; see `FormattedWidget` and the joiner rules. Default false. */
  readonly colonJoin?: boolean
  /**
   * Widget ids ordered hide first → hide last. Unknown ids are ignored,
   * duplicates keep their first position, and widgets absent from the list
   * are hidden after every listed one. Default: the Balanced order.
   */
  readonly hideFirst?: readonly string[]
  /** The renderer's width method; production passes the live renderer's choice. Default `unicode`. */
  readonly widthMethod?: WidthMethod
  /** Left-zone widgets in display order. */
  readonly left: readonly FormattedWidget[]
  /** Right-zone widgets in display order. */
  readonly right: readonly FormattedWidget[]
}

/** One surviving widget with its final text: an expanded path, or the widget's whole text. */
export interface FittedItem {
  readonly id: WidgetID
  readonly text: string
  readonly width: number
}

/**
 * One fitted zone: the surviving items in display order and the exact joiner
 * texts between them (`joiners[i]` sits between `items[i]` and `items[i+1]`,
 * so an empty zone has neither items nor joiners). `width` is the sum of both.
 */
export interface FittedZone {
  readonly items: readonly FittedItem[]
  readonly joiners: readonly string[]
  readonly width: number
}

/**
 * The complete, renderable plan for a row. `usedWidth` is left width plus the
 * zone gap (when both zones have content) plus right width, and is always
 * within `contentWidth` — hiding may empty the row, but never overflows it.
 * `hidden` lists the widgets overflow removed, in the order they were hidden.
 *
 * `padding` and `minZoneGap` are echoed so the row renderer lays the plan out
 * with the exact geometry the fit assumed.
 */
export interface FittedRow {
  readonly left: FittedZone
  readonly right: FittedZone
  readonly padding: number
  readonly minZoneGap: number
  readonly contentWidth: number
  readonly usedWidth: number
  readonly hidden: readonly WidgetID[]
}

interface FitContext {
  readonly measure: CellMeasurer
  readonly separatorText: string
  readonly colonJoin: boolean
}

interface RowSlot {
  readonly widget: FormattedWidget
  readonly candidates: readonly PathCandidate[]
  candidateIndex: number
  removed: boolean
}

function nonNegativeCells(value: number | undefined, fallback: number): number {
  const floored = Math.floor(value ?? fallback)

  return Number.isFinite(floored) && floored > 0 ? floored : 0
}

function toRowSlots(widgets: readonly FormattedWidget[]): RowSlot[] {
  const slots: RowSlot[] = []

  for (const widget of widgets) {
    // A widget that would render nothing is absent, not overflowing: dropping
    // it here keeps separators from stacking up around an empty item.
    if (widget.text === "" || widget.width <= 0) continue

    // Only the directory has alternative representations; everything else is
    // its own single candidate, so a stray candidate list on another widget
    // cannot change what it renders. Candidates run full → minimum, so the
    // minimum the hiding pass starts from is the last one.
    const declared =
      widget.id === "directory" ? (widget.pathCandidates?.filter((c) => c.text !== "" && c.width > 0) ?? []) : []

    const candidates: readonly PathCandidate[] =
      declared.length > 0 ? declared : [{ text: widget.text, width: widget.width }]

    slots.push({ widget, candidates, candidateIndex: candidates.length - 1, removed: false })
  }

  return slots
}

function hideRanks(hideFirst: readonly string[] | undefined): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>()
  const list = hideFirst ?? DEFAULT_HIDE_FIRST

  for (let index = 0; index < list.length; index += 1) {
    const id = list[index]

    if (id === undefined) continue

    if (!ranks.has(id)) ranks.set(id, index)
  }

  return ranks
}

interface HideCandidate {
  readonly slot: RowSlot
  readonly zoneIndex: 0 | 1
  readonly position: number
  readonly rank: number
}

function collectHideCandidates(
  slots: readonly RowSlot[],
  zoneIndex: 0 | 1,
  ranks: ReadonlyMap<string, number>,
): HideCandidate[] {
  const candidates: HideCandidate[] = []

  for (const [position, slot] of slots.entries()) {
    candidates.push({ slot, zoneIndex, position, rank: ranks.get(slot.widget.id) ?? Number.MAX_SAFE_INTEGER })
  }

  return candidates
}

interface Joiner {
  readonly text: string
  readonly width: number
}

function joinerBetween(left: RowSlot, right: RowSlot, context: FitContext): Joiner {
  // Colon-style branch: `dir:branch` with no ordinary separator and no spaces,
  // but only while the branch immediately follows the directory in the same
  // visible zone. Anywhere else the branch is a bare neighbor, including after
  // overflow has hidden the directory.
  if (context.colonJoin && left.widget.id === "directory" && right.widget.id === "branch") {
    return { text: ":", width: context.measure(":") }
  }

  if (isMetricWidget(left.widget.id) && isMetricWidget(right.widget.id)) {
    return { text: context.separatorText, width: context.measure(context.separatorText) }
  }

  return { text: " ", width: context.measure(" ") }
}

function layoutZone(slots: readonly RowSlot[], context: FitContext): FittedZone {
  const items: FittedItem[] = []
  const joiners: string[] = []
  let width = 0
  let previous: RowSlot | undefined

  for (const slot of slots) {
    if (slot.removed) continue

    const candidate = slot.candidates[slot.candidateIndex]

    if (candidate === undefined) continue

    if (previous !== undefined) {
      const joiner = joinerBetween(previous, slot, context)

      joiners.push(joiner.text)
      width += joiner.width
    }

    items.push({ id: slot.widget.id, text: candidate.text, width: candidate.width })
    width += candidate.width
    previous = slot
  }

  return { items, joiners, width }
}

function usedRowWidth(left: FittedZone, right: FittedZone, minZoneGap: number): number {
  const gap = left.items.length > 0 && right.items.length > 0 ? minZoneGap : 0

  return left.width + gap + right.width
}

function rowWidthOf(
  leftSlots: readonly RowSlot[],
  rightSlots: readonly RowSlot[],
  context: FitContext,
  minZoneGap: number,
): number {
  return usedRowWidth(layoutZone(leftSlots, context), layoutZone(rightSlots, context), minZoneGap)
}

/**
 * Fits one row. Pure and deterministic: the same input always yields the same
 * plan, and each row (the composer-top row, the footer row) is fitted
 * independently — one row's overflow never influences another's.
 */
export function fitRow(input: RowFitInput): FittedRow {
  const padding = nonNegativeCells(input.padding, DEFAULT_ROW_PADDING)
  const minZoneGap = nonNegativeCells(input.minZoneGap, DEFAULT_ZONE_GAP)
  const contentWidth = Math.max(0, nonNegativeCells(input.width, 0) - padding * 2)
  const separator = input.separator ?? "dot"

  const context: FitContext = {
    measure: createCellMeasurer(input.widthMethod ?? DEFAULT_WIDTH_METHOD),
    separatorText: separator instanceof Object ? separator.text : SEPARATOR_TEXTS[separator],
    colonJoin: input.colonJoin ?? false,
  }

  const leftSlots = toRowSlots(input.left)
  const rightSlots = toRowSlots(input.right)
  const ranks = hideRanks(input.hideFirst)

  const hideOrder = [
    ...collectHideCandidates(leftSlots, 0, ranks),
    ...collectHideCandidates(rightSlots, 1, ranks),
  ].sort((a, b) => a.rank - b.rank || a.zoneIndex - b.zoneIndex || a.position - b.position)

  // Hide whole widgets in priority order until the row fits. The directory is
  // at its minimum representation during this pass, and every removal
  // re-derives the joiners, so separator changes are part of the arithmetic.
  const hidden: WidgetID[] = []
  let hideIndex = 0

  while (hideIndex < hideOrder.length) {
    if (rowWidthOf(leftSlots, rightSlots, context, minZoneGap) <= contentWidth) break

    const victim = hideOrder[hideIndex]

    hideIndex += 1

    if (victim === undefined) continue

    victim.slot.removed = true
    hidden.push(victim.slot.widget.id)
  }

  // Spend what is left on the directory: the longest candidate that still
  // fits, trying from the full representation down to the minimum. Each
  // directory ends at worst back at its minimum, which is the state the
  // hiding pass proved fits.
  for (const slots of [leftSlots, rightSlots]) {
    for (const slot of slots) {
      if (slot.removed || slot.widget.id !== "directory") continue

      for (let index = 0; index < slot.candidates.length; index += 1) {
        slot.candidateIndex = index

        if (rowWidthOf(leftSlots, rightSlots, context, minZoneGap) <= contentWidth) break
      }
    }
  }

  const left = layoutZone(leftSlots, context)
  const right = layoutZone(rightSlots, context)

  return {
    left,
    right,
    padding,
    minZoneGap,
    contentWidth,
    usedWidth: usedRowWidth(left, right, minZoneGap),
    hidden,
  }
}

/** A zone as one plain string — the exact text a renderer draws for it. */
export function composeZoneText(zone: FittedZone): string {
  let text = ""

  for (let index = 0; index < zone.items.length; index += 1) {
    const item = zone.items[index]
    const joiner = index > 0 ? zone.joiners[index - 1] : undefined

    if (joiner !== undefined) text += joiner

    if (item !== undefined) text += item.text
  }

  return text
}
