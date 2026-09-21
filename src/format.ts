// opencode2-enhanced-composer — the prompt-status formatting layer.
//
// One pure function family between the status snapshot and the layout engine:
// `formatWidgets` turns a `StatusSnapshot` plus the curated `StatusAppearance`
// into the formatted widgets `fitRow` consumes — every widget already resolved
// to its selected representation, carrying the exact cell widths of the shared
// `MeasureTextWidth` measure, and the directory carrying its path candidates
// so fitting can shorten it without re-formatting. Availability is explicit
// and decided here: an absent widget in the returned set is missing data — no
// branch, no session, no rate — never a fabricated zero, while a known `$0.00`
// cost stays displayable.
//
// Numeric semantics preserve compact token numbers, one-decimal cache share,
// USD money, and integer context percentage. Formatting is host-independent.
//
// The spinner's representative text and the context-bar cells are plain
// strings duplicated from `widgets.tsx` (which owns the live visuals) so that
// formatting stays free of TUI imports; the parity tests in `format.test.ts`
// pin the two copies together. Colon joining and the final inter-widget
// separators are deliberately absent — they depend on which widgets survive
// fitting, which only `layout.ts` knows; the caller passes `colonJoin` to
// `fitRow` from the branch appearance.

import type { FormattedWidget } from "./layout.js"
import type {
  BackgroundAgentStyle,
  BranchStyle,
  CacheLabel,
  ContextAppearance,
  ContextBarStyle,
  ContextOrder,
  ContextStatus,
  CostStyle,
  DirectoryIcon,
  LocationStatus,
  MeasureTextWidth,
  PathCandidate,
  SpinnerAppearance,
  StatusAppearance,
  StatusSnapshot,
  TokenLabels,
  WidgetID,
  WorktreeMarker,
} from "./options.js"

// All codepoints are in the Basic Multilingual Plane so they render with the
// common Nerd Font ranges the default TUI already relies on.

export const GLYPH_FOLDER_OPEN_O = "\u{f115}" // nf-fa-folder_open_o: the default folder decoration

export const GLYPH_FOLDER_CLOSED = "\u{f07b}" // nf-fa-folder

export const GLYPH_FOLDER_OPEN = "\u{f07c}" // nf-fa-folder_open

export const GLYPH_BRANCH = "\u{f418}" // nf-oct-git_branch: the default branch decoration

export const GLYPH_BRANCH_DEVICON = "\u{e0a0}" // nf-pl-branch

export const GLYPH_WORKTREE = "\u{e5fb}" // nf-custom-folder_git_branch: the default worktree marker

export const GLYPH_WORKTREE_ALT = "\u{ec7d}" // nf-cod-worktree_small

export const GLYPH_DATABASE = "\u{f49b}" // nf-oct-cache: the curated cache glyph

export const GLYPH_IN = "\u2191"

export const GLYPH_OUT = "\u2193"

export const GLYPH_ROBOT = "\u{ec20}" // nf-cod-robot: the subagent glyph

const FOLDER_GLYPHS: Readonly<Record<Exclude<Extract<DirectoryIcon, string>, "none">, string>> = {
  f115: GLYPH_FOLDER_OPEN_O,
  f07b: GLYPH_FOLDER_CLOSED,
  f07c: GLYPH_FOLDER_OPEN,
}

const BRANCH_GLYPHS: Readonly<Record<Exclude<Extract<BranchStyle, string>, "colon">, string>> = {
  e0a0: GLYPH_BRANCH_DEVICON,
  f418: GLYPH_BRANCH,
}

const WORKTREE_GLYPHS: Readonly<Record<Exclude<Extract<WorktreeMarker, string>, "none">, string>> = {
  e5fb: GLYPH_WORKTREE,
  ec7d: GLYPH_WORKTREE_ALT,
}

export function folderGlyph(icon: DirectoryIcon): string | undefined {
  if (icon instanceof Object) return icon.text || undefined

  return icon === "none" ? undefined : FOLDER_GLYPHS[icon]
}

export function branchGlyph(style: BranchStyle): string | undefined {
  if (style instanceof Object) return style.text || undefined

  return style === "colon" ? undefined : BRANCH_GLYPHS[style]
}

export function worktreeGlyph(marker: WorktreeMarker): string | undefined {
  if (marker instanceof Object) return marker.text || undefined

  return marker === "none" ? undefined : WORKTREE_GLYPHS[marker]
}

export function formatTokens(value: number): string {
  if (value < 1_000) return `${value}`
  const thousands = value / 1_000

  // Math.round promotes 999.5k to "1000k"; cross into millions first.
  if (thousands < 999.5) {
    return thousands >= 100 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1).replace(/\.0$/, "")}k`
  }

  const millions = value / 1_000_000

  return millions >= 100 ? `${Math.round(millions)}M` : `${millions.toFixed(1).replace(/\.0$/, "")}M`
}

/**
 * Cache-read share of the whole input side; see the README semantics table.
 * One decimal, because a whole percent is tens of thousands of tokens: reads
 * sitting at 99.2% and 98.8% must not collapse into the same `99%`.
 */
export function cacheShare(input: number, cacheRead: number): number {
  return input > 0 ? Math.round((cacheRead / input) * 1_000) / 10 : 0
}

/** One decimal with a trailing `.0` trimmed, matching `formatTokens`' shape. */
export function formatPercent(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "")
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function formatMoney(value: number): string {
  return money.format(value)
}

// The layout engine's fitting contract wants text on every widget, spinner
// included: the representative text occupies exactly the cells the live
// visual substitutes for it, so the reserved width can never disagree with
// what renders. `widgets.tsx` owns the frames; these are the same first
// frames as plain strings.

/** The static spinner label; the spinner is shown only while running. */
export const SPINNER_TEXT = "Running"

const SPINNER_BRAILLE_REPRESENTATIVE = "⠋"

const SPINNER_BLOCKS_REPRESENTATIVE = "■⬝⬝⬝⬝⬝⬝⬝"

/** The representative text of a spinner face: exactly the cells the live visual occupies. */
export function spinnerRepresentativeText(style: SpinnerAppearance): string {
  if (style === "blocks") return SPINNER_BLOCKS_REPRESENTATIVE

  return style === "text" ? SPINNER_TEXT : SPINNER_BRAILLE_REPRESENTATIVE
}

// The curated value forms. Separator and colon joining live in the layout
// layer; these are the per-widget strings it joins.

function prefixText(prefix: string, value: string): string {
  return prefix === "" ? value : `${prefix} ${value}`
}

export function formatInputTokens(value: number, labels: TokenLabels): string {
  if (labels instanceof Object) return prefixText(labels.input, formatTokens(value))

  return labels === "arrows" ? `${GLYPH_IN}${formatTokens(value)}` : `in ${formatTokens(value)}`
}

export function formatOutputTokens(value: number, labels: TokenLabels): string {
  if (labels instanceof Object) return prefixText(labels.output, formatTokens(value))

  return labels === "arrows" ? `${GLYPH_OUT}${formatTokens(value)}` : `out ${formatTokens(value)}`
}

/** The cache percentage; the `none` label drops the label, not the widget. */
export function formatCachePercentage(share: number, label: CacheLabel): string {
  const percent = `${formatPercent(share)}%`

  if (label instanceof Object) return prefixText(label.text, percent)

  if (label === "none") return percent

  return label === "f49b" ? `${GLYPH_DATABASE} ${percent}` : `cache ${percent}`
}

export function formatCost(value: number, style: CostStyle): string {
  if (style instanceof Object) return prefixText(style.text, formatMoney(value))

  return style === "labeled" ? `cost ${formatMoney(value)}` : formatMoney(value)
}

export function formatBackgroundAgent(style: BackgroundAgentStyle, count: number): string {
  const label = count === 1 ? "1 agent" : `${count} agents`

  if (style instanceof Object) return prefixText(style.text, label)

  if (style === "ec20") return `${GLYPH_ROBOT} ${label}`

  return style === "text" ? label : `${GLYPH_OUT}${label}`
}

/** The branch text: a glyph form, or the bare name for the colon style. */
export function formatBranchName(branch: string, style: BranchStyle): string {
  const glyph = branchGlyph(style)

  return glyph === undefined ? branch : `${glyph} ${branch}`
}

// Text (`format`), bar (`bar`), and label (`label`) are independent pieces
// joined in `order` with single spaces: either text or bar can be `off`, the
// label can be `none`, and absent pieces are skipped keeping relative order.
// Text formats needing a limit fall back to the bare token count when it is
// unknown; the bar needs the limit for its fill and is omitted then. When
// nothing remains to show the widget hides with an empty string, distinct
// from overflow behavior: overflow never changes a selected representation.

const CONTEXT_BAR_SOLID_CELLS = 10

const CONTEXT_BAR_SLANTED_CELLS = 5

const CONTEXT_BAR_SOLID_FILL = "█"

const CONTEXT_BAR_SOLID_EMPTY = "░"

const CONTEXT_BAR_SLANTED_FILL = "▰"

const CONTEXT_BAR_SLANTED_EMPTY = "▱"

/**
 * The bracketed bar at its fixed size: fill rounded to the nearest cell and
 * clamped to the bar bounds, ten continuous cells or five slanted ones. The
 * token count shown beside it is the caller's, so an overflowing context
 * reads as a full bar next to a true number — the bar itself depicts the
 * share, which is why no separate percentage is shown.
 */
export function contextBar(ratio: number, style: ContextBarStyle): string {
  const solid = style === "solid"
  const cells = solid ? CONTEXT_BAR_SOLID_CELLS : CONTEXT_BAR_SLANTED_CELLS
  const rounded = Number.isFinite(ratio) ? Math.round(ratio * cells) : 0
  const fill = Math.max(0, Math.min(cells, rounded))
  const filled = solid ? CONTEXT_BAR_SOLID_FILL : CONTEXT_BAR_SLANTED_FILL
  const empty = solid ? CONTEXT_BAR_SOLID_EMPTY : CONTEXT_BAR_SLANTED_EMPTY

  return `[${filled.repeat(fill)}${empty.repeat(cells - fill)}]`
}

/** The limit when it can anchor a ratio; an absent or zero limit is unknown. */
function usableLimit(usage: ContextStatus): number | undefined {
  return usage.limit !== undefined && usage.limit > 0 ? usage.limit : undefined
}

/**
 * The context percentage: the snapshot's own value when it carries one,
 * otherwise the existing integer rounding of tokens over a usable limit.
 */
function contextPercent(usage: ContextStatus, limit: number | undefined): number | undefined {
  if (usage.percent !== undefined) return usage.percent

  return limit === undefined ? undefined : Math.round((usage.tokens / limit) * 100)
}

/** The slots one context order arranges, in display order. */
const CONTEXT_ORDER_SLOTS: Readonly<Record<ContextOrder, readonly ("bar" | "text" | "label")[]>> = {
  "bar-text-label": ["bar", "text", "label"],
  "bar-label-text": ["bar", "label", "text"],
  "text-bar-label": ["text", "bar", "label"],
  "text-label-bar": ["text", "label", "bar"],
  "label-bar-text": ["label", "bar", "text"],
  "label-text-bar": ["label", "text", "bar"],
}

/** The context widget's text for the selected format, bar style, label, and order. Present pieces join with single spaces in the listed order; a missing piece is skipped, and nothing showable hides the widget with an empty string. */
export function formatContext(usage: ContextStatus, appearance: ContextAppearance): string {
  const tokens = formatTokens(usage.tokens)
  const limit = usableLimit(usage)
  const percent = contextPercent(usage, limit)

  let text: string | undefined

  if (appearance.format === "off") {
    text = undefined
  } else if (appearance.format === "tokens") {
    text = tokens
  } else if (appearance.format === "tokens-percent") {
    text = percent === undefined ? tokens : `${tokens} (${percent}%)`
  } else if (appearance.format === "percent") {
    text = percent === undefined ? tokens : `${percent}%`
  } else {
    text = limit === undefined ? tokens : `${tokens}/${formatTokens(limit)}`
  }

  let bar: string | undefined

  if (appearance.bar === "off" || limit === undefined) {
    bar = undefined
  } else {
    bar = contextBar(usage.tokens / limit, appearance.bar)
  }

  const pieces: Readonly<Record<"bar" | "text" | "label", string | undefined>> = {
    bar,
    text,
    label: appearance.label === "none" ? undefined : appearance.label,
  }

  const parts: string[] = []

  for (const slot of CONTEXT_ORDER_SLOTS[appearance.order]) {
    const piece = pieces[slot]

    if (piece !== undefined) parts.push(piece)
  }

  return parts.join(" ")
}

// Name mode shows the whole final name. Path mode shortens by eliding whole
// leading intermediate segments behind `...`, keeping the root/home marker and
// the complete final directory name; the final name is never cut, and no
// candidate suggests segments that were not actually omitted.

function withoutTrailingSeparators(path: string): string {
  const normalized = /^(?:[A-Za-z]:|\\\\)/u.test(path) ? path.replace(/\\/gu, "/") : path

  return normalized.replace(/\/+$/u, "")
}

/** Last path segment, or `~` for the home directory. */
export function directoryName(directory: string, home?: string): string {
  const normalized = withoutTrailingSeparators(directory)
  const normalizedHome = home === undefined ? undefined : withoutTrailingSeparators(home)

  if (normalizedHome !== undefined && normalized === normalizedHome) return "~"
  const name = pathSegments(normalized).at(-1)

  return name || directory
}

/** Split a normalized path into the segments between `/` separators. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "")
}

interface PathParts {
  /** `~` inside home, `/` for POSIX roots, or a Windows drive/UNC share root. */
  readonly prefix: string | undefined
  /** Segments after the prefix; empty for home itself and the filesystem root. */
  readonly segments: string[]
  /** The separator-stripped input, kept for paths that get no elidable head. */
  readonly normalized: string
}

function decomposePath(directory: string, home: string): PathParts {
  const normalized = withoutTrailingSeparators(directory)

  // A home that strips to nothing (the filesystem root itself) cannot anchor a `~` prefix.
  const normalizedHome = withoutTrailingSeparators(home)

  if (normalizedHome !== "" && (normalized === normalizedHome || normalized.startsWith(`${normalizedHome}/`))) {
    return {
      prefix: "~",
      segments: normalized === normalizedHome ? [] : pathSegments(normalized.slice(normalizedHome.length)),
      normalized,
    }
  }

  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(normalized)

  if (unc !== null) {
    const [, server, share] = unc
    const prefix = `//${server}/${share}`

    return { prefix, segments: pathSegments(normalized.slice(prefix.length)), normalized }
  }

  const drive = /^([A-Za-z]:)(?:\/|$)/u.exec(normalized)?.[1]

  if (drive !== undefined) {
    return { prefix: drive, segments: pathSegments(normalized.slice(drive.length)), normalized }
  }

  // An empty path is the filesystem root, same as `/` itself.
  if (normalized === "" || normalized.startsWith("/")) {
    return { prefix: "/", segments: pathSegments(normalized), normalized }
  }

  return { prefix: undefined, segments: pathSegments(normalized), normalized }
}

/**
 * The elision chain for path mode, richest first: the full path, then forms
 * that drop whole leading intermediate segments behind `...` while keeping as
 * many complete trailing segments as exist. Home itself, the filesystem root,
 * and paths without an elidable head yield exactly one path.
 */
function elidablePaths(parts: PathParts): string[] {
  if (parts.prefix === undefined) return [parts.normalized]

  if (parts.segments.length === 0) return [parts.prefix]

  // The root prefix already carries its separator; the tilde does not.
  const head = parts.prefix === "/" ? "" : parts.prefix
  const paths: string[] = []
  const fullest = parts.segments.length - 1

  for (let kept = fullest; kept >= 0; kept -= 1) {
    const trailing = parts.segments.slice(-(kept + 1))
    const elided = kept < fullest

    paths.push(elided ? `${head}/.../${trailing.join("/")}` : `${head}/${trailing.join("/")}`)
  }

  return paths
}

/**
 * The decoration glyph for the directory widget: in a worktree a selected
 * worktree marker replaces the ordinary folder decoration, the `none` marker
 * falls back to the ordinary appearance, and an absent ordinary icon never
 * suppresses a selected marker.
 */
function directoryDecoration(location: LocationStatus, appearance: StatusAppearance): string | undefined {
  if (location.worktree) {
    const marker = worktreeGlyph(appearance.worktree)

    if (marker !== undefined) return marker
  }

  return folderGlyph(appearance.directory.icon)
}

/**
 * The directory widget's path candidates, ordered full → minimum: name mode
 * yields exactly one candidate — the whole name; path mode yields the elision
 * chain. Every candidate carries the same decoration, and a candidate that is
 * not strictly narrower than the one before it is excluded: it cannot help
 * the fit, and a widened form would mislead the expansion pass.
 */
export function directoryCandidates(
  location: LocationStatus,
  appearance: StatusAppearance,
  measure: MeasureTextWidth,
): readonly PathCandidate[] {
  const decoration = directoryDecoration(location, appearance)

  const paths =
    appearance.directory.format === "name"
      ? [directoryName(location.directory, location.home)]
      : elidablePaths(decomposePath(location.directory, location.home))

  const candidates: PathCandidate[] = []
  let previousWidth = Number.POSITIVE_INFINITY

  for (const path of paths) {
    const text = decoration === undefined ? path : `${decoration} ${path}`
    const width = measure(text)

    if (width >= previousWidth) continue

    candidates.push({ text, width })
    previousWidth = width
  }

  return candidates
}

/**
 * The available widgets keyed by ID: an absent key is unavailable data — a
 * missing branch, an unknown context, no session, no rate — which the caller
 * skips when assembling a row. Availability is decided here, before fitting;
 * overflow hiding is the layout engine's separate decision.
 */
export type FormattedStatusWidgets = { readonly [ID in WidgetID]?: FormattedWidget & { readonly id: ID } }

/** The mutable shape `formatWidgets` accumulates before returning it as read-only. */
type WidgetAccumulator = { [ID in WidgetID]?: FormattedWidget & { readonly id: ID } }

/** The directory widget: its full representation plus the candidate chain the layout engine shortens along. */
function directoryWidget(
  location: LocationStatus | undefined,
  appearance: StatusAppearance,
  measure: MeasureTextWidth,
): (FormattedWidget & { readonly id: "directory" }) | undefined {
  if (location === undefined) return undefined

  const candidates = directoryCandidates(location, appearance, measure)
  const fullest = candidates[0]

  // Unreachable while every mode yields at least the full representation; the
  // guard keeps the invariant explicit rather than asserted.
  if (fullest === undefined) return undefined

  return { id: "directory", text: fullest.text, width: fullest.width, pathCandidates: candidates }
}

/**
 * Format every widget from one status snapshot.
 *
 * The spinner appears only while running; the subagent marker only while
 * subagents run; the metrics only with a session; the context only once usage exists;
 * the rate only while the tracker has a value. Everything else is available
 * whenever its data is, and every width comes from the injected measure so
 * the fitting pass and the renderer agree.
 */
export function formatWidgets(
  snapshot: StatusSnapshot,
  appearance: StatusAppearance,
  measure: MeasureTextWidth,
): FormattedStatusWidgets {
  const widgets: WidgetAccumulator = {}

  if (snapshot.running) {
    const text = spinnerRepresentativeText(appearance.spinner)

    widgets.spinner = { id: "spinner", text, width: measure(text) }
  }

  const directory = directoryWidget(snapshot.location, appearance, measure)

  if (directory !== undefined) widgets.directory = directory

  const branch = snapshot.location?.branch

  // An empty branch is as missing as an absent one, matching the footer's truthiness.
  if (branch) {
    const text = formatBranchName(branch, appearance.branch)

    widgets.branch = { id: "branch", text, width: measure(text) }
  }

  const metrics = snapshot.metrics

  if (metrics !== undefined) {
    const input = formatInputTokens(metrics.input, appearance.tokens)
    const output = formatOutputTokens(metrics.output, appearance.tokens)
    const cache = formatCachePercentage(metrics.cacheShare, appearance.cache)
    const cost = formatCost(metrics.cost, appearance.cost)

    widgets.input = { id: "input", text: input, width: measure(input) }
    widgets.output = { id: "output", text: output, width: measure(output) }
    widgets.cache = { id: "cache", text: cache, width: measure(cache) }
    widgets.cost = { id: "cost", text: cost, width: measure(cost) }
  }

  const context = metrics?.context

  if (context !== undefined) {
    const text = formatContext(context, appearance.context)

    // Both text and bar off — or a bar-only selection without a known limit —
    // leaves nothing to show; the widget hides like missing data.
    if (text !== "") widgets.context = { id: "context", text, width: measure(text) }
  }

  const tps = snapshot.tps

  if (tps !== undefined) widgets.tps = { id: "tps", text: tps.label, width: measure(tps.label) }

  // The subagent marker shows only while subagents run; a zero count hides
  // the widget like missing data, never as a rendered zero.
  if (snapshot.background.agents > 0) {
    const text = formatBackgroundAgent(appearance.bgagent, snapshot.background.agents)

    widgets.bgagent = { id: "bgagent", text, width: measure(text) }
  }

  return widgets
}
