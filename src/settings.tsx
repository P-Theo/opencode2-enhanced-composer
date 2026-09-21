// opencode2-enhanced-composer — the settings editor dialog (Stage 3B).
//
// A keyboard-first editor for the plugin's footer options, opened by
// the `Customize footer` palette and slash commands. Mouse support is
// passive: when the host enables mouse reporting, clicking a row focuses it,
// clicking the focused row applies it, and the wheel scrolls the list.
// The draft lives in `settings-model.ts`'s pure operations, the miniature
// preview renders the real pipeline (`formatWidgets` → `fitRow` →
// `StatusRow`), and saves go through the `cli.json` store adapter: one
// atomic write, conflicts and failures keep the draft, and a successful save
// hands the merged normalized options to the caller before closing so the
// running plugin updates without waiting for another setup.
//
// The host owns the dialog chrome, its size, and the modal keymap mode; this
// component owns its content, a component-scoped key layer (disposed with
// it), and closing itself through the opener's ownership-checked
// `requestClose`, so a late async continuation can never clear a different
// dialog.
//
// Layout: a title line, the live preview with its location shortcut, one
// scrolling settings list (Layout, Appearance, and Overflow groups), a status
// line, and the key legend. Every appearance choice shows its real rendered
// value — glyph choices show just the glyph — and the preview is the same
// renderer the footer uses, so nothing here can promise something production
// does not draw.

import { parseColor, RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import {
  DEFAULT_STATUS_OPTIONS,
  isLiteralText,
  resolveStatusOptions,
  type CanonicalField,
  type NormalizedStatusOptions,
  type WidgetID,
} from "./options.js"
import {
  DEFAULT_PREVIEW_STATE,
  PLUGIN_PACKAGE_NAME,
  adoptFields,
  appearanceChoices,
  appearanceControlsForWidget,
  buildPreviewRows,
  controlValueText,
  createCliStatusOptionsStore,
  cycledChoice,
  cycleOverflowPreset,
  draftPatch,
  editDraft,
  editorRows,
  ensureWindowStart,
  fieldSummary,
  moveRowCursor,
  moveWidgetToAdjacentZone,
  rebaseDraft,
  retargetDraft,
  reorderHideFirst,
  reorderWidgetWithinZone,
  resolvePluginDirectory,
  rowDescription,
  toggleWidgetVisibility,
  type DraftState,
  type PreviewState,
  type SettingsRow,
  type SettingsSection,
  type SettingControl,
  type StatusSettingsEntry,
  type StatusSettingsStore,
} from "./settings-model.js"
import {
  currentCliConfigEnvironment,
  hasInlineCliPluginsConfig,
} from "./config-file.js"
import { StatusRow, useRowWidth, type RowColor, type SpinnerRender, type StatusRowTheme } from "./status-row.js"
import { createCellMeasurer } from "./layout.js"

type FocusArea = "body" | "actions" | "panel"

interface AppearanceEdit {
  readonly control: SettingControl
  readonly values: readonly string[]
  readonly field: number
}

const CUSTOM_TEXT_ERROR = "Use valid single-line text without control characters."

type SavePhase =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "error"; readonly message: string }

type Panel =
  | {
      readonly kind: "target"
      readonly mode: "open" | "retarget"
      readonly entries: readonly StatusSettingsEntry[]
      readonly note?: string
    }
  | { readonly kind: "create" }
  | {
      readonly kind: "conflict"
      readonly fields: readonly CanonicalField[]
      readonly current: NormalizedStatusOptions
    }
  | { readonly kind: "error"; readonly message: string; readonly source: "read" | "save" }

/** One focusable or informational row inside a panel. */
interface PanelRow {
  readonly id: string
  /** Informational rows cannot take the cursor. */
  readonly info: boolean
  readonly text: string
  readonly detail?: string
  /** Runs when the row is activated. */
  readonly run?: () => void
}

/** One status-line message: the text and whether it needs emphasis. */
interface StatusMessage {
  readonly text: string
  readonly strong: boolean
}

const ACTIONS = [
  { id: "save", title: "Save changes" },
  { id: "cancel", title: "Cancel" },
  { id: "reset", title: "Reset defaults" },
] as const

const DISABLED_ENTRY_NOTICE = "This plugin entry is disabled; saving won't enable it."

/** How long a transient note stays before the log line clears itself. */
const NOTICE_TIMEOUT_MS = 4000

export interface StatusSettingsDialogProps {
  readonly context: Plugin.Context
  readonly store: StatusSettingsStore
  /** The effective options at setup: the draft baseline when no entry exists. */
  readonly fallback: NormalizedStatusOptions
  /** Receives the saved normalized options before the dialog closes. */
  readonly onSaved?: (options: NormalizedStatusOptions) => void
  /** Closes the host dialog; the opener checks that this editor still owns it. */
  readonly requestClose: () => void
}

export function StatusSettingsDialog(props: StatusSettingsDialogProps): JSX.Element {
  const [draft, setDraft] = createSignal<DraftState>(rebaseDraft(props.fallback))
  const [editing, setEditing] = createSignal<AppearanceEdit>()
  const [editError, setEditError] = createSignal("")
  // Custom text lives in `options` only while its control is selected. The
  // stash remembers it for the session so cycling back to `custom` restores
  // the text instead of dropping it and asking for it again.
  const [customStash, setCustomStash] = createSignal<Readonly<Record<string, readonly string[]>>>({})
  const [target, setTarget] = createSignal<StatusSettingsEntry | undefined>()
  const [preview, setPreview] = createSignal<PreviewState>(DEFAULT_PREVIEW_STATE)
  const [area, setArea] = createSignal<FocusArea>("body")
  const [cursor, setCursor] = createSignal(0)
  const [panel, setPanel] = createSignal<Panel>()
  const [savePhase, setSavePhase] = createSignal<SavePhase>({ status: "idle" })
  const [notice, setNotice] = createSignal("")
  const [diskIssues, setDiskIssues] = createSignal(0)
  const [reading, setReading] = createSignal(true)
  const [readError, setReadError] = createSignal<string>()
  const [bodyHeight, setBodyHeight] = createSignal(0)
  const [contentWidth, setContentWidth] = createSignal(0)
  const [windowStart, setWindowStart] = createSignal(0)
  // Moving focus to the actions row must not scroll the settings list back under the user.
  const [windowCursor, setWindowCursor] = createSignal(0)
  // A wheel-scrolled view is temporary: set while the wheel moves, cleared by
  // any cursor or area move, which re-anchors the window to the cursor.
  const [scrollOffset, setScrollOffset] = createSignal<number | undefined>(undefined)

  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  // Transient notes clear themselves after a timeout; a new note restarts it.
  // Sticky states (saving, errors, disk repairs) are unaffected.
  createEffect(() => {
    if (notice() === "") return

    const timer = setTimeout(() => {
      if (!disposed) setNotice("")
    }, NOTICE_TIMEOUT_MS)

    onCleanup(() => clearTimeout(timer))
  })

  const options = (): NormalizedStatusOptions => draft().current

  const previewOptions = (): NormalizedStatusOptions => {
    const edit = editing()

    return edit !== undefined && edit.values.every(isLiteralText)
      ? (edit.control.custom?.apply(options(), edit.values) ?? options())
      : options()
  }

  const beginCustomEdit = (control: SettingControl): void => {
    const custom = control.custom

    if (custom === undefined) return

    setEditError("")
    setNotice("")
    setEditing({ control, values: custom.read(options()) ?? custom.labels.map(() => ""), field: 0 })
  }

  /** Remember the custom text a cycle is leaving behind so hovering back restores it. */
  const stashCustom = (control: SettingControl): void => {
    const values = control.custom?.read(options())

    if (values === undefined) return

    setCustomStash((stash) => ({ ...stash, [control.id]: values }))
  }

  /** What a cycle onto `custom` applies: this session's stashed text, or a blank custom. */
  const stashedCustom = (control: SettingControl): readonly string[] =>
    customStash()[control.id] ?? (control.custom?.labels.map(() => "") ?? [])

  const finishCustomEdit = (): boolean => {
    const edit = editing()

    if (edit === undefined) return true

    if (editError() !== "" || !edit.values.every(isLiteralText)) {
      setEditError(CUSTOM_TEXT_ERROR)

      return false
    }

    applyOptions(edit.control.custom?.apply(options(), edit.values) ?? options())
    setEditing(undefined)
    setEditError("")

    return true
  }

  const changeAppearance = (control: SettingControl, direction: 1 | -1): void => {
    const choices = appearanceChoices(control)
    const custom = control.custom

    if (custom === undefined) {
      applyOptions(control.apply(options(), cycledChoice(choices, control.current(options()), direction).value))
      setNotice("")

      return
    }

    const applied = custom.read(options())
    const current = applied === undefined ? control.current(options()) : "custom"
    const next = cycledChoice(choices, current, direction)

    if (current === "custom") stashCustom(control)

    // Hovering `custom` selects it like a preset: the stashed text comes back
    // and the preview follows, while Enter is what opens the editor.
    if (next.value === "custom") applyOptions(custom.apply(options(), applied ?? stashedCustom(control)))
    else applyOptions(control.apply(options(), next.value))

    setNotice("")
  }

  const changedCount = (): number => draft().changed.size

  const focusArea = (next: FocusArea, index = 0): void => {
    setArea(next)
    setCursor(index)
  }

  const adoptEntry = (entry: StatusSettingsEntry): void => {
    const resolution = resolveStatusOptions(entry.options)

    setTarget(entry)
    setDiskIssues(resolution.diagnostics.length)
    setDraft(rebaseDraft(resolution.options))
    setCustomStash({})
    setPanel(undefined)
    setNotice(entry.enabled ? "" : DISABLED_ENTRY_NOTICE)
    focusArea("body")
  }

  /** Re-target after a stale save, keeping the user's edits; the new entry's values become the baseline. */
  const retargetEntry = (entry: StatusSettingsEntry): void => {
    const resolution = resolveStatusOptions(entry.options)

    setTarget(entry)
    setDiskIssues(resolution.diagnostics.length)
    setDraft((state) => retargetDraft(state, resolution.options))
    setCustomStash({})
    setPanel(undefined)
    setNotice(entry.enabled ? "" : DISABLED_ENTRY_NOTICE)
    focusArea("body")
  }

  const readNow = async (): Promise<void> => {
    setReading(true)
    setReadError(undefined)

    const result = await props.store.read()

    if (disposed) return
    setReading(false)

    if (result.status === "error") {
      setReadError(result.message)
      setPanel({ kind: "error", message: result.message, source: "read" })
      setArea("panel")
      setCursor(0)

      return
    }

    const entries = result.state.entries

    if (entries.length === 0) {
      setTarget(undefined)
      setDiskIssues(0)
      setDraft(rebaseDraft(props.fallback))
      setCustomStash({})

      return
    }

    const only = entries[0]

    if (entries.length === 1 && only !== undefined) {
      adoptEntry(only)

      return
    }

    setPanel({ kind: "target", mode: "open", entries })
    setArea("panel")
    setCursor(0)
  }

  void readNow()

  const rows = createMemo(() => editorRows(options()))

  const bodyWindow = createMemo(() => {
    const list = rows()
    const height = bodyHeight()
    const manual = scrollOffset()

    if (manual !== undefined && height > 0) {
      const count = Math.max(0, Math.min(height, list.length))
      const start = Math.max(0, Math.min(manual, Math.max(0, list.length - count)))

      return { list, start, visible: list.slice(start, start + count) }
    }

    const start = ensureWindowStart(list.length, windowCursor(), height, untrack(windowStart))
    const count = height > 0 ? Math.max(0, Math.min(height, list.length - start)) : list.length

    return { list, start, visible: list.slice(start, start + count) }
  })

  createEffect(() => {
    if (area() === "body" || area() === "panel") setWindowCursor(cursor())
    // The wheel never moves the cursor, so it never clears the manual view;
    // any cursor or area move ends it and re-anchors the window.
    setScrollOffset(undefined)
  })

  createEffect(() => {
    const list = rows()
    const next = ensureWindowStart(list.length, windowCursor(), bodyHeight(), untrack(windowStart))

    if (next !== untrack(windowStart)) setWindowStart(next)
  })

  createEffect(() => {
    const list = rows()

    if (list.length > 0 && cursor() >= list.length) setCursor(moveRowCursor(list, list.length - 1, -1))
  })

  // The cursor always sits on a focusable row of whatever is rendered: the
  // hidden context-bar control appearing and disappearing, and fresh panels
  // all land on their first actionable row.
  createEffect(() => {
    if (area() !== "body") return
    const list = rows()

    if (list.length === 0) return
    const snapped = moveRowCursor(list, cursor(), 1)

    if (snapped !== cursor()) setCursor(snapped)
  })

  createEffect(() => {
    if (area() !== "panel") return
    const list = panelRows()
    const row = list[cursor()]

    if (row === undefined || row.info) movePanelCursor(1)
  })

  const currentRow = (): SettingsRow | undefined => rows()[cursor()]

  const panelRows = createMemo<readonly PanelRow[]>(() => {
    const active = panel()

    if (active === undefined) return []

    if (active.kind === "target") {
      const rows: PanelRow[] = active.entries.map((entry) => {
        const row: PanelRow = {
          id: `entry:${entry.index}`,
          info: false,
          text: entry.specifier,
          run: () => (active.mode === "open" ? adoptEntry(entry) : retargetEntry(entry)),
        }

        return entry.enabled ? row : { ...row, detail: "disabled · saving won't enable the plugin" }
      })

      if (rows.length === 0) {
        rows.push({
          id: "entry:create",
          info: false,
          text: `Create a new ${PLUGIN_PACKAGE_NAME} entry`,
          detail: "saves the draft and adds the package entry",
          run: () => {
            setTarget(undefined)
            setPanel(undefined)
            void performSave(false)
          },
        })
      }

      return rows
    }

    if (active.kind === "create") {
      return [
        { id: "create:info", info: true, text: `No ${PLUGIN_PACKAGE_NAME} entry exists in this file yet.` },
        { id: "create:action", info: false, text: "Create the entry and save", run: () => {
            setPanel(undefined)
            void performSave(false)
          } },
        { id: "create:back", info: false, text: "Back to editing", run: closePanel },
      ]
    }

    if (active.kind === "conflict") {
      const rows: PanelRow[] = [
        {
          id: "conflict:info",
          info: true,
          text: "These settings changed on disk since the editor opened:",
        },
      ]

      for (const field of active.fields) {
        const mine = fieldSummary(options(), field)
        const theirs = fieldSummary(active.current, field)

        rows.push({
          id: `conflict:${field}`,
          info: true,
          text: theirs.label,
          detail: `yours: ${mine.value} · file: ${theirs.value}`,
        })
      }

      rows.push({
        id: "conflict:mine",
        info: false,
        text: "Keep my changes",
        detail: "overwrite the file's values",
        run: () => void performSave(true),
      })

      if (active.fields.length > 0) {
        rows.push({
          id: "conflict:theirs",
          info: false,
          text: "Use the file's values",
          detail: "drop these edits",
          run: () => {
            setDraft((state) => adoptFields(state, active.fields, active.current))
            closePanel()
          },
        })
      }

      rows.push({ id: "conflict:back", info: false, text: "Back to editing", run: closePanel })

      return rows
    }

    return [
      { id: "error:info", info: true, text: active.message },
      {
        id: "error:retry",
        info: false,
        text: "Try again",
        run: () => {
          setPanel(undefined)

          if (active.source === "read") void readNow()
          else void performSave(false)
        },
      },
      { id: "error:back", info: false, text: "Back to editing", run: closePanel },
    ]
  })

  // The same measured window as the section body: a target list or a field
  // list longer than the viewport scrolls with the panel cursor, and the
  // panel's own title and actions stay fixed. The wheel can park the view
  // away from the cursor here too, until the cursor moves.
  const panelWindow = () => {
    const list = panelRows()
    const height = bodyHeight()
    const manual = scrollOffset()

    if (manual !== undefined && height > 0) {
      const count = Math.max(0, Math.min(height, list.length))
      const start = Math.max(0, Math.min(manual, Math.max(0, list.length - count)))

      return { list, start, visible: list.slice(start, start + count) }
    }

    const start = ensureWindowStart(list.length, windowCursor(), height, untrack(windowStart))
    const count = height > 0 ? Math.max(0, Math.min(height, list.length - start)) : list.length

    return { list, start, visible: list.slice(start, start + count) }
  }

  function closePanel(): void {
    setPanel(undefined)
    focusArea("body", moveRowCursor(rows(), 0, 1))
  }

  const movePanelCursor = (direction: 1 | -1): void => {
    const list = panelRows()
    const start = Math.max(0, Math.min(cursor() + direction, list.length - 1))

    for (let index = start; index >= 0 && index < list.length; index += direction) {
      if (list[index]?.info !== true) {
        setCursor(index)

        return
      }
    }

    for (let index = start; index >= 0 && index < list.length; index -= direction) {
      if (list[index]?.info !== true) {
        setCursor(index)

        return
      }
    }
  }

  const activatePanelRow = (): void => {
    const row = panelRows()[cursor()]

    row?.run?.()
  }

  const performSave = async (force: boolean): Promise<void> => {
    if (savePhase().status === "saving") return
    const state = draft()

    setSavePhase({ status: "saving" })

    const result = await props.store.save({
      target: target(),
      changed: [...state.changed],
      patch: draftPatch(state),
      force,
    })

    if (result.status === "saved") {
      // The write already happened, so the caller applies the merged options
      // even when the host closed the dialog mid-save; its callback is
      // generation-guarded. Only the dialog's own state (closing, panels)
      // stops at disposal.
      props.onSaved?.(result.options)

      if (!disposed) props.requestClose()

      return
    }

    if (disposed) return
    setSavePhase({ status: "idle" })

    if (result.status === "conflict") {
      setPanel({
        kind: "conflict",
        fields: result.fields,
        current: result.current,
      })
      setArea("panel")
      setCursor(0)

      return
    }

    if (result.status === "stale") {
      setPanel({
        kind: "target",
        mode: "retarget",
        entries: result.state.entries,
        note: "The file changed while saving; pick the entry to update.",
      })
      setArea("panel")
      setCursor(0)

      return
    }

    setSavePhase({ status: "error", message: result.message })
    setPanel({ kind: "error", message: result.message, source: "save" })
    setArea("panel")
    setCursor(0)
  }

  const requestSave = (): void => {
    if (savePhase().status === "saving") return

    if (!finishCustomEdit()) return

    if (target() === undefined) {
      setPanel({ kind: "create" })
      setArea("panel")
      setCursor(0)

      return
    }

    void performSave(false)
  }

  const applyOptions = (next: NormalizedStatusOptions): void => {
    setDraft((state) => editDraft(state, next))
  }

  /**
   * Keep the cursor on a widget across a move or a visibility toggle: the
   * rows reflow around it (an emptied corner, the hidden section), and the
   * widget itself is still what the user is working on.
   */
  const focusWidgetRow = (widget: WidgetID, next: NormalizedStatusOptions): void => {
    const list = editorRows(next)
    const index = list.findIndex((row) => row.kind === "widget" && row.widget === widget)

    if (index !== -1) setCursor(index)
  }

  const openAppearanceFor = (widget: WidgetID): void => {
    const controls = appearanceControlsForWidget(widget)

    if (controls.length === 0) {
      setNotice(`No appearance settings for the ${widget} widget.`)

      return
    }

    const list = editorRows(options())
    const targetIndex = list.findIndex((row) => row.kind === "control" && controls.includes(row.control.id))

    setNotice("")
    revealSection("appearance", targetIndex)
  }

  const revealSection = (section: SettingsSection, targetIndex = -1): void => {
    const list = rows()
    const heading = list.findIndex((row) => row.id === `section:${section}`)
    const next = targetIndex < 0 ? moveRowCursor(list, heading, 1) : targetIndex

    batch(() => {
      setWindowStart(heading)
      setWindowCursor(next)
      focusArea("body", next)
    })
  }

  const previewTarget = (): string => preview().location === "project" ? "worktree" : "project"

  const changePreview = (): void => {
    setPreview((state) => ({ ...state, location: state.location === "project" ? "worktree" : "project" }))
  }

  const changeFocusedValue = (direction: 1 | -1): void => {
    switch (area()) {
      case "actions":
        setCursor((index) => Math.max(0, Math.min(index + direction, ACTIONS.length - 1)))

        return

      case "body":
        break

      default:
        return
    }

    const row = currentRow()

    if (row === undefined) return

    if (row.kind === "widget") {
      const next = moveWidgetToAdjacentZone(options(), row.widget, direction)

      applyOptions(next)
      focusWidgetRow(row.widget, next)
      setNotice("")

      return
    }

    if (row.kind === "control") {
      changeAppearance(row.control, direction)

      return
    }

    if (row.kind === "preset") {
      applyOptions(cycleOverflowPreset(options(), direction))
      setNotice("")

      return
    }

    if (row.kind === "priority") {
      const next = reorderHideFirst(options(), row.position - 1, direction)

      applyOptions(next)
      const list = editorRows(next)
      const index = list.findIndex((candidate) => candidate.kind === "priority" && candidate.widget === row.widget)

      if (index !== -1) setCursor(index)
      setNotice("")
    }
  }

  const toggleFocused = (): void => {
    if (area() === "actions") {
      activateAction()

      return
    }

    if (area() !== "body") return
    const row = currentRow()

    if (row === undefined) return

    if (row.kind === "widget") {
      const next = toggleWidgetVisibility(options(), row.widget)

      applyOptions(next)
      focusWidgetRow(row.widget, next)
      setNotice("")

      return
    }

    if (row.kind === "control") {
      if (row.control.custom?.read(options()) !== undefined) beginCustomEdit(row.control)
      else changeAppearance(row.control, 1)
    }
  }

  const activateFocused = (): void => {
    if (area() === "actions") {
      activateAction()

      return
    }

    if (area() !== "body") return
    const row = currentRow()

    if (row === undefined) return

    if (row.kind === "widget") {
      openAppearanceFor(row.widget)

      return
    }

    if (row.kind === "control" && row.control.custom?.read(options()) !== undefined) {
      beginCustomEdit(row.control)
    } else if (row.kind === "control" || row.kind === "preset") {
      changeFocusedValue(1)
    }
  }

  const reorderFocused = (direction: 1 | -1): void => {
    if (area() !== "body") return
    const row = currentRow()

    if (row === undefined) return

    if (row.kind === "priority") {
      const next = reorderHideFirst(options(), row.position - 1, direction)

      applyOptions(next)
      // Keep the cursor on the moved widget so repeated `[` / `]` walks it
      // to the end without an `up`/`down` between each step.
      const list = editorRows(next)
      const index = list.findIndex((candidate) => candidate.kind === "priority" && candidate.widget === row.widget)

      if (index !== -1) setCursor(index)
      setNotice("")

      return
    }

    if (row.kind === "widget") {
      const zone = row.zone

      if (zone === undefined) {
        setNotice(`Can't reorder hidden ${row.widget}; press space to show it first.`)

        return
      }

      const next = reorderWidgetWithinZone(options(), row.widget, direction)

      applyOptions(next)
      focusWidgetRow(row.widget, next)
    }
  }

  const activateAction = (): void => {
    const action = ACTIONS[cursor()]?.id

    if (action === "reset") {
      setDraft((state) => editDraft(state, DEFAULT_STATUS_OPTIONS))
      setCustomStash({})
      setNotice("Defaults loaded; Save to apply.")

      return
    }

    if (action === "save") {
      requestSave()

      return
    }

    if (action === "cancel") props.requestClose()
  }

  const cycleArea = (direction: 1 | -1): void => {
    const order: readonly FocusArea[] = ["body", "actions"]
    const index = order.indexOf(area())
    const next = order[(index + direction + order.length) % order.length] ?? "body"

    focusArea(next, next === "body" ? moveRowCursor(rows(), windowCursor(), 1) : 0)
  }

  const moveFocus = (direction: 1 | -1): void => {
    switch (area()) {
      case "body": {
        const list = rows()
        const last = moveRowCursor(list, list.length - 1, -1)

        if (direction === 1 && cursor() >= last) {
          focusArea("actions", 0)

          return
        }

        setCursor((index) => moveRowCursor(list, index + direction, direction))

        return
      }

      case "actions":
        if (direction === -1) focusArea("body", moveRowCursor(rows(), rows().length - 1, -1))
        else setCursor((index) => Math.max(0, Math.min(index + direction, ACTIONS.length - 1)))

        return

      case "panel":
        movePanelCursor(direction)
    }
  }

  const movePage = (direction: 1 | -1): void => {
    if (area() !== "body") return
    const step = Math.max(1, bodyHeight() > 0 ? bodyHeight() - 1 : 5)

    setCursor((index) => moveRowCursor(rows(), index + direction * step, direction))
  }

  // Mouse support is passive: these handlers only fire when the host enables
  // mouse reporting. A click focuses its row; a click on the already-focused
  // row applies the row's primary key action forward-only (enter / →). The
  // wheel parks the visible window away from the cursor until the cursor moves.

  const scrollView = (direction: 1 | -1): void => {
    if (editing() !== undefined) return

    const height = bodyHeight()

    if (height <= 0) return
    const window = panel() !== undefined ? panelWindow() : bodyWindow()
    const count = Math.min(height, window.list.length)

    if (window.list.length <= count) return
    const max = window.list.length - count
    const start = Math.max(0, Math.min(window.start + direction * WHEEL_STEP, max))

    // Keep the base position in sync with the parked view: clearing the
    // override (any cursor move, including a click) re-anchors from here, so
    // the view never snaps back to a stale position.
    setWindowStart(start)
    setScrollOffset(start)
  }

  const applyFocusedRow = (row: SettingsRow): void => {
    if (row.kind === "widget") {
      openAppearanceFor(row.widget)

      return
    }

    if (row.kind === "control") {
      if (row.control.custom?.read(options()) !== undefined) beginCustomEdit(row.control)
      else changeAppearance(row.control, 1)

      return
    }

    if (row.kind === "preset") {
      applyOptions(cycleOverflowPreset(options(), 1))
      setNotice("")
    }
    // Priority rows and headers have no forward action; a click only focuses.
  }

  const handleRowClick = (index: number): void => {
    if (savePhase().status === "saving" || panel() !== undefined) return

    if (editing() !== undefined && (cursor() === index || !finishCustomEdit())) return

    const row = rows()[index]

    if (row === undefined || row.kind === "header" || row.kind === "note") return

    if (area() !== "body" || cursor() !== index) {
      focusArea("body", index)

      return
    }

    applyFocusedRow(row)
  }

  const handleActionClick = (index: number): void => {
    if (savePhase().status === "saving" || panel() !== undefined) return

    if (ACTIONS[index]?.id === "cancel") {
      setEditing(undefined)
      setEditError("")
    } else if (!finishCustomEdit()) return

    if (area() !== "actions" || cursor() !== index) {
      focusArea("actions", index)

      return
    }

    activateAction()
  }

  const handlePanelClick = (index: number): void => {
    if (savePhase().status === "saving") return
    const row = panelRows()[index]

    if (row === undefined || row.info) return

    if (area() !== "panel" || cursor() !== index) {
      setArea("panel")
      setCursor(index)

      return
    }

    activatePanelRow()
  }

  const handleKey = (key: string): void => {
    if (savePhase().status === "saving") return

    if (tooSmall() && key !== "escape") return

    const edit = editing()

    if (edit !== undefined) {
      if (key === "escape") {
        setEditing(undefined)
        setEditError("")
      } else if (key === "save") requestSave()
      else if (key === "activate") finishCustomEdit()
      else if (key === "tab" || key === "shift+tab") {
        if (edit.values.length > 1) setEditing({ ...edit, field: (edit.field + 1) % edit.values.length })
        else if (finishCustomEdit()) cycleArea(key === "tab" ? 1 : -1)
      }

      return
    }

    if (key === "save") {
      requestSave()

      return
    }

    if (key === "escape") {
      if (tooSmall() || panel() === undefined) props.requestClose()
      else closePanel()

      return
    }

    if (area() === "panel") {
      switch (key) {
        case "up":
          movePanelCursor(-1)

          return

        case "down":
          movePanelCursor(1)

          return

        case "activate":
        case "toggle":
          activatePanelRow()

          return
      }

      return
    }

    switch (key) {
      case "preview-location":
        changePreview()

        return

      case "section-layout":
        revealSection("layout")

        return

      case "section-appearance":
        revealSection("appearance")

        return

      case "section-overflow":
        revealSection("overflow")

        return

      case "tab":
        cycleArea(1)

        return

      case "shift+tab":
        cycleArea(-1)

        return

      case "up":
      case "down":
        moveFocus(key === "up" ? -1 : 1)

        return

      case "page-up":
        movePage(-1)

        return

      case "page-down":
        movePage(1)

        return

      case "left":
        changeFocusedValue(-1)

        return

      case "right":
        changeFocusedValue(1)

        return

      case "activate":
        activateFocused()

        return

      case "toggle":
        toggleFocused()

        return

      case "reorder-prev":
        reorderFocused(-1)

        return

      case "reorder-next":
        reorderFocused(1)
    }
  }

  // The dialog is modal while it is open: the host pushes the `modal` input
  // mode for any open dialog, and the layer is owned by this component, so it
  // disappears with the dialog.
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: editing() !== undefined ? [
      { bind: "return", title: "Accept text", group: "Customize footer", run: () => handleKey("activate") },
      { bind: "escape", title: "Cancel text edit", group: "Customize footer", run: () => handleKey("escape") },
      { bind: "tab", title: "Next input", group: "Customize footer", run: () => handleKey("tab") },
      { bind: "shift+tab", title: "Previous input", group: "Customize footer", run: () => handleKey("shift+tab") },
      { bind: "ctrl+s", title: "Save settings", group: "Customize footer", run: () => handleKey("save") },
    ] : [
      { bind: "tab", title: "Focus actions", group: "Customize footer", run: () => handleKey("tab") },
      { bind: "shift+tab", title: "Focus settings", group: "Customize footer", run: () => handleKey("shift+tab") },
      { bind: "up", title: "Row up", group: "Customize footer", run: () => handleKey("up") },
      { bind: "down", title: "Row down", group: "Customize footer", run: () => handleKey("down") },
      { bind: "left", title: "Change value", group: "Customize footer", run: () => handleKey("left") },
      { bind: "right", title: "Change value", group: "Customize footer", run: () => handleKey("right") },
      { bind: "return", title: "Activate", group: "Customize footer", run: () => handleKey("activate") },
      { bind: "space", title: "Toggle", group: "Customize footer", run: () => handleKey("toggle") },
      { bind: "[", title: "Move earlier", group: "Customize footer", run: () => handleKey("reorder-prev") },
      { bind: "]", title: "Move later", group: "Customize footer", run: () => handleKey("reorder-next") },
      { bind: "shift+left", title: "Move earlier", group: "Customize footer", run: () => handleKey("reorder-prev") },
      { bind: "shift+right", title: "Move later", group: "Customize footer", run: () => handleKey("reorder-next") },
      { bind: "pageup", title: "Page up", group: "Customize footer", run: () => handleKey("page-up") },
      { bind: "pagedown", title: "Page down", group: "Customize footer", run: () => handleKey("page-down") },
      { id: "enhanced-composer.preview.location", bind: "l", title: `Preview ${previewTarget()} sample`, group: "Customize footer", run: () => handleKey("preview-location") },
      { id: "enhanced-composer.settings.layout", bind: "1", title: "Jump to Layout", group: "Customize footer", run: () => handleKey("section-layout") },
      { id: "enhanced-composer.settings.appearance", bind: "2", title: "Jump to Appearance", group: "Customize footer", run: () => handleKey("section-appearance") },
      { id: "enhanced-composer.settings.overflow", bind: "3", title: "Jump to Overflow", group: "Customize footer", run: () => handleKey("section-overflow") },
      { bind: "ctrl+s", title: "Save settings", group: "Customize footer", run: () => handleKey("save") },
      { bind: "s", title: "Save settings", group: "Customize footer", run: () => handleKey("save") },
      { bind: "escape", title: "Cancel settings", group: "Customize footer", run: () => handleKey("escape") },
    ],
  }))

  const statusMessage = (): StatusMessage => {
    if (editError() !== "") return { text: `! ${editError()}`, strong: true }

    const phase = savePhase()

    if (phase.status === "saving") return { text: "Saving…", strong: true }

    if (phase.status === "error") return { text: `! ${phase.message}`, strong: true }

    const error = readError()

    if (error !== undefined) return { text: `! ${error}`, strong: true }

    if (editing() !== undefined) return { text: wide() ? customEditDescription(editing()?.control.id) : "", strong: false }

    if (notice() !== "") return { text: notice(), strong: false }

    if (diskIssues() > 0) {
      const count = diskIssues()

      return {
        text: count === 1
          ? "1 file value repaired, showing default; save touches only edited fields"
          : `${count} file values repaired, showing defaults; save touches only edited fields`,
        strong: false,
      }
    }

    return { text: "", strong: false }
  }

  /**
   * The log line text: errors and saving as-is, notes with a `·` prefix, and
   * a blank to hold the row when clean so showing a message never reflows
   * the list above or the legend below.
   */
  const logText = (): string => {
    const message = statusMessage()

    if (message.text === "") return " "

    return message.strong ? message.text : `· ${message.text}`
  }

  const keyHints = (): readonly KeyHint[] => {
    if (editing() !== undefined) return editing()?.values.length === 2 ? [{ key: "tab", action: "in / out" }] : []

    const row = currentRow()

    if (panel() !== undefined) {
      return [
        { key: "enter", action: "confirm" },
        { key: "esc", action: "back" },
        { key: "s", action: "save" },
        { key: "ctrl+s", action: "save" },
      ]
    }

    switch (area()) {
      case "actions":
        return [{ key: "enter", action: "run" }]

      case "body":
        switch (currentRow()?.kind) {
          case "widget":
            return [
              { key: "space", action: row?.kind === "widget" && row.zone === undefined ? "show" : "hide" },
              { key: "[ ]", action: "order" },
              { key: "enter", action: "style" },
            ]

          case "control":
            return row?.kind === "control" && row.control.custom?.read(options()) !== undefined ? [{ key: "enter", action: "edit" }] : []

          case "preset":
          case "priority":
            return currentRow()?.kind === "priority" ? [{ key: "[ ]", action: "reorder" }] : []

          default:
            return []
        }

      default:
        return [
          { key: "s", action: "save" },
          { key: "esc", action: "cancel" },
        ]
    }
  }

  const measureBody = function (this: { readonly height: number }): void {
    setBodyHeight(this.height)
  }

  const dimensions = useTerminalDimensions()
  const availableWidth = (): number => contentWidth() || Math.max(1, dimensions().width - 4)
  const wide = (): boolean => availableWidth() >= 96
  const compact = (): boolean => dimensions().height < 30
  const tooSmall = (): boolean => availableWidth() < 56 || dimensions().height < 20

  const focusedDescription = (): string => {
    if (editing() !== undefined) return customEditDescription(editing()?.control.id)

    if (area() !== "body") return ""
    const row = currentRow()

    if (row === undefined) return ""

    if (row.kind !== "widget" || row.zone === undefined) return rowDescription(row)

    return `${rowDescription(row)}${row.zone === "topLeft" || row.zone === "topRight" ? " Sessions only." : ""}`
  }

  // Legend wrapping is decided here rather than by the renderer's `flexWrap`:
  // a bare `flexWrap` sends an item's leading " · " separator to the next line
  // when the item wraps, leaving a stray dot at the start of the line. Packing
  // the chips by measured width keeps every separator between two chips.

  /** A chip's display text, used only to measure how much width it needs. */
  const hintChips = (): readonly string[] =>
    keyHints().map((hint) => `${hint.key} ${hint.action}`.trimEnd())

  /** Universal keys plus the preview jump: always visible below the contextual hints. */
  const bottomHints = (): readonly KeyHint[] => editing() !== undefined ? [
    { key: "enter", action: "accept" },
    { key: "esc", action: "back" },
    { key: "ctrl+s", action: "save" },
  ] : [
    { key: "l", action: `preview ${previewTarget()}` },
    { key: "tab", action: area() === "actions" ? "settings" : "actions" },
    { key: "s", action: "save" },
    { key: "esc", action: "cancel" },
  ]

  /** A bottom chip's display text, used only to measure how much width it needs. */
  const bottomChips = (): readonly string[] =>
    bottomHints().map((hint) => `${hint.key} ${hint.action}`.trimEnd())

  /** Groups chips into lines that fit; each line is a list of chip indices. */
  const packLegend = (chips: readonly string[]): readonly (readonly number[])[] => {
    const measure = createCellMeasurer(props.context.renderer?.widthMethod)
    const gap = measure(LEGEND_SEPARATOR)
    const limit = availableWidth()
    const lines: number[][] = []
    let line: number[] = []
    let width = 0

    for (let index = 0; index < chips.length; index += 1) {
      const chipWidth = measure(chips[index] ?? "")

      if (line.length > 0 && width + gap + chipWidth > limit) {
        lines.push(line)
        line = []
        width = 0
      }

      width = line.length === 0 ? chipWidth : width + gap + chipWidth
      line.push(index)
    }

    if (line.length > 0) lines.push(line)

    return lines
  }

  /**
   * True when the contextual hints and the universal hints fit on one line:
   * the footer renders a single row with the contextual hints left and the
   * universal hints right. Otherwise the groups stack, universal lines
   * right-aligned.
   */
  const legendSingleRow = (): boolean => {
    const left = hintChips()
    const right = bottomChips()

    if (left.length === 0 || right.length === 0) return true
    const measure = createCellMeasurer(props.context.renderer?.widthMethod)
    const gap = measure(LEGEND_SEPARATOR)

    const width = (chips: readonly string[]): number =>
      chips.reduce((total, chip, index) => total + measure(chip) + (index > 0 ? gap : 0), 0)

    return width(left) + gap + width(right) <= availableWidth()
  }

  // The host centers a dialog in the terminal but does not bound its content,
  // so the editor sizes itself to the viewport: the fixed rows (title,
  // preview, actions, message, key legend) always fit and
  // only the settings list scrolls.
  const viewportHeight = (): number => Math.max(1, dimensions().height - 2)

  // The host resets presentation when it shows a dialog; reclaim the wide
  // centered layout once this component is mounted, the same way the host's
  // own dialogs set their size from inside the component.
  onMount(() => {
    props.context.ui.dialog.set({ size: "xlarge", centered: true })
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      height={viewportHeight()}
      paddingLeft={2}
      paddingRight={2}
      onSizeChange={function () { setContentWidth(Math.max(1, this.width - 4)) }}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction

        if (direction === "up") scrollView(-1)
        else if (direction === "down") scrollView(1)
      }}
    >
      <Show when={!tooSmall()} fallback={
        <box flexDirection="column" width="100%">
          <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD}>{"Terminal too small"}</text>
          <text fg={props.context.theme.text.base}>{"Resize to at least 60 × 20 to edit settings."}</text>
          <text fg={props.context.theme.text.muted}>{"Esc  Close"}</text>
        </box>
      }>
      <box flexDirection="row" width="100%" flexShrink={0}>
        <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          {"Customize footer"}
        </text>
        <text fg={props.context.theme.text.muted} wrapMode="none">
          {editing() !== undefined ? "  editing custom text" : changedCount() > 0 ? `  ${changedCount()} unsaved` : "  no unsaved changes"}
        </text>
      </box>

      <Show when={!compact()}><box height={1} flexShrink={0} /></Show>

      <PreviewBlock
        context={props.context}
        options={previewOptions()}
        preview={preview()}
        spinnerBase={props.context.theme.border.base}
        compact={compact()}
      />

      <Show when={!compact()}><box height={1} flexShrink={0} /></Show>

      <Show
        when={panel() === undefined}
        fallback={
          <box flexDirection="column" width="100%" flexGrow={1} minHeight={0}>
            <box flexDirection="row" width="100%" flexShrink={0}>
              <text fg={props.context.theme.text.base} attributes={TextAttributes.BOLD}>
                {panelTitle(panel())}
              </text>
            </box>
            <Show when={panelNote(panel()) !== ""}>
              <box flexDirection="row" width="100%" flexShrink={0}>
                <text fg={props.context.theme.text.muted}>{panelNote(panel())}</text>
              </box>
            </Show>
            <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} onSizeChange={measureBody}>
              <For each={panelWindow().visible}>
                {(row, index) => (
                  <box flexDirection="row" width="100%" onMouseDown={() => handlePanelClick(panelWindow().start + index())}>
                    <text fg={props.context.theme.text.base} wrapMode="none">
                      {row.info ? "  " : cursor() === panelWindow().start + index() ? "› " : "  "}
                    </text>
                    <text
                      fg={row.info ? props.context.theme.text.muted : props.context.theme.text.base}
                      attributes={!row.info && cursor() === panelWindow().start + index() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {row.text}
                    </text>
                    <Show when={row.detail !== undefined}>
                      <text fg={props.context.theme.text.muted} wrapMode="none">{`  ${row.detail ?? ""}`}</text>
                    </Show>
                  </box>
                )}
              </For>
            </box>
          </box>
        }
      >
        <box flexDirection="column" width="100%" flexGrow={1} minHeight={0} onSizeChange={measureBody}>
          <Show when={!reading()} fallback={<text fg={props.context.theme.text.muted}>{"Reading configuration…"}</text>}>
            <For each={bodyWindow().visible}>
              {(row, index) => (
                <BodyRow
                  row={row}
                  index={bodyWindow().start + index()}
                  focused={area() === "body" && cursor() === bodyWindow().start + index()}
                  options={options()}
                  subdued={props.context.theme.text.muted}
                  primary={props.context.theme.text.base}
                  wide={wide()}
                  onRowClick={handleRowClick}
                  edit={editing()?.control.id === (row.kind === "control" ? row.control.id : undefined) ? editing() : undefined}
                  onEditField={(field) => setEditing((edit) => edit === undefined ? undefined : { ...edit, field })}
                  onEditValue={(field, value) => {
                    const edit = editing()

                    if (edit === undefined) return

                    const nextValues = edit.values.map((text, index) => index === field ? value : text)

                    setEditing({ ...edit, values: nextValues })
                    setEditError(nextValues.every(isLiteralText) ? "" : CUSTOM_TEXT_ERROR)
                  }}
                  onEditError={() => setEditError(CUSTOM_TEXT_ERROR)}
                  onEditSubmit={finishCustomEdit}
                />
              )}
            </For>
          </Show>
        </box>
      </Show>

      <Show when={!wide() && panel() === undefined}>
        <text width="100%" height={2} flexShrink={0} fg={props.context.theme.text.muted} wrapMode="word">{focusedDescription()}</text>
      </Show>

      <Show when={!compact()}><box height={1} flexShrink={0} /></Show>

      <box flexDirection="row" width="100%" flexShrink={0}>
        <For each={ACTIONS}>
          {(action, index) => {
            const focused = (): boolean => area() === "actions" && cursor() === index()
            const save = (): boolean => action.id === "save"

            return (
              <text
                fg={focused() || save() ? props.context.theme.text.base : props.context.theme.text.muted}
                attributes={focused() || save() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                onMouseDown={() => handleActionClick(index())}
              >
                {focused() ? `› ${action.title}   ` : `  ${action.title}   `}
              </text>
            )
          }}
        </For>
      </box>

      <Show when={!compact()}><box height={1} flexShrink={0} /></Show>

      <box flexDirection="row" width="100%" flexShrink={0}>
        <text
          fg={statusMessage().strong ? props.context.theme.text.base : props.context.theme.text.muted}
          wrapMode="none"
        >
          {logText()}
        </text>
      </box>
      <Show
        when={panel() === undefined && legendSingleRow()}
        fallback={
          <box flexDirection="column" width="100%" flexShrink={0}>
            <For each={packLegend(hintChips())}>
              {(line) => (
                <box flexDirection="row" width="100%" flexShrink={0}>
                  <HintLine
                    subdued={props.context.theme.text.muted}
                    primary={props.context.theme.text.base}
                    hints={keyHints()}
                    line={line}
                  />
                </box>
              )}
            </For>
            <Show when={panel() === undefined}>
              <For each={packLegend(bottomChips())}>
                {(line) => (
                  <box flexDirection="row" width="100%" flexShrink={0} justifyContent="flex-end">
                    <HintLine
                      subdued={props.context.theme.text.muted}
                      primary={props.context.theme.text.base}
                      hints={bottomHints()}
                      line={line}
                    />
                  </box>
                )}
              </For>
            </Show>
          </box>
        }
      >
        <box flexDirection="row" width="100%" flexShrink={0}>
          <box flexDirection="row" flexShrink={0}>
            <HintLine
              subdued={props.context.theme.text.muted}
              primary={props.context.theme.text.base}
              hints={keyHints()}
              line={allIndices(keyHints().length)}
            />
          </box>
          <box flexGrow={1} flexShrink={0} />
          <box flexDirection="row" flexShrink={0}>
            <HintLine
              subdued={props.context.theme.text.muted}
              primary={props.context.theme.text.base}
              hints={bottomHints()}
              line={allIndices(bottomHints().length)}
            />
          </box>
        </box>
      </Show>
      </Show>
    </box>
  )
}

function panelTitle(active: Panel | undefined): string {
  if (active === undefined) return ""

  switch (active.kind) {
    case "target":
      return "Choose the entry to update"

    case "create":
      return "Create a new entry"

    case "conflict":
      return "These settings changed on disk"

    case "error":
      return active.source === "read" ? "The configuration could not be read" : "The save did not complete"
  }
}

function panelNote(active: Panel | undefined): string {
  return active?.kind === "target" ? (active.note ?? "") : ""
}

interface PreviewBlockProps {
  readonly context: Plugin.Context
  readonly options: NormalizedStatusOptions
  readonly preview: PreviewState
  readonly spinnerBase: RGBA
  readonly compact: boolean
}

/**
 * The miniature prompt: the draft's options through the production pipeline,
 * the top row from the top zones and the footer row from the bottom zones.
 * A dimmed prompt placeholder with breathing room on both sides signals that
 * the prompt sits between the two rows. The preview always renders at the
 * live width — overflow is observed in the real terminal, not a fixed narrow
 * sample.
 */
function PreviewBlock(props: PreviewBlockProps): JSX.Element {
  const rowWidth = useRowWidth()
  const theme = (): StatusRowTheme => ({ subdued: props.context.theme.text.muted })

  const rows = createMemo(() =>
    buildPreviewRows({
      options: props.options,
      scenario: props.preview.scenario,
      location: props.preview.location,
      width: rowWidth.width(),
      widthMethod: props.context.renderer?.widthMethod,
    }),
  )

  const spinner = createMemo<SpinnerRender>(() => ({
    visual: props.options.appearance.spinner,
    base: props.spinnerBase,
  }))

  return (
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      border
      borderStyle="single"
      borderColor={props.context.theme.border.base}
      title="Preview"
    >
      <box width="100%">
        <StatusRow row={rows().top} theme={theme()} spinner={spinner()} onSizeChange={rowWidth.onSizeChange} />
      </box>
      <Show when={!props.compact}><box height={1} flexShrink={0} /></Show>
      <box flexDirection="row" width="100%" flexShrink={0}>
        <text fg={props.context.theme.text.muted} wrapMode="none">
          {"  › Type a message…"}
        </text>
      </box>
      <Show when={!props.compact}><box height={1} flexShrink={0} /></Show>
      <box width="100%">
        <StatusRow row={rows().bottom} theme={theme()} spinner={spinner()} />
      </box>
    </box>
  )
}

/** The label column width for `Label: value` control and preset rows. */
const SETTING_LABEL_WIDTH = 17

const SETTING_VALUE_WIDTH = 25

const SETTING_GUTTER_WIDTH = 4

/** Rows per wheel notch; small enough to keep the cursor's neighborhood. */
const WHEEL_STEP = 3

/** The separator between key legend chips; kept inside a chip's box so wrapping never strands it. */
const LEGEND_SEPARATOR = " · "

/** One key legend entry: the keystrokes to press and what they do. */
interface KeyHint {
  readonly key: string
  readonly action: string
}

interface HintLineProps {
  readonly subdued: RowColor
  readonly primary: RowColor
  readonly hints: readonly KeyHint[]
  readonly line: readonly number[]
}

/** One packed legend line: bold keys with dimmed actions, separators kept between chips. */
function HintLine(props: HintLineProps): JSX.Element {
  return (
    <For each={props.line}>
      {(chip, position) => {
        const hint = (): KeyHint | undefined => props.hints[chip]

        return (
          <box flexDirection="row" flexShrink={0}>
            <Show when={position() > 0}>
              <text fg={props.subdued} wrapMode="none">{LEGEND_SEPARATOR}</text>
            </Show>
            <text fg={props.primary} attributes={TextAttributes.BOLD} wrapMode="none">
              {hint()?.key ?? ""}
            </text>
            <text fg={props.subdued} wrapMode="none">
              {` ${hint()?.action ?? ""}`}
            </text>
          </box>
        )
      }}
    </For>
  )
}

/** Every chip index, for rendering an unpacked single line. */
function allIndices(count: number): readonly number[] {
  return Array.from({ length: count }, (_, index) => index)
}

interface BodyRowProps {
  readonly row: SettingsRow
  /** Global row index for the click handler; headers and notes ignore clicks. */
  readonly index: number
  readonly focused: boolean
  readonly options: NormalizedStatusOptions
  readonly subdued: RowColor
  readonly primary: RowColor
  readonly wide: boolean
  readonly onRowClick: (index: number) => void
  readonly edit: AppearanceEdit | undefined
  readonly onEditField: (field: number) => void
  readonly onEditValue: (field: number, value: string) => void
  readonly onEditError: () => void
  readonly onEditSubmit: () => boolean
}

function customEditDescription(id: string | undefined): string {
  if (id === "separator") return "Type or paste text. Spaces are literal. Empty joins metrics directly."

  if (id === "worktree") return "Type or paste text. Empty keeps the ordinary folder icon."

  return "Type or paste symbols or text. Empty removes the prefix."
}

function CustomAppearanceInput(props: BodyRowProps): JSX.Element {
  const initial = untrack(() => props.edit)
  // The theme hands out shared RGBA instances: clone before fading so the
  // editor's band never dims the host's own text color.
  const background = RGBA.clone(parseColor(props.primary))

  background.a = 0.08

  return (
    <box flexDirection="row" width="100%" height={1}>
      <For each={initial?.control.custom?.labels ?? []}>
        {(label, index) => (
          <box flexDirection="row" flexGrow={1} minWidth={0} paddingLeft={index() === 0 ? 0 : 2}>
            <Show when={(initial?.values.length ?? 0) > 1}>
              <text fg={props.primary} flexShrink={0}>{`${label} `}</text>
            </Show>
            <input
              id={`custom-${initial?.control.id}-${index()}`}
              value={initial?.values[index()] ?? ""}
              placeholder={initial?.values.length === 1 ? "custom" : ""}
              placeholderColor={props.subdued}
              textColor={props.primary}
              backgroundColor={background}
              focusedBackgroundColor={background}
              focusedTextColor={props.primary}
              focused={props.focused && props.edit?.field === index()}
              maxLength={Infinity}
              flexGrow={1}
              flexBasis={0}
              minWidth={0}
              onMouseDown={(event) => {
                event.stopPropagation()
                props.onEditField(index())
              }}
              onInput={(value) => props.onEditValue(index(), value)}
              onSubmit={() => props.onEditSubmit()}
              onPaste={(event) => {
                if (isLiteralText(new TextDecoder().decode(event.bytes))) return

                event.preventDefault()
                props.onEditError()
              }}
            />
          </box>
        )}
      </For>
    </box>
  )
}

function BodyRow(props: BodyRowProps): JSX.Element {
  // Rows that carry only a widget name — a layout widget or an overflow
  // priority — show it in the center value column with the focus marker
  // inside the name, not in the gutter; the row's label column stays empty.
  const nameInValue = (): boolean => props.row.kind === "widget" || props.row.kind === "priority"

  const marker = (): string => {
    if (nameInValue()) return "    "

    return props.focused ? "  › " : "    "
  }

  const select = (): void => props.onRowClick(props.index)

  if (props.row.kind === "header") {
    const section = props.row.level === "section"
    const label = `${section ? "" : "  "}${props.row.text}`

    return (
      <box flexDirection="row" width="100%" height={1} flexShrink={0}>
        <box flexDirection="row" width={SETTING_GUTTER_WIDTH + SETTING_LABEL_WIDTH + SETTING_VALUE_WIDTH} flexShrink={0} paddingRight={2}>
          <text fg={props.primary} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>{label}</text>
          <Show when={props.row.hint !== undefined}>
            <text fg={props.subdued} flexShrink={0} wrapMode="none">{` ${props.row.hint ?? ""}`}</text>
          </Show>
          <Show when={section}>
            <text fg={props.subdued} flexGrow={1} wrapMode="none">{" ─────────────────────────────────────────────"}</text>
          </Show>
        </box>
        <Show when={props.wide}>
          <text fg={props.subdued} flexGrow={1} minWidth={0} truncate wrapMode="none">{rowDescription(props.row)}</text>
        </Show>
      </box>
    )
  }

  if (props.row.kind === "note") {
    return <text width="100%" height={1} flexShrink={0} fg={props.subdued} wrapMode="none">{`    ${props.row.text}`}</text>
  }

  const label = (): string => {
    const row = props.row

    switch (row.kind) {
      case "widget": return ""
      case "control": return `${row.control.title}:`
      case "preset": return "Preset:"
      default: return ""
    }
  }

  const value = (): string => {
    const row = props.row

    switch (row.kind) {
      case "widget":
      case "priority": return props.focused ? `› ${row.widget}` : `  ${row.widget}`
      case "control": return `‹ ${controlValueText(row.control, props.options)} ›`
      case "preset": return `‹ ${props.options.overflow.preset} ›`
      default: return ""
    }
  }

  return (
    <box flexDirection="row" width="100%" height={1} flexShrink={0} onMouseDown={select}>
      <text width={SETTING_GUTTER_WIDTH} flexShrink={0} fg={props.primary} wrapMode="none">{marker()}</text>
      <text width={SETTING_LABEL_WIDTH} flexShrink={0} fg={props.primary} attributes={props.focused ? TextAttributes.BOLD : undefined} wrapMode="none">{label()}</text>
      <box width={SETTING_VALUE_WIDTH} flexShrink={0} paddingRight={2}>
        <Show when={props.edit !== undefined} fallback={
          <text fg={props.primary} attributes={props.focused ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined} truncate wrapMode="none">{value()}</text>
        }>
          <CustomAppearanceInput {...props} />
        </Show>
      </box>
      <Show when={props.wide}>
        <text fg={props.subdued} flexGrow={1} minWidth={0} truncate wrapMode="none">{rowDescription(props.row)}</text>
      </Show>
    </box>
  )
}

let activeDialog: (() => void) | undefined

/**
 * Opens the settings editor in the host's dialog. The optional `onSaved`
 * receives the normalized options the merged file resolves to, so the caller
 * can apply them to the live plugin immediately. Opening while an editor is
 * already open is ignored.
 */
export function openStatusSettings(
  context: Plugin.Context,
  onSaved?: (options: NormalizedStatusOptions) => void,
): void {
  if (activeDialog !== undefined) return

  const environment = currentCliConfigEnvironment()

  if (hasInlineCliPluginsConfig(process.env.OPENCODE_CLI_CONFIG_CONTENT)) {
    void context.ui.dialog.alert({
      title: "Customize footer unavailable",
      message:
        "OpenCode is using OPENCODE_CLI_CONFIG_CONTENT to override plugins. Update or unset that environment variable, then restart OpenCode before customizing the footer.",
    })

    return
  }

  const store = createCliStatusOptionsStore({
    identity: { packageName: PLUGIN_PACKAGE_NAME, directory: resolvePluginDirectory(import.meta.url) },
    environment,
  })

  const fallback = resolveStatusOptions(context.options).options
  const session = { open: true }

  const release = (): void => {
    // The host closed the dialog (or another dialog replaced it): nothing this
    // session still owns may touch the host's active dialog afterwards.
    session.open = false

    if (activeDialog === release) activeDialog = undefined
  }

  const requestClose = (): void => {
    if (!session.open || activeDialog !== release) return
    session.open = false
    activeDialog = undefined
    context.ui.dialog.clear()
  }

  activeDialog = release
  context.ui.dialog.show(
    () => <StatusSettingsDialog context={context} store={store} fallback={fallback} onSaved={onSaved} requestClose={requestClose} />,
    release,
  )
  // The host applies its own default presentation when it shows a dialog, so
  // the requested size goes in after the show (the mounted editor also
  // reclaims it).
  context.ui.dialog.set({ size: "xlarge", centered: true })
}
