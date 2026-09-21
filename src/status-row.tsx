// opencode2-enhanced-composer — the shared status row renderer
//
// One row component for the production footer, the composer-top
// row, and the settings-editor preview. It consumes `fitRow`'s plan from
// `layout.ts` verbatim: the surviving items in display order, the exact
// joiner texts between neighbors, and the geometry the fit assumed (padding,
// and a minimum zone gap the fit already reserved — the leftover space the
// left zone's flexibility leaves between the zones is never smaller). The
// row adds no spacing of its own, never truncates, and never wraps.
//
// The plan's `spinner` item carries only a representative text of its exact
// width; the row substitutes the live visuals for it when the caller supplies
// the face and agent color, and owns the animation lifecycle either way, so a
// preview rendering the same plan animates exactly like production.
//
// The measured-row-width discipline also lives here: `useRowWidth` keeps the
// row's own reported width ahead of the raw terminal size, so a sidebar or
// any other host UI that reduces the row's space is respected, while the
// terminal read keeps resize tracking alive.

import { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { FittedItem, FittedRow, FittedZone } from "./layout.js"
import { SpinnerGlyph, useSpinnerFrame, type SpinnerVisual } from "./widgets.js"

/** A color the renderer accepts: a resolved `RGBA` or a theme string. */
export type RowColor = RGBA | string

/**
 * The live spinner the row substitutes for the plan's `spinner` item: the
 * selected face and the session's agent color. The caller must keep the face
 * consistent with the one the fitted item's representative text was built
 * for, so the substitution occupies exactly the width the fit reserved.
 */
export interface SpinnerRender {
  readonly visual: SpinnerVisual
  readonly base: RGBA
}

/** The theme colors the row needs; information text stays subdued. */
export interface StatusRowTheme {
  readonly subdued: RowColor
}

export interface StatusRowProps {
  /** The fitted row plan from `fitRow`; rendered verbatim. */
  readonly row: FittedRow
  readonly theme: StatusRowTheme
  /**
   * Without it a `spinner` item renders its representative text like any
   * other item and nothing animates.
   */
  readonly spinner?: SpinnerRender
  /** Attached to the row's own box; see `useRowWidth`. */
  readonly onSizeChange?: (this: { readonly width: number }) => void
}

function findSpinnerItem(row: FittedRow): FittedItem | undefined {
  const inLeft = row.left.items.find((candidate) => candidate.id === "spinner")

  return inLeft ?? row.right.items.find((candidate) => candidate.id === "spinner")
}

function renderItem(
  item: FittedItem,
  theme: StatusRowTheme,
  spinner: SpinnerRender | undefined,
  frame: () => number,
): JSX.Element {
  if (item.id === "spinner" && spinner !== undefined) {
    return <SpinnerGlyph visual={spinner.visual} frameIndex={frame()} base={spinner.base} />
  }

  return (
    <text fg={theme.subdued} wrapMode="none" flexShrink={0}>
      {item.text}
    </text>
  )
}

/**
 * The joiner before `items[index]`. An empty joiner renders nothing at all —
 * an empty text element would still claim a blank cell, which would be
 * spacing the fit never accounted for.
 */
function renderJoiner(zone: FittedZone, index: number, theme: StatusRowTheme): JSX.Element {
  if (index === 0) return null
  const joiner = zone.joiners[index - 1]

  if (joiner === undefined || joiner === "") return null

  return (
    <text fg={theme.subdued} wrapMode="none" flexShrink={0}>
      {joiner}
    </text>
  )
}

interface ZoneViewProps {
  readonly zone: FittedZone
  readonly theme: StatusRowTheme
  readonly spinner: SpinnerRender | undefined
  readonly frame: () => number
}

/**
 * One fitted zone: every item preceded by its joiner (`joiners[i - 1]` before
 * `items[i]`, nothing before the first), rendered in display order with no
 * spacing of the row's own.
 */
function ZoneView(props: ZoneViewProps) {
  return (
    <For each={props.zone.items}>
      {(item: FittedItem, index: () => number) => (
        <>
          {renderJoiner(props.zone, index(), props.theme)}
          {renderItem(item, props.theme, props.spinner, props.frame)}
        </>
      )}
    </For>
  )
}

/**
 * Renders a fitted row plan: the left zone left-aligned, the right zone
 * right-aligned, the leftover space between them left empty by the layout.
 * Empty rows collapse to nothing — an empty replacement footer still replaces
 * the native one; that is the slot's decision, not the row's.
 */
export function StatusRow(props: StatusRowProps) {
  // The timer exists only while an animated spinner item is actually on
  // screen: hidden by overflow or absent means no scheduling at all. The memo
  // keeps refits that do not change the face from restarting the interval.
  const spinnerVisual = createMemo(() => (findSpinnerItem(props.row) === undefined ? undefined : props.spinner?.visual))
  const frame = useSpinnerFrame(spinnerVisual)

  const empty = () => props.row.left.items.length === 0 && props.row.right.items.length === 0

  // The box stays mounted even when the plan is empty: with no children it is
  // a zero-height, full-width measurement shell, so the row still collapses
  // while the host's real available width keeps being reported. Unmounting the
  // box would freeze the last measured width, and a row that overflowed to
  // empty could never come back when a sidebar closes or the terminal grows
  // without a resize event reaching useRowWidth's terminal fallback.
  return (
    <box
      width="100%"
      flexDirection="row"
      paddingLeft={props.row.padding}
      paddingRight={props.row.padding}
      onSizeChange={props.onSizeChange}
    >
      <Show when={!empty()}>
        <>
          <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row">
            <ZoneView zone={props.row.left} theme={props.theme} spinner={props.spinner} frame={frame} />
          </box>
          <Show when={props.row.right.items.length > 0}>
            <box flexDirection="row" flexShrink={0}>
              <ZoneView zone={props.row.right} theme={props.theme} spinner={props.spinner} frame={frame} />
            </box>
          </Show>
        </>
      </Show>
    </box>
  )
}

export interface RowWidthSource {
  readonly width: () => number
  readonly onSizeChange: (this: { readonly width: number }) => void
}

/**
 * The measured-row-width discipline shared by every status row host: the
 * row's own reported width wins — a sidebar or any other host UI that
 * reduces the row's space is respected — while the terminal read keeps the
 * accessor tracking resizes even before the row reports, or after it has
 * collapsed to nothing. The caller fits against `width()` and passes the
 * resulting plan back to `StatusRow`.
 */
export function useRowWidth(): RowWidthSource {
  const dimensions = useTerminalDimensions()
  const [rowWidth, setRowWidth] = createSignal(0)

  const width = () => {
    const terminal = dimensions().width
    const row = rowWidth()

    return row > 0 ? Math.min(row, terminal) : terminal
  }

  // The renderer fires `onSizeChange` from inside its own layout pass
  // (`onResize`), so the write must not land synchronously: a reactive refit
  // mid-layout re-enters the render pass and blanks the frame. Deferring to a
  // microtask keeps the row's reported width ahead of the terminal read — the
  // next draw uses it — without touching the tree during layout.
  const onSizeChange = function (this: { readonly width: number }) {
    const measured = this.width

    queueMicrotask(() => {
      setRowWidth(measured)
    })
  }

  return { width, onSizeChange }
}
