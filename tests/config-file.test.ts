// Persistence tests for `config-file.ts`. Every fixture lives in a fresh
// temporary directory; no test reads or writes the developer's real `cli.json`.
import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  currentCliConfigEnvironment,
  diffOptions,
  findPluginEntries,
  hasInlineCliPluginsConfig,
  readCliConfig,
  resolveCliConfigPath,
  savePluginOptions,
  type CliConfigSnapshot,
  type ConfigChange,
  type JsonObject,
  type JsonValue,
  type PluginEntrySelection,
  type PluginIdentity,
  type PluginMatchContext,
  type SavePluginOptionsResult,
} from "../src/config-file.ts"

const PACKAGE_NAME = "opencode2-enhanced-composer"

const UNRELATED_NAME = "opencode.notifications"

const temporaryRoots: string[] = []

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()

    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "enhanced-composer-config-"))

  temporaryRoots.push(directory)

  return directory
}

async function writeFixture(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, "utf8")
}

function identity(directory: string): PluginIdentity {
  return { packageName: PACKAGE_NAME, directory }
}

function matchContext(directory: string, configDirectory: string): PluginMatchContext {
  return { packageName: PACKAGE_NAME, directory, configDirectory }
}

function change(path: readonly string[], value: JsonValue | undefined, expected: JsonValue | undefined): ConfigChange {
  return { path, value, expected }
}

function save(
  path: string,
  pluginDirectory: string,
  selection: PluginEntrySelection,
  changes: readonly ConfigChange[],
): Promise<SavePluginOptionsResult> {
  return savePluginOptions({ path, identity: identity(pluginDirectory), selection, changes })
}

async function readOk(path: string, pluginDirectory: string): Promise<CliConfigSnapshot> {
  const result = await readCliConfig(path, identity(pluginDirectory))

  if (result.status !== "ok") throw new Error(`expected a readable config, got ${result.status}`)

  return result.snapshot
}

describe("resolveCliConfigPath", () => {
  test("defaults to ~/.config/opencode/cli.json", () => {
    const location = resolveCliConfigPath({ home: "/home/me" })

    expect(location.path).toBe("/home/me/.config/opencode/cli.json")
    expect(location.directory).toBe("/home/me/.config/opencode")
    expect(location.source).toBe("home")
  })

  test("honors XDG_CONFIG_HOME", () => {
    const location = resolveCliConfigPath({ home: "/home/me", xdgConfigHome: "/xdg" })

    expect(location.path).toBe("/xdg/opencode/cli.json")
    expect(location.source).toBe("XDG_CONFIG_HOME")
  })

  test("treats an empty XDG_CONFIG_HOME as unset, like the host", () => {
    const location = resolveCliConfigPath({ home: "/home/me", xdgConfigHome: "" })

    expect(location.path).toBe("/home/me/.config/opencode/cli.json")
    expect(location.source).toBe("home")
  })

  test("OPENCODE_CONFIG_DIR replaces the whole opencode directory", () => {
    const location = resolveCliConfigPath({
      home: "/home/me",
      xdgConfigHome: "/xdg",
      opencodeConfigDir: "/custom/opencode",
    })

    expect(location.path).toBe("/custom/opencode/cli.json")
    expect(location.directory).toBe("/custom/opencode")
    expect(location.source).toBe("OPENCODE_CONFIG_DIR")
  })

  test("treats an empty OPENCODE_CONFIG_DIR as unset, like the host", () => {
    const location = resolveCliConfigPath({ home: "/home/me", xdgConfigHome: "/xdg", opencodeConfigDir: "" })

    expect(location.path).toBe("/xdg/opencode/cli.json")
    expect(location.source).toBe("XDG_CONFIG_HOME")
  })

  test("currentCliConfigEnvironment ignores OPENCODE_TEST_HOME for the config root", () => {
    const previous = {
      testHome: process.env.OPENCODE_TEST_HOME,
      xdg: process.env.XDG_CONFIG_HOME,
      configDir: process.env.OPENCODE_CONFIG_DIR,
    }

    process.env.OPENCODE_TEST_HOME = "/tmp/oc-test-home"
    delete process.env.XDG_CONFIG_HOME
    delete process.env.OPENCODE_CONFIG_DIR

    try {
      const environment = currentCliConfigEnvironment()

      expect(environment.home).toBe(homedir())
      expect(environment.xdgConfigHome).toBeUndefined()
      expect(environment.opencodeConfigDir).toBeUndefined()
      expect(resolveCliConfigPath(environment).path).toBe(join(homedir(), ".config", "opencode", "cli.json"))
    } finally {
      if (previous.testHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previous.testHome

      if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous.xdg

      if (previous.configDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous.configDir
    }
  })
})

describe("hasInlineCliPluginsConfig", () => {
  test("recognizes a plugins override in valid JSONC", () => {
    expect(hasInlineCliPluginsConfig('{\n  // supplied by the launcher\n  "plugins": [],\n}')).toBe(true)
  })

  test("recognizes plugin arrays alongside other config", () => {
    expect(
      hasInlineCliPluginsConfig(
        '{ "plugins": [{ "package": "private-plugin", "options": { "color": "blue" } }], "mouse": false }',
      ),
    ).toBe(true)
  })

  test("ignores valid inline config without plugins", () => {
    expect(hasInlineCliPluginsConfig('{ "theme": { "mode": "dark" } }')).toBe(false)
  })

  test("ignores invalid inline config", () => {
    expect(hasInlineCliPluginsConfig('{ "plugins": [ }')).toBe(false)
  })

  test("ignores inline config with a non-array plugins value", () => {
    expect(hasInlineCliPluginsConfig('{ "plugins": { "unexpected": true } }')).toBe(false)
  })

  test("detects plugin arrays without validating their entries", () => {
    for (const content of [
      '{ "plugins": [42] }',
      '{ "plugins": [{ "package": 42 }] }',
      '{ "plugins": [{ "package": "private-plugin", "options": [] }] }',
    ]) {
      expect(hasInlineCliPluginsConfig(content)).toBe(true)
    }
  })

  test("detects plugin arrays independently of unrelated CLI settings", () => {
    for (const content of [
      '{ "plugins": [], "mouse": "enabled" }',
      '{ "plugins": [], "theme": { "mode": "sepia" } }',
      '{ "plugins": [], "keybinds": { "app.exit": true } }',
      '{ "plugins": [], "keybinds": { "leader": true } }',
    ]) {
      expect(hasInlineCliPluginsConfig(content)).toBe(true)
    }
  })

  test("ignores a BOM-prefixed inline config that the host parser rejects", () => {
    expect(hasInlineCliPluginsConfig('\uFEFF{ "plugins": [] }')).toBe(false)
  })

  test("recognizes plugin arrays without validating unrelated config", () => {
    const content = '{ "plugins": [], "theme": { "mode": "high-contrast" } }'

    expect(hasInlineCliPluginsConfig(content)).toBe(true)
    expect(hasInlineCliPluginsConfig('{ "theme": { "mode": "high-contrast" } }')).toBe(false)
  })

  test("ignores absent inline config", () => {
    expect(hasInlineCliPluginsConfig(undefined)).toBe(false)
  })
})

describe("findPluginEntries", () => {
  test("matches registry, versioned, disabled and object entries", () => {
    const entries: JsonValue[] = [
      PACKAGE_NAME,
      `${PACKAGE_NAME}@1.2.3`,
      `-${PACKAGE_NAME}`,
      { package: PACKAGE_NAME, options: { spinner: "blocks" } },
      UNRELATED_NAME,
      { package: "@scope/other", options: {} },
    ]

    const matches = findPluginEntries(entries, matchContext("/plugins/enhanced-composer", "/config"))

    expect(matches.map((match) => match.index)).toEqual([0, 1, 2, 3])
    expect(matches[1]?.specifier).toBe(`${PACKAGE_NAME}@1.2.3`)
    expect(matches[2]?.enabled).toBe(false)
    expect(matches[3]?.options).toEqual({ spinner: "blocks" })
  })

  test("matches scoped package names with and without versions", () => {
    const context: PluginMatchContext = {
      packageName: "@example/opencode-tui",
      directory: "/plugins/tui",
      configDirectory: "/config",
    }

    const matches = findPluginEntries(["@example/opencode-tui@1.0.0", "@example/opencode-tui"], context)

    expect(matches).toHaveLength(2)
    expect(matches[0]?.specifier).toBe("@example/opencode-tui@1.0.0")
  })

  test("marks an object entry whose package field carries the disable prefix", () => {
    const entries: JsonValue[] = [
      { package: `-${PACKAGE_NAME}`, options: { spinner: "blocks" } },
      { package: PACKAGE_NAME, options: {} },
    ]

    const matches = findPluginEntries(entries, matchContext("/plugins/enhanced-composer", "/config"))

    expect(matches).toHaveLength(2)
    expect(matches[0]?.enabled).toBe(false)
    expect(matches[0]?.specifier).toBe(`-${PACKAGE_NAME}`)
    expect(matches[0]?.options).toEqual({ spinner: "blocks" })
    expect(matches[1]?.enabled).toBe(true)
  })

  test("resolves relative, absolute and file entries against the config directory", () => {
    const directory = "/home/me/solo/opencode2-enhanced-composer"
    const context = matchContext(directory, "/home/me/.config/opencode")

    const entries: JsonValue[] = [
      "../../solo/opencode2-enhanced-composer",
      directory,
      pathToFileURL(directory).href,
      "../../solo/other-plugin",
      "./opencode2-enhanced-composer",
    ]

    const matches = findPluginEntries(entries, context)

    expect(matches.map((match) => match.index)).toEqual([0, 1, 2])
    expect(matches[0]?.kind).toBe("path")
  })

  test("follows a symlinked plugin directory", async () => {
    const root = await fixture()
    const real = join(root, "real-plugin")
    const link = join(root, "plugin-link")

    await mkdir(real, { recursive: true })
    await symlink(real, link)

    const matches = findPluginEntries([link], matchContext(real, root))

    expect(matches).toHaveLength(1)
    expect(matches[0]?.kind).toBe("path")
  })
})

describe("readCliConfig", () => {
  test("reports a missing file without failing", async () => {
    const root = await fixture()
    const snapshot = await readOk(join(root, "cli.json"), root)

    expect(snapshot.exists).toBe(false)
    expect(snapshot.document).toEqual({})
    expect(snapshot.plugins).toEqual([])
    expect(snapshot.matches).toEqual([])
  })

  test("reads comments, trailing commas and unrelated settings", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(
      path,
      `{
  // a comment the host accepts
  "theme": { "name": "catppuccin" },
  "plugins": [
    "${PACKAGE_NAME}@0.1.0",
  ],
  "mouse": true,
}
`,
    )

    const snapshot = await readOk(path, root)

    expect(snapshot.exists).toBe(true)
    expect(snapshot.document["theme"]).toEqual({ name: "catppuccin" })
    expect(snapshot.document["mouse"]).toBe(true)
    expect(snapshot.matches).toHaveLength(1)
    expect(snapshot.matches[0]?.specifier).toBe(`${PACKAGE_NAME}@0.1.0`)
    expect(snapshot.matches[0]?.form).toBe("string")
  })

  test("reports the line and column of malformed content", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(
      path,
      `{
  "plugins": [
}
`,
    )

    const result = await readCliConfig(path, identity(root))

    expect(result.status).toBe("invalid")

    if (result.status !== "invalid") return
    expect(result.error.line).toBe(3)
    expect(result.error.column).toBe(1)
  })

  test("rejects a plugins setting that is not an array", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(path, `{ "plugins": {} }\n`)

    const result = await readCliConfig(path, identity(root))

    expect(result.status).toBe("invalid")
  })

  test("rejects entries without a string package field", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(path, `{ "plugins": [{ "options": {} }] }\n`)

    const result = await readCliConfig(path, identity(root))

    expect(result.status).toBe("invalid")
  })

  test("rejects non-object entry options", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(path, `{ "plugins": [{ "package": "other", "options": "compact" }] }\n`)

    const result = await readCliConfig(path, identity(root))

    expect(result.status).toBe("invalid")
  })

  test("reads a file that starts with a byte-order mark", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(path, `\uFEFF{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8 } }] }\n`)

    const snapshot = await readOk(path, root)

    expect(snapshot.exists).toBe(true)
    expect(snapshot.matches).toHaveLength(1)
    expect(snapshot.matches[0]?.options).toEqual({ refreshHz: 8 })
  })

  test("reports positions in the original file when a byte-order mark is present", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(path, '\uFEFF{ "plugins": }')

    const result = await readCliConfig(path, identity(root))

    expect(result.status).toBe("invalid")

    if (result.status !== "invalid") return
    expect(result.error.line).toBe(1)
    expect(result.error.column).toBe(15)
  })

  test("treats an empty file as invalid rather than missing", async () => {
    const root = await fixture()
    const path = join(root, "cli.json")

    await writeFixture(path, "")

    const result = await readCliConfig(path, identity(root))

    expect(result.status).toBe("invalid")
  })

  test("surfaces read failures that are not a missing file", async () => {
    const root = await fixture()
    const result = await readCliConfig(root, identity(root))

    expect(result.status).toBe("error")
  })
})

describe("diffOptions", () => {
  test("walks nested objects and treats arrays as atomic", () => {
    const baseline: JsonObject = {
      layout: { topLeft: ["spinner"] },
      appearance: { spinner: "braille" },
      tps: { refreshHz: 8 },
    }

    const draft: JsonObject = {
      layout: { topLeft: ["spinner", "tps"] },
      appearance: { spinner: "blocks" },
      tps: { refreshHz: 8 },
    }

    expect(diffOptions(baseline, draft)).toEqual([
      { path: ["layout", "topLeft"], value: ["spinner", "tps"], expected: ["spinner"] },
      { path: ["appearance", "spinner"], value: "blocks", expected: "braille" },
    ])
  })

  test("emits a leaf per field when the baseline had no container", () => {
    expect(diffOptions({}, { overflow: { preset: "balanced" } })).toEqual([
      { path: ["overflow", "preset"], value: "balanced", expected: undefined },
    ])
  })

  test("replaces a scalar with an object as one change", () => {
    expect(diffOptions({ overflow: "custom" }, { overflow: { preset: "balanced" } })).toEqual([
      { path: ["overflow"], value: { preset: "balanced" }, expected: "custom" },
    ])
  })

  test("returns nothing when the draft matches the baseline", () => {
    const options: JsonObject = { layout: { topLeft: [] }, appearance: { spinner: "text" } }

    expect(diffOptions(options, { layout: { topLeft: [] }, appearance: { spinner: "text" } })).toEqual([])
  })

  test("emits a deletion when the draft drops a baseline leaf", () => {
    const baseline: JsonObject = { appearance: { spinner: "blocks" }, refreshHz: 8 }
    const changes = diffOptions(baseline, { appearance: { spinner: "blocks" } })

    expect(changes.map((entry) => [entry.path.join("."), entry.value, entry.expected])).toEqual([["refreshHz", undefined, 8]])
  })

  test("emits a deletion inside a nested object without touching its siblings", () => {
    const baseline: JsonObject = { appearance: { directory: { icon: "f115", folderGlyph: "f001" }, spinner: "blocks" } }
    const changes = diffOptions(baseline, { appearance: { directory: { icon: "f115" }, spinner: "blocks" } })

    expect(changes.map((entry) => [entry.path.join("."), entry.value, entry.expected])).toEqual([
      ["appearance.directory.folderGlyph", undefined, "f001"],
    ])
  })

  test("deletes a dropped object subtree as one change", () => {
    const changes = diffOptions({ legacy: { a: 1, b: 2 }, keep: true }, { keep: true })

    expect(changes.map((entry) => [entry.path.join("."), entry.value, entry.expected])).toEqual([
      ["legacy", undefined, { a: 1, b: 2 }],
    ])
  })
})

describe("savePluginOptions", () => {
  test("creates a missing config with an explicit plugin entry", async () => {
    const root = await fixture()
    const configDirectory = join(root, "config")
    const configPath = join(configDirectory, "cli.json")
    const pluginDirectory = join(root, "plugin")

    await mkdir(pluginDirectory, { recursive: true })

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [
      change(["layout", "topLeft"], ["spinner"], undefined),
      change(["appearance", "spinner"], "braille", undefined),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.changed).toBe(true)
    expect(result.index).toBe(0)

    const text = await readFile(configPath, "utf8")

    expect(text.endsWith("\n")).toBe(true)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches).toHaveLength(1)
    expect(snapshot.matches[0]?.options).toEqual({
      layout: { topLeft: ["spinner"] },
      appearance: { spinner: "braille" },
    })
  })

  test("creates the plugins setting when it is absent", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "theme": { "name": "catppuccin" } }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.document["theme"]).toEqual({ name: "catppuccin" })
    expect(snapshot.matches).toHaveLength(1)
    expect(snapshot.matches[0]?.options).toEqual({ appearance: { spinner: "blocks" } })
  })

  test("appends to an empty plugins array", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": [] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches).toHaveLength(1)
  })

  test("promotes a string entry without changing its specifier", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const specifier = `${PACKAGE_NAME}@0.1.0`

    await writeFixture(
      configPath,
      `{
  // keep me
  "theme": { "name": "catppuccin" },
  "plugins": [
    "${specifier}", // pinned
  ],
}
`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain("// keep me")
    expect(text).toContain("// pinned")
    expect(text).toContain(`"catppuccin"`)
    expect(text).toContain(`"package": "${specifier}"`)

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches).toHaveLength(1)
    expect(snapshot.matches[0]?.form).toBe("object")
    expect(snapshot.matches[0]?.options).toEqual({ appearance: { spinner: "blocks" } })
  })

  test("merges changed fields and preserves unedited options and comments", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{
  "plugins": [
    {
      "package": "${PACKAGE_NAME}",
      "options": {
        // tuning the editor must not touch
        "refreshHz": 12,
        "futureSetting": true,
        "custom": { "keep": 1 }
      }
    }
  ]
}
`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "branch"], "colon", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain("// tuning the editor must not touch")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({
      refreshHz: 12,
      futureSetting: true,
      custom: { keep: 1 },
      appearance: { branch: "colon" },
    })
  })

  test("serializes concurrent saves so disjoint changes both persist", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const selection = { kind: "existing", index: 0, specifier: PACKAGE_NAME } as const

    await writeFixture(configPath, `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": {} }] }\n`)

    const [spinner, branch] = await Promise.all([
      save(configPath, pluginDirectory, selection, [change(["appearance", "spinner"], "blocks", undefined)]),
      save(configPath, pluginDirectory, selection, [change(["appearance", "branch"], "colon", undefined)]),
    ])

    expect(spinner.status).toBe("saved")
    expect(branch.status).toBe("saved")
    expect((await readOk(configPath, pluginDirectory)).matches[0]?.options).toEqual({
      appearance: { spinner: "blocks", branch: "colon" },
    })
  })

  test("keeps unrelated values another writer added after the read", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{
  "theme": { "name": "tokyonight" },
  "tabs": { "indicators": "numbers" },
  "plugins": [
    { "package": "other-plugin", "options": { "compact": true } },
    { "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8 } }
  ],
  "mouse": false
}
`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 1, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "text", undefined),
    ])

    expect(result.status).toBe("saved")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.document["theme"]).toEqual({ name: "tokyonight" })
    expect(snapshot.document["tabs"]).toEqual({ indicators: "numbers" })
    expect(snapshot.document["mouse"]).toBe(false)
    expect(snapshot.plugins[0]).toEqual({ package: "other-plugin", options: { compact: true } })
    expect(snapshot.matches[0]?.options).toEqual({ refreshHz: 8, appearance: { spinner: "text" } })
  })

  test("reports a conflict on an externally edited field without writing", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": { "topLeft": ["spinner"] } } }] }\n`,
    )

    const external = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": { "topLeft": ["directory"] } } }] }\n`

    await writeFile(configPath, external, "utf8")

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["layout", "topLeft"], ["spinner", "tps"], ["spinner"]),
    ])

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") return
    expect(result.conflicts).toEqual([
      { path: ["layout", "topLeft"], expected: ["spinner"], value: ["spinner", "tps"], actual: ["directory"] },
    ])
    expect(await readFile(configPath, "utf8")).toBe(external)
  })

  test("reports a conflict when a parent object became a scalar", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": {} }] }\n`)

    // The draft started with no layout; an external writer gave the field a
    // scalar value before the save, so the draft can no longer descend into it.
    const external = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": "custom" } }] }\n`

    await writeFile(configPath, external, "utf8")

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["layout", "topLeft"], ["spinner"], undefined),
    ])

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") return
    expect(result.conflicts).toEqual([
      { path: ["layout", "topLeft"], expected: undefined, value: ["spinner"], actual: "custom" },
    ])
    expect(await readFile(configPath, "utf8")).toBe(external)
  })

  test("reports the blocking value when an edited field's parent changed", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": { "topLeft": ["spinner"] } } }] }\n`,
    )

    const external = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": "compact" } }] }\n`

    await writeFile(configPath, external, "utf8")

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["layout", "topLeft"], ["spinner", "tps"], ["spinner"]),
    ])

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") return
    expect(result.conflicts).toEqual([
      { path: ["layout", "topLeft"], expected: ["spinner"], value: ["spinner", "tps"], actual: "compact" },
    ])
    expect(await readFile(configPath, "utf8")).toBe(external)
  })

  test("merges edits to sibling fields while an array changed elsewhere", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": { "topLeft": ["spinner"], "topRight": ["tps"] } } }] }\n`,
    )

    await writeFile(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "layout": { "topLeft": ["directory"], "topRight": ["tps"] } } }] }\n`,
      "utf8",
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["layout", "topRight"], ["context"], ["tps"]),
    ])

    expect(result.status).toBe("saved")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({ layout: { topLeft: ["directory"], topRight: ["context"] } })
  })

  test("a change that is already present is a no-op save", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const text = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "appearance": { "spinner": "blocks" } } }] }\n`

    await writeFixture(configPath, text)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", "braille"),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.changed).toBe(false)
    expect(await readFile(configPath, "utf8")).toBe(text)
  })

  test("merges a deletion with a disjoint external edit in one atomic save", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{
  "plugins": [
    {
      "package": "${PACKAGE_NAME}",
      "options": {
        // tuning the editor does not touch
        "refreshHz": 8,
        // legacy layout flag
        "spinnerPlacement": "footer",
        "futureSetting": true
      }
    }
  ]
}
`,
    )

    // Another writer changed a field the draft never touched.
    await writeFile(
      configPath,
      `{
  "plugins": [
    {
      "package": "${PACKAGE_NAME}",
      "options": {
        // tuning the editor does not touch
        "refreshHz": 8,
        // legacy layout flag
        "spinnerPlacement": "footer",
        "futureSetting": false
      }
    }
  ]
}
`,
      "utf8",
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["spinnerPlacement"], undefined, "footer"),
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain("// tuning the editor does not touch")
    expect(text).not.toContain("spinnerPlacement")
    expect(text).not.toContain("// legacy layout flag")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({ refreshHz: 8, futureSetting: false, appearance: { spinner: "blocks" } })
  })

  test("deletes a legacy key without disturbing the byte-order mark or CRLF endings", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `\uFEFF{\r\n  "plugins": [\r\n    {\r\n      "package": "${PACKAGE_NAME}",\r\n      "options": {\r\n        // tuning kept\r\n        "refreshHz": 8,\r\n        // legacy to retire\r\n        "spinnerPlacement": "footer",\r\n        "futureSetting": true\r\n      }\r\n    }\r\n  ]\r\n}\r\n`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["spinnerPlacement"], undefined, "footer"),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text.startsWith("\uFEFF")).toBe(true)
    expect(text).toContain("// tuning kept")
    expect(text).not.toContain("spinnerPlacement")
    expect(text.replaceAll("\r\n", "")).not.toContain("\n")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({ refreshHz: 8, futureSetting: true })
  })

  test("reports a conflict when the field to delete changed externally", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "spinnerPlacement": "footer" } }] }\n`,
    )

    const external = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "spinnerPlacement": "composer" } }] }\n`

    await writeFile(configPath, external, "utf8")

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["spinnerPlacement"], undefined, "footer"),
    ])

    expect(result.status).toBe("conflict")

    if (result.status !== "conflict") return
    const conflict = result.conflicts[0]

    expect(conflict?.path).toEqual(["spinnerPlacement"])
    expect(conflict?.expected).toBe("footer")
    expect(conflict?.value).toBeUndefined()
    expect(conflict?.actual).toBe("composer")
    expect(await readFile(configPath, "utf8")).toBe(external)
  })

  test("treats a deletion of an already removed field as a no-op save", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const text = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8 } }] }\n`

    await writeFixture(configPath, text)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["spinnerPlacement"], undefined, "footer"),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.changed).toBe(false)
    expect(result.options).toEqual({ refreshHz: 8 })
    expect(await readFile(configPath, "utf8")).toBe(text)
  })

  test("removes a nested legacy scalar while keeping sibling options and comments", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{
  "plugins": [
    {
      "package": "${PACKAGE_NAME}",
      "options": {
        "appearance": {
          // icon the user chose
          "directory": {
            "icon": "f115",
            "folderGlyph": "f001"
          },
          "spinner": "blocks"
        }
      }
    }
  ]
}
`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "directory", "folderGlyph"], undefined, "f001"),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain("// icon the user chose")
    expect(text).not.toContain("folderGlyph")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({ appearance: { directory: { icon: "f115" }, spinner: "blocks" } })
  })

  test("keeps an emptied options object after deleting its only field", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "spinnerPlacement": "footer" } }] }\n`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["spinnerPlacement"], undefined, "footer"),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.options).toEqual({})

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({})
  })

  test("clears the options object when the empty path is deleted", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8, "legacy": true } }] }\n`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change([], undefined, { refreshHz: 8, legacy: true }),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.options).toEqual({})

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({})
  })

  test("rejects an unsafe deletion path without writing", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const text = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8 } }] }\n`

    await writeFixture(configPath, text)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["refreshHz"], 12, 8),
      change(["__proto__"], undefined, undefined),
    ])

    expect(result.status).toBe("invalid")
    expect(await readFile(configPath, "utf8")).toBe(text)
  })

  test("returns stale-target when the selected entry disappeared", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": ["other-plugin"] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("stale-target")

    if (result.status !== "stale-target") return
    expect(result.matches).toEqual([])
  })

  test("updates the explicitly selected entry when the specifier appears twice", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": ["${PACKAGE_NAME}", "${PACKAGE_NAME}"] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 1, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.index).toBe(1)

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.plugins[0]).toBe(PACKAGE_NAME)
    expect(snapshot.matches[0]?.options).toEqual({})
    expect(snapshot.matches[1]?.options).toEqual({ appearance: { spinner: "blocks" } })
  })

  test("relocates a save when the unique match moved to another index", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": ["other-plugin", "${PACKAGE_NAME}"] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.index).toBe(1)

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.plugins[0]).toBe("other-plugin")
    expect(snapshot.matches[0]?.options).toEqual({ appearance: { spinner: "blocks" } })
  })

  test("stays ambiguous when the stale index cannot identify either duplicate", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": ["other-plugin", "${PACKAGE_NAME}", "${PACKAGE_NAME}"] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("ambiguous")

    if (result.status !== "ambiguous") return
    expect(result.matches).toHaveLength(2)
  })

  test("refuses to create another entry for an already configured plugin", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": ["${PACKAGE_NAME}"] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("ambiguous")

    if (result.status !== "ambiguous") return
    expect(result.matches).toHaveLength(1)
  })

  test("leaves a malformed config untouched", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const text = `{ "plugins": [\n`

    await writeFixture(configPath, text)

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("invalid")
    expect(await readFile(configPath, "utf8")).toBe(text)
  })

  test("writes through a symlinked config without replacing the link", async () => {
    const root = await fixture()
    const configDirectory = join(root, "config")
    const target = join(root, "dotfiles", "cli.json")
    const link = join(configDirectory, "cli.json")
    const pluginDirectory = root

    await mkdir(configDirectory, { recursive: true })
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `{ "theme": { "name": "catppuccin" } }\n`, "utf8")
    await symlink(target, link)

    const result = await save(link, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")
    expect((await lstat(link)).isSymbolicLink()).toBe(true)

    const snapshot = await readOk(target, pluginDirectory)

    expect(snapshot.document["theme"]).toEqual({ name: "catppuccin" })
    expect(snapshot.matches).toHaveLength(1)
  })

  test("writes through a dangling symlink and creates its target", async () => {
    const root = await fixture()
    const configDirectory = join(root, "config")
    const target = join(root, "dotfiles", "cli.json")
    const link = join(configDirectory, "cli.json")
    const pluginDirectory = root

    await mkdir(configDirectory, { recursive: true })
    await mkdir(dirname(target), { recursive: true })
    await symlink(target, link)

    const result = await save(link, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")
    expect((await lstat(link)).isSymbolicLink()).toBe(true)

    const snapshot = await readOk(target, pluginDirectory)

    expect(snapshot.matches).toHaveLength(1)
  })

  test("creates the config through a symlinked directory", async () => {
    const root = await fixture()
    const realConfig = join(root, "real-config")
    const linkedConfig = join(root, "linked-config")
    const pluginDirectory = join(root, "plugin")

    await mkdir(realConfig, { recursive: true })
    await mkdir(pluginDirectory, { recursive: true })
    await symlink(realConfig, linkedConfig)

    const result = await save(join(linkedConfig, "cli.json"), pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")
    expect((await lstat(linkedConfig)).isSymbolicLink()).toBe(true)

    const snapshot = await readOk(join(realConfig, "cli.json"), pluginDirectory)

    expect(snapshot.matches).toHaveLength(1)
  })

  test("updates an entry written as a relative path", async () => {
    const root = await fixture()
    const configDirectory = join(root, "config")
    const configPath = join(configDirectory, "cli.json")
    const pluginDirectory = join(root, "plugin")

    await mkdir(pluginDirectory, { recursive: true })
    await writeFixture(configPath, `{ "plugins": ["../plugin"] }\n`)

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.specifier).toBe("../plugin")

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: "../plugin" }, [
      change(["appearance", "branch"], "e0a0", undefined),
    ])

    expect(result.status).toBe("saved")

    const updated = await readOk(configPath, pluginDirectory)

    expect(updated.matches[0]?.options).toEqual({ appearance: { branch: "e0a0" } })
  })

  test("updates a plugin entry written as a file URL", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = join(root, "plugin")
    const specifier = pathToFileURL(pluginDirectory).href

    await mkdir(pluginDirectory, { recursive: true })
    await writeFixture(configPath, `{ "plugins": ["${specifier}"] }\n`)

    const before = await readOk(configPath, pluginDirectory)

    expect(before.matches[0]?.kind).toBe("path")

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier }, [
      change(["appearance", "spinner"], "text", undefined),
    ])

    expect(result.status).toBe("saved")

    const after = await readOk(configPath, pluginDirectory)

    expect(after.matches[0]?.options).toEqual({ appearance: { spinner: "text" } })
  })

  test("keeps comments inside the plugins array when appending", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{
  "plugins": [
    // another plugin the user keeps
    { "package": "other-plugin", "options": {} }
  ]
}
`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "braille", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain("// another plugin the user keeps")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.plugins).toHaveLength(2)
    expect(snapshot.matches).toHaveLength(1)
  })

  test("round-trips quotes, newlines and unicode through the file", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const note = `quote " backslash \\ newline\n\tend — π`

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [
      change(["note"], note, undefined),
    ])

    expect(result.status).toBe("saved")

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({ note })
  })

  test("preserves CRLF line endings", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{\r\n  "plugins": [\r\n    "${PACKAGE_NAME}"\r\n  ]\r\n}\r\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain("\r\n")
    expect(text.replaceAll("\r\n", "")).not.toContain("\n")
  })

  test("preserves a byte-order mark across a save", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `\uFEFF{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8 } }] }\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text.startsWith("\uFEFF")).toBe(true)

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({ refreshHz: 8, appearance: { spinner: "blocks" } })
  })

  test("does not add a byte-order mark when creating the file", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")
    expect((await readFile(configPath, "utf8")).startsWith("\uFEFF")).toBe(false)
  })

  test("matches tab indentation when inserting settings", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{\n\t"plugins": [\n\t\t{ "package": "${PACKAGE_NAME}", "options": {} }\n\t]\n}\n`)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain('\t\t\t\t\t"spinner": "blocks"')

    const indented = text.split("\n").filter((line) => line.startsWith("\t") || line.startsWith(" "))

    expect(indented.length).toBeGreaterThan(0)
    expect(indented.every((line) => line.startsWith("\t"))).toBe(true)
  })

  test("keeps a trailing comma when appending an entry", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{\n  "plugins": [\n    "other-plugin",\n  ]\n}\n`)

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")

    const text = await readFile(configPath, "utf8")

    expect(text).toContain('"other-plugin",')

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.plugins).toHaveLength(2)
    expect(snapshot.matches).toHaveLength(1)
  })

  test("refuses to persist a non-finite number", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const text = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "refreshHz": 8 } }] }\n`

    await writeFixture(configPath, text)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["refreshHz"], Number.NaN, 8),
    ])

    expect(result.status).toBe("error")
    expect(await readFile(configPath, "utf8")).toBe(text)
  })

  test("a failed write keeps the file and reports an error", async () => {
    if (process.getuid?.() === 0) return

    const root = await fixture()
    const configDirectory = join(root, "config")
    const configPath = join(configDirectory, "cli.json")
    const pluginDirectory = root
    const text = `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": {} }] }\n`

    await writeFixture(configPath, text)
    await chmod(configDirectory, 0o500)

    try {
      const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
        change(["appearance", "spinner"], "blocks", undefined),
      ])

      expect(result.status).toBe("error")
      expect(await readFile(configPath, "utf8")).toBe(text)

      const leftovers = (await readdir(configDirectory)).filter((name) => name.endsWith(".tmp"))

      expect(leftovers).toEqual([])
    } finally {
      await chmod(configDirectory, 0o700)
    }
  })

  test("replaces an existing config with owner-only permissions", async () => {
    if (process.platform === "win32") return

    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(configPath, `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": {} }] }\n`)
    await chmod(configPath, 0o644)

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  test("does not follow a stale temporary symlink", async () => {
    if (process.platform === "win32") return

    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root
    const victim = join(root, "victim.json")
    const victimText = "leave this alone\n"

    await writeFixture(configPath, `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": {} }] }\n`)
    await writeFixture(victim, victimText)
    await symlink(victim, `${configPath}.${process.pid}.0.tmp`)

    const { savePluginOptions: saveWithFreshModule } = await import(`../src/config-file.ts?temporary-symlink-${randomUUID()}`)

    const result = await saveWithFreshModule({
      path: configPath,
      identity: identity(pluginDirectory),
      selection: { kind: "existing", index: 0, specifier: PACKAGE_NAME },
      changes: [change(["appearance", "spinner"], "blocks", undefined)],
    })

    expect(result.status).toBe("saved")
    expect(await readFile(victim, "utf8")).toBe(victimText)
    expect((await lstat(`${configPath}.${process.pid}.0.tmp`)).isSymbolicLink()).toBe(true)
  })

  test("keeps a __proto__ option key without touching Object.prototype", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    await writeFixture(
      configPath,
      `{ "plugins": [{ "package": "${PACKAGE_NAME}", "options": { "__proto__": { "polluted": true } } }] }\n`,
    )

    const result = await save(configPath, pluginDirectory, { kind: "existing", index: 0, specifier: PACKAGE_NAME }, [
      change(["appearance", "spinner"], "blocks", undefined),
    ])

    expect(result.status).toBe("saved")
    expect("polluted" in {}).toBe(false)

    const snapshot = await readOk(configPath, pluginDirectory)
    const options = snapshot.matches[0]?.options

    expect(Object.hasOwn(options ?? {}, "__proto__")).toBe(true)
    expect(options?.["__proto__"]).toEqual({ polluted: true })
  })

  test("writes a fresh entry when the create action has no settings yet", async () => {
    const root = await fixture()
    const configPath = join(root, "cli.json")
    const pluginDirectory = root

    const result = await save(configPath, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")

    if (result.status !== "saved") return
    expect(result.options).toEqual({})

    const snapshot = await readOk(configPath, pluginDirectory)

    expect(snapshot.matches[0]?.options).toEqual({})
  })

  test("writes to the path resolved from the environment", async () => {
    const root = await fixture()
    const configDirectory = join(root, "config")
    const pluginDirectory = join(root, "plugin")

    await mkdir(pluginDirectory, { recursive: true })

    const location = resolveCliConfigPath({ home: root, xdgConfigHome: configDirectory })
    const result = await save(location.path, pluginDirectory, { kind: "create", specifier: PACKAGE_NAME }, [])

    expect(result.status).toBe("saved")
    expect(location.path).toBe(join(configDirectory, "opencode", "cli.json"))

    const snapshot = await readOk(location.path, pluginDirectory)

    expect(snapshot.matches).toHaveLength(1)
  })
})
