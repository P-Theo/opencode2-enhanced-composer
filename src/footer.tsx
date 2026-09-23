// opencode2-enhanced-composer — a configurable OpenCode 2 prompt-status plugin.
//
// This module owns the host boundary —
// plugin setup, the generation guard, event tracking, the TPS tracker, and
// slot registration — and derives one status snapshot from host data.
// Everything else is shared code: `options.ts` parses the
// configuration, `format.ts` turns a snapshot into formatted widgets,
// `layout.ts` fits each row against its measured width, and `status-row.tsx`
// renders the fitted plan.
//
//   * `replace: "prompt.footer"` renders the bottom zones. The claim stays
//     mounted even when the row renders nothing: an empty replacement footer
//     still replaces the native one. Home mounts this slot without a session
//     ID, so home renders its bottom zones through the same claim; no
//     `home.footer` claim exists.
//   * `append: "session.composer.top"` renders the top zones. That slot is
//     session-only and never relocates home's top-zone items.
//
// Which widgets exist and where they sit is entirely the layout arrays'
// decision; nothing here is placement-specific. The token-throughput engine
// lives in `tps.ts`, and its semantics — observable-stream estimate held
// across tools and between steps, exact-usage reconciliation, frozen run
// average — are untouched by where the TPS widget is placed.
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import type { WidthMethod } from "@opentui/core"
import { homedir } from "node:os"
import { createMemo, createSignal, Show } from "solid-js"
import { cacheShare, formatWidgets } from "./format.js"
import type { FormattedStatusWidgets } from "./format.js"
import { createCellMeasurer, fitRow } from "./layout.js"
import type { FormattedWidget } from "./layout.js"
import {
  resolveStatusOptions,
  type BackgroundStatus,
  type ContextStatus,
  type LocationStatus,
  type NormalizedStatusOptions,
  type StatusSnapshot,
  type TpsStatus,
  type UsageStatus,
  type WidgetID,
} from "./options.js"
import { StatusRow, useRowWidth } from "./status-row.js"
import { openStatusSettings } from "./settings.js"
import { formatTpsLabel, resolveTpsOptions, TpsTracker } from "./tps.js"

// The host's `util/session.ts` is not importable, so these mirror it: the last
// assistant message carrying usage after the last completed compaction and
// before the revert boundary.

export function lastAssistantWithUsage(
  messages: ReadonlyArray<SessionMessageInfo>,
  boundary?: string,
): (SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> }) | undefined {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1

  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )

  return messages.findLast(
    (
      message,
      index,
    ): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

/** Everything the context scan reads from a model; `ModelInfo` satisfies it. */
export interface UsageModel {
  readonly id: string
  readonly providerID: string
  readonly limit: { readonly context: number }
}

/**
 * The latest usable context usage: token count, the model's window limit, and
 * the integer share. A missing or unusable limit leaves the tokens known and
 * the share unknown — the formatter's limit-requiring formats fall back.
 */
export function contextUsage(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<UsageModel> | undefined,
  boundary?: string,
): ContextStatus | undefined {
  const last = lastAssistantWithUsage(messages, boundary)

  if (!last) return undefined

  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write

  if (tokens <= 0) return undefined
  const model = models?.find((candidate) => candidate.providerID === last.model.providerID && candidate.id === last.model.id)
  const limit = model?.limit.context

  if (limit === undefined || limit <= 0) return { tokens, limit: undefined, percent: undefined }

  return { tokens, limit, percent: Math.round((tokens / limit) * 100) }
}

/**
 * Live subagents of one session: running family members whose parent is the
 * session itself. Attributing by `parentID` — not mere family membership,
 * which also surfaces the session itself, its parent, and its siblings —
 * keeps the count to this session's own subagents. Correct at setup, not
 * only after a live event, since it reads host data directly.
 */
export function backgroundUsage(
  sessionID: string,
  family: ReadonlyArray<string>,
  get: (id: string) => { readonly parentID?: string } | undefined,
  status: (id: string) => "idle" | "running",
): BackgroundStatus {
  let agents = 0

  for (const member of family) {
    if (member === sessionID) continue

    if (get(member)?.parentID !== sessionID) continue

    if (status(member) === "running") agents += 1
  }

  return { agents }
}

/** Separator-stripped path for containment checks; display shortening is `format.ts`'s job. */
function withoutTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/u, "")
}

function isInside(directory: string, parent: string): boolean {
  const base = withoutTrailingSeparators(parent)

  return directory === base || directory.startsWith(`${base}/`) || directory.startsWith(`${base}\\`)
}

/**
 * The project inventory records alternate checkout roots in `sandboxes`. A
 * sandbox can contain the session's working directory when the session was
 * opened below the worktree root, so containment is intentional here. The
 * canonical root itself may also appear in that list; it must not turn every
 * ordinary subdirectory into a worktree. Older hosts and test doubles may
 * omit `sandboxes`, so an external path keeps the previous fallback.
 */
function isWorktreeDirectory(
  directory: string,
  project: { readonly canonical: string; readonly sandboxes?: ReadonlyArray<string> } | undefined,
): boolean {
  if (!project || directory === project.canonical) return false

  if (
    project.sandboxes?.some(
      (sandbox) => sandbox !== project.canonical && isInside(directory, sandbox),
    )
  )
    return true

  return !isInside(directory, project.canonical)
}

// Event payloads are taken from the SDK's own union (via the non-generic
// `data.listen` signature) rather than restated structurally: handlers are
// contravariant, so hand-written shapes keep typechecking after a field rename.

type PluginContext = Parameters<Plugin.Definition["setup"]>[0]

type AnyEvent = Parameters<Parameters<PluginContext["data"]["listen"]>[0]>[0]["details"]

type EventOf<Type extends AnyEvent["type"]> = Extract<AnyEvent, { type: Type }>

type DeltaEvent = EventOf<"session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta">

type BlockStartedEvent = EventOf<
  "session.text.started" | "session.reasoning.started" | "session.tool.input.started"
>

type BlockEndedEvent = EventOf<"session.text.ended" | "session.reasoning.ended" | "session.tool.input.ended">

type FinishEvent = EventOf<
  "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" | "session.idle"
>

type StepStartedEvent = EventOf<"session.step.started">

type StepStreamedEvent = EventOf<"session.step.streamed">

type StepFinishedEvent = EventOf<"session.step.ended" | "session.step.failed">

type BackgroundEvent = EventOf<
  "session.tool.called" | "session.tool.success" | "session.tool.failed" | "session.tool.progress"
>

function blockID(e: DeltaEvent | BlockStartedEvent | BlockEndedEvent): string {
  if (
    e.type === "session.tool.input.delta" ||
    e.type === "session.tool.input.started" ||
    e.type === "session.tool.input.ended"
  )
    return `tool:${e.data.id}`

  return `${e.type.startsWith("session.text.") ? "text" : "reasoning"}:${e.data.ordinal}`
}

/** The zone's widgets that have data, in display order; unavailable widgets are absent, not hidden. */
function zoneWidgets(zone: readonly WidgetID[], widgets: FormattedStatusWidgets): FormattedWidget[] {
  const list: FormattedWidget[] = []

  for (const id of zone) {
    const widget = widgets[id]

    if (widget !== undefined) list.push(widget)
  }

  return list
}

const definition: Plugin.Definition = {
  id: "opencode2.enhanced-composer",
  setup(context) {
    // Generation guard: the host may start a new generation of this plugin
    // without disposing the previous one (observed on server (re)attach), and
    // hot reload shares `storage.memory` across generations. Only the newest
    // generation may render or run a spinner.
    const [gen, setGen] = context.storage.memory("generation", { initial: { active: 0 } })
    const mine = gen.active + 1

    setGen((draft) => {
      draft.active = mine
    })
    const isActive = () => gen.active === mine

    const resolution = resolveStatusOptions(context.options)

    // Setup receives an options snapshot. Apply a successful settings save
    // immediately while the host reconciles its watched config. All row readers
    // below track this signal.
    const [statusOptions, applyStatusOptions] = createSignal<NormalizedStatusOptions>(resolution.options)

    const tpsOptions = resolveTpsOptions(context.options)

    const tracker = new TpsTracker(tpsOptions)
    const [version, setVersion] = createSignal(0)
    const seenEventIDs = new Set<string>()

    // Rendering is throttled: deltas arrive at 100-200/s, and every bump costs
    // a memo recompute plus a terminal repaint to move a number no one can read
    // faster than ~10 Hz. Handlers only set a flag; the timer does the work,
    // and it only runs while a live rate can still change with time.
    let dirty = false
    let timer: ReturnType<typeof setInterval> | undefined

    function stopTimer(): void {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }

    const flush = () => {
      // A superseded generation stops ticking even if its cleanup never ran.
      if (!isActive()) {
        stopTimer()

        return
      }

      const running = tracker.hasRunning(Date.now())

      // The observable live rate decays only through a short stale tail while
      // streaming, then freezes at the stream-end boundary. Opaque provider
      // work after that is not charged to a numerator we cannot see. A dirty
      // lifecycle event still flushes one final render even when the timer stops.
      if (dirty || running) {
        dirty = false
        setVersion((value) => value + 1)
      }

      if (!running) stopTimer()
    }

    const touch = () => {
      dirty = true

      if (timer !== undefined) return
      timer = setInterval(flush, Math.round(1000 / tpsOptions.refreshHz))
      timer.unref?.()
    }

    const isNewEvent = (e: AnyEvent): boolean => {
      if (seenEventIDs.has(e.id)) return false
      seenEventIDs.add(e.id)

      if (seenEventIDs.size > 4_096) {
        const oldest = seenEventIDs.values().next().value

        if (oldest !== undefined) seenEventIDs.delete(oldest)
      }

      return true
    }

    const onDelta = (e: DeltaEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.push(e.data.sessionID, e.data.delta, e.created, e.data.assistantMessageID, blockID(e))
      touch()
    }

    const onBlockStarted = (e: BlockStartedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.beginBlock(e.data.sessionID, e.data.assistantMessageID, blockID(e), e.created)
    }

    const onBlockEnded = (e: BlockEndedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.finishBlock(e.data.sessionID, e.data.assistantMessageID, blockID(e), e.data.text, e.created)
      touch()
    }

    const onFinish = (e: FinishEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.finish(e.data.sessionID, e.created)
      touch()
    }

    const onStepStarted = (e: StepStartedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.beginStep(e.data.sessionID, e.data.assistantMessageID, e.created)
      touch()
    }

    const onStepStreamed = (e: StepStreamedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      tracker.markStreamed(e.data.sessionID, e.data.assistantMessageID, e.created)
      touch()
    }

    // The subagent marker derives from messages, which have no signal of
    // their own: these events poke the refresh timer so a starting or
    // finishing subagent re-renders within a tick.
    const onBackgroundActivity = (e: BackgroundEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      touch()
    }

    const onStepFinished = (e: StepFinishedEvent) => {
      if (!isActive() || !isNewEvent(e)) return
      const tokens = e.data.tokens

      const generatedTokens =
        tokens !== undefined &&
        Number.isFinite(tokens.output) &&
        tokens.output >= 0 &&
        Number.isFinite(tokens.reasoning) &&
        tokens.reasoning >= 0
          ? tokens.output + tokens.reasoning
          : undefined

      tracker.finishStep(e.data.sessionID, e.data.assistantMessageID, generatedTokens, e.created)
      touch()
    }

    const unsubs = [
      context.data.on("session.execution.started", (e) => {
        if (!isActive() || !isNewEvent(e)) return
        tracker.beginRun(e.data.sessionID)
        touch()
      }),
      context.data.on("session.text.delta", onDelta),
      context.data.on("session.reasoning.delta", onDelta),
      context.data.on("session.tool.input.delta", onDelta),
      context.data.on("session.text.started", onBlockStarted),
      context.data.on("session.reasoning.started", onBlockStarted),
      context.data.on("session.tool.input.started", onBlockStarted),
      context.data.on("session.text.ended", onBlockEnded),
      context.data.on("session.reasoning.ended", onBlockEnded),
      context.data.on("session.tool.input.ended", onBlockEnded),
      context.data.on("session.step.started", onStepStarted),
      context.data.on("session.step.streamed", onStepStreamed),
      context.data.on("session.step.ended", onStepFinished),
      context.data.on("session.step.failed", onStepFinished),
      context.data.on("session.tool.called", onBackgroundActivity),
      context.data.on("session.tool.success", onBackgroundActivity),
      context.data.on("session.tool.failed", onBackgroundActivity),
      context.data.on("session.tool.progress", onBackgroundActivity),
      context.data.on("session.execution.succeeded", onFinish),
      context.data.on("session.execution.failed", onFinish),
      context.data.on("session.execution.interrupted", onFinish),
      context.data.on("session.idle", onFinish),
      context.data.on("session.deleted", (e) => {
        if (!isActive() || !isNewEvent(e)) return
        tracker.evict(e.data.sessionID)
        touch()
      }),
    ]

    /**
     * The live renderer's width method — the one measurement the fit and the
     * render must share. A context that carries no renderer falls back to the
     * renderer's documented default, the same measurement `fitRow` uses when
     * no method is passed.
     */
    const rendererWidthMethod = (): WidthMethod => context.renderer?.widthMethod ?? "unicode"

    interface PromptFooterProps {
      readonly sessionID: string | undefined
    }

    interface ComposerTopProps {
      readonly sessionID: string
    }

    function spinnerBaseColor(sessionID?: string): RGBA {
      const fallback: RGBA = context.theme.border.base
      const session = sessionID ? context.data.session.get(sessionID) : undefined
      const location = session?.location ?? context.location ?? context.data.location.default()
      const agents = context.data.location.agent.list(location)

      if (!agents || agents.length === 0) return fallback
      const visible = agents.filter((agent) => !agent.hidden)

      const agent =
        agents.find((candidate) => candidate.id === session?.agent) ??
        agents.find((candidate) => candidate.mode !== "subagent" && !candidate.hidden) ??
        visible[0]

      if (!agent) return fallback

      const step = context.themeMode === "light" ? 800 : 200

      if (agent.color) {
        if (/^#[0-9a-f]{6}$/iu.test(agent.color)) return RGBA.fromHex(agent.color)

        if (agent.color === "accent" || agent.color === "interactive" || agent.color === "neutral") {
          const declared = context.theme.hue?.[agent.color]?.[step]

          if (declared) return declared
        }
      }

      const palette: RGBA[] = []

      for (const scale of context.theme.categorical ?? []) {
        const color: RGBA | undefined = scale?.[step]

        if (color && !palette.some((existing) => existing.equals(color))) palette.push(color)
      }

      if (palette.length === 0) return fallback
      const index = visible.findIndex((candidate) => candidate.id === agent.id)

      return index === -1 ? (palette[0] ?? fallback) : (palette[index % palette.length] ?? fallback)
    }

    /**
     * The tracker's current label for a session, or undefined when no rate
     * exists — never a placeholder. Reading `version()` here is what makes
     * the label live while a run streams and frozen at the last run's average
     * afterwards, wherever the TPS widget is placed.
     */
    function currentTps(sessionID: string | undefined): TpsStatus | undefined {
      version()

      if (!isActive() || sessionID === undefined) return undefined
      const value = tracker.value(sessionID, Date.now())

      if (value === null || value.tps === null) return undefined

      return { label: formatTpsLabel(value) }
    }

    /**
     * One consistent snapshot of everything the status rows can display,
     * derived from host data. Raw values stay separate from display strings,
     * and availability stays separate from numeric zero: a known `$0.00` cost
     * is displayable even before any usage exists, while a home screen
     * without a session has no metrics to invent and unknown context is
     * absent rather than a fabricated zero.
     */
    function deriveSnapshot(sessionID: string | undefined): StatusSnapshot {
      const session = sessionID === undefined ? undefined : context.data.session.get(sessionID)
      const ref = sessionID === undefined ? (context.location ?? context.data.location.default()) : session?.location

      let location: LocationStatus | undefined

      if (ref !== undefined) {
        const project = session ? context.data.project.get(session.projectID) : undefined

        const worktree = session !== undefined && isWorktreeDirectory(session.location.directory, project)

        location = {
          directory: ref.directory,
          home: homedir(),
          branch: context.data.location.vcs.info(ref)?.branch.current,
          worktree,
        }
      }

      let metrics: UsageStatus | undefined

      if (sessionID !== undefined && session !== undefined) {
        const tokens = session.tokens
        const cacheRead = tokens.cache.read
        const input = tokens.input + cacheRead + tokens.cache.write
        const models = context.data.location.model.list(session.location)

        metrics = {
          input,
          output: tokens.output + tokens.reasoning,
          cacheShare: cacheShare(input, cacheRead),
          cost: context.data.session.cost(sessionID),
          context: contextUsage(context.data.session.message.list(sessionID), models, session.revert?.messageID),
        }
      }

      const background =
        sessionID === undefined
          ? { agents: 0 }
          : backgroundUsage(
              sessionID,
              context.data.session.family(sessionID),
              context.data.session.get,
              context.data.session.status,
            )

      return {
        sessionID,
        running: sessionID !== undefined && context.data.session.status(sessionID) === "running",
        location,
        metrics,
        tps: currentTps(sessionID),
        background,
      }
    }

    interface StatusRowViewProps {
      readonly left: readonly WidgetID[]
      readonly right: readonly WidgetID[]
      readonly sessionID: string | undefined
    }

    /**
     * One status row: the widgets available from one snapshot, fitted into
     * the row's measured width and rendered by the shared row component.
     * Both slots render through this — which zone lists they pass is the
     * layout's decision, and nothing here is placement-specific.
     */
    function StatusRowView(props: StatusRowViewProps) {
      const source = useRowWidth()
      const measure = createMemo(() => createCellMeasurer(rendererWidthMethod()))
      const snapshot = createMemo(() => deriveSnapshot(props.sessionID))
      const widgets = createMemo(() => formatWidgets(snapshot(), statusOptions().appearance, measure()))

      const plan = createMemo(() => {
        const options = statusOptions()

        return fitRow({
          width: source.width(),
          separator: options.appearance.separator,
          colonJoin: options.appearance.branch === "colon",
          hideFirst: options.overflow.hideFirst,
          widthMethod: rendererWidthMethod(),
          left: zoneWidgets(props.left, widgets()),
          right: zoneWidgets(props.right, widgets()),
        })
      })

      const spinner = createMemo(() => ({
        visual: statusOptions().appearance.spinner,
        base: spinnerBaseColor(props.sessionID),
      }))

      return (
        <StatusRow
          row={plan()}
          theme={{ subdued: context.theme.text.muted }}
          spinner={spinner()}
          onSizeChange={source.onSizeChange}
        />
      )
    }

    function PromptFooter(props: PromptFooterProps) {
      return (
        <Show when={isActive()} fallback={null}>
          <StatusRowView
            left={statusOptions().layout.bottomLeft}
            right={statusOptions().layout.bottomRight}
            sessionID={props.sessionID}
          />
        </Show>
      )
    }

    function ComposerTop(props: ComposerTopProps) {
      return (
        <Show when={isActive()} fallback={null}>
          <StatusRowView
            left={statusOptions().layout.topLeft}
            right={statusOptions().layout.topRight}
            sessionID={props.sessionID}
          />
        </Show>
      )
    }

    function SettingsCommand() {
      // A mounted app contribution gives the layer a Solid owner, so the host
      // disposes it on unload. The generation guard also disables stale layers.
      context.keymap.layer(() => ({
        mode: "global",
        enabled: isActive,
        commands: [{
          id: "opencode2.enhanced-composer.customize",
          title: "Customize footer",
          description: "Footer and composer-top widgets, appearance, and overflow",
          group: "Footer",
          palette: true,
          slash: { name: "customize-footer" },
          bind: false,
          enabled: isActive,
          run: () => {
            if (!isActive()) return
            openStatusSettings(context, (saved) => {
              if (isActive()) applyStatusOptions(saved)
            })
          },
        }],
      }))

      return null
    }

    const commandDispose = context.ui.slot({
      append: "app",
      render: () => <SettingsCommand />,
    })

    const footerDispose = context.ui.slot({
      replace: "prompt.footer",
      render: (input) => <PromptFooter sessionID={input.sessionID} />,
    })

    const composerDispose = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <ComposerTop sessionID={input.sessionID} />,
    })

    return () => {
      for (const unsub of unsubs) unsub()
      footerDispose()
      composerDispose()
      commandDispose()
      stopTimer()

      if (gen.active === mine)
        setGen((draft) => {
          draft.active = 0
        })
    }
  },
}

export default definition
