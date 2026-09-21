// Tests for the prompt-status configuration contract in `options.ts`.
//
// Stage 1 of the customization plan: registries, defaults, tolerant parsing,
// strict validation, draft semantics, and agreement with
// `options.schema.json`. The host-independent contracts are pinned with type
// witnesses the type checker keeps honest: the status snapshot is declared in
// `options.ts`, while the Stage 2 formatted-widget and fitted-row contracts
// are the canonical ones from `layout.ts`, re-exported by `options.ts`, so
// these witnesses exercise the engine's own shapes.

import { describe, expect, test } from "bun:test"
import optionsSchema from "../options.schema.json"
import { DEFAULT_TPS_OPTIONS } from "../src/tps.ts"
import {
  BGAGENT_STYLES,
  BRANCH_STYLES,
  CACHE_LABELS,
  CANONICAL_FIELDS,
  CONTEXT_BARS,
  CONTEXT_FORMATS,
  CONTEXT_LABELS,
  COST_STYLES,
  DEFAULT_APPEARANCE,
  DEFAULT_LAYOUT,
  DEFAULT_OVERFLOW,
  DEFAULT_STATUS_OPTIONS,
  DIRECTORY_FORMATS,
  DIRECTORY_ICONS,
  METRIC_SEPARATORS,
  METRIC_WIDGET_IDS,
  OVERFLOW_PRESETS,
  OVERFLOW_PRESET_IDS,
  resolveStatusOptions,
  serializeStatusDraft,
  SPINNER_APPEARANCES,
  startStatusDraft,
  TOKEN_LABELS,
  updateStatusDraft,
  validateStatusOptions,
  WIDGET_IDS,
  WORKTREE_MARKERS,
  ZONE_IDS,
  type FittedItem,
  type FittedRow,
  type FittedZone,
  type FormattedWidget,
  type FormattedWidgetSet,
  type MeasureTextWidth,
  type StatusSnapshot,
  type WidgetID,
} from "../src/options.ts"
import { createCellMeasurer, fitRow, type FittedRow as EngineFittedRow } from "../src/layout.ts"

const CANONICAL_EXAMPLE = {
  layout: {
    topLeft: ["spinner", "bgagent"],
    topRight: ["tps"],
    bottomLeft: ["directory", "branch"],
    bottomRight: ["input", "output", "cache", "cost", "context"],
  },
  appearance: {
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
  },
  overflow: { preset: "balanced" },
}

describe("registries", () => {
  test("widgets and zones are stable and complete", () => {
    expect(WIDGET_IDS).toEqual(["spinner", "directory", "branch", "input", "output", "cache", "cost", "context", "tps", "bgagent"])
    expect(ZONE_IDS).toEqual(["topLeft", "topRight", "bottomLeft", "bottomRight"])
    expect(METRIC_WIDGET_IDS).toEqual(["input", "output", "cache", "cost", "context", "tps"])
    expect(CANONICAL_FIELDS).toEqual([
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
    ])
  })

  test("every preset list ranks every widget exactly once", () => {
    for (const preset of OVERFLOW_PRESET_IDS) {
      const list = OVERFLOW_PRESETS[preset]

      expect(new Set(list).size).toBe(WIDGET_IDS.length)
      expect([...list].sort()).toEqual([...WIDGET_IDS].sort())
    }
  })

  test("the preset orders are the shipped hiding priorities", () => {
    expect(OVERFLOW_PRESETS.balanced).toEqual(["cost", "branch", "cache", "output", "input", "tps", "directory", "context", "spinner", "bgagent"])
    expect(OVERFLOW_PRESETS["usage-first"]).toEqual(["branch", "directory", "cost", "cache", "tps", "output", "input", "context", "spinner", "bgagent"])
    expect(OVERFLOW_PRESETS["location-first"]).toEqual(["cost", "cache", "tps", "output", "input", "context", "branch", "directory", "spinner", "bgagent"])
  })
})

describe("resolveStatusOptions defaults", () => {
  test("empty options resolve to the documented defaults without diagnostics", () => {
    const resolution = resolveStatusOptions({})

    expect(resolution.diagnostics).toEqual([])
    expect(resolution.options).toEqual(DEFAULT_STATUS_OPTIONS)
  })

  test("the default arrangement places the location bottom-left", () => {
    expect(DEFAULT_LAYOUT).toEqual({
      topLeft: ["spinner", "bgagent"],
      topRight: ["tps"],
      bottomLeft: ["directory", "branch"],
      bottomRight: ["input", "output", "cache", "cost", "context"],
    })
    expect(DEFAULT_OVERFLOW).toEqual({ preset: "balanced", hideFirst: OVERFLOW_PRESETS.balanced })
  })

  test("the canonical example resolves clean", () => {
    const resolution = resolveStatusOptions(CANONICAL_EXAMPLE)

    expect(resolution.diagnostics).toEqual([])
    expect(resolution.options).toEqual(DEFAULT_STATUS_OPTIONS)
  })
})

describe("layout parsing", () => {
  test("an explicit layout is authoritative and omitted zones are empty", () => {
    const { options, diagnostics } = resolveStatusOptions({ layout: { topLeft: ["directory"] } })

    expect(diagnostics).toEqual([])
    expect(options.layout).toEqual({ topLeft: ["directory"], topRight: [], bottomLeft: [], bottomRight: [] })
  })

  test("an explicitly empty layout hides every widget", () => {
    const { options, diagnostics } = resolveStatusOptions({ layout: {} })

    expect(diagnostics).toEqual([])
    expect(options.layout).toEqual({ topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] })
  })

  test("a widget omitted from every zone is hidden", () => {
    const { options } = resolveStatusOptions({ layout: { bottomRight: ["input", "context"] } })

    expect(options.layout.bottomRight).toEqual(["input", "context"])
    expect(JSON.stringify(options.layout)).not.toContain("cost")
    expect(JSON.stringify(options.layout)).not.toContain("spinner")
  })

  test("zone order is display order", () => {
    const { options } = resolveStatusOptions({ layout: { bottomRight: ["context", "input"] } })

    expect(options.layout.bottomRight).toEqual(["context", "input"])
  })

  test("unknown widget IDs are ignored with a diagnostic", () => {
    const { options, diagnostics } = resolveStatusOptions({ layout: { topLeft: ["spinner", "spin"] } })

    expect(options.layout.topLeft).toEqual(["spinner"])
    expect(diagnostics).toEqual([{ path: "layout.topLeft[1]", message: expect.stringContaining("unknown widget") }])
  })

  test("duplicates keep their first occurrence in zone order", () => {
    const { options, diagnostics } = resolveStatusOptions({
      layout: { topLeft: ["spinner", "directory"], topRight: [], bottomLeft: ["spinner"], bottomRight: ["directory", "directory"] },
    })

    expect(options.layout).toEqual({ topLeft: ["spinner", "directory"], topRight: [], bottomLeft: [], bottomRight: [] })
    expect(diagnostics.map((issue) => issue.path)).toEqual([
      "layout.bottomLeft[0]",
      "layout.bottomRight[0]",
      "layout.bottomRight[1]",
    ])
  })

  test("a non-array zone renders empty with a diagnostic", () => {
    const { options, diagnostics } = resolveStatusOptions({ layout: { topLeft: "spinner" } })

    expect(options.layout.topLeft).toEqual([])
    expect(diagnostics.map((issue) => issue.path)).toEqual(["layout.topLeft"])
  })

  test("a non-object layout falls back to the default arrangement", () => {
    const { options, diagnostics } = resolveStatusOptions({ layout: "rows" })

    expect(options.layout).toEqual(DEFAULT_LAYOUT)
    expect(diagnostics.map((issue) => issue.path)).toEqual(["layout"])
  })

  test("unknown zone keys are reported so a typo cannot silently empty a zone", () => {
    const { options, diagnostics } = resolveStatusOptions({ layout: { topleft: ["spinner"] } })

    expect(options.layout).toEqual({ topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] })
    expect(diagnostics.map((issue) => issue.path)).toEqual(["layout.topleft"])
  })
})

test("removed top-level settings have no effect", () => {
  expect(resolveStatusOptions({ spinner: "none", spinnerPlacement: "footer", folderGlyph: "f74a" }).options).toEqual(DEFAULT_STATUS_OPTIONS)
})

describe("appearance parsing", () => {
  test("missing fields inherit defaults individually", () => {
    const { options, diagnostics } = resolveStatusOptions({ appearance: { separator: "pipe" } })

    expect(diagnostics).toEqual([])
    expect(options.appearance.separator).toBe("pipe")
    expect(options.appearance.spinner).toBe(DEFAULT_APPEARANCE.spinner)
    expect(options.appearance.directory).toEqual(DEFAULT_APPEARANCE.directory)
    expect(options.appearance.context).toEqual(DEFAULT_APPEARANCE.context)
  })

  test("every curated value is accepted", () => {
    const { options, diagnostics } = resolveStatusOptions({
      appearance: {
        spinner: "text",
        directory: { format: "path", icon: "f07c" },
        branch: "colon",
        worktree: "ec7d",
        tokens: "arrows",
        cache: "f49b",
        cost: "labeled",
        bgagent: "ec20",
        context: { format: "off", bar: "slanted", label: "context", order: "bar-text-label" },
        separator: "space",
      },
    })

    expect(diagnostics).toEqual([])
    expect(options.appearance).toEqual({
      spinner: "text",
      directory: { format: "path", icon: "f07c" },
      branch: "colon",
      worktree: "ec7d",
      tokens: "arrows",
      cache: "f49b",
      cost: "labeled",
      bgagent: "ec20",
      context: { format: "off", bar: "slanted", label: "context", order: "bar-text-label" },
      separator: "space",
    })
  })

  test("removed context format bar uses ordinary invalid-value defaults", () => {
    const { options, diagnostics } = resolveStatusOptions({ appearance: { context: { format: "bar", bar: "slanted" } } })

    expect(options.appearance.context).toEqual({
      format: "tokens",
      bar: "slanted",
      label: DEFAULT_APPEARANCE.context.label,
      order: DEFAULT_APPEARANCE.context.order,
    })
    expect(diagnostics.map((issue) => issue.path)).toEqual(["appearance.context.format"])

    const absent = resolveStatusOptions({ appearance: { context: { format: "bar" } } })

    expect(absent.options.appearance.context).toEqual({
      format: "tokens",
      bar: DEFAULT_APPEARANCE.context.bar,
      label: DEFAULT_APPEARANCE.context.label,
      order: DEFAULT_APPEARANCE.context.order,
    })
  })

  test("every context order is accepted and invalid ones fall back", () => {
    for (const order of ["bar-text-label", "bar-label-text", "text-bar-label", "text-label-bar", "label-bar-text", "label-text-bar"] as const) {
      const { options, diagnostics } = resolveStatusOptions({ appearance: { context: { order } } })

      expect(diagnostics).toEqual([])
      expect(options.appearance.context.order).toBe(order)
    }

    const { options, diagnostics } = resolveStatusOptions({ appearance: { context: { order: "tokens-first" } } })

    expect(options.appearance.context.order).toBe(DEFAULT_APPEARANCE.context.order)
    expect(diagnostics.map((issue) => issue.path)).toEqual(["appearance.context.order"])
  })

  test("invalid enum values fall back with diagnostics", () => {
    const { options, diagnostics } = resolveStatusOptions({ appearance: { spinner: "fancy", separator: "dash" } })

    expect(options.appearance.spinner).toBe(DEFAULT_APPEARANCE.spinner)
    expect(options.appearance.separator).toBe(DEFAULT_APPEARANCE.separator)
    expect(diagnostics.map((issue) => issue.path)).toEqual(["appearance.spinner", "appearance.separator"])
  })

  test("a non-object appearance section uses defaults", () => {
    const { options, diagnostics } = resolveStatusOptions({ appearance: "pretty" })

    expect(options.appearance.spinner).toBe("blocks")
    expect(diagnostics.map((issue) => issue.path)).toEqual(["appearance"])
  })

  test("a non-object directory or context section defaults its fields", () => {
    const { options, diagnostics } = resolveStatusOptions({ appearance: { directory: "name", context: 3 } })

    expect(options.appearance.directory).toEqual(DEFAULT_APPEARANCE.directory)
    expect(options.appearance.context).toEqual(DEFAULT_APPEARANCE.context)
    expect(diagnostics.map((issue) => issue.path)).toEqual(["appearance.directory", "appearance.context"])
  })

  test("unknown appearance keys are reported", () => {
    const { options, diagnostics } = resolveStatusOptions({ appearance: { seperator: "pipe" } })

    expect(options.appearance.separator).toBe("pipe")
    expect(diagnostics.map((issue) => issue.path)).toEqual(["appearance.seperator"])
  })
})

describe("overflow parsing", () => {
  test("missing overflow resolves to the balanced preset", () => {
    const { options, diagnostics } = resolveStatusOptions({})

    expect(diagnostics).toEqual([])
    expect(options.overflow).toEqual({ preset: "balanced", hideFirst: OVERFLOW_PRESETS.balanced })
  })

  test.each([...OVERFLOW_PRESET_IDS])("the %s preset resolves to its own list", (preset) => {
    const { options, diagnostics } = resolveStatusOptions({ overflow: { preset } })

    expect(diagnostics).toEqual([])
    expect(options.overflow).toEqual({ preset, hideFirst: OVERFLOW_PRESETS[preset] })
  })

  test("a custom list is kept in order", () => {
    const list: readonly WidgetID[] = ["spinner", "context", "directory", "tps", "input", "output", "cache", "cost", "branch", "bgagent"]
    const { options, diagnostics } = resolveStatusOptions({ overflow: { preset: "custom", hideFirst: list } })

    expect(diagnostics).toEqual([])
    expect(options.overflow).toEqual({ preset: "custom", hideFirst: list })
  })

  test("an incomplete custom list is completed in Balanced order without a diagnostic", () => {
    const { options, diagnostics } = resolveStatusOptions({ overflow: { preset: "custom", hideFirst: ["spinner"] } })

    expect(diagnostics).toEqual([])
    expect(options.overflow.preset).toBe("custom")
    expect(options.overflow.hideFirst).toEqual(["spinner", ...OVERFLOW_PRESETS.balanced.filter((id) => id !== "spinner")])
  })

  test("retired shell entries are reported as unknown", () => {
    const { options, diagnostics } = resolveStatusOptions({ overflow: { preset: "custom", hideFirst: ["shell", "cost"] } })

    expect(diagnostics.map((issue) => issue.path)).toEqual(["overflow.hideFirst[0]"])
    expect(options.overflow.hideFirst[0]).toBe("cost")
    expect(options.overflow.hideFirst).not.toContain("shell")
    expect(options.overflow.hideFirst).toHaveLength(WIDGET_IDS.length)

    const zoned = resolveStatusOptions({ layout: { bottomLeft: ["directory", "shell", "branch"] } })

    expect(zoned.diagnostics.map((issue) => issue.path)).toEqual(["layout.bottomLeft[1]"])
    expect(zoned.options.layout.bottomLeft).toEqual(["directory", "branch"])

    const retired = resolveStatusOptions({
      layout: { topLeft: ["spinner", "bgshell", "bgagent"] },
      appearance: { bgshell: "terminal" },
    })

    expect(retired.diagnostics.map((issue) => issue.path)).toEqual(["layout.topLeft[1]", "appearance.bgshell"])
    expect(retired.options.layout.topLeft).toEqual(["spinner", "bgagent"])
  })

  test("unknown and duplicate custom entries are removed with diagnostics", () => {
    const { options, diagnostics } = resolveStatusOptions({
      overflow: { preset: "custom", hideFirst: ["cost", "bogus", "cost", "branch"] },
    })

    expect(options.overflow.hideFirst).toEqual([
      "cost",
      "branch",
      ...OVERFLOW_PRESETS.balanced.filter((id) => id !== "cost" && id !== "branch"),
    ])
    expect(diagnostics.map((issue) => issue.path)).toEqual(["overflow.hideFirst[1]", "overflow.hideFirst[2]"])
  })

  test("a custom preset without a usable list normalizes to Balanced order", () => {
    const absent = resolveStatusOptions({ overflow: { preset: "custom" } })
    const malformed = resolveStatusOptions({ overflow: { preset: "custom", hideFirst: "cost" } })

    expect(absent.options.overflow).toEqual({ preset: "custom", hideFirst: OVERFLOW_PRESETS.balanced })
    expect(malformed.options.overflow).toEqual({ preset: "custom", hideFirst: OVERFLOW_PRESETS.balanced })
    expect(absent.diagnostics.map((issue) => issue.path)).toEqual(["overflow.hideFirst"])
    expect(malformed.diagnostics.map((issue) => issue.path)).toEqual(["overflow.hideFirst"])
  })

  test("hideFirst is ignored for built-in presets with a diagnostic", () => {
    const { options, diagnostics } = resolveStatusOptions({ overflow: { preset: "usage-first", hideFirst: ["cost"] } })

    expect(options.overflow.hideFirst).toEqual(OVERFLOW_PRESETS["usage-first"])
    expect(diagnostics.map((issue) => issue.path)).toEqual(["overflow.hideFirst"])
  })

  test("hideFirst without a preset is ignored with a diagnostic", () => {
    const { options, diagnostics } = resolveStatusOptions({ overflow: { hideFirst: ["cost"] } })

    expect(options.overflow).toEqual(DEFAULT_OVERFLOW)
    expect(diagnostics.map((issue) => issue.path)).toEqual(["overflow.hideFirst"])
  })

  test("an invalid preset falls back to balanced", () => {
    const { options, diagnostics } = resolveStatusOptions({ overflow: { preset: "newest-first" } })

    expect(options.overflow).toEqual(DEFAULT_OVERFLOW)
    expect(diagnostics.map((issue) => issue.path)).toEqual(["overflow.preset"])
  })
})

describe("validateStatusOptions", () => {
  test("valid input produces no issues", () => {
    expect(validateStatusOptions({})).toEqual([])
    expect(validateStatusOptions(CANONICAL_EXAMPLE)).toEqual([])
    expect(
      validateStatusOptions({
        layout: { topLeft: ["spinner"], bottomLeft: ["directory", "branch"] },
        appearance: { directory: { format: "path" }, context: { format: "off", bar: "slanted" } },
        overflow: { preset: "custom", hideFirst: ["cost"] },
      }),
    ).toEqual([])
  })

  test("unknown top-level options such as tuning keys are accepted", () => {
    expect(validateStatusOptions({ refreshHz: 12, bytesPerToken: 5, futureSetting: "x" })).toEqual([])
  })

  test("reports exactly what a tolerant read would repair or ignore", () => {
    const raw = {
      layout: { topLeft: ["spinner", "spin", "spinner"], extra: true },
      appearance: { spinner: "fancy", colour: "red" },
      overflow: { preset: "custom", priority: "low" },
    }

    const issues = validateStatusOptions(raw)

    expect(issues.map((issue) => issue.path)).toEqual([
      "layout.extra",
      "layout.topLeft[1]",
      "layout.topLeft[2]",
      "appearance.colour",
      "appearance.spinner",
      "overflow.priority",
      "overflow.hideFirst",
    ])
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true)
    expect(resolveStatusOptions(raw).diagnostics).toEqual(issues)
  })
})

describe("draft semantics", () => {
  const baseline = resolveStatusOptions({
    layout: { ...DEFAULT_LAYOUT, topLeft: ["directory", "branch"], bottomLeft: ["spinner", "bgagent"] },
    appearance: { directory: { icon: { text: "📁" } } },
  }).options

  test("a fresh draft has no changes and serializes to an empty patch", () => {
    const draft = startStatusDraft(baseline)

    expect(draft.baseline).toBe(baseline)
    expect(draft.current).toBe(baseline)
    expect(draft.changed.size).toBe(0)
    expect(serializeStatusDraft(draft)).toEqual({})
  })

  test("changed fields are tracked against the baseline", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      appearance: { ...baseline.appearance, separator: "dot" },
    })

    expect([...draft.changed]).toEqual(["appearance.separator"])
  })

  test("editing a field back to the baseline clears it", () => {
    const edited = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      appearance: { ...baseline.appearance, separator: "dot" },
    })

    const restored = updateStatusDraft(edited, baseline)

    expect(restored.changed.size).toBe(0)
    expect(serializeStatusDraft(restored)).toEqual({})
  })

  test("a layout change writes all four zones", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      layout: { topLeft: ["spinner"], topRight: [], bottomLeft: ["directory"], bottomRight: ["tps"] },
    })

    const patch = serializeStatusDraft(draft)

    expect(patch.layout).toEqual({ topLeft: ["spinner"], topRight: [], bottomLeft: ["directory"], bottomRight: ["tps"] })
    expect(patch.appearance).toBeUndefined()
    expect(patch.overflow).toBeUndefined()
  })

  test("layout and spinner style changes serialize together", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      layout: DEFAULT_LAYOUT,
      appearance: { ...baseline.appearance, spinner: "text" },
    })

    const patch = serializeStatusDraft(draft)

    expect(patch.appearance).toEqual({ spinner: "text" })
    expect(patch.layout).toEqual(DEFAULT_LAYOUT)
  })

  test("an icon change writes the icon", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      appearance: {
        ...baseline.appearance,
        directory: { format: "name", icon: "f07b" },
      },
    })

    const patch = serializeStatusDraft(draft)

    expect(patch.appearance).toEqual({ directory: { icon: "f07b" } })
  })

  test("a custom overflow change writes the preset and the list", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      overflow: { preset: "custom", hideFirst: ["cost", ...OVERFLOW_PRESETS.balanced.filter((id) => id !== "cost")] },
    })

    const patch = serializeStatusDraft(draft)

    expect(patch.overflow).toEqual({ preset: "custom", hideFirst: draft.current.overflow.hideFirst })
  })

  test("switching to a built-in preset writes the preset without a list", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), {
      ...baseline,
      overflow: { preset: "location-first", hideFirst: OVERFLOW_PRESETS["location-first"] },
    })

    const patch = serializeStatusDraft(draft)

    expect(patch.overflow).toEqual({ preset: "location-first" })
  })

  test("reset to the defaults serializes every differing field", () => {
    const draft = updateStatusDraft(startStatusDraft(baseline), DEFAULT_STATUS_OPTIONS)
    const patch = serializeStatusDraft(draft)

    expect(patch.layout).toEqual(DEFAULT_LAYOUT)
    expect(patch.appearance).toEqual({ directory: { icon: DEFAULT_STATUS_OPTIONS.appearance.directory.icon } })
    expect(patch.overflow).toBeUndefined()
  })
})

describe("options.schema.json agreement", () => {
  test("documents the same enumerations as runtime parsing", () => {
    const appearance = optionsSchema.$defs.appearance.properties

    expect(appearance.spinner.enum).toEqual([...SPINNER_APPEARANCES])
    expect(appearance.directory.properties.format.enum).toEqual([...DIRECTORY_FORMATS])
    expect(appearance.directory.properties.icon.oneOf[0]?.enum).toEqual([...DIRECTORY_ICONS])
    expect(appearance.branch.oneOf[0]?.enum).toEqual([...BRANCH_STYLES])
    expect(appearance.worktree.oneOf[0]?.enum).toEqual([...WORKTREE_MARKERS])
    expect(appearance.tokens.oneOf[0]?.enum).toEqual([...TOKEN_LABELS])
    expect(appearance.cache.oneOf[0]?.enum).toEqual([...CACHE_LABELS])
    expect(appearance.cost.oneOf[0]?.enum).toEqual([...COST_STYLES])
    expect(appearance.bgagent.oneOf[0]?.enum).toEqual([...BGAGENT_STYLES])
    expect(appearance.context.properties.format.enum).toEqual([...CONTEXT_FORMATS])
    expect(appearance.context.properties.bar.enum).toEqual([...CONTEXT_BARS])
    expect(appearance.context.properties.label.enum).toEqual([...CONTEXT_LABELS])
    expect(appearance.separator.oneOf[0]?.enum).toEqual([...METRIC_SEPARATORS])
    expect(optionsSchema.$defs.overflow.properties.preset.enum).toEqual([...OVERFLOW_PRESET_IDS, "custom"])
    expect(optionsSchema.$defs.widgetID.enum).toEqual([...WIDGET_IDS])
  })

  test("documents the same defaults as runtime parsing", () => {
    const appearance = optionsSchema.$defs.appearance.properties

    expect(appearance.spinner.default).toBe(DEFAULT_APPEARANCE.spinner)
    expect(appearance.directory.properties.format.default).toBe(DEFAULT_APPEARANCE.directory.format)
    expect(appearance.directory.properties.icon.default).toBe(DEFAULT_APPEARANCE.directory.icon)
    expect(appearance.branch.default).toBe(DEFAULT_APPEARANCE.branch)
    expect(appearance.worktree.default).toBe(DEFAULT_APPEARANCE.worktree)
    expect(appearance.tokens.default).toBe(DEFAULT_APPEARANCE.tokens)
    expect(appearance.cache.default).toBe(DEFAULT_APPEARANCE.cache)
    expect(appearance.cost.default).toBe(DEFAULT_APPEARANCE.cost)
    expect(appearance.bgagent.default).toBe(DEFAULT_APPEARANCE.bgagent)
    expect(appearance.context.properties.format.default).toBe(DEFAULT_APPEARANCE.context.format)
    expect(appearance.context.properties.bar.default).toBe(DEFAULT_APPEARANCE.context.bar)
    expect(appearance.context.properties.label.default).toBe(DEFAULT_APPEARANCE.context.label)
    expect(appearance.separator.default).toBe(DEFAULT_APPEARANCE.separator)
    expect(optionsSchema.$defs.layout.default).toEqual({
      topLeft: [...DEFAULT_LAYOUT.topLeft],
      topRight: [...DEFAULT_LAYOUT.topRight],
      bottomLeft: [...DEFAULT_LAYOUT.bottomLeft],
      bottomRight: [...DEFAULT_LAYOUT.bottomRight],
    })
    expect(optionsSchema.$defs.overflow.properties.preset.default).toBe(DEFAULT_OVERFLOW.preset)
    expect(optionsSchema.properties.refreshHz.default).toBe(DEFAULT_TPS_OPTIONS.refreshHz)
    expect(optionsSchema.properties.bytesPerToken.default).toBe(DEFAULT_TPS_OPTIONS.bytesPerToken)
  })
})

describe("host-independent contracts", () => {
  test("a status snapshot keeps availability separate from zero", () => {
    const snapshot: StatusSnapshot = {
      sessionID: "ses_zero_cost",
      running: false,
      background: { agents: 0 },
      location: { directory: "/home/user/repo", home: "/home/user", branch: "main", worktree: false },
      metrics: { input: 0, output: 0, cacheShare: 0, cost: 0, context: undefined },
      tps: undefined,
    }

    expect(snapshot.metrics?.cost).toBe(0)
    expect(snapshot.metrics?.context).toBeUndefined()
    expect(snapshot.tps).toBeUndefined()
  })

  test("formatted widgets carry exact widths and path candidates", () => {
    const widgets = {
      spinner: { id: "spinner", text: "⠋", width: 1 },
      directory: {
        id: "directory",
        text: "~/.../repo",
        width: 10,
        pathCandidates: [
          { text: "~/.../repo", width: 10 },
          { text: "repo", width: 4 },
        ],
      },
      tps: { id: "tps", text: "~52.4 t/s", width: 9 },
    } satisfies FormattedWidgetSet

    expect(widgets.spinner.width).toBe(1)
    expect(widgets.directory.pathCandidates[0]?.text).toBe("~/.../repo")
    expect(widgets.tps.text).toBe("~52.4 t/s")
  })

  test("formatted and fitted widgets are the layout engine's canonical contracts", () => {
    const measure: MeasureTextWidth = createCellMeasurer()

    const directory: FormattedWidget = {
      id: "directory",
      text: "~/.../repo",
      width: measure("~/.../repo"),
      pathCandidates: [
        { text: "~/.../repo", width: measure("~/.../repo") },
        { text: "repo", width: measure("repo") },
      ],
    }

    const tps: FormattedWidget = { id: "tps", text: "~52.4 t/s", width: measure("~52.4 t/s") }
    const input: FormattedWidget = { id: "input", text: "in 128k", width: measure("in 128k") }

    const row: FittedRow = fitRow({ width: 40, left: [directory], right: [tps, input] })
    const canonical: EngineFittedRow = row
    const left: FittedZone = row.left
    const first: FittedItem | undefined = left.items[0]

    expect(canonical).toBe(row)
    expect(first?.text).toBe("~/.../repo")
    expect(first?.width).toBe(measure("~/.../repo"))
    expect(row.right.joiners).toEqual([" · "])
    expect(row.right.width).toBe(tps.width + measure(" · ") + input.width)
    expect(row.hidden).toEqual([])
    expect(row.padding).toBe(1)
    expect(row.usedWidth).toBe(left.width + row.right.width + row.minZoneGap)
  })
})
