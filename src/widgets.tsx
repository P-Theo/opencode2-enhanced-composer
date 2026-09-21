// opencode2-enhanced-composer — the visual widget primitives
//
// The spinner faces live here so the production footer, the settings-editor
// preview, and the render tests share one implementation.
//
// This module also owns the static `Running` text face, the `SpinnerVisual`
// surface the layout engine measures against, the shared animation lifecycle
// hook, and the fixed-size context bars.
//
// `@opentui/core` is imported bare on purpose: the host's runtime plugin
// support rewrites it to the TUI's own copy, so `RGBA` instances share the
// renderer.

import { RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"

// The host spinner lives inside the same boundary as the location label, so a
// replacement cannot keep it. This re-creates its two faces: a frame array
// advanced by a signal, and — for the block style — the same Knight Rider trail
// colors (`ui/spinner.ts`), decoded from the session's agent color.

export const SPINNER_INTERVAL_MS = 80

export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const BLOCK_WIDTH = 8

const BLOCK_TRAIL_LENGTH = 6

// The host holds at the start for 30 frames; that reads as a dead stop, so both
// ends hold for the same short beat.
const BLOCK_HOLD_START = 9

const BLOCK_HOLD_END = 9

const BLOCK_INACTIVE_FACTOR = 0.6

const BLOCK_MIN_ALPHA = 0.3

interface ScannerState {
  readonly position: number
  readonly forward: boolean
  readonly holding: boolean
  readonly holdProgress: number
  readonly holdTotal: number
  readonly movementProgress: number
  readonly movementTotal: number
}

/** Ported from the host's Knight Rider scanner (`ui/spinner.ts`). */
function scannerState(frameIndex: number, totalChars: number, holdStart: number, holdEnd: number): ScannerState {
  const forwardFrames = totalChars
  const backwardFrames = totalChars - 1

  if (frameIndex < forwardFrames) {
    return {
      position: frameIndex,
      forward: true,
      holding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frameIndex,
      movementTotal: forwardFrames,
    }
  }

  if (frameIndex < forwardFrames + holdEnd) {
    return {
      position: totalChars - 1,
      forward: true,
      holding: true,
      holdProgress: frameIndex - forwardFrames,
      holdTotal: holdEnd,
      movementProgress: 0,
      movementTotal: 0,
    }
  }

  if (frameIndex < forwardFrames + holdEnd + backwardFrames) {
    const backwardIndex = frameIndex - forwardFrames - holdEnd

    return {
      position: totalChars - 2 - backwardIndex,
      forward: false,
      holding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: backwardIndex,
      movementTotal: backwardFrames,
    }
  }

  return {
    position: 0,
    forward: false,
    holding: true,
    holdProgress: frameIndex - forwardFrames - holdEnd - backwardFrames,
    holdTotal: holdStart,
    movementProgress: 0,
    movementTotal: 0,
  }
}

function colorIndex(state: ScannerState, charIndex: number, trailLength: number): number {
  const distance = state.forward ? state.position - charIndex : charIndex - state.position

  if (state.holding) return distance + state.holdProgress

  if (distance > 0 && distance < trailLength) return distance

  if (distance === 0) return 0

  return -1
}

/** Host `deriveTrailColors`: alpha falloff with a one-step bloom. */
export function deriveTrailColors(bright: RGBA, steps = BLOCK_TRAIL_LENGTH): RGBA[] {
  const colors: RGBA[] = []

  for (let index = 0; index < steps; index += 1) {
    let alpha: number
    let brightness: number

    if (index === 0) {
      alpha = 1
      brightness = 1
    } else if (index === 1) {
      alpha = 0.9
      brightness = 1.15
    } else {
      alpha = 0.65 ** (index - 1)
      brightness = 1
    }

    colors.push(
      RGBA.fromValues(
        Math.min(1, bright.r * brightness),
        Math.min(1, bright.g * brightness),
        Math.min(1, bright.b * brightness),
        alpha,
      ),
    )
  }

  return colors
}

/** Host `deriveInactiveColor`: same hue, dimmed through alpha alone. */
export function deriveInactiveColor(bright: RGBA, factor = BLOCK_INACTIVE_FACTOR): RGBA {
  return RGBA.fromValues(bright.r, bright.g, bright.b, factor)
}

export interface SpinnerCell {
  readonly char: string
  readonly color: RGBA
}

/**
 * One rendered row of the block scanner: active cells take their trail color;
 * inactive cells fade between the inactive factor and the minimum alpha exactly
 * as the host's `createKnightRiderTrail` does.
 */
export function blockCells(frameIndex: number, base: RGBA): SpinnerCell[] {
  const state = scannerState(frameIndex, BLOCK_WIDTH, BLOCK_HOLD_START, BLOCK_HOLD_END)
  const colors = deriveTrailColors(base, BLOCK_TRAIL_LENGTH)
  const inactive = deriveInactiveColor(base, BLOCK_INACTIVE_FACTOR)
  let fade = 1

  if (state.holding && state.holdTotal > 0) {
    const progress = Math.min(state.holdProgress / state.holdTotal, 1)

    fade = Math.max(BLOCK_MIN_ALPHA, 1 - progress * (1 - BLOCK_MIN_ALPHA))
  } else if (!state.holding && state.movementTotal > 0) {
    const progress = Math.min(state.movementProgress / Math.max(1, state.movementTotal - 1), 1)

    fade = BLOCK_MIN_ALPHA + progress * (1 - BLOCK_MIN_ALPHA)
  }

  const faded = RGBA.clone(inactive)

  faded.a = inactive.a * fade

  return Array.from({ length: BLOCK_WIDTH }, (_, charIndex) => {
    const index = colorIndex(state, charIndex, BLOCK_TRAIL_LENGTH)
    const active = index >= 0 && index < colors.length

    return { char: active ? "■" : "⬝", color: active ? (colors[index] ?? faded) : faded }
  })
}

export function blockScannerFrames(
  width = BLOCK_WIDTH,
  trailLength = BLOCK_TRAIL_LENGTH,
  holdStart = BLOCK_HOLD_START,
  holdEnd = BLOCK_HOLD_END,
): string[] {
  const totalFrames = width + holdEnd + (width - 1) + holdStart

  return Array.from({ length: totalFrames }, (_, frameIndex) => {
    const state = scannerState(frameIndex, width, holdStart, holdEnd)

    return Array.from({ length: width }, (_, charIndex) => {
      const index = colorIndex(state, charIndex, trailLength)

      return index >= 0 && index < trailLength ? "■" : "⬝"
    }).join("")
  })
}

export const BLOCK_FRAMES = blockScannerFrames()

// The three faces the appearance catalog offers. `text` is the static
// `Running` label: it is shown only while the session runs, and it never
// animates, so it keeps the row timer-free.

export type SpinnerVisual = "braille" | "blocks" | "text"

export const SPINNER_TEXT_LABEL = "Running"

/** Terminal cells a spinner face occupies; the layout engine reserves this. */
export function spinnerCellWidth(visual: SpinnerVisual): number {
  if (visual === "blocks") return BLOCK_WIDTH

  // Pure ASCII, so the string length is the cell count; the render tests pin
  // this against the renderer's own measurement.
  if (visual === "text") return SPINNER_TEXT_LABEL.length

  return 1
}

/** Frames one full cycle of a face takes; the static face has exactly one. */
export function spinnerFrameCount(visual: SpinnerVisual): number {
  if (visual === "blocks") return BLOCK_FRAMES.length

  if (visual === "text") return 1

  return BRAILLE_FRAMES.length
}

/**
 * The static text a fitted spinner item carries: the first frame of its
 * face, at exactly the face's cell width. `format.ts` builds the spinner's
 * formatted widget from this so the fit reserves the width the live
 * substitution occupies.
 */
export function spinnerRepresentativeText(visual: SpinnerVisual): string {
  if (visual === "blocks") return BLOCK_FRAMES[0] ?? ""

  if (visual === "text") return SPINNER_TEXT_LABEL

  return BRAILLE_FRAMES[0] ?? ""
}

/**
 * The spinner's animation lifecycle: a frame counter that advances on the
 * host-matched cadence while an animated face is on screen. A hidden spinner
 * (`undefined`) or the static text face keeps the hook timer-free, so idle
 * rows and static previews never schedule anything. The timer is dropped the
 * moment the face changes or disappears, and unmounting cleans it up.
 *
 * Like every Solid hook this needs a component owner; `StatusRow` calls it for
 * the row's spinner item, and any preview rendering the same row gets the
 * same visuals for free.
 */
export function useSpinnerFrame(visual: () => SpinnerVisual | undefined): () => number {
  const [frameIndex, setFrameIndex] = createSignal(0)

  createEffect(() => {
    const current = visual()

    if (current === undefined || current === "text") return
    const count = spinnerFrameCount(current)
    const spinnerTimer = setInterval(() => setFrameIndex((value) => (value + 1) % count), SPINNER_INTERVAL_MS)

    spinnerTimer.unref?.()
    onCleanup(() => clearInterval(spinnerTimer))
  })

  return frameIndex
}

export interface SpinnerGlyphProps {
  readonly visual: SpinnerVisual
  readonly frameIndex: number
  readonly base: RGBA
}

function spinnerLabel(props: SpinnerGlyphProps): string {
  if (props.visual === "text") return SPINNER_TEXT_LABEL

  return BRAILLE_FRAMES[props.frameIndex % BRAILLE_FRAMES.length] ?? ""
}

/** One spinner frame: colored block cells, a braille glyph, or static text. */
export function SpinnerGlyph(props: SpinnerGlyphProps) {
  const cells = createMemo(() =>
    props.visual === "blocks" ? blockCells(props.frameIndex % BLOCK_FRAMES.length, props.base) : null,
  )

  return (
    <box flexDirection="row" flexShrink={0}>
      <Show when={cells()} fallback={<text fg={props.base}>{spinnerLabel(props)}</text>}>
        {(resolved: () => SpinnerCell[]) => (
          <>
            {resolved().map((cell: SpinnerCell) => (
              <text fg={cell.color}>{cell.char}</text>
            ))}
          </>
        )}
      </Show>
    </box>
  )
}

// The two fixed bar sizes from the appearance catalog: ten continuous cells
// and five slanted cells, both bracketed. Fill is rounded to the nearest cell
// and clamped to the bar bounds; the percentage text beside the bar is the
// formatter's job and keeps the actual computed value, even above 100%.

export type ContextBarStyle = "solid" | "slanted"

export const CONTEXT_BAR_SOLID_CELLS = 10

export const CONTEXT_BAR_SLANTED_CELLS = 5

const SOLID_FILL = "█" // U+2588 full block

const SOLID_EMPTY = "░" // U+2591 light shade

const SLANTED_FILL = "▰" // U+25B0 black parallelogram

const SLANTED_EMPTY = "▱" // U+25B1 white parallelogram

export function contextBarCellCount(style: ContextBarStyle): number {
  return style === "solid" ? CONTEXT_BAR_SOLID_CELLS : CONTEXT_BAR_SLANTED_CELLS
}

/** Rounded to the nearest cell, clamped to the bar bounds; NaN reads empty. */
export function contextBarFill(ratio: number, style: ContextBarStyle): number {
  const cells = contextBarCellCount(style)

  if (!Number.isFinite(ratio)) return 0

  return Math.max(0, Math.min(cells, Math.round(ratio * cells)))
}

/** The cell run alone, without brackets: `█████░░░░░`. */
export function contextBarCells(fill: number, style: ContextBarStyle): string {
  const cells = contextBarCellCount(style)
  const safe = Math.max(0, Math.min(cells, Math.round(fill)))
  const [filled, empty] = style === "solid" ? [SOLID_FILL, SOLID_EMPTY] : [SLANTED_FILL, SLANTED_EMPTY]

  return filled.repeat(safe) + empty.repeat(cells - safe)
}

/** The bracketed bar the row renders as one text segment: `[█████░░░░░]`. */
export function contextBarText(fill: number, style: ContextBarStyle): string {
  return `[${contextBarCells(fill, style)}]`
}
