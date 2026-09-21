import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import optionsSchema from "../options.schema.json"
import { resolveCliConfigPath } from "../src/config-file.ts"
import { directoryCandidates, formatWidgets } from "../src/format.ts"
import { composeZoneText, createCellMeasurer, fitRow } from "../src/layout.ts"
import {
  DEFAULT_STATUS_OPTIONS,
  diffStatusOptions,
  resolveStatusOptions,
  serializeStatusDraft,
  startStatusDraft,
  updateStatusDraft,
  validateStatusOptions,
  type OptionValue,
  type StatusSnapshot,
} from "../src/options.ts"
import { createCliStatusOptionsStore, cycleAppearanceControl } from "../src/settings-model.ts"

const CUSTOM_APPEARANCE = {
  directory: { icon: { text: "📁" } },
  branch: { text: "🌿" },
  worktree: { text: "🌳" },
  tokens: { input: "📥", output: "📤" },
  cache: { text: "♻️" },
  cost: { text: "💰" },
  bgagent: { text: "🧑🏽‍💻" },
  separator: { text: " ⚡ " },
}

const SNAPSHOT: StatusSnapshot = {
  sessionID: "ses_custom_text",
  running: false,
  background: { agents: 2 },
  location: { directory: "/home/me/repo", home: "/home/me", branch: "main", worktree: false },
  metrics: { input: 128_000, output: 4_200, cacheShare: 61, cost: 0.42, context: undefined },
  tps: undefined,
}

function appearanceWithText(text: OptionValue) {
  return {
    directory: { icon: { text } },
    branch: { text },
    worktree: { text },
    tokens: { input: text, output: text },
    cache: { text },
    cost: { text },
    bgagent: { text },
    separator: { text },
  }
}

describe("literal appearance text", () => {
  const accepted = ["📁", "★", "\u{f115}", "🧑🏽‍💻", "🇬🇷", "1️⃣", "e\u0301", "日本語", "→ ★", "", "  ", "none", "f115", ":folder:", "U+1F4C1", "\\u{1F4C1}"]
  const rejected = ["\n", "x\r", "\t", "\u0000", "\u001b[31m", "\u007f", "\u0085", "\u2028", "\u2029", "\ud800", "\udfff"]

  test("preserves literal symbols, emoji sequences, text and spaces across every supported setting", () => {
    const schemaPattern = new RegExp(optionsSchema.$defs.literalText.pattern, "u")

    for (const text of accepted) {
      const appearance = appearanceWithText(text)
      const resolved = resolveStatusOptions({ appearance })

      expect(resolved.diagnostics).toEqual([])
      expect(resolved.options.appearance).toMatchObject(appearance)
      expect(schemaPattern.test(text)).toBe(true)
    }
  })

  test("rejects multiline text, terminal controls, malformed Unicode and non-string values", () => {
    const schemaPattern = new RegExp(optionsSchema.$defs.literalText.pattern, "u")

    for (const text of rejected) expect(schemaPattern.test(text)).toBe(false)

    const invalidValues: readonly OptionValue[] = [...rejected, null, 42, true, [], {}, { toString: null }, { toString: "📁" }]

    for (const text of invalidValues) {
      const raw = { appearance: appearanceWithText(text) }
      const resolved = resolveStatusOptions(raw)

      expect(resolved.diagnostics).toHaveLength(8)
      expect(resolved.options.appearance).toEqual(DEFAULT_STATUS_OPTIONS.appearance)
      expect(validateStatusOptions(raw)).toEqual(resolved.diagnostics)
    }
  })

  test("requires the documented custom shape and reports unknown keys", () => {
    const invalidIcons: readonly OptionValue[] = [{}, { text: "📁", typo: true }, { icon: "📁" }, "📁", ["📁"]]
    const invalidLabels: readonly OptionValue[] = [{ input: "↑" }, { output: "↓" }, { text: "↑" }, { input: "↑", output: "↓", typo: true }]

    for (const value of invalidIcons) {
      expect(validateStatusOptions({ appearance: { directory: { icon: value } } }).length).toBeGreaterThan(0)
    }

    for (const value of invalidLabels) {
      expect(validateStatusOptions({ appearance: { tokens: value } }).length).toBeGreaterThan(0)
    }
  })

  test("custom values round-trip through drafts and compare by content", () => {
    const raw = { appearance: CUSTOM_APPEARANCE }
    const options = resolveStatusOptions(raw).options
    const baseline = DEFAULT_STATUS_OPTIONS
    const draft = updateStatusDraft(startStatusDraft(baseline), options)
    const patch = serializeStatusDraft(draft)

    expect(patch.appearance).toEqual(CUSTOM_APPEARANCE)
    expect(resolveStatusOptions(JSON.parse(JSON.stringify({ appearance: patch.appearance }))).options).toEqual(options)
    expect(diffStatusOptions(options, resolveStatusOptions(raw).options).size).toBe(0)
    expect(diffStatusOptions(options, DEFAULT_STATUS_OPTIONS).size).toBe(8)

    const changed = resolveStatusOptions({ appearance: { ...CUSTOM_APPEARANCE, tokens: { input: "📥", output: "↓" } } }).options

    expect([...diffStatusOptions(options, changed)]).toEqual(["appearance.tokens"])
  })

})

describe("custom text rendering and layout", () => {
  const measure = createCellMeasurer()

  test("renders each custom prefix with the original value semantics", () => {
    const { appearance } = resolveStatusOptions({ appearance: CUSTOM_APPEARANCE }).options
    const widgets = formatWidgets(SNAPSHOT, appearance, measure)

    expect(widgets.directory?.text).toBe("📁 repo")
    expect(widgets.branch?.text).toBe("🌿 main")
    expect(widgets.input?.text).toBe("📥 128k")
    expect(widgets.output?.text).toBe("📤 4.2k")
    expect(widgets.cache?.text).toBe("♻️ 61%")
    expect(widgets.cost?.text).toBe("💰 $0.42")
    expect(widgets.bgagent?.text).toBe("🧑🏽‍💻 2 agents")

    for (const widget of Object.values(widgets)) expect(widget.width).toBe(measure(widget.text))
  })

  test("empty text removes prefixes without removing values or adding spaces", () => {
    const { appearance } = resolveStatusOptions({ appearance: appearanceWithText("") }).options
    const widgets = formatWidgets(SNAPSHOT, appearance, measure)

    expect(widgets.directory?.text).toBe("repo")
    expect(widgets.branch?.text).toBe("main")
    expect(widgets.input?.text).toBe("128k")
    expect(widgets.output?.text).toBe("4.2k")
    expect(widgets.cache?.text).toBe("61%")
    expect(widgets.cost?.text).toBe("$0.42")
    expect(widgets.bgagent?.text).toBe("2 agents")
  })

  test("worktree text replaces the folder prefix on every path candidate", () => {
    const { appearance } = resolveStatusOptions({
      appearance: { ...CUSTOM_APPEARANCE, directory: { format: "path", icon: { text: "📁" } } },
    }).options

    const location = { directory: "/home/me/projects/feature/repo", home: "/home/me", branch: "feature", worktree: true }
    const candidates = directoryCandidates(location, appearance, measure)

    expect(candidates.length).toBeGreaterThan(1)

    for (const candidate of candidates) {
      expect(candidate.text.startsWith("🌳 ")).toBe(true)
      expect(candidate.width).toBe(measure(candidate.text))
    }

    const fallback = directoryCandidates(location, { ...appearance, worktree: { text: "" } }, measure)

    expect(fallback[0]?.text.startsWith("📁 ")).toBe(true)
  })

  test("fits wide custom text and exact separators without splitting symbols or leaving dangling separators", () => {
    const { appearance } = resolveStatusOptions({ appearance: CUSTOM_APPEARANCE }).options
    const widgets = formatWidgets(SNAPSHOT, appearance, measure)

    const left = [widgets.directory, widgets.branch, widgets.input, widgets.output, widgets.cache, widgets.cost, widgets.bgagent]
      .filter((widget) => widget !== undefined)

    if (widgets.input === undefined || widgets.output === undefined) throw new Error("Missing token widgets")

    for (const text of [" ⚡ ", "", "::", "🧑🏽‍💻"]) {
      for (let width = 0; width <= 120; width++) {
        const row = fitRow({ width, left, right: [], padding: 0, separator: { text } })

        expect(row.usedWidth).toBeLessThanOrEqual(width)
        expect(row.left.width).toBe(measure(composeZoneText(row.left)))
        expect(row.left.joiners).toHaveLength(Math.max(0, row.left.items.length - 1))

        for (const item of row.left.items) expect(left.some((original) => original.id === item.id && original.text === item.text)).toBe(true)
      }

      const row = fitRow({ width: 200, left: [widgets.input, widgets.output], right: [], separator: { text } })

      expect(composeZoneText(row.left)).toBe(`📥 128k${text}📤 4.2k`)
    }
  })
})

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("custom values survive file saves, unrelated edits and preset replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhanced-composer-custom-"))

  roots.push(root)
  const path = resolveCliConfigPath({ home: root }).path

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{\n// keep this comment\n"plugins": [{"package": "opencode2-enhanced-composer", "options": {"refreshHz": 4}}]\n}')
  const store = createCliStatusOptionsStore({ identity: { packageName: "opencode2-enhanced-composer", directory: join(root, "plugin") }, environment: { home: root } })
  const initial = await store.read()

  if (initial.status !== "read") throw new Error("Could not read fixture")

  const target = initial.state.entries[0]
  const baseline = resolveStatusOptions(target?.options ?? {}).options
  const custom = resolveStatusOptions({ appearance: CUSTOM_APPEARANCE }).options
  const draft = updateStatusDraft(startStatusDraft(baseline), custom)
  const saved = await store.save({ target, changed: [...draft.changed], patch: serializeStatusDraft(draft) })

  expect(saved.status).toBe("saved")
  const reloaded = await store.read()

  if (reloaded.status !== "read") throw new Error("Could not reload fixture")

  const entry = reloaded.state.entries[0]

  expect(entry?.options.appearance).toEqual(CUSTOM_APPEARANCE)
  expect(entry?.options.refreshHz).toBe(4)
  expect(await readFile(path, "utf8")).toContain("// keep this comment")

  const current = resolveStatusOptions(entry?.options ?? {}).options
  const spinnerDraft = updateStatusDraft(startStatusDraft(current), cycleAppearanceControl(current, "spinner", 1))

  expect((await store.save({ target: entry, changed: [...spinnerDraft.changed], patch: serializeStatusDraft(spinnerDraft) })).status).toBe("saved")
  const afterSpinner = await store.read()

  if (afterSpinner.status !== "read") throw new Error("Could not reload spinner edit")

  const spinnerEntry = afterSpinner.state.entries[0]

  expect(spinnerEntry?.options.appearance).toMatchObject(CUSTOM_APPEARANCE)
  const presetDraft = updateStatusDraft(startStatusDraft(custom), DEFAULT_STATUS_OPTIONS)

  expect((await store.save({ target: spinnerEntry, changed: [...presetDraft.changed], patch: serializeStatusDraft(presetDraft) })).status).toBe("saved")
  const afterPresets = await store.read()

  if (afterPresets.status !== "read") throw new Error("Could not reload presets")

  const final = resolveStatusOptions(afterPresets.state.entries[0]?.options ?? {})

  expect(final.diagnostics).toEqual([])
  expect(final.options.appearance.directory.icon).toEqual(DEFAULT_STATUS_OPTIONS.appearance.directory.icon)
  expect(final.options.appearance.tokens).toEqual(DEFAULT_STATUS_OPTIONS.appearance.tokens)
  expect(final.options.appearance.separator).toEqual(DEFAULT_STATUS_OPTIONS.appearance.separator)
})
