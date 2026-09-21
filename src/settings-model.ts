// opencode2-enhanced-composer — the settings editor's model (Stage 3B).
//
// Everything the dialog needs except JSX lives here, as pure functions over
// the shared contracts: the sample snapshots and the preview pipeline (which
// runs the production formatter, fitter, and zone assembly, so the preview
// cannot drift from the footer), the draft operations for visibility, corner
// movement, reordering, appearance cycling, and overflow priorities, the
// curated control catalog the Appearance and Overflow sections render, the
// cursor-following row window for short terminals, and the `cli.json` store
// adapter that turns `config-file.ts`'s primitives into the read/save
// boundary the dialog consumes.
//
// The module is plain TypeScript with no TUI imports, so its tests run
// headlessly and `settings.tsx` stays a thin rendering and keymap layer.

import {
  CANONICAL_FIELDS,
  DEFAULT_LAYOUT,
  OVERFLOW_PRESETS,
  WIDGET_IDS,
  ZONE_IDS,
  resolveStatusOptions,
  serializeStatusDraft,
  startStatusDraft,
  updateStatusDraft,
} from "./options.js"
import type {
  CanonicalField,
  CustomText,
  CustomTokenLabels,
  NormalizedStatusOptions,
  StatusLayout,
  StatusOptionsInput,
  StatusOptionsPatch,
  StatusSnapshot,
  WidgetID,
  ZoneID,
} from "./options.js"
import { formatWidgets } from "./format.js"
import type { FormattedStatusWidgets } from "./format.js"
import { createCellMeasurer, fitRow } from "./layout.js"
import type { CellMeasurer, FittedRow, FormattedWidget, WidthMethod } from "./layout.js"
import type {
  CliConfigEnvironment,
  ConfigChange,
  JsonObject,
  JsonValue,
  PluginEntryMatch,
  PluginEntrySelection,
  PluginIdentity,
} from "./config-file.js"
import { currentCliConfigEnvironment, readCliConfig, resolveCliConfigPath, savePluginOptions } from "./config-file.js"
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// The store adapter matches `cli.json` entries the way the host resolves them:
// by package name for registry entries and by package directory for path and
// `file:` entries. The published artifact is `dist/tui.js`, so the package
// directory is the parent of `dist`; source loading runs from the repository
// root through `src/`, so a module URL inside `src/` unwraps to its parent too.

export const PLUGIN_PACKAGE_NAME = "opencode2-enhanced-composer"

/** The plugin's package directory for a module URL inside this package. */
export function resolvePluginDirectory(moduleURL: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleURL))
  const base = basename(moduleDirectory)

  return base === "dist" || base === "src" ? dirname(moduleDirectory) : moduleDirectory
}

// Representative data so every enabled metric, both locations, and all three
// prompt states can be inspected without a live session. The numbers match
// the appearance catalog's own examples (`in 128k`, `61%`, `$0.42`,
// `100k (50%)`, `~52.4 t/s`), so a choice's value preview and the rendered
// preview row always tell the same story.

export type PreviewScenarioID = "idle" | "running"

export type PreviewLocationID = "project" | "worktree"

export interface PreviewState {
  readonly scenario: PreviewScenarioID
  readonly location: PreviewLocationID
}

export const DEFAULT_PREVIEW_STATE: PreviewState = { scenario: "running", location: "project" }

const SAMPLE_HOME = "/home/ada"

const SAMPLE_PROJECT = { directory: "/home/ada/projects/acme/app", branch: "main" }

const SAMPLE_WORKTREE = { directory: "/home/ada/projects/acme/.worktrees/fix-crash", branch: "fix-crash" }

const SAMPLE_METRICS = {
  input: 128_450,
  output: 4_216,
  cacheShare: 61,
  cost: 0.42,
  context: { tokens: 100_000, limit: 200_000, percent: 50 },
}

const SAMPLE_TPS_LABEL = "~52.4 t/s"

/** The sample snapshot for one scenario and location. `running` shows the spinner — the richest row. */
export function previewSnapshot(scenario: PreviewScenarioID, location: PreviewLocationID): StatusSnapshot {
  const where = location === "worktree" ? SAMPLE_WORKTREE : SAMPLE_PROJECT

  return {
    sessionID: "ses_preview",
    running: scenario !== "idle",
    location: {
      directory: where.directory,
      home: SAMPLE_HOME,
      branch: where.branch,
      worktree: location === "worktree",
    },
    metrics: SAMPLE_METRICS,
    tps: { label: SAMPLE_TPS_LABEL },
    background: { agents: 2 },
  }
}

// The same three steps the production rows run: format the snapshot with the
// draft's appearance, assemble each zone's available widgets in display
// order, and fit both zones of the row into the preview width. `zoneWidgets`
// is the zone assembly `footer.tsx` also performs; the duplication lasts until
// Stage 4 consolidates it into the shared pipeline.

/** The zone's widgets that have data, in display order; unavailable widgets are absent, not hidden. */
export function zoneWidgets(zone: readonly WidgetID[], widgets: FormattedStatusWidgets): FormattedWidget[] {
  const list: FormattedWidget[] = []

  for (const id of zone) {
    const widget = widgets[id]

    if (widget !== undefined) list.push(widget)
  }

  return list
}

export interface PreviewRows {
  /** The row above the prompt (`session.composer.top`); session-only in production. */
  readonly top: FittedRow
  /** The replacement footer row (`prompt.footer`). */
  readonly bottom: FittedRow
}

export interface PreviewInput {
  readonly options: NormalizedStatusOptions
  readonly scenario: PreviewScenarioID
  readonly location: PreviewLocationID
  /** The row width to fit against, in cells. */
  readonly width: number
  /** The renderer's width method; defaults to the shared `unicode` measure. */
  readonly widthMethod?: WidthMethod
}

/** Both preview rows for one draft, scenario, location, and width. */
export function buildPreviewRows(input: PreviewInput): PreviewRows {
  const measure: CellMeasurer = createCellMeasurer(input.widthMethod ?? "unicode")
  const snapshot = previewSnapshot(input.scenario, input.location)
  const widgets = formatWidgets(snapshot, input.options.appearance, measure)

  const fit = (left: ZoneID, right: ZoneID): FittedRow =>
    fitRow({
      width: input.width,
      separator: input.options.appearance.separator,
      colonJoin: input.options.appearance.branch === "colon",
      hideFirst: input.options.overflow.hideFirst,
      widthMethod: input.widthMethod,
      left: zoneWidgets(input.options.layout[left], widgets),
      right: zoneWidgets(input.options.layout[right], widgets),
    })

  return { top: fit("topLeft", "topRight"), bottom: fit("bottomLeft", "bottomRight") }
}

// Pure transforms over `StatusLayout`. Hiding is omission from every zone;
// showing appends to the widget's default-arrangement corner, which the
// hidden rows state explicitly so the behavior is predictable without docs.

/** The corner the default arrangement places a widget in; every widget has exactly one. */
export function defaultZoneFor(id: WidgetID): ZoneID {
  for (const zone of ZONE_IDS) {
    if (DEFAULT_LAYOUT[zone].includes(id)) return zone
  }

  return "bottomRight"
}

/** The zone a widget is currently placed in, or undefined when it is hidden. */
export function widgetZone(layout: StatusLayout, id: WidgetID): ZoneID | undefined {
  for (const zone of ZONE_IDS) {
    if (layout[zone].includes(id)) return zone
  }

  return undefined
}

/** The widgets omitted from every zone, in catalog order. */
export function hiddenWidgets(options: NormalizedStatusOptions): readonly WidgetID[] {
  return WIDGET_IDS.filter((id) => widgetZone(options.layout, id) === undefined)
}

function replaceZone(layout: StatusLayout, zone: ZoneID, ids: readonly WidgetID[]): StatusLayout {
  return {
    topLeft: zone === "topLeft" ? ids : layout.topLeft,
    topRight: zone === "topRight" ? ids : layout.topRight,
    bottomLeft: zone === "bottomLeft" ? ids : layout.bottomLeft,
    bottomRight: zone === "bottomRight" ? ids : layout.bottomRight,
  }
}

function withLayout(options: NormalizedStatusOptions, layout: StatusLayout): NormalizedStatusOptions {
  return { ...options, layout }
}

/**
 * Show or hide one widget. Hiding removes it from its zone; showing appends
 * it to its default-arrangement corner. Showing an already-visible widget
 * and hiding an already-hidden one are no-ops.
 */
export function toggleWidgetVisibility(options: NormalizedStatusOptions, id: WidgetID): NormalizedStatusOptions {
  const zone = widgetZone(options.layout, id)

  if (zone === undefined) {
    const target = defaultZoneFor(id)

    return withLayout(options, replaceZone(options.layout, target, [...options.layout[target], id]))
  }

  return withLayout(options, replaceZone(options.layout, zone, options.layout[zone].filter((widget) => widget !== id)))
}

/**
 * Move a visible widget to the adjacent corner, wrapping through the four
 * zones in `topLeft → topRight → bottomLeft → bottomRight` order. The widget
 * appends to the end of its new corner's list; hidden widgets do not move.
 */
export function moveWidgetToAdjacentZone(
  options: NormalizedStatusOptions,
  id: WidgetID,
  direction: 1 | -1,
): NormalizedStatusOptions {
  const zone = widgetZone(options.layout, id)

  if (zone === undefined) return options

  const current = ZONE_IDS.indexOf(zone)
  const target = ZONE_IDS[(current + direction + ZONE_IDS.length) % ZONE_IDS.length]

  if (target === undefined) return options

  const emptied = replaceZone(options.layout, zone, options.layout[zone].filter((widget) => widget !== id))

  return withLayout(options, replaceZone(emptied, target, [...emptied[target], id]))
}

/**
 * Swap a visible widget with its neighbor within its corner. Clamped at the
 * ends of the list; hidden widgets do not reorder.
 */
export function reorderWidgetWithinZone(
  options: NormalizedStatusOptions,
  id: WidgetID,
  direction: 1 | -1,
): NormalizedStatusOptions {
  const zone = widgetZone(options.layout, id)

  if (zone === undefined) return options

  const ids = [...options.layout[zone]]
  const index = ids.indexOf(id)
  const target = index + direction

  if (index < 0 || target < 0 || target >= ids.length) return options

  const neighbor = ids[target]

  if (neighbor === undefined) return options
  ids[index] = neighbor
  ids[target] = id

  return withLayout(options, replaceZone(options.layout, zone, ids))
}

// One shape for every cyclable setting the editor shows: a stable id, the
// group and label it keeps for conflict messages, the short title the row
// shows, the curated choices with the text the row displays (the actual glyph
// for glyph choices, the actual rendered value for value choices), and the
// read/apply pair.

export interface SettingChoice {
  readonly value: string
  /** What the row shows for this choice: the real glyph or rendered value, not a description. */
  readonly text: string
}

export interface SettingControl {
  readonly id: string
  readonly group: string
  readonly label: string
  /** The short human label the editor row shows before the value, e.g. `Spinner`. */
  readonly title: string
  /** Stable explanation of what the setting affects. */
  readonly description: string
  readonly choices: readonly SettingChoice[]
  /** The currently selected choice value. */
  readonly current: (options: NormalizedStatusOptions) => string
  /** Applies a curated choice; a value outside the catalog is a no-op. */
  readonly apply: (options: NormalizedStatusOptions, value: string) => NormalizedStatusOptions
  /** The row's value text for a selection outside the catalog; defaults to the choice text. */
  readonly valueText?: (options: NormalizedStatusOptions, choiceText: string) => string
  /** Present when the setting also takes literal text instead of only cycling presets. */
  readonly custom?: CustomAppearanceControl
}

/** How one control edits literal text: the input labels, the current values, and the apply. */
export interface CustomAppearanceControl {
  readonly labels: readonly string[]
  /** The current custom values, or undefined while a preset is selected. */
  readonly read: (options: NormalizedStatusOptions) => readonly string[] | undefined
  readonly apply: (options: NormalizedStatusOptions, values: readonly string[]) => NormalizedStatusOptions
}

function customTextControl(field: "branch" | "worktree" | "cache" | "cost" | "bgagent" | "separator"): CustomAppearanceControl {
  return {
    labels: ["text"],
    read: (options) => {
      const value = options.appearance[field]

      return value instanceof Object ? [value.text] : undefined
    },
    apply: (options, values) => withAppearance(options, { ...options.appearance, [field]: { text: values[0] ?? "" } }),
  }
}

/** True when the value is one of the curated choices; the editor's cast-free membership test. */
function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value)
}

function glyphChoice(value: string, glyph: string): SettingChoice {
  return { value, text: glyph }
}

function appearanceChoice(value: string | CustomText | CustomTokenLabels): string {
  return value instanceof Object ? JSON.stringify(value) : value
}

const SPINNER_CHOICES: readonly SettingChoice[] = [
  { value: "braille", text: "⠋ braille" },
  { value: "blocks", text: "■⬝ blocks" },
  { value: "text", text: "Running text" },
]

const DIRECTORY_FORMAT_CHOICES: readonly SettingChoice[] = [
  { value: "name", text: "folder name" },
  { value: "path", text: "path" },
]

const DIRECTORY_ICON_CHOICES: readonly SettingChoice[] = [
  glyphChoice("f115", "\u{f115}"),
  glyphChoice("f07b", "\u{f07b}"),
  glyphChoice("f07c", "\u{f07c}"),
  { value: "none", text: "none" },
]

const BRANCH_CHOICES: readonly SettingChoice[] = [
  glyphChoice("e0a0", "\u{e0a0}"),
  glyphChoice("f418", "\u{f418}"),
  { value: "colon", text: "colon" },
]

const WORKTREE_CHOICES: readonly SettingChoice[] = [
  glyphChoice("e5fb", "\u{e5fb}"),
  glyphChoice("ec7d", "\u{ec7d}"),
  { value: "none", text: "none" },
]

const TOKEN_CHOICES: readonly SettingChoice[] = [
  { value: "words", text: "in / out" },
  { value: "arrows", text: "↑ / ↓" },
]

const CACHE_CHOICES: readonly SettingChoice[] = [
  { value: "text", text: "cache 61%" },
  glyphChoice("f49b", "\u{f49b}"),
  { value: "none", text: "61%" },
]

const COST_CHOICES: readonly SettingChoice[] = [
  { value: "currency", text: "$0.42" },
  { value: "labeled", text: "cost $0.42" },
]

const CONTEXT_FORMAT_CHOICES: readonly SettingChoice[] = [
  { value: "tokens", text: "100k" },
  { value: "tokens-percent", text: "100k (50%)" },
  { value: "percent", text: "50%" },
  { value: "tokens-limit", text: "100k/200k" },
  { value: "off", text: "off" },
]

const CONTEXT_BAR_CHOICES: readonly SettingChoice[] = [
  { value: "solid", text: "[█████░░░░░]" },
  { value: "slanted", text: "[▰▰▰▱▱]" },
  { value: "off", text: "off" },
]


const BGAGENT_CHOICES: readonly SettingChoice[] = [
  { value: "arrow", text: "↓1 agent" },
  { value: "ec20", text: "\u{ec20} 1 agent" },
  { value: "text", text: "1 agent" },
]

const CONTEXT_LABEL_CHOICES: readonly SettingChoice[] = [
  { value: "none", text: "none" },
  { value: "ctx", text: "ctx" },
  { value: "context", text: "context" },
]

const CONTEXT_ORDER_CHOICES: readonly SettingChoice[] = [
  { value: "bar-text-label", text: "bar 100k ctx" },
  { value: "bar-label-text", text: "bar ctx 100k" },
  { value: "text-bar-label", text: "100k bar ctx" },
  { value: "text-label-bar", text: "100k ctx bar" },
  { value: "label-bar-text", text: "ctx bar 100k" },
  { value: "label-text-bar", text: "ctx 100k bar" },
]

const SEPARATOR_CHOICES: readonly SettingChoice[] = [
  { value: "dot", text: "· dot" },
  { value: "pipe", text: "| pipe" },
  { value: "space", text: "space" },
]

function withAppearance(
  options: NormalizedStatusOptions,
  appearance: NormalizedStatusOptions["appearance"],
): NormalizedStatusOptions {
  return { ...options, appearance }
}

export const APPEARANCE_CONTROLS: readonly SettingControl[] = [
  {
    id: "spinner",
    group: "spinner",
    label: "style",
    title: "Spinner",
    description: "How the spinner looks while a task is running.",
    choices: SPINNER_CHOICES,
    current: (options) => options.appearance.spinner,
    apply: (options, value) =>
      isMember(["braille", "blocks", "text"] as const, value)
        ? withAppearance(options, { ...options.appearance, spinner: value })
        : options,
  },
  {
    id: "directory.format",
    group: "directory",
    label: "text",
    title: "Directory",
    description: "How to show current folder.",
    choices: DIRECTORY_FORMAT_CHOICES,
    current: (options) => options.appearance.directory.format,
    apply: (options, value) =>
      isMember(["name", "path"] as const, value)
        ? withAppearance(options, {
            ...options.appearance,
            directory: { ...options.appearance.directory, format: value },
          })
        : options,
  },
  {
    id: "directory.icon",
    custom: {
      labels: ["text"],
      read: (options) => {
        const icon = options.appearance.directory.icon

        return icon instanceof Object ? [icon.text] : undefined
      },
      apply: (options, values) => withAppearance(options, {
        ...options.appearance,
        directory: { ...options.appearance.directory, icon: { text: values[0] ?? "" } },
      }),
    },
    group: "directory",
    label: "icon",
    title: "Directory icon",
    description: "Which folder symbol to show.",
    choices: DIRECTORY_ICON_CHOICES,
    current: (options) => appearanceChoice(options.appearance.directory.icon),
    apply: (options, value) =>
      isMember(["f115", "f07b", "f07c", "none"] as const, value)
        ? withAppearance(options, {
            ...options.appearance,
            directory: { ...options.appearance.directory, icon: value },
          })
        : options,
  },
  {
    id: "branch",
    custom: customTextControl("branch"),
    group: "branch",
    label: "style",
    title: "Branch",
    description: "Which Git branch symbol to show.",
    choices: BRANCH_CHOICES,
    current: (options) => appearanceChoice(options.appearance.branch),
    apply: (options, value) =>
      isMember(["e0a0", "f418", "colon"] as const, value)
        ? withAppearance(options, { ...options.appearance, branch: value })
        : options,
  },
  {
    id: "worktree",
    custom: customTextControl("worktree"),
    group: "worktree",
    label: "marker",
    title: "Worktree marker",
    description: "How to mark worktrees. Press l to preview.",
    choices: WORKTREE_CHOICES,
    current: (options) => appearanceChoice(options.appearance.worktree),
    apply: (options, value) =>
      isMember(["e5fb", "ec7d", "none"] as const, value)
        ? withAppearance(options, { ...options.appearance, worktree: value })
        : options,
  },
  {
    id: "tokens",
    custom: {
      labels: ["in", "out"],
      read: (options) => {
        const labels = options.appearance.tokens

        return labels instanceof Object ? [labels.input, labels.output] : undefined
      },
      apply: (options, values) => withAppearance(options, {
        ...options.appearance,
        tokens: { input: values[0] ?? "", output: values[1] ?? "" },
      }),
    },
    group: "input/output",
    label: "labels",
    title: "Token labels",
    description: "How to label input and output tokens.",
    choices: TOKEN_CHOICES,
    current: (options) => appearanceChoice(options.appearance.tokens),
    apply: (options, value) =>
      isMember(["words", "arrows"] as const, value)
        ? withAppearance(options, { ...options.appearance, tokens: value })
        : options,
  },
  {
    id: "cache",
    custom: customTextControl("cache"),
    group: "cache",
    label: "label",
    title: "Cache",
    description: "How to label the cached-input percentage.",
    choices: CACHE_CHOICES,
    current: (options) => appearanceChoice(options.appearance.cache),
    apply: (options, value) =>
      isMember(["text", "f49b", "none"] as const, value)
        ? withAppearance(options, { ...options.appearance, cache: value })
        : options,
  },
  {
    id: "cost",
    custom: customTextControl("cost"),
    group: "cost",
    label: "style",
    title: "Cost",
    description: "How to display the session cost.",
    choices: COST_CHOICES,
    current: (options) => appearanceChoice(options.appearance.cost),
    apply: (options, value) =>
      isMember(["currency", "labeled"] as const, value)
        ? withAppearance(options, { ...options.appearance, cost: value })
        : options,
  },
  {
    id: "bgagent",
    custom: customTextControl("bgagent"),
    group: "background",
    label: "agent",
    title: "Background agent",
    description: "Which symbol to show for running subagents.",
    choices: BGAGENT_CHOICES,
    current: (options) => appearanceChoice(options.appearance.bgagent),
    apply: (options, value) =>
      isMember(["arrow", "ec20", "text"] as const, value)
        ? withAppearance(options, { ...options.appearance, bgagent: value })
        : options,
  },
  {
    id: "context.format",
    group: "context",
    label: "format",
    title: "Context",
    description: "How to show the context metric.",
    choices: CONTEXT_FORMAT_CHOICES,
    current: (options) => options.appearance.context.format,
    apply: (options, value) =>
      isMember(["tokens", "tokens-percent", "percent", "tokens-limit", "off"] as const, value)
        ? withAppearance(options, {
            ...options.appearance,
            context: { ...options.appearance.context, format: value },
          })
        : options,
  },
  {
    id: "context.bar",
    group: "context",
    label: "bar",
    title: "Context bar",
    description: "How to show the context bar.",
    choices: CONTEXT_BAR_CHOICES,
    current: (options) => options.appearance.context.bar,
    apply: (options, value) =>
      isMember(["solid", "slanted", "off"] as const, value)
        ? withAppearance(options, {
            ...options.appearance,
            context: { ...options.appearance.context, bar: value },
          })
        : options,
  },
  {
    id: "context.label",
    group: "context",
    label: "label",
    title: "Context label",
    description: "How to show the context label.",
    choices: CONTEXT_LABEL_CHOICES,
    current: (options) => options.appearance.context.label,
    apply: (options, value) =>
      isMember(["none", "ctx", "context"] as const, value)
        ? withAppearance(options, {
            ...options.appearance,
            context: { ...options.appearance.context, label: value },
          })
        : options,
  },
  {
    id: "context.order",
    group: "context",
    label: "order",
    title: "Context order",
    description: "How to order the context bar, tokens, and label.",
    choices: CONTEXT_ORDER_CHOICES,
    current: (options) => options.appearance.context.order,
    apply: (options, value) =>
      isMember(
        ["bar-text-label", "bar-label-text", "text-bar-label", "text-label-bar", "label-bar-text", "label-text-bar"] as const,
        value,
      )
        ? withAppearance(options, {
            ...options.appearance,
            context: { ...options.appearance.context, order: value },
          })
        : options,
  },
  {
    id: "separator",
    custom: customTextControl("separator"),
    group: "metrics",
    label: "separator",
    title: "Separator",
    description: "How to separate metrics.",
    choices: SEPARATOR_CHOICES,
    current: (options) => appearanceChoice(options.appearance.separator),
    apply: (options, value) =>
      isMember(["dot", "pipe", "space"] as const, value)
        ? withAppearance(options, { ...options.appearance, separator: value })
        : options,
  },
]

export function cycledChoice(choices: readonly SettingChoice[], current: string, direction: 1 | -1): SettingChoice {
  const count = choices.length

  if (count === 0) return { value: current, text: current }

  const index = choices.findIndex((choice) => choice.value === current)
  const base = index === -1 ? (direction === 1 ? -1 : 0) : index
  const raw = (base + direction + count) % count

  return choices[raw] ?? choices[0] ?? { value: current, text: current }
}

/** Cycle one appearance control; unknown control ids and no-op applies return the draft unchanged. */
export function cycleAppearanceControl(
  options: NormalizedStatusOptions,
  controlId: string,
  direction: 1 | -1,
): NormalizedStatusOptions {
  const control = APPEARANCE_CONTROLS.find((candidate) => candidate.id === controlId)

  if (control === undefined) return options

  return control.apply(options, cycledChoice(control.choices, control.current(options), direction).value)
}

/** The control ids a layout widget's `return` jump targets; empty for the fixed-appearance widgets. */
export function appearanceControlsForWidget(id: WidgetID): readonly string[] {
  switch (id) {
    case "spinner":
      return ["spinner"]
    case "directory":
      return ["directory.format", "directory.icon"]
    case "branch":
      return ["branch"]
    case "input":
    case "output":
      return ["tokens"]
    case "cache":
      return ["cache"]
    case "cost":
      return ["cost"]
    case "bgagent":
      return ["bgagent"]
    case "context":
      return ["context.format", "context.bar", "context.label", "context.order"]
    default:
      return []
  }
}

export const OVERFLOW_PRESET_CHOICES: readonly SettingChoice[] = [
  { value: "balanced", text: "balanced" },
  { value: "usage-first", text: "usage-first" },
  { value: "location-first", text: "location-first" },
  { value: "custom", text: "custom" },
]

/**
 * Cycle the overflow preset. A built-in preset adopts its own hide-first
 * list; `custom` keeps the current list, so editing a preset and then
 * switching to `custom` (or cycling through it) starts from what was shown.
 */
export function cycleOverflowPreset(options: NormalizedStatusOptions, direction: 1 | -1): NormalizedStatusOptions {
  const choice = cycledChoice(OVERFLOW_PRESET_CHOICES, options.overflow.preset, direction)

  if (isMember(["balanced", "usage-first", "location-first"] as const, choice.value)) {
    return { ...options, overflow: { preset: choice.value, hideFirst: OVERFLOW_PRESETS[choice.value] } }
  }

  return { ...options, overflow: { preset: "custom", hideFirst: options.overflow.hideFirst } }
}

/**
 * Swap one entry of the hide-first list with its neighbor. Reordering a
 * built-in preset's list converts the configuration to `custom` with that
 * list as the starting point, exactly the documented rule; the ends clamp.
 */
export function reorderHideFirst(
  options: NormalizedStatusOptions,
  index: number,
  direction: 1 | -1,
): NormalizedStatusOptions {
  const preset = options.overflow.preset
  const list = preset === "custom" ? [...options.overflow.hideFirst] : [...OVERFLOW_PRESETS[preset]]
  const target = index + direction

  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return options

  const widget = list[index]
  const neighbor = list[target]

  if (widget === undefined || neighbor === undefined) return options
  list[index] = neighbor
  list[target] = widget

  return { ...options, overflow: { preset: "custom", hideFirst: list } }
}

// The three section bodies as flat, window-friendly row lists: headers and
// notes are context, widget/control/preset/priority rows are focusable. The
// dialog renders these rows verbatim and moves a cursor between the focusable
// ones, so every keyboard flow is exercisable in tests without a terminal.

export type SettingsSection = "layout" | "appearance" | "overflow"

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["layout", "appearance", "overflow"]

export const SECTION_TITLES: Readonly<Record<SettingsSection, string>> = {
  layout: "[1] Layout",
  appearance: "[2] Appearance",
  overflow: "[3] Overflow",
}

const ZONE_TITLES: Readonly<Record<ZoneID, string>> = {
  topLeft: "Top Left",
  topRight: "Top Right",
  bottomLeft: "Bottom Left",
  bottomRight: "Bottom Right",
}

/** The human zone name, e.g. `Top Left`; shared by rows, notes, and the dialog. */
export function zoneTitle(zone: ZoneID): string {
  return ZONE_TITLES[zone]
}

export interface HeaderRow {
  readonly kind: "header"
  readonly id: string
  readonly text: string
  readonly note?: string
  /**
   * An inline subdued gloss after the bold text, e.g. the overflow list's
   * reading direction. Always visible, unlike `note`, which only the wide
   * description column shows.
   */
  readonly hint?: string
  /** Section headers have a rule; group headers are indented. */
  readonly level: "section" | "group"
}

export interface WidgetRow {
  readonly kind: "widget"
  readonly id: string
  readonly widget: WidgetID
  /** Undefined when the widget is hidden. */
  readonly zone: ZoneID | undefined
  /** 1-based position within its zone; 0 when hidden. */
  readonly position: number
  readonly count: number
}

export interface ControlRow {
  readonly kind: "control"
  readonly id: string
  readonly control: SettingControl
}

export interface PresetRow {
  readonly kind: "preset"
  readonly id: string
}

export interface PriorityRow {
  readonly kind: "priority"
  readonly id: string
  readonly widget: WidgetID
  /** 1-based position in the hide-first list. */
  readonly position: number
}

export interface NoteRow {
  readonly kind: "note"
  readonly id: string
  readonly text: string
}

export type SettingsRow = HeaderRow | WidgetRow | ControlRow | PresetRow | PriorityRow | NoteRow

const WIDGET_DESCRIPTIONS: Readonly<Record<WidgetID, string>> = {
  spinner: "Activity indicator while a task is running.",
  tps: "Live output speed in tokens per second.",
  directory: "Current folder, with an optional worktree mark.",
  branch: "Current Git branch.",
  input: "Session input tokens, including cached.",
  output: "Session output tokens, including reasoning.",
  cache: "Share of session input tokens read from cache.",
  cost: "Total cost for this session.",
  bgagent: "Marker for running subagents in this session.",
  context: "Current use of the model's context window.",
}

/** Shared by the description column and the narrow-screen focused help. */
export function rowDescription(row: SettingsRow): string {
  switch (row.kind) {
    case "header":
      return row.note ?? ""
    case "control":
      return row.control.description
    case "widget":
      // The description stays the widget's own even while hidden; the Hidden
      // heading explains that Space brings it back.
      return WIDGET_DESCRIPTIONS[row.widget]
    // The overflow list carries no per-row text: its heading states the
    // direction, and the widget meanings belong to the layout rows.
    case "preset":
    case "priority":
      return ""
    case "note":
      return row.text
  }
}

export function isFocusableRow(row: SettingsRow): boolean {
  return row.kind === "widget" || row.kind === "control" || row.kind === "preset" || row.kind === "priority"
}

/** The row's choices: the curated presets, plus a trailing `custom` choice for literal-text controls. */
export function appearanceChoices(control: SettingControl): readonly SettingChoice[] {
  return control.custom === undefined ? control.choices : [...control.choices, { value: "custom", text: "custom" }]
}

/** One custom value as the row shows it: empty reads `empty`, and invisible spaces are quoted. */
function customTextSummary(control: SettingControl, text: string): string {
  if (text === "") return "empty"

  return control.id === "separator" || text.trim() === "" ? JSON.stringify(text) : text
}

/** The text a control row shows for its current value; glyph values carry the real glyph. */
export function controlValueText(control: SettingControl, options: NormalizedStatusOptions): string {
  const custom = control.custom?.read(options)

  if (custom !== undefined) {
    // An all-empty pair reads as one `empty`, not `empty / empty`; the
    // separator's `""` stays quoted because its spaces are the value.
    const parts = custom.map((text) => customTextSummary(control, text))
    const summary = parts.every((part) => part === "empty") ? ["empty"] : parts

    return `${summary.join(" / ")} custom`
  }

  const current = control.current(options)
  const choice = control.choices.find((candidate) => candidate.value === current)
  const text = choice?.text ?? current

  return control.valueText?.(options, text) ?? text
}

function zoneValue(ids: readonly WidgetID[]): string {
  return ids.length === 0 ? "(empty)" : ids.join(" ")
}

/** The four zones, then hidden widgets. Each row occupies one terminal line. */
export function layoutRows(options: NormalizedStatusOptions): readonly SettingsRow[] {
  const rows: SettingsRow[] = []

  for (const zone of ZONE_IDS) {
    rows.push({ kind: "note", id: `spacer:before:${zone}`, text: "" })
    rows.push({
      kind: "header",
      id: `zone:${zone}`,
      text: ZONE_TITLES[zone],
      note: zone === "topLeft" || zone === "topRight" ? "Above the prompt. Sessions only." : "Below the prompt. Home and sessions.",
      level: "group",
    })

    const ids = options.layout[zone]

    for (let index = 0; index < ids.length; index += 1) {
      const widget = ids[index]

      if (widget !== undefined) {
        rows.push({ kind: "widget", id: `widget:${widget}`, widget, zone, position: index + 1, count: ids.length })
      }
    }

    if (ids.length === 0) rows.push({ kind: "note", id: `note:${zone}`, text: "empty" })
  }

  rows.push({ kind: "note", id: "spacer:before:hidden", text: "" })
  rows.push({ kind: "header", id: "zone:hidden", text: "Hidden", note: "Space restores a widget to its default corner.", level: "group" })

  const hidden = hiddenWidgets(options)

  for (const widget of hidden) rows.push({ kind: "widget", id: `widget:${widget}`, widget, zone: undefined, position: 0, count: 0 })

  if (hidden.length === 0) rows.push({ kind: "note", id: "note:hidden", text: "none" })

  return rows
}

/** The Appearance section's rows: one control row per control, in display order. */
export function appearanceRows(): readonly SettingsRow[] {
  return APPEARANCE_CONTROLS.map((control) => ({
    kind: "control" as const,
    id: `control:${control.id}`,
    control,
  }))
}

/** The Overflow section's rows: the preset row, then the full hide-first list. */
export function overflowRows(options: NormalizedStatusOptions): readonly SettingsRow[] {
  const rows: SettingsRow[] = [
    { kind: "preset", id: "overflow:preset" },
    // A blank line separates the preset control from the order it produces,
    // the same way each zone group is set off from the one above it. The
    // heading states the reading direction, and rank is the row's position, so
    // the list itself stays bare widget names.
    { kind: "note", id: "spacer:before:priority", text: "" },
    { kind: "header", id: "priority:order", text: "Hide order", hint: "(hide first ↓ hide last)", level: "group" },
  ]

  for (let index = 0; index < options.overflow.hideFirst.length; index += 1) {
    const widget = options.overflow.hideFirst[index]

    if (widget !== undefined) rows.push({ kind: "priority", id: `priority:${widget}`, widget, position: index + 1 })
  }

  return rows
}

/** One section's rows for the options the editor currently shows. */
export function settingsRows(section: SettingsSection, options: NormalizedStatusOptions): readonly SettingsRow[] {
  switch (section) {
    case "layout":
      return layoutRows(options)
    case "appearance":
      return appearanceRows()
    case "overflow":
      return overflowRows(options)
  }
}

/**
 * The whole editor body as one scrolling list: Layout, Appearance, and
 * Overflow groups under bold section headers, so nothing hides behind a tab.
 * Section switches, spacers, and notes are context; widget, control, preset,
 * and priority rows take the cursor exactly like the per-section lists.
 */
export function editorRows(options: NormalizedStatusOptions): readonly SettingsRow[] {
  return [
    { kind: "header", id: "section:layout", text: "[1] Layout", note: "Arrange widgets around the prompt.", level: "section" },
    ...layoutRows(options),
    { kind: "note", id: "spacer:section:appearance", text: "" },
    { kind: "header", id: "section:appearance", text: "[2] Appearance", note: "Change how footer items look.", level: "section" },
    ...appearanceRows(),
    { kind: "note", id: "spacer:section:overflow", text: "" },
    { kind: "header", id: "section:overflow", text: "[3] Overflow", note: "Choose what survives a narrow row.", level: "section" },
    ...overflowRows(options),
  ]
}

/**
 * The nearest focusable row to `cursor`: the cursor itself when it already
 * sits on a focusable row, otherwise the next one in `direction`, falling back
 * to the nearest one behind. Never leaves the list, and keeps the cursor on
 * the closest focusable row when moving past an end.
 */
export function moveRowCursor(rows: readonly SettingsRow[], cursor: number, direction: 1 | -1): number {
  if (rows.length === 0) return 0

  const start = Math.max(0, Math.min(cursor, rows.length - 1))

  for (let index = start; index >= 0 && index < rows.length; index += direction) {
    const row = rows[index]

    if (row !== undefined && isFocusableRow(row)) return index
  }

  for (let index = start; index >= 0 && index < rows.length; index -= direction) {
    const row = rows[index]

    if (row !== undefined && isFocusableRow(row)) return index
  }

  return start
}

/** A label and a display value for one canonical field, used by conflict messages. */
export interface FieldSummary {
  readonly label: string
  readonly value: string
}

export function fieldSummary(options: NormalizedStatusOptions, field: CanonicalField): FieldSummary {
  switch (field) {
    case "layout.topLeft":
      return { label: "layout top left", value: zoneValue(options.layout.topLeft) }
    case "layout.topRight":
      return { label: "layout top right", value: zoneValue(options.layout.topRight) }
    case "layout.bottomLeft":
      return { label: "layout bottom left", value: zoneValue(options.layout.bottomLeft) }
    case "layout.bottomRight":
      return { label: "layout bottom right", value: zoneValue(options.layout.bottomRight) }
    case "overflow.preset":
      return { label: "priority preset", value: options.overflow.preset }
    case "overflow.hideFirst":
      return { label: "hide first", value: options.overflow.hideFirst.join(" ") }
    default:
      return appearanceFieldSummary(options, field)
  }
}

function controlIdForField(field: CanonicalField): string | undefined {
  switch (field) {
    case "appearance.spinner":
      return "spinner"
    case "appearance.directory.format":
      return "directory.format"
    case "appearance.directory.icon":
      return "directory.icon"
    case "appearance.branch":
      return "branch"
    case "appearance.worktree":
      return "worktree"
    case "appearance.tokens":
      return "tokens"
    case "appearance.cache":
      return "cache"
    case "appearance.cost":
      return "cost"
    case "appearance.bgagent":
      return "bgagent"
    case "appearance.context.format":
      return "context.format"
    case "appearance.context.bar":
      return "context.bar"
    case "appearance.context.label":
      return "context.label"
    case "appearance.context.order":
      return "context.order"
    case "appearance.separator":
      return "separator"
    default:
      return undefined
  }
}

function appearanceFieldSummary(options: NormalizedStatusOptions, field: CanonicalField): FieldSummary {
  const controlId = controlIdForField(field)
  const control = controlId === undefined ? undefined : APPEARANCE_CONTROLS.find((candidate) => candidate.id === controlId)

  if (control === undefined) return { label: field, value: "" }

  return { label: `${control.group} ${control.label}`, value: controlValueText(control, options) }
}

// The section bodies can hold more rows than a short terminal's dialog. The
// window shows `height` rows and follows the cursor minimally: it only moves
// when the cursor would leave it, so scanning with the cursor does not jog
// the view. A non-positive height means unmeasured — show everything and let
// the first measurement correct it.

export function ensureWindowStart(total: number, cursor: number, height: number, start: number): number {
  if (height <= 0 || total <= height) return 0

  const count = Math.min(height, total)
  let next = Math.max(0, Math.min(start, total - count))

  if (cursor < next) next = cursor

  if (cursor >= next + count) next = cursor - count + 1

  return Math.max(0, Math.min(next, total - count))
}

// The editor-facing persistence boundary over `config-file.ts`. Reading maps
// this plugin's matching entries; saving writes exactly the draft's changed
// canonical fields into the latest document, detects conflicts on those
// fields, and returns the normalized options the merged file now resolves to — what
// `onSaved` hands to the live plugin, whose setup options are otherwise a
// snapshot even though OpenCode 2 reloads valid `cli.json` changes.

export interface StatusSettingsEntry {
  /** The entry's package specifier exactly as written. */
  readonly specifier: string
  /** Position in the `plugins` array at read time. */
  readonly index: number
  /** The entry's raw options object; empty for string entries without options. */
  readonly options: JsonObject
  /** False for `-name` disable directives. */
  readonly enabled: boolean
}

export interface StatusSettingsStoreState {
  /** The resolved `cli.json` path, for display and diagnostics. */
  readonly path: string
  /** Every entry that can represent this plugin, in file order. */
  readonly entries: readonly StatusSettingsEntry[]
}

export type StatusSettingsReadResult =
  | { readonly status: "read"; readonly state: StatusSettingsStoreState }
  | { readonly status: "error"; readonly message: string }

export interface StatusSettingsSaveInput {
  /**
   * The entry to update, from a prior read; undefined asks to create this
   * package's normal global entry, an explicit editor action.
   */
  readonly target: StatusSettingsEntry | undefined
  /** The draft's changed canonical fields, with their values in `patch`. */
  readonly changed: readonly CanonicalField[]
  readonly patch: StatusOptionsPatch
  /**
   * True re-bases the conflict comparison onto the latest file values — the
   * editor's explicit "keep my changes" retry after reporting a conflict.
   */
  readonly force?: boolean
}

export type StatusSettingsSaveResult =
  | { readonly status: "saved"; readonly options: NormalizedStatusOptions }
  | {
      readonly status: "conflict"
      /** The edited fields that changed externally; zone arrays are atomic. */
      readonly fields: readonly CanonicalField[]
      /** The normalized options the file resolves to now, for "use the file's values". */
      readonly current: NormalizedStatusOptions
    }
  | { readonly status: "error"; readonly message: string }
  | {
      /** The selected entry disappeared, or a create found an existing entry; re-read and re-target. */
      readonly status: "stale"
      readonly state: StatusSettingsStoreState
    }

export interface StatusSettingsStore {
  /** The latest matching entries; a missing config file reads as none. */
  readonly read: () => Promise<StatusSettingsReadResult>
  readonly save: (input: StatusSettingsSaveInput) => Promise<StatusSettingsSaveResult>
}

export interface CliStatusStoreInput {
  readonly identity: PluginIdentity
  /** Defaults to the current host configuration environment. */
  readonly environment?: CliConfigEnvironment
}

/** The JSON path of one canonical field inside the plugin's options object. */
const FIELD_PATHS: Readonly<Record<CanonicalField, readonly string[]>> = {
  "layout.topLeft": ["layout", "topLeft"],
  "layout.topRight": ["layout", "topRight"],
  "layout.bottomLeft": ["layout", "bottomLeft"],
  "layout.bottomRight": ["layout", "bottomRight"],
  "appearance.spinner": ["appearance", "spinner"],
  "appearance.directory.format": ["appearance", "directory", "format"],
  "appearance.directory.icon": ["appearance", "directory", "icon"],
  "appearance.branch": ["appearance", "branch"],
  "appearance.worktree": ["appearance", "worktree"],
  "appearance.tokens": ["appearance", "tokens"],
  "appearance.cache": ["appearance", "cache"],
  "appearance.cost": ["appearance", "cost"],
  "appearance.bgagent": ["appearance", "bgagent"],
  "appearance.context.format": ["appearance", "context", "format"],
  "appearance.context.bar": ["appearance", "context", "bar"],
  "appearance.context.label": ["appearance", "context", "label"],
  "appearance.context.order": ["appearance", "context", "order"],
  "appearance.separator": ["appearance", "separator"],
  "overflow.preset": ["overflow", "preset"],
  "overflow.hideFirst": ["overflow", "hideFirst"],
}

/** The four layout zones, in canonical order. */
const LAYOUT_FIELDS: readonly CanonicalField[] = [
  "layout.topLeft",
  "layout.topRight",
  "layout.bottomLeft",
  "layout.bottomRight",
]

const PATH_FIELDS = new Map<string, CanonicalField>(CANONICAL_FIELDS.map((field) => [FIELD_PATHS[field].join("."), field]))

/** The canonical field a JSON option path belongs to, if any. */
function fieldForPath(path: readonly string[]): CanonicalField | undefined {
  return PATH_FIELDS.get(path.join("."))
}

/** The plain object at a JSON value, or undefined when it is absent, null, an array, or a primitive. */
function jsonObjectAt(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined

  // SAFETY: after the absent, null, and array guards, `instanceof Object` selects the plain-object member of the JsonValue union — the JSON boundary never yields another object kind — so the re-frame is exact.
  return value instanceof Object ? (value as JsonObject) : undefined
}

/** The raw value at a JSON path inside the entry's options, or undefined when absent. */
function rawValueAt(options: JsonObject, path: readonly string[]): JsonValue | undefined {
  let cursor: JsonValue | undefined = options

  for (const key of path) {
    const container = jsonObjectAt(cursor)

    if (container === undefined) return undefined
    const next: JsonValue | undefined = container[key]

    if (next === undefined) return undefined
    cursor = next
  }

  return cursor
}

/**
 * The canonical value a changed field's patch carries, as JSON. A changed
 * field always has its value in the patch `serializeStatusDraft` built; the
 * guards keep a mismatched pair from writing undefined into the file.
 */
function patchValue(field: CanonicalField, patch: StatusOptionsPatch): JsonValue | undefined {
  switch (field) {
    case "layout.topLeft":
      return patch.layout?.topLeft
    case "layout.topRight":
      return patch.layout?.topRight
    case "layout.bottomLeft":
      return patch.layout?.bottomLeft
    case "layout.bottomRight":
      return patch.layout?.bottomRight
    case "appearance.spinner":
      return patch.appearance?.spinner
    case "appearance.directory.format":
      return patch.appearance?.directory?.format
    case "appearance.directory.icon":
      return patch.appearance?.directory?.icon
    case "appearance.branch":
      return patch.appearance?.branch
    case "appearance.worktree":
      return patch.appearance?.worktree
    case "appearance.tokens":
      return patch.appearance?.tokens
    case "appearance.cache":
      return patch.appearance?.cache
    case "appearance.cost":
      return patch.appearance?.cost
    case "appearance.bgagent":
      return patch.appearance?.bgagent
    case "appearance.context.format":
      return patch.appearance?.context?.format
    case "appearance.context.bar":
      return patch.appearance?.context?.bar
    case "appearance.context.label":
      return patch.appearance?.context?.label
    case "appearance.context.order":
      return patch.appearance?.context?.order
    case "appearance.separator":
      return patch.appearance?.separator
    case "overflow.preset":
      return patch.overflow?.preset
    case "overflow.hideFirst":
      return patch.overflow?.hideFirst
  }
}

function toEntries(matches: readonly PluginEntryMatch[]): readonly StatusSettingsEntry[] {
  return matches.map((match) => ({
    specifier: match.specifier,
    index: match.index,
    options: match.options,
    enabled: match.enabled,
  }))
}

function describeConfigError(error: {
  readonly message: string
  readonly line?: number
  readonly column?: number
}): string {
  const position = error.line === undefined ? "" : ` (line ${error.line}, column ${error.column ?? 1})`

  return `${error.message}${position}`
}

/**
 * The `cli.json`-backed store. The selected entry carries the raw options the
 * editor accepted as its baseline, including invalid or absent fields that
 * normalization would erase. A freshly selected entry supplies a fresh
 * baseline even when it reuses a previous entry's index and specifier.
 */
export function createCliStatusOptionsStore(input: CliStatusStoreInput): StatusSettingsStore {
  const environment = input.environment ?? currentCliConfigEnvironment()
  const identity = input.identity
  const configPath = resolveCliConfigPath(environment).path

  const read = async (): Promise<StatusSettingsReadResult> => {
    const result = await readCliConfig(configPath, identity)

    if (result.status === "error") return { status: "error", message: describeConfigError(result.error) }

    if (result.status === "invalid") return { status: "error", message: describeConfigError(result.error) }

    const entries = toEntries(result.snapshot.matches)

    return { status: "read", state: { path: configPath, entries } }
  }

  const save = async (saveInput: StatusSettingsSaveInput): Promise<StatusSettingsSaveResult> => {
    const fresh = await readCliConfig(configPath, identity)

    if (fresh.status === "error" || fresh.status === "invalid") {
      return { status: "error", message: describeConfigError(fresh.error) }
    }

    const freshEntries = toEntries(fresh.snapshot.matches)
    const target = saveInput.target

    const freshTarget =
      target === undefined
        ? undefined
        : freshEntries.find((entry) => entry.index === target.index && entry.specifier === target.specifier)

    if (target !== undefined && freshTarget === undefined) {
      return { status: "stale", state: { path: configPath, entries: freshEntries } }
    }

    if (target === undefined && freshEntries.length > 0) {
      return { status: "stale", state: { path: configPath, entries: freshEntries } }
    }

    const rawBaseline: JsonObject = target?.options ?? {}

    // "Keep my changes" re-bases the comparison onto the file's latest values,
    // so only a write racing this save can still conflict; every other field
    // keeps the draft's own starting values and is merged per field.
    const conflictBaseline: JsonObject = saveInput.force === true ? (freshTarget?.options ?? {}) : rawBaseline

    const selection: PluginEntrySelection =
      target === undefined
        ? { kind: "create", specifier: PLUGIN_PACKAGE_NAME }
        : { kind: "existing", index: target.index, specifier: target.specifier }

    // Supplying `layout` makes every omitted zone empty, so the first write
    // that makes the layout explicit carries all four zones with the draft's
    // effective arrangement, including default corners.
    // An entry that already has an explicit layout gets only its edited zones,
    // so the other arrays stay whatever the latest document holds.
    const fields = new Set<CanonicalField>(saveInput.changed)

    if (saveInput.patch.layout !== undefined && rawValueAt(rawBaseline, ["layout"]) === undefined) {
      for (const field of LAYOUT_FIELDS) fields.add(field)
    }

    // The priority companion: a custom preset is invalid without its list, so
    // choosing custom always writes both keys; a built-in preset makes a
    // stored list redundant, and selecting one retires it in the same write.
    const overflow = saveInput.patch.overflow

    if (overflow !== undefined && overflow.preset === "custom") fields.add("overflow.hideFirst")

    const changes: ConfigChange[] = []

    for (const field of fields) {
      const value = patchValue(field, saveInput.patch)

      if (value === undefined) continue
      const path = FIELD_PATHS[field]

      changes.push({ path, value, expected: rawValueAt(conflictBaseline, path) })
    }

    if (overflow !== undefined && overflow.preset !== "custom") {
      const path = FIELD_PATHS["overflow.hideFirst"]

      changes.push({ path, value: undefined, expected: rawValueAt(conflictBaseline, path) })
    }

    const result = await savePluginOptions({ path: configPath, identity, selection, changes })
    const mapped = mapSaveResult(result, freshEntries)

    if (mapped !== undefined) return mapped

    if (result.status !== "saved") return { status: "error", message: "The save did not complete" }

    return { status: "saved", options: resolveStatusOptions(result.options).options }
  }

  function mapSaveResult(
    result: Awaited<ReturnType<typeof savePluginOptions>>,
    freshEntries: readonly StatusSettingsEntry[],
  ): StatusSettingsSaveResult | undefined {
    if (result.status === "error" || result.status === "invalid") {
      return { status: "error", message: describeConfigError(result.error) }
    }

    if (result.status === "ambiguous" || result.status === "stale-target") {
      return { status: "stale", state: { path: configPath, entries: freshEntries } }
    }

    if (result.status === "conflict") {
      const fields = result.conflicts
        .map((conflict) => fieldForPath(conflict.path))
        .filter((field): field is CanonicalField => field !== undefined)

      return {
        status: "conflict",
        fields,
        current: resolveStatusOptions(result.options).options,
      }
    }

    return undefined
  }

  return { read, save }
}

// Thin compositions of the options contract's own draft semantics, so the
// dialog's signals stay simple: apply an edit, rebase after a save or a
// "use the file's values" resolution, and serialize the patch a save writes.

export interface DraftState {
  readonly baseline: NormalizedStatusOptions
  readonly current: NormalizedStatusOptions
  readonly changed: ReadonlySet<CanonicalField>
}

/** The draft after one edit, with changed fields recomputed against the baseline. */
export function editDraft(state: DraftState, current: NormalizedStatusOptions): DraftState {
  const draft = updateStatusDraft(startStatusDraft(state.baseline), current)

  return { baseline: state.baseline, current, changed: draft.changed }
}

/**
 * The draft after a successful save: both sides adopt the merged file's
 * settings, so nothing counts as unsaved and later edits diff against what
 * the file actually holds — including any external edits the merge kept.
 */
export function rebaseDraft(options: NormalizedStatusOptions): DraftState {
  return { baseline: options, current: options, changed: new Set<CanonicalField>() }
}

/** Carry only the user's edits onto a freshly selected entry, retaining its other settings. */
export function retargetDraft(state: DraftState, baseline: NormalizedStatusOptions): DraftState {
  let current = baseline

  for (const field of CANONICAL_FIELDS) {
    if (state.changed.has(field)) current = adoptField(current, field, state.current)
  }

  // A preset and its effective order travel together; switching to custom
  // records the preset change without a separate hideFirst change.
  if (state.changed.has("overflow.preset") || state.changed.has("overflow.hideFirst")) {
    current = { ...current, overflow: state.current.overflow }
  }

  return editDraft(rebaseDraft(baseline), current)
}

/**
 * Adopt another configuration's value for specific fields on both sides of
 * the draft: the fields stop counting as edits, and the user's changes to
 * every other field survive untouched. Layout zones are the exception the
 * invariant forces: the adopted zone's widgets are removed from the other
 * three zones, because a widget can only occupy one corner.
 */
export function adoptFields(
  state: DraftState,
  fields: readonly CanonicalField[],
  adopted: NormalizedStatusOptions,
): DraftState {
  let baseline = state.baseline
  let current = state.current

  for (const field of fields) {
    baseline = adoptField(baseline, field, adopted)
    current = adoptField(current, field, adopted)
  }

  return editDraft({ ...state, baseline }, current)
}

function adoptField(
  options: NormalizedStatusOptions,
  field: CanonicalField,
  from: NormalizedStatusOptions,
): NormalizedStatusOptions {
  switch (field) {
    case "layout.topLeft":
      return adoptLayoutZone(options, "topLeft", from)
    case "layout.topRight":
      return adoptLayoutZone(options, "topRight", from)
    case "layout.bottomLeft":
      return adoptLayoutZone(options, "bottomLeft", from)
    case "layout.bottomRight":
      return adoptLayoutZone(options, "bottomRight", from)
    case "appearance.spinner":
      return { ...options, appearance: { ...options.appearance, spinner: from.appearance.spinner } }
    case "appearance.directory.format":
      return {
        ...options,
        appearance: { ...options.appearance, directory: { ...options.appearance.directory, format: from.appearance.directory.format } },
      }
    case "appearance.directory.icon":
      return {
        ...options,
        appearance: {
          ...options.appearance,
          directory: { ...options.appearance.directory, icon: from.appearance.directory.icon },
        },
      }
    case "appearance.branch":
      return { ...options, appearance: { ...options.appearance, branch: from.appearance.branch } }
    case "appearance.worktree":
      return { ...options, appearance: { ...options.appearance, worktree: from.appearance.worktree } }
    case "appearance.tokens":
      return { ...options, appearance: { ...options.appearance, tokens: from.appearance.tokens } }
    case "appearance.cache":
      return { ...options, appearance: { ...options.appearance, cache: from.appearance.cache } }
    case "appearance.cost":
      return { ...options, appearance: { ...options.appearance, cost: from.appearance.cost } }
    case "appearance.bgagent":
      return { ...options, appearance: { ...options.appearance, bgagent: from.appearance.bgagent } }
    case "appearance.context.format":
      return {
        ...options,
        appearance: { ...options.appearance, context: { ...options.appearance.context, format: from.appearance.context.format } },
      }
    case "appearance.context.bar":
      return {
        ...options,
        appearance: { ...options.appearance, context: { ...options.appearance.context, bar: from.appearance.context.bar } },
      }
    case "appearance.context.label":
      return {
        ...options,
        appearance: { ...options.appearance, context: { ...options.appearance.context, label: from.appearance.context.label } },
      }
    case "appearance.context.order":
      return {
        ...options,
        appearance: { ...options.appearance, context: { ...options.appearance.context, order: from.appearance.context.order } },
      }
    case "appearance.separator":
      return { ...options, appearance: { ...options.appearance, separator: from.appearance.separator } }
    case "overflow.preset":
      return { ...options, overflow: { ...options.overflow, preset: from.overflow.preset } }
    case "overflow.hideFirst":
      return { ...options, overflow: { ...options.overflow, hideFirst: from.overflow.hideFirst } }
  }
}

/**
 * Adopt one whole zone from another configuration while keeping the layout
 * invariant: every widget the adopted zone owns is removed from the other
 * three zones, so no widget can ever occupy two corners. A widget the draft
 * had hidden reappears in the adopted zone, exactly as the file places it.
 */
function adoptLayoutZone(
  options: NormalizedStatusOptions,
  zone: ZoneID,
  from: NormalizedStatusOptions,
): NormalizedStatusOptions {
  const adopted = from.layout[zone]

  let layout = options.layout

  for (const other of ZONE_IDS) {
    if (other === zone) continue
    layout = replaceZone(layout, other, layout[other].filter((id) => !adopted.includes(id)))
  }

  return { ...options, layout: replaceZone(layout, zone, adopted) }
}

/** The patch a draft's save writes; the dialog's save wiring and the tests consume it. */
export function draftPatch(state: DraftState): StatusOptionsPatch {
  return serializeStatusDraft({ baseline: state.baseline, current: state.current, changed: state.changed })
}

/** The editor's initial draft for a raw options object from disk or the setup snapshot. */
export function draftFromOptions(options: StatusOptionsInput): DraftState {
  return rebaseDraft(resolveStatusOptions(options).options)
}
