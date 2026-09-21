// Stage 3B model tests: the pure draft, layout, appearance, overflow, row, and
// preview operations, plus the `cli.json`-backed settings store driven against
// real fixture files — one atomic save per call, conflicts and stale targets
// reported instead of overwritten, and unrelated options preserved throughout.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveCliConfigPath, readCliConfig, type JsonObject } from "../src/config-file.ts"
import {
  DEFAULT_APPEARANCE,
  DEFAULT_STATUS_OPTIONS,
  OVERFLOW_PRESETS,
  resolveStatusOptions,
  WIDGET_IDS,
  type NormalizedStatusOptions,
  type StatusOptionsPatch,
} from "../src/options.ts"
import {
  APPEARANCE_CONTROLS,
  adoptFields,
  appearanceChoices,
  buildPreviewRows,
  controlValueText,
  cycledChoice,
  createCliStatusOptionsStore,
  cycleAppearanceControl,
  cycleOverflowPreset,
  defaultZoneFor,
  draftFromOptions,
  draftPatch,
  editDraft,
  editorRows,
  ensureWindowStart,
  fieldSummary,
  hiddenWidgets,
  isFocusableRow,
  moveRowCursor,
  moveWidgetToAdjacentZone,
  rebaseDraft,
  retargetDraft,
  reorderHideFirst,
  reorderWidgetWithinZone,
  resolvePluginDirectory,
  rowDescription,
  settingsRows,
  toggleWidgetVisibility,
  widgetZone,
  type DraftState,
  type StatusSettingsEntry,
  type StatusSettingsStore,
} from "../src/settings-model.ts"

const temporaryRoots: string[] = []

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()

    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "enhanced-composer-settings-"))

  temporaryRoots.push(directory)

  return directory
}

async function writeFixture(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf8")
}

function defaults(): NormalizedStatusOptions {
  return resolveStatusOptions({}).options
}

function editDraftWith(state: DraftState, mutate: (options: NormalizedStatusOptions) => NormalizedStatusOptions): DraftState {
  return editDraft(state, mutate(state.current))
}

function storeFor(root: string): StatusSettingsStore {
  return createCliStatusOptionsStore({
    identity: { packageName: "opencode2-enhanced-composer", directory: join(root, "plugin") },
    environment: { home: root },
  })
}

async function readEntries(store: StatusSettingsStore) {
  const result = await store.read()

  if (result.status !== "read") throw new Error(`expected a read, got ${result.status}: ${result.message}`)

  return result.state
}

function saveInput(
  baseline: NormalizedStatusOptions,
  target: StatusSettingsEntry | undefined,
  mutate?: (options: NormalizedStatusOptions) => NormalizedStatusOptions,
  force = false,
) {
  const current = mutate === undefined ? baseline : mutate(baseline)
  const draft = editDraft(rebaseDraft(baseline), current)

  return { target, changed: [...draft.changed], patch: draftPatch(draft), force }
}

async function saveOk(store: StatusSettingsStore, input: ReturnType<typeof saveInput>): Promise<NormalizedStatusOptions> {
  const result = await store.save(input)

  if (result.status !== "saved") throw new Error(`expected a saved result, got ${result.status}`)

  return result.options
}

/** The entry's raw options as the host's own reader resolves them. */
async function pluginOptionsAt(path: string, index: number): Promise<JsonObject> {
  const result = await readCliConfig(path, { packageName: "opencode2-enhanced-composer", directory: "/fixture/plugin" })

  if (result.status !== "ok") throw new Error(`expected a readable config, got ${result.status}`)

  return result.snapshot.matches.find((entry) => entry.index === index)?.options ?? {}
}

function control(id: string) {
  const found = APPEARANCE_CONTROLS.find((candidate) => candidate.id === id)

  if (found === undefined) throw new Error(`missing control ${id}`)

  return found
}

describe("layout operations", () => {
  test("every widget has exactly one default corner", () => {
    const seen = new Set<string>()

    for (const zone of ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const) {
      for (const widget of DEFAULT_STATUS_OPTIONS.layout[zone]) {
        expect(seen.has(widget)).toBe(false)
        seen.add(widget)
        expect(defaultZoneFor(widget)).toBe(zone)
      }
    }

    expect(seen.size).toBe(WIDGET_IDS.length)
    expect(widgetZone(DEFAULT_STATUS_OPTIONS.layout, "spinner")).toBe("topLeft")
    expect(hiddenWidgets(DEFAULT_STATUS_OPTIONS)).toEqual([])
  })

  test("hiding removes the widget everywhere and showing appends it to its default corner", () => {
    const hidden = toggleWidgetVisibility(defaults(), "directory")

    expect(widgetZone(hidden.layout, "directory")).toBeUndefined()
    expect(hiddenWidgets(hidden)).toEqual(["directory"])

    const shown = toggleWidgetVisibility(hidden, "directory")

    expect(shown.layout.bottomLeft).toEqual(["branch", "directory"])
    expect(hiddenWidgets(shown)).toEqual([])
  })

  test("moving cycles through the four corners and wraps; hidden widgets do not move", () => {
    const moved = moveWidgetToAdjacentZone(defaults(), "spinner", 1)

    expect(widgetZone(moved.layout, "spinner")).toBe("topRight")

    const wrapped = moveWidgetToAdjacentZone(moved, "spinner", -1)

    expect(widgetZone(wrapped.layout, "spinner")).toBe("topLeft")

    const hidden = toggleWidgetVisibility(defaults(), "spinner")

    expect(moveWidgetToAdjacentZone(hidden, "spinner", 1)).toBe(hidden)
  })

  test("reordering swaps neighbors within the corner and clamps at the ends", () => {
    const reordered = reorderWidgetWithinZone(defaults(), "directory", 1)

    expect(reordered.layout.bottomLeft).toEqual(["branch", "directory"])

    const clamped = reorderWidgetWithinZone(reordered, "branch", -1)
    const base = defaults()

    expect(clamped).toBe(reordered)
    expect(reorderWidgetWithinZone(base, "context", 1)).toBe(base)
  })
})

describe("appearance controls", () => {
  test("cycling wraps both ways and unknown controls are no-ops", () => {
    const text = cycleAppearanceControl(defaults(), "spinner", 1)

    expect(text.appearance.spinner).toBe("text")
    expect(cycleAppearanceControl(text, "spinner", -1).appearance.spinner).toBe("blocks")

    const wrapped = cycleAppearanceControl(defaults(), "spinner", -1)
    const base = defaults()

    expect(wrapped.appearance.spinner).toBe("braille")
    expect(cycleAppearanceControl(base, "missing", 1)).toBe(base)
  })

  test("context text and bar are separate controls with their own off", () => {
    expect(APPEARANCE_CONTROLS.some((candidate) => candidate.id === "context.bar")).toBe(true)

    // Text cycles tokens -> tokens-percent -> percent -> tokens-limit -> off; bar stays put.
    const combined = cycleAppearanceControl(defaults(), "context.format", 1)

    expect(combined.appearance.context.format).toBe("tokens-percent")
    expect(combined.appearance.context.bar).toBe("slanted")

    const percentage = cycleAppearanceControl(combined, "context.format", 1)

    expect(percentage.appearance.context.format).toBe("percent")
    expect(percentage.appearance.context.bar).toBe("slanted")
    expect(controlValueText(control("context.format"), percentage)).toBe("50%")

    const limits = cycleAppearanceControl(percentage, "context.format", 1)

    expect(limits.appearance.context.format).toBe("tokens-limit")
    expect(limits.appearance.context.bar).toBe("slanted")

    const off = cycleAppearanceControl(limits, "context.format", 1)

    expect(off.appearance.context.format).toBe("off")
    expect(off.appearance.context.bar).toBe("slanted")
    expect(controlValueText(control("context.format"), off)).toBe("off")

    // Bar cycles solid -> slanted -> off; text stays put.
    const barOff = cycleAppearanceControl(defaults(), "context.bar", 1)

    expect(barOff.appearance.context.bar).toBe("off")
    expect(barOff.appearance.context.format).toBe("tokens")
    expect(controlValueText(control("context.bar"), barOff)).toBe("off")
    expect(controlValueText(control("context.bar"), defaults())).toBe("[▰▰▰▱▱]")
  })

  test("context order cycles through all six permutations", () => {
    const first = cycleAppearanceControl(defaults(), "context.order", 1)

    expect(first.appearance.context.order).toBe("bar-label-text")
    expect(controlValueText(control("context.order"), first)).toBe("bar ctx 100k")

    const back = cycleAppearanceControl(first, "context.order", -1)

    expect(back.appearance.context.order).toBe("bar-text-label")

    const last = cycleAppearanceControl(defaults(), "context.order", -1)

    expect(last.appearance.context.order).toBe("label-text-bar")
  })

  test("literal-text controls append a trailing custom choice; other controls do not", () => {
    expect(appearanceChoices(control("branch")).map((choice) => choice.value)).toEqual(["e0a0", "f418", "colon", "custom"])
    expect(appearanceChoices(control("tokens")).at(-1)?.value).toBe("custom")
    expect(appearanceChoices(control("context.order"))).toBe(control("context.order").choices)

    const choices = appearanceChoices(control("branch"))

    expect(cycledChoice(choices, "colon", 1).value).toBe("custom")
    expect(cycledChoice(choices, "e0a0", -1).value).toBe("custom")
    expect(cycledChoice(choices, "custom", 1).value).toBe("e0a0")
    expect(cycledChoice(choices, "custom", -1).value).toBe("colon")
  })

  test("custom values show a readable summary with empty and quoted parts", () => {
    const options = resolveStatusOptions({
      appearance: { branch: { text: "🌿" }, separator: { text: " ⚡ " }, tokens: { input: "", output: "📤" } },
    }).options

    const blank = resolveStatusOptions({ appearance: { tokens: { input: "", output: "" } } }).options

    expect(controlValueText(control("branch"), options)).toBe("🌿 custom")
    expect(controlValueText(control("separator"), options)).toBe('" ⚡ " custom')
    expect(controlValueText(control("tokens"), options)).toBe("empty / 📤 custom")
    expect(controlValueText(control("tokens"), blank)).toBe("empty custom")
    expect(controlValueText(control("directory.icon"), options)).toBe("\u{f115}")
  })

  test("the agent style cycles and shows its count in the preview", () => {
    const text = cycleAppearanceControl(defaults(), "bgagent", 1)

    expect(text.appearance.bgagent).toBe("text")
    expect(controlValueText(control("bgagent"), text)).toBe("1 agent")

    const arrow = cycleAppearanceControl(defaults(), "bgagent", -1)

    expect(arrow.appearance.bgagent).toBe("arrow")
    expect(controlValueText(control("bgagent"), arrow)).toContain("1 agent")
  })

  test("overflow presets adopt their own list; custom keeps the shown list", () => {
    const usage = cycleOverflowPreset(defaults(), 1)

    expect(usage.overflow.preset).toBe("usage-first")
    expect(usage.overflow.hideFirst).toEqual(OVERFLOW_PRESETS["usage-first"])

    const location = cycleOverflowPreset(usage, 1)
    const custom = cycleOverflowPreset(location, 1)

    expect(location.overflow.preset).toBe("location-first")
    expect(custom.overflow.preset).toBe("custom")
    expect(custom.overflow.hideFirst).toEqual(OVERFLOW_PRESETS["location-first"])
  })

  test("reordering the hide-first list converts a built-in preset to custom", () => {
    const custom = reorderHideFirst(defaults(), 0, 1)
    const base = defaults()

    expect(custom.overflow.preset).toBe("custom")
    expect(custom.overflow.hideFirst[0]).toBe("branch")
    expect(custom.overflow.hideFirst[1]).toBe("cost")
    expect(reorderHideFirst(base, 0, -1)).toBe(base)
    expect(reorderHideFirst(base, 10, 1)).toBe(base)
  })

  test("reordering leaves the baseline and the shared presets untouched", () => {
    const baseline = defaults()
    const state = editDraftWith(rebaseDraft(baseline), (options) => reorderHideFirst(options, 0, 1))

    // The draft is a new value, not a view over shared state: the baseline,
    // the rebased baseline, and the exported preset list all stay intact.
    expect(state.baseline.overflow.hideFirst).toEqual(OVERFLOW_PRESETS.balanced)
    expect(baseline.overflow.hideFirst).toEqual(OVERFLOW_PRESETS.balanced)
    expect(state.current.overflow.hideFirst[0]).toBe("branch")
    expect(state.current.overflow.hideFirst[1]).toBe("cost")
    expect([...state.changed]).toEqual(["overflow.preset"])
  })
})

describe("draft semantics", () => {
  test("retargeting keeps only edited fields and adopts fresh settings elsewhere", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => cycleAppearanceControl(options, "spinner", 1))
    const fresh = resolveStatusOptions({ appearance: { separator: "dot" }, overflow: { preset: "usage-first" } }).options
    const retargeted = retargetDraft(state, fresh)

    expect(retargeted.baseline).toBe(fresh)
    expect(retargeted.current.appearance.spinner).toBe("text")
    expect(retargeted.current.appearance.separator).toBe("dot")
    expect(retargeted.current.overflow).toEqual(fresh.overflow)
    expect([...retargeted.changed]).toEqual(["appearance.spinner"])
    expect(retargetDraft(rebaseDraft(defaults()), fresh).changed.size).toBe(0)
  })

  test("retargeting carries an edited custom overflow preset with its order", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => reorderHideFirst(options, 0, 1))
    const fresh = resolveStatusOptions({ overflow: { preset: "usage-first" } }).options
    const retargeted = retargetDraft(state, fresh)

    expect(retargeted.current.overflow).toEqual(state.current.overflow)
    expect(draftPatch(retargeted).overflow).toEqual(state.current.overflow)
    expect(fresh.overflow.hideFirst).toEqual(OVERFLOW_PRESETS["usage-first"])
  })

  test("retargeting a moved widget removes its fresh placement and keeps other fresh zones", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => moveWidgetToAdjacentZone(options, "spinner", 1))

    const fresh = resolveStatusOptions({ layout: {
      ...defaults().layout,
      topLeft: ["bgagent"],
      bottomLeft: ["directory", "branch", "spinner"],
      bottomRight: ["input", "output", "context"],
    } }).options

    const retargeted = retargetDraft(state, fresh)

    expect(retargeted.current.layout.topRight).toEqual(["tps", "spinner"])
    expect(retargeted.current.layout.bottomLeft).toEqual(["directory", "branch"])
    expect(retargeted.current.layout.bottomRight).toEqual(fresh.layout.bottomRight)
    expect(fresh.layout.bottomLeft).toContain("spinner")
    expect([...retargeted.changed]).toEqual(["layout.topRight", "layout.bottomLeft"])
  })

  test("retargeting an edited custom order retains custom when the fresh entry uses a built-in preset", () => {
    const baseline = reorderHideFirst(defaults(), 0, 1)
    const state = editDraftWith(rebaseDraft(baseline), (options) => reorderHideFirst(options, 1, 1))
    const retargeted = retargetDraft(state, defaults())

    expect([...state.changed]).toEqual(["overflow.hideFirst"])
    expect(retargeted.current.overflow).toEqual(state.current.overflow)
    expect(draftPatch(retargeted).overflow?.preset).toBe("custom")
  })

  test("editing and reverting tracks changed fields exactly", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => cycleAppearanceControl(options, "separator", 1))

    expect([...state.changed]).toEqual(["appearance.separator"])

    const reverted = editDraftWith(state, (options) => cycleAppearanceControl(options, "separator", -1))

    expect(reverted.changed.size).toBe(0)
  })

  test("a patch writes only changed sections", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => {
      const hidden = toggleWidgetVisibility(options, "spinner")

      return cycleAppearanceControl(hidden, "spinner", 1)
    })

    const patch: StatusOptionsPatch = draftPatch(state)

    expect(patch.layout).toBeDefined()
    expect(patch.appearance).toEqual({ spinner: "text" })
    expect(patch.overflow).toBeUndefined()
  })

  test("a layout edit does not write appearance settings", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => toggleWidgetVisibility(options, "cost"))
    const patch = draftPatch(state)

    expect(patch.layout).toBeDefined()
    expect(patch.appearance).toBeUndefined()
  })

  test("adoption takes the file's value on both sides of the draft", () => {
    const state = editDraftWith(rebaseDraft(defaults()), (options) => cycleAppearanceControl(options, "spinner", 1))
    const file = cycleAppearanceControl(defaults(), "separator", -1)
    const adopted = adoptFields(state, ["appearance.spinner"], file)

    expect(state.changed.has("appearance.spinner")).toBe(true)
    expect(adopted.changed.size).toBe(0)
    expect(adopted.current.appearance.spinner).toBe(file.appearance.spinner)
  })

  test("adopting a layout zone removes its widgets from the other zones", () => {
    const layout = {
      topLeft: ["directory", "spinner", "bgagent"],
      topRight: ["tps"],
      bottomLeft: ["branch"],
      bottomRight: ["input", "output", "cache", "cost", "context"],
    }

    const baseline = resolveStatusOptions({ layout }).options

    // The user moves "directory" two corners over, out of topLeft.
    const once = moveWidgetToAdjacentZone(baseline, "directory", 1)
    const state = editDraft(rebaseDraft(baseline), moveWidgetToAdjacentZone(once, "directory", 1))

    expect(state.current.layout.bottomLeft).toEqual(["branch", "directory"])

    // The file changed topLeft externally; a reorder alone is a conflict.
    const file = resolveStatusOptions({ layout: { ...layout, topLeft: ["spinner", "directory", "bgagent"] } }).options
    const adopted = adoptFields(state, ["layout.topLeft"], file)

    expect(adopted.current.layout.topLeft).toEqual(file.layout.topLeft)
    expect(adopted.current.layout.bottomLeft).toEqual(["branch"])
    expect([...adopted.changed]).toEqual([])

    const placed = (["topLeft", "topRight", "bottomLeft", "bottomRight"] as const).flatMap(
      (zone) => adopted.current.layout[zone],
    )

    expect(new Set(placed).size).toBe(placed.length)
  })

  test("a draft from raw options starts clean", () => {
    const state = draftFromOptions({ appearance: { separator: "pipe" } })

    expect(state.changed.size).toBe(0)
    expect(state.current.appearance.separator).toBe("pipe")
  })

  test("the plugin directory resolution unwraps the published dist directory and source src directory", () => {
    expect(resolvePluginDirectory("file:///home/me/plugins/opencode2-enhanced-composer/tui.tsx")).toBe(
      "/home/me/plugins/opencode2-enhanced-composer",
    )
    expect(resolvePluginDirectory("file:///home/me/plugins/opencode2-enhanced-composer/dist/tui.js")).toBe(
      "/home/me/plugins/opencode2-enhanced-composer",
    )
    expect(resolvePluginDirectory("file:///home/me/plugins/opencode2-enhanced-composer/src/settings.tsx")).toBe(
      "/home/me/plugins/opencode2-enhanced-composer",
    )
  })
})

describe("editor rows", () => {
  test("layout rows list zones, widgets, and the hidden section", () => {
    const hidden = toggleWidgetVisibility(defaults(), "tps")
    const rows = settingsRows("layout", hidden)
    const widgetRows = rows.filter((row) => row.kind === "widget")

    expect(
      widgetRows.map((row) => (row.kind === "widget" ? `${row.widget}:${row.zone ?? "hidden"}` : "")),
    ).toContain("tps:hidden")
    expect(rows.some((row) => row.kind === "header" && row.text === "Hidden")).toBe(true)
    expect(rows.some((row) => row.kind === "header" && row.note === "Above the prompt. Sessions only.")).toBe(true)
  })

  test("a hidden widget keeps its own description under the Hidden heading", () => {
    const rows = settingsRows("layout", toggleWidgetVisibility(defaults(), "tps"))
    const widget = rows.find((row) => row.kind === "widget" && row.widget === "tps")
    const heading = rows.find((row) => row.kind === "header" && row.text === "Hidden")

    expect(widget === undefined ? "" : rowDescription(widget)).toBe("Live output speed in tokens per second.")
    expect(heading === undefined ? "" : rowDescription(heading)).toBe(
      "Space restores a widget to its default corner.",
    )
  })

  test("appearance rows follow the control catalog", () => {
    const rows = settingsRows("appearance", defaults())

    expect(rows.every((row) => row.kind === "control")).toBe(true)
    expect(rows.length).toBe(APPEARANCE_CONTROLS.length)
  })

  test("overflow rows head the hide-first list with its reading direction", () => {
    const rows = settingsRows("overflow", defaults())
    const priority = rows.filter((row) => row.kind === "priority")

    expect(priority).toHaveLength(WIDGET_IDS.length)
    expect(rows[0]?.kind).toBe("preset")
    // A blank spacer sets the preset control off from the list it produces;
    // the heading states the direction, and the rows themselves carry no rank
    // text — position in the list is rank.
    expect(rows[1]).toEqual({ kind: "note", id: "spacer:before:priority", text: "" })
    expect(rows[2]).toEqual({
      kind: "header",
      id: "priority:order",
      text: "Hide order",
      hint: "(hide first ↓ hide last)",
      level: "group",
    })
    expect(priority.map((row) => (row.kind === "priority" ? row.widget : ""))).toEqual(
      OVERFLOW_PRESETS.balanced.slice(),
    )
  })

  test("cursor movement skips headers and notes and stays on the ends", () => {
    const rows = settingsRows("layout", defaults())
    const first = moveRowCursor(rows, 0, 1)

    expect(rows[first]?.kind).toBe("widget")

    const last = moveRowCursor(rows, rows.length - 1, 1)

    expect(rows[last]?.kind).toBe("widget")
    expect(moveRowCursor(rows, last + 1, 1)).toBe(last)
    expect(moveRowCursor(rows, first - 1, -1)).toBe(first)
  })

  test("the unified editor list carries every focusable row under section headers", () => {
    const rows = editorRows(defaults())
    const sections = rows.filter((row) => row.kind === "header" && row.level === "section")

    expect(sections.map((row) => (row.kind === "header" ? row.text : ""))).toEqual(["[1] Layout", "[2] Appearance", "[3] Overflow"])

    const focusable = rows.filter((row) => isFocusableRow(row))

    // Every widget and priority row, plus the appearance controls and the preset row.
    expect(focusable).toHaveLength(2 * WIDGET_IDS.length + APPEARANCE_CONTROLS.length + 1)

    // Every widget, control, preset, and priority row is reachable by walking
    // the cursor from the top without getting stuck on a spacer or note.
    let cursor = moveRowCursor(rows, 0, 1)
    let visited = 1

    while (visited < focusable.length) {
      const next = moveRowCursor(rows, cursor + 1, 1)

      expect(next).toBeGreaterThan(cursor)
      cursor = next
      visited += 1
    }

    expect(rows[cursor]?.kind).toBe("priority")
  })

  test("the window follows the cursor minimally and clamps", () => {
    expect(ensureWindowStart(20, 3, 5, 0)).toBe(0)
    expect(ensureWindowStart(20, 7, 5, 0)).toBe(3)
    expect(ensureWindowStart(20, 2, 5, 10)).toBe(2)
    expect(ensureWindowStart(3, 2, 5, 0)).toBe(0)
    expect(ensureWindowStart(20, 3, 0, 4)).toBe(0)
  })

  test("field summaries name the field and show its display value", () => {
    expect(fieldSummary(defaults(), "layout.bottomLeft").value).toBe("directory branch")
    expect(fieldSummary(defaults(), "layout.topRight").value).toBe("tps")
    expect(fieldSummary(defaults(), "appearance.spinner")).toEqual({ label: "spinner style", value: "■⬝ blocks" })
    expect(fieldSummary(defaults(), "overflow.hideFirst").value).toBe(OVERFLOW_PRESETS.balanced.join(" "))
  })
})

describe("preview pipeline", () => {
  test("running renders the spinner and the full default arrangement", () => {
    const rows = buildPreviewRows({ options: defaults(), scenario: "running", location: "project", width: 120 })

    expect(rows.top.left.items.map((item) => item.id)).toEqual([...DEFAULT_STATUS_OPTIONS.layout.topLeft])
    expect(rows.top.right.items.map((item) => item.id)).toEqual([...DEFAULT_STATUS_OPTIONS.layout.topRight])
    expect(rows.bottom.left.items.map((item) => item.id)).toEqual([...DEFAULT_STATUS_OPTIONS.layout.bottomLeft])
    expect(rows.bottom.right.items.map((item) => item.id)).toEqual([...DEFAULT_STATUS_OPTIONS.layout.bottomRight])
  })

  test("idle has no spinner and running shows the full default arrangement", () => {
    const idle = buildPreviewRows({ options: defaults(), scenario: "idle", location: "project", width: 120 })
    const running = buildPreviewRows({ options: defaults(), scenario: "running", location: "project", width: 120 })

    expect(idle.top.left.items.map((item) => item.id)).toEqual(["bgagent"])
    expect(running.top.left.items.map((item) => item.id)).toEqual([...DEFAULT_STATUS_OPTIONS.layout.topLeft])
    expect(running.bottom.left.items.map((item) => item.id)).toEqual([...DEFAULT_STATUS_OPTIONS.layout.bottomLeft])
  })

  test("the worktree location marks the directory widget", () => {
    const rows = buildPreviewRows({ options: defaults(), scenario: "running", location: "worktree", width: 120 })
    const directory = rows.bottom.left.items[0]

    expect(directory?.text).toContain("\u{e5fb}")
    expect(directory?.text).not.toContain("\u{f115}")
  })

  test("narrow widths hide by priority without changing representation", () => {
    const rows = buildPreviewRows({ options: defaults(), scenario: "running", location: "project", width: 40 })

    expect(rows.bottom.hidden.length).toBeGreaterThan(0)
    expect(rows.bottom.usedWidth).toBeLessThanOrEqual(rows.bottom.contentWidth)
    expect(rows.top.usedWidth).toBeLessThanOrEqual(rows.top.contentWidth)
  })

  test("the draft's appearance drives the preview", () => {
    const options = cycleAppearanceControl(defaults(), "separator", -1)
    const rows = buildPreviewRows({ options, scenario: "running", location: "project", width: 120 })
    const text = [...rows.bottom.left.joiners, ...rows.bottom.right.joiners].join("")

    expect(text).toContain(" · ")
  })
})

describe("settings store", () => {
  test("each selected entry keeps its own conflict baseline across later reads", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path
    const packageName = "opencode2-enhanced-composer"

    await writeFixture(path, JSON.stringify({ plugins: [packageName] }))

    const store = storeFor(root)
    const original = (await readEntries(store)).entries[0]
    const external = JSON.stringify({ plugins: [{ package: packageName, options: { appearance: { spinner: "text" } } }] })

    await writeFixture(path, external)

    const fresh = (await readEntries(store)).entries[0]
    const originalSave = saveInput(defaults(), original, (options) => cycleAppearanceControl(options, "spinner", -1))

    expect((await store.save(originalSave)).status).toBe("conflict")
    expect(await readFile(path, "utf8")).toBe(external)

    const saved = await saveOk(store, { ...originalSave, target: fresh })

    expect(saved.appearance.spinner).toBe("braille")
  })

  test("treats an empty config directory as the default config location", async () => {
    const root = await fixtureDirectory()

    const store = createCliStatusOptionsStore({
      identity: { packageName: "opencode2-enhanced-composer", directory: join(root, "plugin") },
      environment: { home: root, opencodeConfigDir: "" },
    })

    const state = await readEntries(store)

    expect(state.entries).toEqual([])
    expect(state.path).toBe(resolveCliConfigPath({ home: root }).path)
  })

  test("a missing config reads as no entries", async () => {
    const root = await fixtureDirectory()
    const state = await readEntries(storeFor(root))

    expect(state.entries).toEqual([])
    expect(state.path).toBe(resolveCliConfigPath({ home: root }).path)
  })

  test("a save writes the changed fields in one document edit and preserves unrelated options", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      `{
  // keep this comment
  "theme": "dark",
  "plugins": [
    { "package": "opencode.notifications", "options": { "sound": true } },
    { "package": "opencode2-enhanced-composer", "options": { "refreshHz": 4, "unknownFuture": { "x": 1 } } }
  ]
}
`,
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]

    expect(entry?.specifier).toBe("opencode2-enhanced-composer")

    const baseline = resolveStatusOptions(entry?.options ?? {}).options

    const saved = await saveOk(
      store,
      saveInput(baseline, entry, (options) => cycleAppearanceControl(options, "spinner", 1)),
    )

    expect(saved.appearance.spinner).toBe("text")

    expect(await readFile(path, "utf8")).toContain("// keep this comment")

    const options = await pluginOptionsAt(path, 1)

    expect(options.refreshHz).toBe(4)
    expect(options.unknownFuture).toEqual({ x: 1 })
    expect(resolveStatusOptions(options).options.appearance.spinner).toBe("text")
    expect(await readFile(path, "utf8")).toContain('"opencode.notifications"')
  })

  test("one save writes layout and appearance edits together", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [
          {
            package: "opencode2-enhanced-composer",
            options: { appearance: { spinner: "braille", directory: { icon: { text: "📁" } } }, refreshHz: 4 },
          },
        ],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options

    const saved = await saveOk(
      store,
      saveInput(baseline, entry, (options) =>
        cycleAppearanceControl(moveWidgetToAdjacentZone(options, "spinner", 1), "spinner", 1),
      ),
    )

    expect(saved.layout.topLeft).toEqual(["bgagent"])
    expect(saved.layout.topRight).toContain("spinner")
    expect(saved.appearance.spinner).toBe("blocks")
    expect(saved.appearance.directory.icon).toEqual({ text: "📁" })

    const options = await pluginOptionsAt(path, 0)

    expect(options.refreshHz).toBe(4)
    expect(resolveStatusOptions(options).options.appearance.spinner).toBe("blocks")
    expect(resolveStatusOptions(options).options.layout.topLeft).toEqual(["bgagent"])
  })

  test("a layout edit leaves removed settings as unrelated data", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [{ package: "opencode2-enhanced-composer", options: { spinner: "blocks", spinnerPlacement: "footer" } }],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options

    await saveOk(store, saveInput(baseline, entry, (options) => toggleWidgetVisibility(options, "cost")))

    const options = await pluginOptionsAt(path, 0)

    expect(options.spinner).toBe("blocks")
    expect(options.spinnerPlacement).toBe("footer")
    expect(resolveStatusOptions(options).options.layout.topLeft).toEqual(["spinner", "bgagent"])
    expect(resolveStatusOptions(options).options.layout.bottomRight).not.toContain("cost")
  })

  test("a conflicting external edit is reported and the file stays untouched", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: {} }] }))

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const input = saveInput(baseline, entry, (options) => cycleAppearanceControl(options, "spinner", -1))
    const external = { plugins: [{ package: "opencode2-enhanced-composer", options: { appearance: { spinner: "text" } } }] }

    await writeFixture(path, JSON.stringify(external))

    const result = await store.save(input)

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") throw new Error("unreachable")
    expect(result.fields).toEqual(["appearance.spinner"])
    expect(result.current.appearance.spinner).toBe("text")
    expect(resolveStatusOptions(await pluginOptionsAt(path, 0)).options.appearance.spinner).toBe("text")

    const forced = await saveOk(store, { ...input, force: true })

    expect(forced.appearance.spinner).toBe("braille")
  })

  test("a stale target reports the freshly read entries", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: {} }] }))

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const input = saveInput(baseline, entry, (options) => cycleAppearanceControl(options, "spinner", 1))

    await writeFixture(path, JSON.stringify({ plugins: [] }))

    const result = await store.save(input)

    expect(result.status).toBe("stale")

    if (result.status !== "stale") throw new Error("unreachable")
    expect(result.state.entries).toEqual([])
  })

  test("creating an entry keeps other plugins and writes only the changed section", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: ["opencode.notifications"] }))

    const store = storeFor(root)

    await readEntries(store)
    await saveOk(store, saveInput(defaults(), undefined, (options) => cycleOverflowPreset(options, 1)))

    const text = await readFile(path, "utf8")

    expect(text).toContain('"opencode.notifications"')
    expect(text).toContain('"opencode2-enhanced-composer"')

    const options = await pluginOptionsAt(path, 1)

    expect(options.overflow).toEqual({ preset: "usage-first" })
  })

  test("creating is refused when an entry appeared after the read", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [] }))

    const store = storeFor(root)

    await readEntries(store)
    await writeFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: {} }] }))

    const result = await store.save(saveInput(defaults(), undefined, (options) => cycleOverflowPreset(options, 1)))

    expect(result.status).toBe("stale")
  })

  test("a save with no changes reports the current settings without rewriting", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path
    const text = `{\n  "plugins": [{ "package": "opencode2-enhanced-composer", "options": { "appearance": { "separator": "pipe" } } }]\n}\n`

    await writeFixture(path, text)

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const saved = await saveOk(store, saveInput(baseline, entry))

    expect(saved.appearance.separator).toBe("pipe")
    expect(await readFile(path, "utf8")).toBe(text)
  })

  test("read errors are reported without touching the file", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, "{ not json")

    const store = storeFor(root)
    const read = await store.read()

    expect(read.status).toBe("error")

    const result = await store.save(saveInput(defaults(), undefined))

    expect(result.status).toBe("error")
    expect(await readFile(path, "utf8")).toBe("{ not json")
  })
})

// Supplying `layout` makes every omitted zone empty, so the first save that
// makes the layout explicit must carry all four zones. Which zones get written
// depends on what the entry already had: a missing layout materializes the
// effective arrangement, while an explicit layout only rewrites the zones the
// user edited so the latest document's other arrays survive.

describe("layout materialization", () => {
  const FULL_LAYOUT = resolveStatusOptions({}).options.layout

  test("the first layout write materializes all four zones and keeps unrelated options", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { refreshHz: 4 } }] }))

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]

    const input = saveInput(resolveStatusOptions(entry?.options ?? {}).options, entry, (options) =>
      toggleWidgetVisibility(options, "spinner"),
    )

    expect(input.changed).toEqual(["layout.topLeft"])

    const saved = await saveOk(store, input)
    const written = resolveStatusOptions(await pluginOptionsAt(path, 0)).options

    // The untouched corners keep their effective (default) arrangement and the
    // edited corner is the only difference.
    expect(saved.layout).toEqual({ ...FULL_LAYOUT, topLeft: ["bgagent"] })
    expect(written.layout).toEqual(saved.layout)
    expect(written.appearance.separator).toBe("pipe")
    expect((await pluginOptionsAt(path, 0)).refreshHz).toBe(4)
  })

  test("an explicit layout keeps untouched zones from the latest document", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [
          {
            package: "opencode2-enhanced-composer",
            options: { layout: FULL_LAYOUT, refreshHz: 4 },
          },
        ],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]

    const input = saveInput(resolveStatusOptions(entry?.options ?? {}).options, entry, (options) =>
      toggleWidgetVisibility(options, "spinner"),
    )

    // A disjoint external edit changes an untouched zone and an unrelated
    // option while the draft is open.
    const external = {
      plugins: [
        {
          package: "opencode2-enhanced-composer",
          options: {
            layout: { ...FULL_LAYOUT, bottomRight: ["input", "output", "cache", "context"] },
            refreshHz: 8,
          },
        },
      ],
    }

    await writeFixture(path, JSON.stringify(external))

    const saved = await saveOk(store, input)

    expect(saved.layout.topLeft).toEqual(["bgagent"])
    expect(saved.layout.topRight).toEqual(FULL_LAYOUT.topRight)
    expect(saved.layout.bottomLeft).toEqual(FULL_LAYOUT.bottomLeft)
    expect(saved.layout.bottomRight).toEqual(["input", "output", "cache", "context"])

    const options = await pluginOptionsAt(path, 0)

    expect(options.refreshHz).toBe(8)
    expect(resolveStatusOptions(options).options.layout).toEqual(saved.layout)
  })

  test("an externally edited zone conflicts and rebases with keep-my-changes", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { layout: FULL_LAYOUT } }] }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]

    const input = saveInput(resolveStatusOptions(entry?.options ?? {}).options, entry, (options) =>
      toggleWidgetVisibility(options, "spinner"),
    )

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [{ package: "opencode2-enhanced-composer", options: { layout: { ...FULL_LAYOUT, topLeft: ["spinner", "tps"] } } }],
      }),
    )

    const result = await store.save(input)

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") throw new Error("unreachable")
    expect(result.fields).toEqual(["layout.topLeft"])
    expect(resolveStatusOptions(await pluginOptionsAt(path, 0)).options.layout.topLeft).toEqual(["spinner", "tps"])

    const forced = await saveOk(store, { ...input, force: true })

    expect(forced.layout.topLeft).toEqual(["bgagent"])
    expect(forced.layout.bottomLeft).toEqual(FULL_LAYOUT.bottomLeft)
  })

  test("a layout that appears concurrently conflicts instead of being overwritten", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: {} }] }))

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]

    const input = saveInput(resolveStatusOptions(entry?.options ?? {}).options, entry, (options) =>
      toggleWidgetVisibility(options, "spinner"),
    )

    await writeFixture(
      path,
      JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { layout: FULL_LAYOUT } }] }),
    )

    const result = await store.save(input)

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") throw new Error("unreachable")

    // Only the corner whose value genuinely differs conflicts; the zones the
    // concurrent layout already matches are no-ops, not false conflicts.
    expect(result.fields).toEqual(["layout.topLeft"])
    expect(resolveStatusOptions(await pluginOptionsAt(path, 0)).options.layout).toEqual(FULL_LAYOUT)

    const forced = await saveOk(store, { ...input, force: true })

    expect(forced.layout).toEqual({ ...FULL_LAYOUT, topLeft: ["bgagent"] })
  })

  test("creating an entry writes all four zones for a layout edit", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [] }))

    const store = storeFor(root)
    const draft = editDraft(rebaseDraft(defaults()), toggleWidgetVisibility(defaults(), "spinner"))

    await readEntries(store)

    const saved = await saveOk(store, {
      target: undefined,
      changed: [...draft.changed],
      patch: draftPatch(draft),
      force: false,
    })

    const written = resolveStatusOptions(await pluginOptionsAt(path, 0)).options

    expect(saved.layout).toEqual({ ...FULL_LAYOUT, topLeft: ["bgagent"] })
    expect(written.layout).toEqual(saved.layout)
  })

  test("a missing appearance container needs no materialization", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [{ package: "opencode2-enhanced-composer", options: { refreshHz: 4 } }],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]

    const input = saveInput(resolveStatusOptions(entry?.options ?? {}).options, entry, (options) =>
      cycleAppearanceControl(options, "separator", 1),
    )

    await saveOk(store, input)

    const options = await pluginOptionsAt(path, 0)
    const resolved = resolveStatusOptions(options).options

    expect(options.appearance).toEqual({ separator: "space" })
    expect(options.refreshHz).toBe(4)
    expect(resolved.appearance.separator).toBe("space")
    expect(resolved.appearance.spinner).toBe("blocks")
    expect(resolved.appearance.directory).toEqual(DEFAULT_APPEARANCE.directory)
    expect(resolved.layout).toEqual(FULL_LAYOUT)
  })
})

// `overflow.preset: "custom"` is invalid without its list, and the draft's
// changed-field set carries the preset alone when a reorder switches to
// custom. The store therefore writes the companion list with the preset, and
// retires a stored list when a built-in preset is selected.

describe("overflow materialization", () => {
  const CUSTOM_ORDER = reorderHideFirst(resolveStatusOptions({}).options, 0, 1).overflow.hideFirst

  test("a reorder writes the custom list together with the custom preset", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(path, JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { refreshHz: 4 } }] }))

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const draft = editDraft(rebaseDraft(baseline), reorderHideFirst(baseline, 0, 1))

    expect([...draft.changed]).toEqual(["overflow.preset"])

    const saved = await saveOk(store, {
      target: entry,
      changed: [...draft.changed],
      patch: draftPatch(draft),
      force: false,
    })

    expect(saved.overflow.preset).toBe("custom")
    expect(saved.overflow.hideFirst).toEqual(CUSTOM_ORDER)

    const options = await pluginOptionsAt(path, 0)
    const resolved = resolveStatusOptions(options)

    expect(options.overflow).toEqual({ preset: "custom", hideFirst: CUSTOM_ORDER })
    expect(options.refreshHz).toBe(4)
    // What a reopen reads: the custom preset has its list, so no diagnostics.
    expect(resolved.diagnostics).toEqual([])
  })

  test("selecting a built-in preset retires a stored custom list", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [
          {
            package: "opencode2-enhanced-composer",
            options: { overflow: { preset: "custom", hideFirst: CUSTOM_ORDER }, refreshHz: 4 },
          },
        ],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const draft = editDraft(rebaseDraft(baseline), cycleOverflowPreset(baseline, 1))

    expect(draft.current.overflow.preset).toBe("balanced")
    expect([...draft.changed]).toEqual(["overflow.preset"])

    // A disjoint external edit while the draft is open.
    await writeFixture(
      path,
      JSON.stringify({
        plugins: [
          {
            package: "opencode2-enhanced-composer",
            options: { overflow: { preset: "custom", hideFirst: CUSTOM_ORDER }, refreshHz: 8 },
          },
        ],
      }),
    )

    const saved = await saveOk(store, {
      target: entry,
      changed: [...draft.changed],
      patch: draftPatch(draft),
      force: false,
    })

    expect(saved.overflow).toEqual({ preset: "balanced", hideFirst: OVERFLOW_PRESETS.balanced })

    const options = await pluginOptionsAt(path, 0)

    expect(options.overflow).toEqual({ preset: "balanced" })
    expect(options.refreshHz).toBe(8)
    expect(resolveStatusOptions(options).diagnostics).toEqual([])
  })

  test("switching between built-in presets leaves no list behind", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [{ package: "opencode2-enhanced-composer", options: { overflow: { preset: "usage-first" } } }],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options

    await saveOk(
      store,
      saveInput(baseline, entry, (options) => cycleOverflowPreset(options, 1)),
    )

    const options = await pluginOptionsAt(path, 0)

    expect(options.overflow).toEqual({ preset: "location-first" })
    expect(resolveStatusOptions(options).diagnostics).toEqual([])
  })

  test("editing a custom list writes the list without touching the preset key", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({
        plugins: [
          {
            package: "opencode2-enhanced-composer",
            options: { overflow: { preset: "custom", hideFirst: OVERFLOW_PRESETS.balanced } },
          },
        ],
      }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const draft = editDraft(rebaseDraft(baseline), reorderHideFirst(baseline, 0, 1))

    expect([...draft.changed]).toEqual(["overflow.hideFirst"])

    await saveOk(store, {
      target: entry,
      changed: [...draft.changed],
      patch: draftPatch(draft),
      force: false,
    })

    const options = await pluginOptionsAt(path, 0)

    expect(options.overflow).toEqual({ preset: "custom", hideFirst: CUSTOM_ORDER })
    expect(resolveStatusOptions(options).diagnostics).toEqual([])
  })

  test("a custom list that appears concurrently conflicts only where the values differ", async () => {
    const root = await fixtureDirectory()
    const path = resolveCliConfigPath({ home: root }).path

    await writeFixture(
      path,
      JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { overflow: { preset: "balanced" } } }] }),
    )

    const store = storeFor(root)
    const entry = (await readEntries(store)).entries[0]
    const baseline = resolveStatusOptions(entry?.options ?? {}).options
    const draft = editDraft(rebaseDraft(baseline), reorderHideFirst(baseline, 0, 1))

    const external = { preset: "custom", hideFirst: ["directory", "spinner", "context"] }

    await writeFixture(
      path,
      JSON.stringify({ plugins: [{ package: "opencode2-enhanced-composer", options: { overflow: external } }] }),
    )

    const result = await store.save({
      target: entry,
      changed: [...draft.changed],
      patch: draftPatch(draft),
      force: false,
    })

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") throw new Error("unreachable")

    // The external preset already matches the draft's, so only the list — the
    // field whose value genuinely differs — is reported.
    expect(result.fields).toEqual(["overflow.hideFirst"])
    expect((await pluginOptionsAt(path, 0)).overflow).toEqual(external)

    const forced = await saveOk(store, {
      target: entry,
      changed: [...draft.changed],
      patch: draftPatch(draft),
      force: true,
    })

    expect(forced.overflow).toEqual({ preset: "custom", hideFirst: CUSTOM_ORDER })
    expect((await pluginOptionsAt(path, 0)).overflow).toEqual({ preset: "custom", hideFirst: CUSTOM_ORDER })
  })
})
