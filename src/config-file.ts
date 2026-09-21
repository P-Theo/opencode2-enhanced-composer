// opencode2-enhanced-composer — cli.json persistence
//
// The settings editor writes plugin options into OpenCode's own CLI config;
// this module is the only code that touches that file. JSONC reading and
// structural editing go through `jsonc-parser` — the same library the host's
// own settings dialog uses to patch its config files — so the accepted
// syntax, the comment handling, and the shape of an edit match the host
// exactly instead of approximating it.
//
// What the target host (OpenCode v2.0.11, verified against its source and
// documentation) does:
//
//   * The file is `cli.json` inside a non-empty `$OPENCODE_CONFIG_DIR`,
//     otherwise `opencode` under `$XDG_CONFIG_HOME`, otherwise
//     `~/.config/opencode`. The v2.0.11 launcher treats an empty config
//     directory as unset, so the editor follows that fallback rather than
//     writing `./cli.json`.
//     `$OPENCODE_TEST_HOME` changes `Global.Path.home`, but not this config
//     root, which still derives from `$XDG_CONFIG_HOME` or `os.homedir()`.
//   * It is parsed as JSONC with trailing commas allowed; any syntax or schema
//     error makes the host fall back to defaults silently, so a write that
//     breaks parsing would disable every setting. Structural edits keep the
//     original bytes outside the replaced ranges — comments, spacing, key
//     order — and a leading byte-order mark survives a save.
//   * Plugin entries are `string | { package, options? }`; a leading `-` on a
//     string entry or on an object's `package` field disables matching
//     plugins. Relative and `file:` entries resolve against the directory
//     containing `cli.json`.
//   * The host's own settings dialog re-reads, applies value changes with
//     jsonc-parser, and replaces the file atomically through `cli.json.tmp`
//     with mode 0600. Valid `cli.json` changes are watched and reloaded while
//     the TUI runs.
//   * `OPENCODE_CLI_CONFIG_CONTENT` can overlay this file. Its `plugins` array
//     replaces the disk plugin list, so the editor must not write an inactive
//     disk entry while that override is active.
//
// Saving never depends on a running session: it re-reads the file, merges the
// caller's changed fields into the latest document, reports conflicts instead
// of overwriting concurrent edits — including edits that replaced an object
// the draft still expects to descend into — and resolves symlinks before the
// atomic rename so a dotfile symlink stays a symlink.

import { applyEdits, modify, parseTree, printParseErrorCode, type FormattingOptions, type Node, type ParseError } from "jsonc-parser"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, open, readFile, readlink, realpath, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// `cli.json` is arbitrary JSON at the boundary; nothing downstream may assume a
// shape until it has been validated. `JsonValue` is the one recursive type this
// module uses for both parsed host input and caller-supplied draft values.

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject

export type JsonObject = { [key: string]: JsonValue }

/** JSON containers are exactly the values `Object()` returns by identity. */
function isJsonContainer(value: JsonValue): value is readonly JsonValue[] | JsonObject {
  return Object(value) === value
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isJsonContainer(value) && !isJsonArray(value)
}

/** JSON strings are the values that stringify to themselves. */
function isJsonString(value: JsonValue): value is string {
  return value === String(value)
}

/** Own-property writes must not trigger the `__proto__` setter on parsed data. */
function defineMember(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (!isJsonContainer(value)) return value

  if (isJsonArray(value)) return value.map(cloneJsonValue)

  const copy: JsonObject = {}

  for (const key of Object.keys(value)) {
    const member = value[key]

    if (member === undefined) continue
    defineMember(copy, key, cloneJsonValue(member))
  }

  return copy
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const clone = cloneJsonValue(value)

  return isJsonObject(clone) ? clone : {}
}

function deepEqualJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true

  if (left === undefined || right === undefined) return false

  if (!isJsonContainer(left) || !isJsonContainer(right)) return false

  if (isJsonArray(left) || isJsonArray(right)) {
    if (!isJsonArray(left) || !isJsonArray(right)) return false

    if (left.length !== right.length) return false

    return left.every((item, index) => deepEqualJson(item, right[index]))
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)

  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]))
}

export interface CliConfigEnvironment {
  /** The user's home directory, normally `os.homedir()`. */
  readonly home: string
  /** `$XDG_CONFIG_HOME`; the host treats an empty string as unset. */
  readonly xdgConfigHome?: string
  /** `$OPENCODE_CONFIG_DIR`; a non-empty value replaces the whole `opencode` directory. */
  readonly opencodeConfigDir?: string
}

export interface CliConfigLocation {
  readonly path: string
  readonly directory: string
  readonly source: "OPENCODE_CONFIG_DIR" | "XDG_CONFIG_HOME" | "home"
}

/**
 * Mirror the host's config-root resolution. The pure resolver receives the
 * system home and the two directory overrides for direct test isolation.
 */
export function resolveCliConfigPath(environment: CliConfigEnvironment): CliConfigLocation {
  const override = environment.opencodeConfigDir || undefined
  const base = environment.xdgConfigHome || join(environment.home, ".config")
  const directory = override ?? join(base, "opencode")
  const source = override !== undefined ? "OPENCODE_CONFIG_DIR" : environment.xdgConfigHome ? "XDG_CONFIG_HOME" : "home"

  return { path: join(directory, "cli.json"), directory, source }
}

export function currentCliConfigEnvironment(): CliConfigEnvironment {
  return {
    home: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR,
  }
}

export interface PluginIdentity {
  /** The published package name, e.g. `opencode2-enhanced-composer`. */
  readonly packageName: string
  /** Absolute path of the plugin's package directory. */
  readonly directory: string
}

export interface PluginMatchContext extends PluginIdentity {
  /** Directory containing `cli.json`; relative plugin entries resolve here. */
  readonly configDirectory: string
}

export interface PluginEntryMatch {
  /** Position in the `plugins` array; the array itself is never reordered. */
  readonly index: number
  /** The entry exactly as written, including a leading `-` when disabled. */
  readonly specifier: string
  readonly form: "string" | "object"
  readonly kind: "registry" | "path"
  /** False for `-name` disable directives, in either entry form. */
  readonly enabled: boolean
  /** The entry's options object; empty when absent. */
  readonly options: JsonObject
}

interface PluginEntry {
  readonly specifier: string
  readonly form: "string" | "object"
  readonly enabled: boolean
  readonly options: JsonObject
}

function readPluginEntry(entry: JsonValue): PluginEntry | null {
  if (isJsonString(entry)) {
    return { specifier: entry, form: "string", enabled: !entry.startsWith("-"), options: {} }
  }

  if (!isJsonObject(entry)) return null
  const packageValue = entry["package"]

  if (packageValue === undefined || !isJsonString(packageValue)) return null

  // The host reads an object's `package` field with the same leading `-`
  // disable rule as string entries, so the flag must follow the specifier.
  const enabled = !packageValue.startsWith("-")
  const options = entry["options"]

  if (options === undefined) return { specifier: packageValue, form: "object", enabled, options: {} }

  if (!isJsonObject(options)) return null

  return { specifier: packageValue, form: "object", enabled, options }
}

function isPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("~/") ||
    specifier === "~" ||
    specifier.startsWith(".\\") ||
    specifier.startsWith("..\\") ||
    /^[A-Za-z]:[\\/]/u.test(specifier)
  )
}

interface RegistrySpecifier {
  readonly name: string
  readonly version: string | undefined
}

/** Split `name@version` or `@scope/name@version`; versions are not compared. */
function parseRegistrySpecifier(specifier: string): RegistrySpecifier | null {
  const trimmed = specifier.trim()

  if (trimmed.length === 0) return null

  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/")

    if (slash < 2) return null
    const at = trimmed.indexOf("@", slash)

    if (at < 0) return { name: trimmed, version: undefined }

    return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) }
  }

  const at = trimmed.indexOf("@")

  if (at <= 0) return { name: trimmed, version: undefined }

  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) }
}

/** Resolve a local entry the way the host does, against the config file. */
function resolveLocalSpecifier(specifier: string, configDirectory: string): string | null {
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier)
    } catch {
      return null
    }
  }

  if (specifier === "~") return homedir()

  if (specifier.startsWith("~/")) return resolve(homedir(), specifier.slice(2))

  return resolve(configDirectory, specifier)
}

/** Follow symlinks when the path exists, otherwise compare lexically. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function matchKind(specifier: string, context: PluginMatchContext, canonicalDirectory: string): "registry" | "path" | null {
  const candidate = specifier.startsWith("-") ? specifier.slice(1) : specifier

  if (candidate.length === 0) return null

  if (isPathSpecifier(candidate)) {
    const resolved = resolveLocalSpecifier(candidate, context.configDirectory)

    if (resolved === null) return null

    return canonicalPath(resolved) === canonicalDirectory ? "path" : null
  }

  const parsed = parseRegistrySpecifier(candidate)

  if (parsed === null) return null

  return parsed.name === context.packageName ? "registry" : null
}

export function findPluginEntries(
  plugins: readonly JsonValue[],
  context: PluginMatchContext,
): readonly PluginEntryMatch[] {
  const canonicalDirectory = canonicalPath(context.directory)
  const matches: PluginEntryMatch[] = []

  plugins.forEach((entry, index) => {
    const parsed = readPluginEntry(entry)

    if (parsed === null) return
    const kind = matchKind(parsed.specifier, context, canonicalDirectory)

    if (kind === null) return

    matches.push({
      index,
      specifier: parsed.specifier,
      form: parsed.form,
      kind,
      enabled: parsed.enabled,
      options: cloneJsonObject(parsed.options),
    })
  })

  return matches
}

export interface CliConfigError {
  readonly message: string
  readonly line?: number
  readonly column?: number
}

export interface CliConfigSnapshot {
  readonly path: string
  readonly exists: boolean
  readonly text: string
  readonly document: JsonObject
  readonly plugins: readonly JsonValue[]
  readonly matches: readonly PluginEntryMatch[]
}

export type ReadCliConfigResult =
  | { readonly status: "ok"; readonly snapshot: CliConfigSnapshot }
  | { readonly status: "invalid"; readonly path: string; readonly error: CliConfigError }
  | { readonly status: "error"; readonly path: string; readonly error: CliConfigError }

type ConfigTextResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly error: CliConfigError }

/** Read failures other than "no file yet" must not be mistaken for an empty config. */
async function readConfigText(path: string): Promise<ConfigTextResult> {
  try {
    const text = await readFile(path, "utf8")

    return { status: "ok", text }
  } catch (cause) {
    if (isMissingFileError(cause)) return { status: "missing" }

    return { status: "error", error: { message: describeError(cause) } }
  }
}

function isMissingFileError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false

  if (!("code" in cause)) return false
  const code = cause.code

  return code === "ENOENT" || code === "ENOTDIR"
}

export async function readCliConfig(path: string, identity: PluginIdentity): Promise<ReadCliConfigResult> {
  const read = await readConfigText(path)

  if (read.status === "error") return { status: "error", path, error: read.error }

  if (read.status === "missing") {
    return {
      status: "ok",
      snapshot: { path, exists: false, text: "", document: {}, plugins: [], matches: [] },
    }
  }

  const parsed = parseJsoncDocument(read.text)

  if (!parsed.ok) return { status: "invalid", path, error: parsed.error }
  const decoded = decodeConfigDocument(parsed.value)

  if (!decoded.ok) return { status: "invalid", path, error: decoded.error }

  const matches = findPluginEntries(decoded.config.plugins, {
    packageName: identity.packageName,
    directory: identity.directory,
    configDirectory: dirname(path),
  })

  return {
    status: "ok",
    snapshot: { path, exists: true, text: read.text, document: decoded.config.document, plugins: decoded.config.plugins, matches },
  }
}

interface DecodedConfig {
  readonly document: JsonObject
  readonly plugins: readonly JsonValue[]
}

type DecodedConfigResult =
  | { readonly ok: true; readonly config: DecodedConfig }
  | { readonly ok: false; readonly error: CliConfigError }

function decodeConfigDocument(root: JsonValue): DecodedConfigResult {
  if (!isJsonObject(root)) return invalidConfig("The CLI config must be a JSON object")
  const plugins = root["plugins"]

  if (plugins === undefined) return { ok: true, config: { document: root, plugins: [] } }

  if (!isJsonArray(plugins)) return invalidConfig("The plugins setting must be an array")

  for (const entry of plugins) {
    if (readPluginEntry(entry) === null) {
      return invalidConfig("Every plugins entry must be a string or an object with a string package field")
    }
  }

  return { ok: true, config: { document: root, plugins } }
}

interface InvalidConfigResult {
  readonly ok: false
  readonly error: CliConfigError
}

function invalidConfig(message: string): InvalidConfigResult {
  return { ok: false, error: { message } }
}

// The host accepts comments and trailing commas, so the file is parsed with
// jsonc-parser's fault-reporting tree parser: the first parse error becomes
// the reported position. Values are extracted by hand instead of through
// getNodeValue so an own `__proto__` property stays an own property rather
// than reaching Object.prototype. A leading byte-order mark is not JSON to
// jsonc-parser; it is split off before parsing and re-attached on write.

const BOM = "\uFEFF"

interface BomSplit {
  /** The document text without the mark; parsing and edits apply to this. */
  readonly body: string
  readonly bom: boolean
}

function splitBom(text: string): BomSplit {
  return text.startsWith(BOM) ? { body: text.slice(BOM.length), bom: true } : { body: text, bom: false }
}

type JsoncDocumentResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: CliConfigError }

/** Parse one config document; the first parse error wins, with its position. */
function parseJsoncDocument(text: string): JsoncDocumentResult {
  const { body, bom } = splitBom(text)
  const errors: ParseError[] = []
  const root = parseTree(body, errors, { allowTrailingComma: true })
  const first = errors[0]

  if (first !== undefined) {
    // Error offsets count from the mark-free body; shifting by the mark's
    // length restores positions in the file as the user sees it.
    const position = positionAt(text, first.offset + (bom ? BOM.length : 0))

    return { ok: false, error: { message: describeParseError(first.error), line: position.line, column: position.column } }
  }

  if (root === undefined) return { ok: false, error: { message: "The CLI config is empty" } }

  return { ok: true, value: extractNodeValue(root) }
}

function parseInlineCliConfig(content: string | undefined): JsonObject | undefined {
  if (content === undefined || content.trim() === "" || content.startsWith(BOM)) return undefined

  const parsed = parseJsoncDocument(content)

  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined
}

/** Detects plugin arrays without duplicating the host's evolving CLI schema. */
export function hasInlineCliPluginsConfig(content: string | undefined): boolean {
  const config = parseInlineCliConfig(content)

  if (config === undefined || !Object.hasOwn(config, "plugins")) return false

  const plugins = config["plugins"]

  return plugins !== undefined && isJsonArray(plugins)
}

// jsonc-parser's error code is a const enum, which cannot cross the Babel
// build as a value, so the messages hang off printParseErrorCode's names.
type ParseErrorCodeName = ReturnType<typeof printParseErrorCode>

const PARSE_ERROR_MESSAGES: Partial<Record<ParseErrorCodeName, string>> = {
  InvalidSymbol: "Invalid character",
  InvalidNumberFormat: "Invalid number format",
  PropertyNameExpected: "Expected a property name",
  ValueExpected: "Expected a value",
  ColonExpected: "Expected a colon",
  CommaExpected: "Expected a comma",
  CloseBraceExpected: "Expected a closing brace",
  CloseBracketExpected: "Expected a closing bracket",
  EndOfFileExpected: "Unexpected trailing characters",
  InvalidCommentToken: "Invalid comment",
  UnexpectedEndOfComment: "Unterminated comment",
  UnexpectedEndOfString: "Unterminated string",
  UnexpectedEndOfNumber: "Unterminated number",
  InvalidUnicode: "Invalid unicode escape",
  InvalidEscapeCharacter: "Invalid escape sequence",
  InvalidCharacter: "Invalid character",
}

function describeParseError(code: ParseError["error"]): string {
  const name = printParseErrorCode(code)

  return PARSE_ERROR_MESSAGES[name] ?? name
}

/** Build the JavaScript value of a node; own properties stay own properties. */
function extractNodeValue(node: Node): JsonValue {
  if (node.type === "object") {
    const value: JsonObject = {}

    for (const property of node.children ?? []) {
      const key = property.children?.[0]
      const member = property.children?.[1]

      if (key === undefined || member === undefined) continue
      defineMember(value, String(key.value), extractNodeValue(member))
    }

    return value
  }

  if (node.type === "array") return (node.children ?? []).map((item) => extractNodeValue(item))

  // SAFETY: parseTree only attaches values to literal nodes, and every
  // literal — string, number, boolean, null — is one of the JsonValue leaves;
  // containers were built above, so no other node type reaches this cast.
  return node.value as JsonValue
}

interface TextPosition {
  readonly line: number
  readonly column: number
}

function positionAt(source: string, offset: number): TextPosition {
  const lines = source.slice(0, offset).split("\n")

  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 }
}

// jsonc-parser's modify computes the minimal text edits for one path: every
// byte outside the replaced range — comments, spacing, key order — survives
// verbatim, and inserted content follows the file's own indentation and line
// endings. Each write re-parses the updated document, so offsets stay correct
// without a diffing layer, and a byte-order mark is carried across untouched.

function detectEol(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n"
}

interface IndentationStyle {
  readonly insertSpaces: boolean
  readonly tabSize: number
}

/** Match the file's own indentation so inserted lines do not stand out. */
function detectIndentation(text: string): IndentationStyle {
  for (const line of text.split("\n")) {
    if (line.startsWith("\t")) return { insertSpaces: false, tabSize: 2 }

    const leading = /^ +/u.exec(line)

    if (leading !== null) return { insertSpaces: true, tabSize: leading[0].length }
  }

  return { insertSpaces: true, tabSize: 2 }
}

function setAtPath(source: string, path: readonly (string | number)[], value: JsonValue | undefined): string {
  const { body, bom } = splitBom(source)
  const formatting: FormattingOptions = { ...detectIndentation(body), eol: detectEol(body) }
  const edits = modify(body, [...path], value, { formattingOptions: formatting })
  const edited = applyEdits(body, edits)

  return bom ? BOM + edited : edited
}

// The editor starts from the options it read and tracks the fields it changed.
// Arrays are atomic on purpose: zone order and custom priority lists are only
// meaningful as a whole, so a concurrent edit of any element is a conflict.
// A field the draft no longer carries becomes a deletion change (`value`
// undefined), such as removing a custom priority list when selecting a preset.

export interface ConfigChange {
  /** Path inside the plugin's `options` object. */
  readonly path: readonly string[]
  /**
   * The desired value. `undefined` deletes the field; a deletion at the empty
   * path clears the whole `options` object (it is written away, which the host
   * reads back as `{}`).
   */
  readonly value: JsonValue | undefined
  /** Value seen when the draft started; `undefined` means the field was absent. */
  readonly expected: JsonValue | undefined
}

export function diffOptions(baseline: JsonObject, draft: JsonObject): readonly ConfigChange[] {
  return diffObjects(baseline, draft, [])
}

function diffObjects(baseline: JsonObject, draft: JsonObject, prefix: readonly string[]): ConfigChange[] {
  const changes: ConfigChange[] = []

  for (const key of Object.keys(draft)) {
    const next = draft[key]

    if (next === undefined) continue
    const previous = Object.hasOwn(baseline, key) ? baseline[key] : undefined

    if (deepEqualJson(previous, next)) continue
    const path = [...prefix, key]

    if (isJsonObject(next)) {
      if (previous !== undefined && !isJsonObject(previous)) {
        changes.push({ path, value: next, expected: previous })
        continue
      }

      changes.push(...diffObjects(previous === undefined ? {} : previous, next, path))
      continue
    }

    changes.push({ path, value: next, expected: previous })
  }

  // A baseline key the draft no longer carries is a deletion. The whole
  // subtree goes at once, the same way replacing a scalar with an object is
  // one change above, so an external edit inside a deleted subtree conflicts.
  for (const key of Object.keys(baseline)) {
    const next = Object.hasOwn(draft, key) ? draft[key] : undefined

    if (next !== undefined) continue
    const previous = baseline[key]

    if (previous === undefined) continue
    changes.push({ path: [...prefix, key], value: undefined, expected: previous })
  }

  return changes
}

export type PluginEntrySelection =
  | { readonly kind: "existing"; readonly index: number; readonly specifier: string }
  | { readonly kind: "create"; readonly specifier: string }

export interface ConfigConflict {
  readonly path: readonly string[]
  readonly expected: JsonValue | undefined
  /** The desired value; `undefined` when the draft deletes the field. */
  readonly value: JsonValue | undefined
  /**
   * The path's current value, or the value now sitting where an object was
   * expected — the latter means the parent structure changed externally, not
   * merely that the leaf went missing.
   */
  readonly actual: JsonValue | undefined
}

export interface SavePluginOptionsInput {
  readonly path: string
  readonly identity: PluginIdentity
  readonly selection: PluginEntrySelection
  readonly changes: readonly ConfigChange[]
}

export type SavePluginOptionsResult =
  | {
      readonly status: "saved"
      readonly path: string
      readonly text: string
      readonly options: JsonObject
      readonly index: number
      readonly specifier: string
      /** False when the file already contained every change. */
      readonly changed: boolean
    }
  | {
      readonly status: "conflict"
      readonly path: string
      readonly conflicts: readonly ConfigConflict[]
      readonly matches: readonly PluginEntryMatch[]
      readonly options: JsonObject
    }
  | { readonly status: "ambiguous"; readonly path: string; readonly matches: readonly PluginEntryMatch[] }
  | { readonly status: "stale-target"; readonly path: string; readonly matches: readonly PluginEntryMatch[] }
  | { readonly status: "invalid"; readonly path: string; readonly error: CliConfigError }
  | { readonly status: "error"; readonly path: string; readonly error: CliConfigError }

interface ResolvedSelection {
  readonly status: "ok"
  readonly index: number
  readonly specifier: string
  readonly form: "string" | "object"
  readonly options: JsonObject
  readonly create: boolean
}

type SelectionResolution =
  | ResolvedSelection
  | { readonly status: "ambiguous"; readonly matches: readonly PluginEntryMatch[] }
  | { readonly status: "stale-target"; readonly matches: readonly PluginEntryMatch[] }

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

// A save includes the read–modify–write cycle, so serializing writes lets a
// later in-process editor rebase on the earlier editor's completed change.
let activeConfigSave = Promise.resolve()

function serializeConfigSave<Result>(operation: () => Promise<Result>): Promise<Result> {
  const previous = activeConfigSave
  let release: () => void = () => undefined

  activeConfigSave = new Promise<void>((resolve) => {
    release = resolve
  })

  return previous.then(operation).finally(release)
}

function isSafeOptionPath(path: readonly string[]): boolean {
  return path.every((key) => key.length > 0 && !UNSAFE_KEYS.has(key))
}

export function savePluginOptions(input: SavePluginOptionsInput): Promise<SavePluginOptionsResult> {
  return serializeConfigSave(() => savePluginOptionsNow(input))
}

async function savePluginOptionsNow(input: SavePluginOptionsInput): Promise<SavePluginOptionsResult> {
  const path = input.path

  if (input.selection.specifier.length === 0) {
    return { status: "invalid", path, error: { message: "The plugin specifier must not be empty" } }
  }

  for (const change of input.changes) {
    if (!isSafeOptionPath(change.path)) {
      return { status: "invalid", path, error: { message: `Unsupported option path: ${change.path.join(".")}` } }
    }
  }

  const read = await readCliConfig(path, input.identity)

  if (read.status === "error") return { status: "error", path, error: read.error }

  if (read.status === "invalid") return { status: "invalid", path, error: read.error }

  const snapshot = read.snapshot
  const resolved = resolveSelection(input.selection, snapshot)

  if (resolved.status === "ambiguous") return { status: "ambiguous", path, matches: resolved.matches }

  if (resolved.status === "stale-target") return { status: "stale-target", path, matches: resolved.matches }

  const conflicts: ConfigConflict[] = []
  const applied: ConfigChange[] = []

  for (const change of input.changes) {
    const walk = walkOptionPath(resolved.options, change.path)

    // A scalar or array now sits where the draft needs to descend, so the
    // parent structure changed externally; merging would clobber it.
    if (walk.kind === "blocked") {
      conflicts.push({ path: change.path, expected: change.expected, value: change.value, actual: walk.value })
      continue
    }

    const actual = walk.value

    if (deepEqualJson(actual, change.value)) continue

    if (deepEqualJson(actual, change.expected)) {
      applied.push(change)
      continue
    }

    conflicts.push({ path: change.path, expected: change.expected, value: change.value, actual })
  }

  if (conflicts.length > 0) {
    return { status: "conflict", path, conflicts, matches: snapshot.matches, options: resolved.options }
  }

  let finalOptions = resolved.options

  for (const change of applied) finalOptions = setJsonPath(finalOptions, change.path, change.value)

  if (applied.length === 0 && !resolved.create) {
    return {
      status: "saved",
      path,
      text: snapshot.text,
      options: finalOptions,
      index: resolved.index,
      specifier: resolved.specifier,
      changed: false,
    }
  }

  const baseText = snapshot.exists ? snapshot.text : "{}"
  let nextText: string

  try {
    nextText =
      resolved.create || resolved.form === "string"
        ? setAtPath(baseText, ["plugins", resolved.index], buildEntryObject(resolved.specifier, finalOptions))
        : applyOptionChanges(baseText, resolved.index, applied)
  } catch (cause) {
    return { status: "error", path, error: { message: describeError(cause) } }
  }

  const verifyError = verifySavedText(nextText, resolved.index, finalOptions)

  if (verifyError !== null) return { status: "error", path, error: verifyError }

  const writeError = await writeConfigText(path, nextText)

  if (writeError !== null) return { status: "error", path, error: writeError }

  return {
    status: "saved",
    path,
    text: ensureTrailingNewline(nextText),
    options: finalOptions,
    index: resolved.index,
    specifier: resolved.specifier,
    changed: true,
  }
}

function resolveSelection(selection: PluginEntrySelection, snapshot: CliConfigSnapshot): SelectionResolution {
  if (selection.kind === "create") {
    if (snapshot.matches.length > 0) return { status: "ambiguous", matches: snapshot.matches }

    return { status: "ok", index: snapshot.plugins.length, specifier: selection.specifier, form: "object", options: {}, create: true }
  }

  // The selection carries the index the editor read. When that exact entry is
  // still there under the same specifier it wins even if another entry now
  // repeats the specifier: the user picked this element of the array.
  const selected = snapshot.matches.find(
    (match) => match.index === selection.index && match.specifier === selection.specifier,
  )

  if (selected !== undefined) {
    return {
      status: "ok",
      index: selected.index,
      specifier: selected.specifier,
      form: selected.form,
      options: selected.options,
      create: false,
    }
  }

  const candidates = snapshot.matches.filter((match) => match.specifier === selection.specifier)

  if (candidates.length === 0) return { status: "stale-target", matches: snapshot.matches }

  // The entry moved (or another one was inserted before it). Relocating the
  // save is only safe when the specifier names exactly one live match;
  // duplicates make "which entry did the user mean" unanswerable.
  if (candidates.length > 1) return { status: "ambiguous", matches: snapshot.matches }

  const match = candidates[0]

  if (match === undefined) return { status: "stale-target", matches: snapshot.matches }

  return { status: "ok", index: match.index, specifier: match.specifier, form: match.form, options: match.options, create: false }
}

type OptionPathWalk =
  | { readonly kind: "leaf"; readonly value: JsonValue | undefined }
  | { readonly kind: "blocked"; readonly value: JsonValue }

/**
 * Follow one option path through the entry's current options. `leaf` reaches
 * the path's end — its value, or undefined when the field is absent — while
 * `blocked` means an ancestor along the path is no longer an object.
 */
function walkOptionPath(options: JsonObject, path: readonly string[]): OptionPathWalk {
  let cursor: JsonValue = options

  for (const key of path) {
    if (!isJsonObject(cursor)) return { kind: "blocked", value: cursor }
    const next: JsonValue | undefined = cursor[key]

    if (next === undefined) return { kind: "leaf", value: undefined }
    cursor = next
  }

  return { kind: "leaf", value: cursor }
}

function setJsonPath(options: JsonObject, path: readonly string[], value: JsonValue | undefined): JsonObject {
  if (path.length === 0) {
    if (value === undefined) return {}

    return isJsonObject(value) ? cloneJsonObject(value) : cloneJsonObject(options)
  }

  const clone = cloneJsonObject(options)
  let cursor = clone

  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]

    if (key === undefined) return clone
    const existing = cursor[key]

    // A write replaces a non-object on the way down; a deletion stops when an
    // ancestor is absent or is not an object — there is nothing to remove.
    if (value === undefined && (existing === undefined || !isJsonObject(existing))) return clone

    const child = existing !== undefined && isJsonObject(existing) ? existing : {}

    defineMember(cursor, key, child)
    cursor = child
  }

  const last = path[path.length - 1]

  if (last === undefined) return clone

  // Deleting the member leaves its parent in place — even when it becomes an
  // empty object — exactly the shape the JSONC edit below produces.
  if (value === undefined) delete cursor[last]
  else defineMember(cursor, last, value)

  return clone
}

/**
 * Apply the accepted changes to the file's own bytes, one narrow JSONC edit
 * per change. A set replaces a single value; `undefined` deletes a single
 * property without rewriting the whole `options` object.
 * Everything outside the edited ranges — comments, key order, indentation, a
 * byte-order mark, CRLF endings elsewhere — survives; jsonc-parser reformats
 * only the lines the deletion touches (a trailing comment on the deleted
 * property's line can move or go, the host's own edit behavior).
 */
function applyOptionChanges(source: string, index: number, changes: readonly ConfigChange[]): string {
  let text = source

  for (const change of changes) {
    text = setAtPath(text, ["plugins", index, "options", ...change.path], change.value)
  }

  return text
}

function buildEntryObject(specifier: string, options: JsonObject) {
  return { package: specifier, options }
}

function verifySavedText(text: string, index: number, options: JsonObject): CliConfigError | null {
  const parsed = parseJsoncDocument(text)

  if (!parsed.ok) return { message: `The edited configuration did not parse: ${parsed.error.message}` }
  const decoded = decodeConfigDocument(parsed.value)

  if (!decoded.ok) return decoded.error
  const entry = decoded.config.plugins[index]
  const parsedEntry = entry === undefined ? null : readPluginEntry(entry)

  if (parsedEntry === null || !deepEqualJson(parsedEntry.options, options)) {
    return { message: "The edited configuration did not read back as written" }
  }

  return null
}

/** Follow the file's symlink chain so the rename never replaces the link. */
async function resolveWriteTarget(path: string, depth = 0): Promise<string> {
  if (depth > 8) return path
  const direct = await realpath(path).catch(() => undefined)

  if (direct !== undefined) return direct
  const link = await readlink(path).catch(() => undefined)

  if (link !== undefined) return resolveWriteTarget(resolve(dirname(path), link), depth + 1)
  const parent = await realpath(dirname(path)).catch(() => undefined)

  if (parent !== undefined) return join(parent, basename(path))

  return path
}

const TEMPORARY_FILE_ATTEMPTS = 3

function isAlreadyExists(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST"
}

async function writeTemporaryConfig(target: string, text: string): Promise<string> {
  for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    let created = false

    try {
      const handle = await open(temporary, "wx", 0o600)

      created = true

      try {
        await handle.writeFile(ensureTrailingNewline(text))
      } finally {
        await handle.close()
      }

      return temporary
    } catch (cause) {
      if (created) await unlink(temporary).catch(() => undefined)

      if (isAlreadyExists(cause)) continue

      throw cause
    }
  }

  throw new Error("Could not create a unique temporary configuration file")
}

async function writeConfigText(path: string, text: string): Promise<CliConfigError | null> {
  const target = await resolveWriteTarget(path)
  let temporary: string | undefined

  try {
    await mkdir(dirname(target), { recursive: true })
    temporary = await writeTemporaryConfig(target, text)
    await rename(temporary, target)

    return null
  } catch (cause) {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined)

    return { message: describeError(cause) }
  }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message

  return String(cause)
}
