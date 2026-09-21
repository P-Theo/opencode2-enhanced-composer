// opencode2-enhanced-composer — the prompt-status configuration contract.
//
// One validated configuration shared by production rendering, the settings
// editor and its preview, persistence, and documentation: the widget and zone
// registries, the curated appearance catalog, the overflow priority presets,
// tolerant parsing of host-supplied JSON, strict validation for saves,
// editor draft semantics, and the host-independent status,
// formatting, layout, and persistence interfaces the other modules build on.
//
// The module is plain TypeScript with no runtime TUI imports, so every other
// module can depend on it without a Solid transform and tests exercise it
// directly. Its Stage 2 formatting and fitting contracts are type-only
// re-exports from `layout.ts`, the module that implements and consumes them;
// see the contract sections below for why that edge cannot be a runtime
// import. `options.schema.json` documents the same enumerations and defaults
// for agents editing `cli.json` by hand; the tests keep the two in agreement.

import type { FormattedWidget } from "./layout.js"

/** Every movable prompt-status widget, in catalog order. */
export const WIDGET_IDS = [
  "spinner",
  "directory",
  "branch",
  "input",
  "output",
  "cache",
  "cost",
  "context",
  "tps",
  "bgagent",
] as const

export type WidgetID = (typeof WIDGET_IDS)[number]

/** The four placement zones, in the order duplicate resolution visits them. */
export const ZONE_IDS = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const

export type ZoneID = (typeof ZONE_IDS)[number]

/**
 * Widgets joined by the selected metric separator when consecutive; every
 * other widget, and every mixed boundary, keeps a single space.
 */
export const METRIC_WIDGET_IDS = ["input", "output", "cache", "cost", "context", "tps"] as const

export type MetricWidgetID = (typeof METRIC_WIDGET_IDS)[number]

/** Ordered widget lists per zone; array order is display order. */
export interface StatusLayout {
  readonly topLeft: readonly WidgetID[]
  readonly topRight: readonly WidgetID[]
  readonly bottomLeft: readonly WidgetID[]
  readonly bottomRight: readonly WidgetID[]
}

/**
 * The default arrangement: spinner top-left, TPS top-right, directory and
 * branch bottom-left, and the five metrics bottom-right. Background activity
 * follows the spinner above the prompt, where it survives narrowing. A
 * missing `layout` resolves to this arrangement.
 */
export const DEFAULT_LAYOUT: StatusLayout = {
  topLeft: ["spinner", "bgagent"],
  topRight: ["tps"],
  bottomLeft: ["directory", "branch"],
  bottomRight: ["input", "output", "cache", "cost", "context"],
}

export const SPINNER_APPEARANCES = ["braille", "blocks", "text"] as const

export type SpinnerAppearance = (typeof SPINNER_APPEARANCES)[number]

export const DIRECTORY_FORMATS = ["name", "path"] as const

export type DirectoryFormat = (typeof DIRECTORY_FORMATS)[number]

export const DIRECTORY_ICONS = ["f115", "f07b", "f07c", "none"] as const

export type CustomText = { readonly text: string }

export type CustomTokenLabels = { readonly input: string; readonly output: string }

export type DirectoryIcon = (typeof DIRECTORY_ICONS)[number] | CustomText

export const BRANCH_STYLES = ["e0a0", "f418", "colon"] as const

export type BranchStyle = (typeof BRANCH_STYLES)[number] | CustomText

export const WORKTREE_MARKERS = ["e5fb", "ec7d", "none"] as const

export type WorktreeMarker = (typeof WORKTREE_MARKERS)[number] | CustomText

export const TOKEN_LABELS = ["words", "arrows"] as const

export type TokenLabels = (typeof TOKEN_LABELS)[number] | CustomTokenLabels

export const CACHE_LABELS = ["text", "f49b", "none"] as const

export type CacheLabel = (typeof CACHE_LABELS)[number] | CustomText

export const COST_STYLES = ["currency", "labeled"] as const

export type CostStyle = (typeof COST_STYLES)[number] | CustomText

export const BGAGENT_STYLES = ["arrow", "ec20", "text"] as const

export type BackgroundAgentStyle = (typeof BGAGENT_STYLES)[number] | CustomText

export const CONTEXT_FORMATS = ["tokens", "tokens-percent", "percent", "tokens-limit", "off"] as const

export type ContextFormat = (typeof CONTEXT_FORMATS)[number]

export const CONTEXT_BARS = ["solid", "slanted", "off"] as const

export type ContextBarStyle = (typeof CONTEXT_BARS)[number]

export const CONTEXT_LABELS = ["none", "ctx", "context"] as const

export type ContextLabel = (typeof CONTEXT_LABELS)[number]

export const CONTEXT_ORDERS = [
  "bar-text-label",
  "bar-label-text",
  "text-bar-label",
  "text-label-bar",
  "label-bar-text",
  "label-text-bar",
] as const

export type ContextOrder = (typeof CONTEXT_ORDERS)[number]

export const METRIC_SEPARATORS = ["dot", "pipe", "space"] as const

export type MetricSeparator = (typeof METRIC_SEPARATORS)[number] | CustomText

export interface DirectoryAppearance {
  readonly format: DirectoryFormat
  readonly icon: DirectoryIcon
}

export interface ContextAppearance {
  readonly format: ContextFormat
  readonly bar: ContextBarStyle
  readonly label: ContextLabel
  readonly order: ContextOrder
}

export interface StatusAppearance {
  readonly spinner: SpinnerAppearance
  readonly directory: DirectoryAppearance
  readonly branch: BranchStyle
  readonly worktree: WorktreeMarker
  readonly tokens: TokenLabels
  readonly cache: CacheLabel
  readonly cost: CostStyle
  readonly bgagent: BackgroundAgentStyle
  readonly context: ContextAppearance
  readonly separator: MetricSeparator
}

export const DEFAULT_APPEARANCE = {
  spinner: "blocks",
  directory: { format: "name", icon: "f115" },
  branch: "f418",
  worktree: "e5fb",
  tokens: "words",
  cache: "text",
  cost: "currency",
  bgagent: "ec20",
  context: { format: "tokens", bar: "slanted", label: "context", order: "bar-text-label" },
  separator: "pipe",
} satisfies StatusAppearance

export const OVERFLOW_PRESET_IDS = ["balanced", "usage-first", "location-first"] as const

export type OverflowPresetID = (typeof OVERFLOW_PRESET_IDS)[number]

/** A built-in preset, or `custom` for an explicit hide-first list. */
export type OverflowPreset = OverflowPresetID | "custom"

/**
 * The built-in hide-first → hide-last lists. Every list contains every widget
 * exactly once, including widgets hidden from the layout; editing one in the
 * editor switches the configuration to `custom`.
 */
export const OVERFLOW_PRESETS: Readonly<Record<OverflowPresetID, readonly WidgetID[]>> = {
  balanced: ["cost", "branch", "cache", "output", "input", "tps", "directory", "context", "spinner", "bgagent"],
  "usage-first": ["branch", "directory", "cost", "cache", "tps", "output", "input", "context", "spinner", "bgagent"],
  "location-first": ["cost", "cache", "tps", "output", "input", "context", "branch", "directory", "spinner", "bgagent"],
}

export interface StatusOverflow {
  readonly preset: OverflowPreset
  /** The effective hide-first list; the preset's own list unless the preset is `custom`. */
  readonly hideFirst: readonly WidgetID[]
}

export const DEFAULT_OVERFLOW: StatusOverflow = {
  preset: "balanced",
  hideFirst: OVERFLOW_PRESETS.balanced,
}

/**
 * The validated configuration every consumer shares: production rendering,
 * the settings editor, its preview, and the persistence merge. Raw values,
 * display strings, and availability are kept apart end-to-end.
 */
export interface NormalizedStatusOptions {
  readonly layout: StatusLayout
  readonly appearance: StatusAppearance
  readonly overflow: StatusOverflow
}

/** The documented defaults; also the editor's Reset target. */
export const DEFAULT_STATUS_OPTIONS: NormalizedStatusOptions = {
  layout: DEFAULT_LAYOUT,
  appearance: DEFAULT_APPEARANCE,
  overflow: DEFAULT_OVERFLOW,
}

// `ctx.options` is host-supplied JSON, so this is a real parsing boundary:
// every value is validated, anything invalid falls back to a default rather
// than propagating into rendering, and every repair or ignored suspicious
// key is reported. Absent fields are normal and produce no diagnostics.

/** A value as it can arrive from `cli.json`: arbitrary JSON, nothing more. */
export type OptionValue =
  | string
  | number
  | boolean
  | null
  | readonly OptionValue[]
  | { readonly [key: string]: OptionValue }

/** The status option surface as it can appear in `cli.json`, before validation. */
export interface StatusOptionsInput {
  readonly layout?: OptionValue
  readonly appearance?: OptionValue
  readonly overflow?: OptionValue
  /** Other keys — tuning options, future releases — pass through untouched. */
  readonly [key: string]: OptionValue | undefined
}

/** One repair or ignored suspicious key: where, what is wrong, what happened. */
export interface StatusOptionIssue {
  /** The offending field path, e.g. `layout.topLeft[2]` or `appearance.spinner`. */
  readonly path: string
  /** What was wrong and which default or normalization replaced it. */
  readonly message: string
}

export interface StatusResolution {
  readonly options: NormalizedStatusOptions
  /** Every repair made while parsing; empty when the input needed none. */
  readonly diagnostics: readonly StatusOptionIssue[]
}

/** Fields of a JSON object option; undefined for anything that is not one. */
type OptionFields = { readonly [key: string]: OptionValue | undefined }

function jsonObjectFields(value: OptionValue | undefined): OptionFields | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined

  // SAFETY: after the absent, null, and array guards, `instanceof Object`
  // selects the plain-object member of the OptionValue union — the JSON
  // boundary never yields another object kind — so the re-frame is exact.
  return value instanceof Object ? (value as OptionFields) : undefined
}

/** True when the value is one of the curated choices. */
function isOneOf<T extends string>(values: readonly T[], value: OptionValue | undefined): value is T {
  return values.some((candidate) => candidate === value)
}

function isWidgetID(value: OptionValue | undefined): value is WidgetID {
  return WIDGET_IDS.some((id) => id === value)
}

/** A compact, control-free rendering of an unknown option value for diagnostics. */
function describeValue(value: OptionValue): string {
  const text = JSON.stringify(value)

  return text === undefined ? "undefined" : text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function parseEnumValue<T extends string>(
  values: readonly T[],
  value: OptionValue,
  fallback: T,
  path: string,
  diagnostics: StatusOptionIssue[],
): T {
  if (isOneOf(values, value)) return value

  diagnostics.push({ path, message: `expected one of ${values.join(", ")}; using ${fallback}` })

  return fallback
}

/** Reports keys a section does not know, so a typo cannot silently no-op. */
function reportUnknownKeys(
  section: OptionFields,
  known: readonly string[],
  path: string,
  diagnostics: StatusOptionIssue[],
): void {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) diagnostics.push({ path: `${path}.${key}`, message: "unknown setting; ignored" })
  }
}

const APPEARANCE_KEYS = ["spinner", "directory", "branch", "worktree", "tokens", "cache", "cost", "bgagent", "context", "separator"]

const DIRECTORY_KEYS = ["format", "icon"]

const CONTEXT_KEYS = ["format", "bar", "label", "order"]

const OVERFLOW_KEYS = ["preset", "hideFirst"]

function parseLayout(raw: StatusOptionsInput, diagnostics: StatusOptionIssue[]): StatusLayout {
  if (raw.layout === undefined) return DEFAULT_LAYOUT

  const section = jsonObjectFields(raw.layout)

  if (section === undefined) {
    diagnostics.push({ path: "layout", message: "expected an object of zones; using the default arrangement" })

    return DEFAULT_LAYOUT
  }

  reportUnknownKeys(section, ZONE_IDS, "layout", diagnostics)

  // First occurrence wins, in zone order topLeft → topRight → bottomLeft → bottomRight.
  const seen = new Set<WidgetID>()

  return {
    topLeft: parseZone(section, "topLeft", seen, diagnostics),
    topRight: parseZone(section, "topRight", seen, diagnostics),
    bottomLeft: parseZone(section, "bottomLeft", seen, diagnostics),
    bottomRight: parseZone(section, "bottomRight", seen, diagnostics),
  }
}

function parseZone(
  section: OptionFields,
  zone: ZoneID,
  seen: Set<WidgetID>,
  diagnostics: StatusOptionIssue[],
): WidgetID[] {
  const value = section[zone]

  if (value === undefined) return []

  if (!Array.isArray(value)) {
    diagnostics.push({ path: `layout.${zone}`, message: "expected an array of widget IDs; the zone renders empty" })

    return []
  }

  const ids: WidgetID[] = []

  for (const [index, item] of value.entries()) {
    if (!isWidgetID(item)) {
      diagnostics.push({ path: `layout.${zone}[${index}]`, message: `unknown widget ${describeValue(item)}; ignored` })

      continue
    }

    if (seen.has(item)) {
      diagnostics.push({
        path: `layout.${zone}[${index}]`,
        message: `duplicate widget ${item}; the first occurrence wins`,
      })

      continue
    }

    seen.add(item)
    ids.push(item)
  }

  return ids
}

function appearanceLeaf<T extends string>(
  section: OptionFields | undefined,
  key: string,
  values: readonly T[],
  fallback: T,
  path: string,
  diagnostics: StatusOptionIssue[],
): T {
  const value = section?.[key]

  if (value === undefined) return fallback

  return parseEnumValue(values, value, fallback, path, diagnostics)
}

export function isLiteralText(value: OptionValue | undefined): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the JSON text leaf without coercing objects or invoking their methods.
  return typeof value === "string" && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
}

function parseTextAppearance<T extends string>(
  value: OptionValue | undefined,
  presets: readonly T[],
  fallback: T | CustomText,
  path: string,
  diagnostics: StatusOptionIssue[],
): T | CustomText {
  if (value === undefined) return fallback

  if (isOneOf(presets, value)) return value

  const custom = jsonObjectFields(value)

  if (custom !== undefined) {
    reportUnknownKeys(custom, ["text"], path, diagnostics)

    if (isLiteralText(custom.text)) return { text: custom.text }
  }

  diagnostics.push({ path, message: `expected one of ${presets.join(", ")} or { text: single-line Unicode text }; using the default` })

  return fallback
}

function parseTokenLabels(value: OptionValue | undefined, diagnostics: StatusOptionIssue[]): TokenLabels {
  if (value === undefined) return DEFAULT_APPEARANCE.tokens

  if (isOneOf(TOKEN_LABELS, value)) return value

  const custom = jsonObjectFields(value)

  if (custom !== undefined) {
    reportUnknownKeys(custom, ["input", "output"], "appearance.tokens", diagnostics)

    if (isLiteralText(custom.input) && isLiteralText(custom.output)) {
      return { input: custom.input, output: custom.output }
    }
  }

  diagnostics.push({ path: "appearance.tokens", message: "expected words, arrows or { input, output } with single-line Unicode text; using the default" })

  return DEFAULT_APPEARANCE.tokens
}

function parseDirectoryAppearance(
  section: OptionFields | undefined,
  diagnostics: StatusOptionIssue[],
): DirectoryAppearance {
  const directory = jsonObjectFields(section?.directory)

  if (section?.directory !== undefined && directory === undefined) {
    diagnostics.push({ path: "appearance.directory", message: "expected an object; using defaults" })
  }

  if (directory !== undefined) reportUnknownKeys(directory, DIRECTORY_KEYS, "appearance.directory", diagnostics)

  const format = appearanceLeaf(
    directory,
    "format",
    DIRECTORY_FORMATS,
    DEFAULT_APPEARANCE.directory.format,
    "appearance.directory.format",
    diagnostics,
  )

  const icon = parseTextAppearance(
    directory?.icon,
    DIRECTORY_ICONS,
    DEFAULT_APPEARANCE.directory.icon,
    "appearance.directory.icon",
    diagnostics,
  )

  return { format, icon }
}

function parseContextAppearance(
  section: OptionFields | undefined,
  diagnostics: StatusOptionIssue[],
): ContextAppearance {
  const context = jsonObjectFields(section?.context)

  if (section?.context !== undefined && context === undefined) {
    diagnostics.push({ path: "appearance.context", message: "expected an object; using defaults" })
  }

  if (context !== undefined) reportUnknownKeys(context, CONTEXT_KEYS, "appearance.context", diagnostics)

  const format = appearanceLeaf(
    context,
    "format",
    CONTEXT_FORMATS,
    DEFAULT_APPEARANCE.context.format,
    "appearance.context.format",
    diagnostics,
  )

  const bar = appearanceLeaf(context, "bar", CONTEXT_BARS, DEFAULT_APPEARANCE.context.bar, "appearance.context.bar", diagnostics)

  return {
    format,
    bar,
    label: appearanceLeaf(
      context,
      "label",
      CONTEXT_LABELS,
      DEFAULT_APPEARANCE.context.label,
      "appearance.context.label",
      diagnostics,
    ),
    order: appearanceLeaf(
      context,
      "order",
      CONTEXT_ORDERS,
      DEFAULT_APPEARANCE.context.order,
      "appearance.context.order",
      diagnostics,
    ),
  }
}

function parseAppearance(raw: StatusOptionsInput, diagnostics: StatusOptionIssue[]): StatusAppearance {
  const section = jsonObjectFields(raw.appearance)

  if (raw.appearance !== undefined && section === undefined) {
    diagnostics.push({
      path: "appearance",
      message: "expected an object; using defaults",
    })
  }

  if (section !== undefined) reportUnknownKeys(section, APPEARANCE_KEYS, "appearance", diagnostics)

  const spinnerValue = section?.spinner

  const spinner =
    spinnerValue === undefined
      ? DEFAULT_APPEARANCE.spinner
      : parseEnumValue(
          SPINNER_APPEARANCES,
          spinnerValue,
          DEFAULT_APPEARANCE.spinner,
          "appearance.spinner",
          diagnostics,
        )

  return {
    spinner,
    directory: parseDirectoryAppearance(section, diagnostics),
    branch: parseTextAppearance(section?.branch, BRANCH_STYLES, DEFAULT_APPEARANCE.branch, "appearance.branch", diagnostics),
    worktree: parseTextAppearance(
      section?.worktree,
      WORKTREE_MARKERS,
      DEFAULT_APPEARANCE.worktree,
      "appearance.worktree",
      diagnostics,
    ),
    tokens: parseTokenLabels(section?.tokens, diagnostics),
    cache: parseTextAppearance(section?.cache, CACHE_LABELS, DEFAULT_APPEARANCE.cache, "appearance.cache", diagnostics),
    cost: parseTextAppearance(section?.cost, COST_STYLES, DEFAULT_APPEARANCE.cost, "appearance.cost", diagnostics),
    bgagent: parseTextAppearance(section?.bgagent, BGAGENT_STYLES, DEFAULT_APPEARANCE.bgagent, "appearance.bgagent", diagnostics),
    context: parseContextAppearance(section, diagnostics),
    separator: parseTextAppearance(
      section?.separator,
      METRIC_SEPARATORS,
      DEFAULT_APPEARANCE.separator,
      "appearance.separator",
      diagnostics,
    ),
  }
}

/**
 * A custom hide-first list: unknown IDs and duplicates are removed with a
 * diagnostic, and missing IDs are appended in Balanced order — the documented
 * normalization, not a repair. An absent or unusable list normalizes all the
 * way to the Balanced order.
 */
function normalizeHideFirst(value: OptionValue | undefined, diagnostics: StatusOptionIssue[]): readonly WidgetID[] {
  if (value === undefined || value === null) {
    diagnostics.push({ path: "overflow.hideFirst", message: "the custom preset requires the list; using Balanced order" })

    return OVERFLOW_PRESETS.balanced
  }

  if (!Array.isArray(value)) {
    diagnostics.push({ path: "overflow.hideFirst", message: "expected an array of widget IDs; using Balanced order" })

    return OVERFLOW_PRESETS.balanced
  }

  const ids: WidgetID[] = []

  for (const [index, item] of value.entries()) {
    if (!isWidgetID(item)) {
      diagnostics.push({ path: `overflow.hideFirst[${index}]`, message: `unknown widget ${describeValue(item)}; removed` })

      continue
    }

    if (ids.includes(item)) {
      diagnostics.push({ path: `overflow.hideFirst[${index}]`, message: `duplicate widget ${item}; removed` })

      continue
    }

    ids.push(item)
  }

  for (const id of OVERFLOW_PRESETS.balanced) {
    if (!ids.includes(id)) ids.push(id)
  }

  return ids
}

function parseOverflow(raw: StatusOptionsInput, diagnostics: StatusOptionIssue[]): StatusOverflow {
  const section = jsonObjectFields(raw.overflow)

  if (section === undefined) {
    if (raw.overflow !== undefined) {
      diagnostics.push({ path: "overflow", message: "expected an object; using the balanced preset" })
    }

    return DEFAULT_OVERFLOW
  }

  reportUnknownKeys(section, OVERFLOW_KEYS, "overflow", diagnostics)

  const preset = section.preset

  if (preset === undefined) {
    if (section.hideFirst !== undefined) {
      diagnostics.push({ path: "overflow.hideFirst", message: "ignored without overflow.preset; using the balanced preset" })
    }

    return DEFAULT_OVERFLOW
  }

  if (preset === "custom") {
    return { preset: "custom", hideFirst: normalizeHideFirst(section.hideFirst, diagnostics) }
  }

  if (isOneOf(OVERFLOW_PRESET_IDS, preset)) {
    if (section.hideFirst !== undefined) {
      diagnostics.push({ path: "overflow.hideFirst", message: `ignored for the built-in ${preset} preset` })
    }

    return { preset, hideFirst: OVERFLOW_PRESETS[preset] }
  }

  diagnostics.push({
    path: "overflow.preset",
    message: 'expected "balanced", "usage-first", "location-first" or "custom"; using "balanced"',
  })

  return DEFAULT_OVERFLOW
}

function inspectStatusOptions(raw: StatusOptionsInput): StatusResolution {
  const diagnostics: StatusOptionIssue[] = []

  return {
    options: {
      layout: parseLayout(raw, diagnostics),
      appearance: parseAppearance(raw, diagnostics),
      overflow: parseOverflow(raw, diagnostics),
    },
    diagnostics,
  }
}

/**
 * Tolerant parsing for the host-supplied JSON boundary: invalid values fall
 * back to defaults, invalid widget IDs are dropped, duplicates keep their
 * first occurrence, and every repair or ignored suspicious key is reported
 * in `diagnostics`. Absent fields are not repairs and
 * produce no diagnostics.
 */
export function resolveStatusOptions(raw: StatusOptionsInput): StatusResolution {
  return inspectStatusOptions(raw)
}

/**
 * Strict validation for the save path: reports exactly the input a tolerant
 * read would repair or ignore as suspicious, rather than silently persisting
 * it. Unknown top-level (future) options are accepted, not issues.
 */
export function validateStatusOptions(raw: StatusOptionsInput): readonly StatusOptionIssue[] {
  return inspectStatusOptions(raw).diagnostics
}

// A draft starts from the effective settings, tracks which canonical fields
// moved away from that baseline (editing a field and putting it back clears
// it again), and serializes only those fields. Unrelated options — tuning,
// unknown future keys — are never part of a patch, so
// the persistence merge cannot drop or clobber them.

/** Every canonical field, at the granularity used for change tracking and conflict detection. */
export const CANONICAL_FIELDS = [
  "layout.topLeft",
  "layout.topRight",
  "layout.bottomLeft",
  "layout.bottomRight",
  "appearance.spinner",
  "appearance.directory.format",
  "appearance.directory.icon",
  "appearance.branch",
  "appearance.worktree",
  "appearance.tokens",
  "appearance.cache",
  "appearance.cost",
  "appearance.bgagent",
  "appearance.context.format",
  "appearance.context.bar",
  "appearance.context.label",
  "appearance.context.order",
  "appearance.separator",
  "overflow.preset",
  "overflow.hideFirst",
] as const

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]

export interface StatusOptionsDraft {
  /** The effective settings the draft started from. */
  readonly baseline: NormalizedStatusOptions
  /** The edited settings the editor renders and previews. */
  readonly current: NormalizedStatusOptions
  /** Canonical fields where `current` differs from `baseline`. */
  readonly changed: ReadonlySet<CanonicalField>
}

export function startStatusDraft(baseline: NormalizedStatusOptions): StatusOptionsDraft {
  return { baseline, current: baseline, changed: new Set<CanonicalField>() }
}

export function updateStatusDraft(draft: StatusOptionsDraft, current: NormalizedStatusOptions): StatusOptionsDraft {
  return { baseline: draft.baseline, current, changed: diffStatusOptions(draft.baseline, current) }
}

function sameWidgetOrder(left: readonly WidgetID[], right: readonly WidgetID[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameAppearance(left: string | CustomText | CustomTokenLabels, right: string | CustomText | CustomTokenLabels): boolean {
  if (!(left instanceof Object) || !(right instanceof Object)) return left === right

  if ("text" in left && "text" in right) return left.text === right.text

  if ("input" in left && "input" in right) return left.input === right.input && left.output === right.output

  return false
}

/** The canonical fields where two normalized configurations differ. */
export function diffStatusOptions(
  baseline: NormalizedStatusOptions,
  current: NormalizedStatusOptions,
): ReadonlySet<CanonicalField> {
  const changed = new Set<CanonicalField>()

  if (!sameWidgetOrder(baseline.layout.topLeft, current.layout.topLeft)) changed.add("layout.topLeft")

  if (!sameWidgetOrder(baseline.layout.topRight, current.layout.topRight)) changed.add("layout.topRight")

  if (!sameWidgetOrder(baseline.layout.bottomLeft, current.layout.bottomLeft)) changed.add("layout.bottomLeft")

  if (!sameWidgetOrder(baseline.layout.bottomRight, current.layout.bottomRight)) changed.add("layout.bottomRight")

  if (baseline.appearance.spinner !== current.appearance.spinner) changed.add("appearance.spinner")

  if (baseline.appearance.directory.format !== current.appearance.directory.format) {
    changed.add("appearance.directory.format")
  }

  if (!sameAppearance(baseline.appearance.directory.icon, current.appearance.directory.icon)) {
    changed.add("appearance.directory.icon")
  }

  if (!sameAppearance(baseline.appearance.branch, current.appearance.branch)) changed.add("appearance.branch")

  if (!sameAppearance(baseline.appearance.worktree, current.appearance.worktree)) changed.add("appearance.worktree")

  if (!sameAppearance(baseline.appearance.tokens, current.appearance.tokens)) changed.add("appearance.tokens")

  if (!sameAppearance(baseline.appearance.cache, current.appearance.cache)) changed.add("appearance.cache")

  if (!sameAppearance(baseline.appearance.cost, current.appearance.cost)) changed.add("appearance.cost")

  if (!sameAppearance(baseline.appearance.bgagent, current.appearance.bgagent)) changed.add("appearance.bgagent")

  if (baseline.appearance.context.format !== current.appearance.context.format) {
    changed.add("appearance.context.format")
  }

  if (baseline.appearance.context.bar !== current.appearance.context.bar) changed.add("appearance.context.bar")

  if (baseline.appearance.context.label !== current.appearance.context.label) changed.add("appearance.context.label")

  if (baseline.appearance.context.order !== current.appearance.context.order) changed.add("appearance.context.order")

  if (!sameAppearance(baseline.appearance.separator, current.appearance.separator)) changed.add("appearance.separator")

  if (baseline.overflow.preset !== current.overflow.preset) {
    changed.add("overflow.preset")
  } else if (
    baseline.overflow.preset === "custom" &&
    !sameWidgetOrder(baseline.overflow.hideFirst, current.overflow.hideFirst)
  ) {
    changed.add("overflow.hideFirst")
  }

  return changed
}

/** Canonical directory values a patch can write; only changed leaves are present. */
export interface CanonicalDirectoryPatch {
  format?: DirectoryFormat
  icon?: DirectoryIcon
}

/** Canonical context values a patch can write; only changed leaves are present. */
export interface CanonicalContextPatch {
  format?: ContextFormat
  bar?: ContextBarStyle
  label?: ContextLabel
  order?: ContextOrder
}

/** Canonical appearance values a patch can write; only changed leaves are present. */
export interface CanonicalAppearancePatch {
  spinner?: SpinnerAppearance
  directory?: CanonicalDirectoryPatch
  branch?: BranchStyle
  worktree?: WorktreeMarker
  tokens?: TokenLabels
  cache?: CacheLabel
  cost?: CostStyle
  bgagent?: BackgroundAgentStyle
  context?: CanonicalContextPatch
  separator?: MetricSeparator
}

/** Canonical overflow values; `hideFirst` is present only for the custom preset. */
export interface CanonicalOverflow {
  preset: OverflowPreset
  hideFirst?: readonly WidgetID[]
}

/**
 * Canonical values a draft save writes; absent sections stay untouched on
 * disk. Built imperatively by `serializeStatusDraft`; consumers treat the
 * result as immutable.
 */
export interface StatusOptionsPatch {
  /** Written whole — all four zones — whenever any zone changed. */
  layout?: StatusLayout
  /** Only changed leaves are present. */
  appearance?: CanonicalAppearancePatch
  /** Written when the preset or the custom list changed. */
  overflow?: CanonicalOverflow
}

function hasLayoutChange(changed: ReadonlySet<CanonicalField>): boolean {
  return (
    changed.has("layout.topLeft") ||
    changed.has("layout.topRight") ||
    changed.has("layout.bottomLeft") ||
    changed.has("layout.bottomRight")
  )
}

function appearancePatch(
  current: NormalizedStatusOptions,
  changed: ReadonlySet<CanonicalField>,
): CanonicalAppearancePatch | undefined {
  const appearance: CanonicalAppearancePatch = {}

  if (changed.has("appearance.spinner")) appearance.spinner = current.appearance.spinner

  if (changed.has("appearance.branch")) appearance.branch = current.appearance.branch

  if (changed.has("appearance.worktree")) appearance.worktree = current.appearance.worktree

  if (changed.has("appearance.tokens")) appearance.tokens = current.appearance.tokens

  if (changed.has("appearance.cache")) appearance.cache = current.appearance.cache

  if (changed.has("appearance.cost")) appearance.cost = current.appearance.cost

  if (changed.has("appearance.bgagent")) appearance.bgagent = current.appearance.bgagent

  if (changed.has("appearance.separator")) appearance.separator = current.appearance.separator

  const directory: CanonicalDirectoryPatch = {}

  if (changed.has("appearance.directory.format")) directory.format = current.appearance.directory.format

  if (changed.has("appearance.directory.icon")) directory.icon = current.appearance.directory.icon

  if (directory.format !== undefined || directory.icon !== undefined) appearance.directory = directory

  const context: CanonicalContextPatch = {}

  if (changed.has("appearance.context.format")) context.format = current.appearance.context.format

  if (changed.has("appearance.context.bar")) context.bar = current.appearance.context.bar

  if (changed.has("appearance.context.label")) context.label = current.appearance.context.label

  if (changed.has("appearance.context.order")) context.order = current.appearance.context.order

  if (context.format !== undefined || context.bar !== undefined || context.label !== undefined || context.order !== undefined) {
    appearance.context = context
  }

  return Object.keys(appearance).length > 0 ? appearance : undefined
}

function overflowPatch(current: NormalizedStatusOptions, changed: ReadonlySet<CanonicalField>): CanonicalOverflow | undefined {
  if (!changed.has("overflow.preset") && !changed.has("overflow.hideFirst")) return undefined

  return current.overflow.preset === "custom"
    ? { preset: "custom", hideFirst: current.overflow.hideFirst }
    : { preset: current.overflow.preset }
}

/**
 * Serializes the draft's changed fields into the canonical patch a save
 * persists. Only changed sections appear, so external edits to untouched
 * fields survive the merge.
 */
export function serializeStatusDraft(draft: StatusOptionsDraft): StatusOptionsPatch {
  const { current, changed } = draft
  const layout = hasLayoutChange(changed) ? current.layout : undefined
  const appearance = appearancePatch(current, changed)
  const overflow = overflowPatch(current, changed)
  const patch: StatusOptionsPatch = {}

  if (layout !== undefined) patch.layout = layout

  if (appearance !== undefined) patch.appearance = appearance

  if (overflow !== undefined) patch.overflow = overflow

  return patch
}

// A host-independent snapshot of everything the status rows can display,
// produced by the production integration (Stage 3A) or sample data for the
// editor preview (Stage 3B). Raw values stay separate from display strings,
// and availability stays separate from numeric zero: a known `$0.00` cost is
// displayable, while an unknown context or a home screen without a session is
// absent rather than a fabricated zero.

export interface LocationStatus {
  /** Absolute working directory of the session, or of the default location on home. */
  readonly directory: string
  /** The user's home directory, for `~` abbreviation. */
  readonly home: string
  /** Current VCS branch; undefined outside a repository. */
  readonly branch: string | undefined
  /** True when the directory is a worktree rather than the project root. */
  readonly worktree: boolean
}

export interface ContextStatus {
  /** Latest usable assistant usage after compaction and before the revert boundary, in tokens. */
  readonly tokens: number
  /** The model's context-window limit when known; formats needing it fall back without it. */
  readonly limit: number | undefined
  /** Integer percentage of the limit when known; retains values above 100. */
  readonly percent: number | undefined
}

export interface UsageStatus {
  /** Cumulative fresh input + cache read + cache write. */
  readonly input: number
  /** Cumulative output + reasoning. */
  readonly output: number
  /** Cache-read share of the input side, in percent with one decimal. */
  readonly cacheShare: number
  /** Cumulative session cost in USD; zero is a known value, not "no data". */
  readonly cost: number
  /** Latest usable context usage; undefined before any usage exists. */
  readonly context: ContextStatus | undefined
}

export interface TpsStatus {
  /** The already-formatted rate label, e.g. `~52.4 t/s`; the TPS appearance is fixed. */
  readonly label: string
}

/** Background activity in the session: running subagents, as a count. */
export interface BackgroundStatus {
  /** Subagents still running; the widget hides at zero. */
  readonly agents: number
}

export interface StatusSnapshot {
  /** The session the prompt belongs to; undefined on the home screen. */
  readonly sessionID: string | undefined
  /** True while the session is generating. */
  readonly running: boolean
  /** Working location; undefined only when the host exposes none. */
  readonly location: LocationStatus | undefined
  /** Session metrics; undefined without a session — home never invents them. */
  readonly metrics: UsageStatus | undefined
  /** Throughput label; undefined when no rate exists, never a placeholder. */
  readonly tps: TpsStatus | undefined
  /** Background activity; zero counts hide the widgets rather than rendering zeros. */
  readonly background: BackgroundStatus
}

// Stage 2A turns a `StatusSnapshot` plus `NormalizedStatusOptions` into the
// widgets the layout engine fits, applying every appearance choice. The shape
// itself is declared by that engine (`FormattedWidget` in `layout.ts`): the
// directory carries its path candidates there, and every widget carries its
// selected text plus the exact terminal-cell width of that text, so the fit's
// decision and the render can never disagree. This module re-exports the type
// instead of declaring a parallel union, so a formatter and the engine cannot
// drift apart.

/** One directory representation, from the full selected form down to the minimum. */
export interface PathCandidate {
  /** Display text, e.g. `~/.../work/repo`. */
  readonly text: string
  /** Terminal cell width of `text`. */
  readonly width: number
}

export type { FormattedWidget } from "./layout.js"

/**
 * The available widgets keyed by ID; an absent widget is unavailable data
 * (missing branch, no session, no rate), which is distinct from being hidden
 * by overflow. Construct with `satisfies` or by accumulation so each entry's
 * `id` matches its key.
 */
export type FormattedWidgetSet = { readonly [ID in WidgetID]?: FormattedWidget & { readonly id: ID } }

// Stage 2B's engine lives in `layout.ts`, and so do its canonical contracts:
// `CellMeasurer`, the exact terminal-cell measure `createCellMeasurer` returns
// and `measureCells` uses, and the fitting plan `fitRow` returns — the
// surviving `FittedItem`s with the joiners between them per zone (`FittedZone`)
// and the row geometry (`FittedRow`) that `status-row.tsx` draws verbatim.
// Re-exported here so the configuration contract stays the shared import site
// and each contract has exactly one definition.
//
// The re-exports must stay type-only: `layout.ts` imports this module at
// runtime for the widget registry, the overflow presets and `PathCandidate`,
// so a runtime import in this direction would be an import cycle. Type-only
// edges are erased before execution, so a consumer that only wants
// configuration never loads `layout.ts` or its `@opentui/core` imports.

/** Measures a string's terminal cell width (wide and zero-width aware). */
export type { CellMeasurer as MeasureTextWidth } from "./layout.js"

/** The fitted plan, canonical in `layout.ts`: surviving items, zone joiners, and row geometry. */
export type { FittedItem, FittedRow, FittedZone } from "./layout.js"

// Stage 2D implements this against `cli.json`; the settings editor (Stage 3B)
// consumes it. It never depends on a running session or background server,
// and read or write failures leave the saved settings unchanged so the
// editor can retain the draft for correction or retry.

/** One `cli.json` plugin entry that can represent this plugin. */
export interface PluginEntryState {
  /** The entry's package specifier exactly as written: name, path, or file URL. */
  readonly specifier: string
  /** Position in the `plugins` array at read time; the saver verifies it still matches. */
  readonly index: number
  /** The entry's raw options object; undefined for string entries without options. */
  readonly options: StatusOptionsInput | undefined
}

/** The latest on-disk state for the editor's initial draft. */
export interface StatusOptionsStoreState {
  /** The resolved `cli.json` path, for display and diagnostics. */
  readonly path: string
  /** Every entry that can represent this plugin, in file order; the editor selects when several match. */
  readonly entries: readonly PluginEntryState[]
}

export type StatusOptionsReadResult =
  | { readonly status: "read"; readonly state: StatusOptionsStoreState }
  | { readonly status: "error"; readonly message: string }

/** What a save persists, plus what it compares for conflicts. */
export interface StatusOptionsSaveInput {
  /**
   * The entry to update, from a prior read. Undefined creates this package's
   * normal global entry — an explicit editor action; if a matching entry
   * appeared since the read, the save fails so the editor can re-read.
   */
  readonly target: PluginEntryState | undefined
  /** The draft's baseline; edited fields are compared against the latest file state. */
  readonly baseline: NormalizedStatusOptions
  /** The draft's changed fields, for external-change (conflict) detection. */
  readonly changed: readonly CanonicalField[]
  /** The canonical values to persist. */
  readonly patch: StatusOptionsPatch
}

export type StatusOptionsSaveResult =
  | { readonly status: "saved" }
  | { readonly status: "conflict"; readonly fields: readonly CanonicalField[] }
  | { readonly status: "error"; readonly message: string }

/**
 * The persistence boundary: discover this plugin's entries, read their raw
 * options, and save a draft's changed fields with re-read, merge, and
 * conflict detection. Zone arrays and the custom priority list are atomic
 * fields for conflict detection.
 */
export interface StatusOptionsStore {
  /** The latest matching entries; a missing config file reads as none. */
  readonly read: () => Promise<StatusOptionsReadResult>
  /** Re-reads, merges disjoint changes, and reports conflicts on edited fields. */
  readonly save: (input: StatusOptionsSaveInput) => Promise<StatusOptionsSaveResult>
}
