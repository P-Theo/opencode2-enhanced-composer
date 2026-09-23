// opencode2-enhanced-composer — the token-throughput tracker
//
// The fused opencode2-tps engine (the standalone plugin lives in the
// ../opencode2-tps repository). It measures the rate of the *observable* model
// stream: bytes to a rolling estimate while output arrives, exact step usage
// once the host reports it, and a frozen average after the run ends.
//
// The running label means recent observable-stream throughput, held while the
// model is not streaming: the live estimate freezes at the stream-end boundary
// across tool execution and between steps, and only new observable bytes
// resume it. The completed run still freezes to the weighted run average.
//
// `footer.tsx` wires it into the composer row: the stream events feed the
// tracker and a timer at `refreshHz` bumps the version signal the rate label
// reads. The timer runs only while a live rate can still change with time;
// the row shows the rate alone, never the generated token count.

export function formatTps(value: number): string {
  if (value < 10) return value.toFixed(2)

  if (value < 100) return value.toFixed(1)

  return Math.round(value).toString()
}

export function formatTpsLabel(value: TpsValue): string {
  return value.tps === null ? "— t/s" : `~${formatTps(value.tps)} t/s`
}

// Ported from opencode2-tps. It measures the rate of the *observable* model
// stream: bytes to a rolling estimate while output arrives, exact step usage
// once the host reports it, and a frozen average after the run ends.

export interface TpsConfig {
  readonly bytesPerToken: number // live and partial-output estimate only
}

export const DEFAULT_CONFIG: TpsConfig = {
  bytesPerToken: 4.75,
}
// The frozen final average stays visible until the next prompt starts a new run.

export const BYTES_PER_TOKEN_MIN = 1

export const BYTES_PER_TOKEN_MAX = 16

const LIVE_WINDOW_MS = 5_000

const LIVE_STALE_MS = 1_500

const LIVE_MIN_DURATION_MS = 250

function estimateTokens(bytes: number, bytesPerToken: number): number {
  return Math.ceil(bytes / bytesPerToken)
}

interface Frozen {
  readonly tps: number | null
  readonly tokens: number
  readonly tokensEstimated: boolean
  readonly partial: boolean
}

interface LiveSample {
  readonly bytes: number
  readonly timestamp: number
}

interface OutputBlock {
  streamedBytes: number
  finalBytes: number | null
}

interface StepState {
  readonly assistantMessageID: string
  readonly startedAt: number
  streamedAt: number | null
  lastBoundaryAt: number | null
  observableBytes: number
  readonly blocks: Map<string, OutputBlock>
  readonly samples: LiveSample[]
}

interface RunState {
  phase: "running" | "ended"
  settledTokens: number
  settledDurationMs: number
  tokensEstimated: boolean
  partial: boolean
  activeStep: StepState | null
  readonly settledSteps: Set<string>
  frozen: Frozen | null
  heldLiveTps: number | null
}

export interface TpsValue {
  readonly tps: number | null
  readonly tokens: number
  readonly frozen: boolean
  readonly tokensEstimated: boolean
  readonly tpsEstimated: true
  readonly partial: boolean
}

// A finished run keeps its frozen average indefinitely (it is what the composer
// still shows), so the map is bounded instead: past this many tracked sessions,
// the least recently started *finished* runs are dropped. Running ones are never
// touched. Entries are tiny, so this is hygiene for a long-lived TUI, not a
// memory fix.
export const MAX_TRACKED_RUNS = 64

export class TpsTracker {
  // Insertion order is kept equal to run-start recency (see beginRun), which is
  // what makes eviction from the front drop the stalest session.
  private readonly runs = new Map<string, RunState>()
  private readonly config: TpsConfig

  constructor(config: TpsConfig = DEFAULT_CONFIG) {
    this.config = config
  }

  private state(sessionID: string): RunState {
    let st = this.runs.get(sessionID)

    if (!st) {
      st = {
        phase: "ended",
        settledTokens: 0,
        settledDurationMs: 0,
        tokensEstimated: false,
        partial: false,
        activeStep: null,
        settledSteps: new Set(),
        frozen: null,
        heldLiveTps: null,
      }
      this.runs.set(sessionID, st)
    }

    return st
  }

  beginRun(sessionID: string): void {
    const st = this.state(sessionID)
    st.phase = "running"
    st.settledTokens = 0
    st.settledDurationMs = 0
    st.tokensEstimated = false
    st.partial = false
    st.activeStep = null
    st.settledSteps.clear()
    st.frozen = null
    st.heldLiveTps = null
    // Re-insert so this session becomes the newest in iteration order. Every
    // entry is created through here, so the cap is checked on the one path that
    // can grow the map.
    this.runs.delete(sessionID)
    this.runs.set(sessionID, st)
    this.evictStale()
  }

  private evictStale(): void {
    if (this.runs.size <= MAX_TRACKED_RUNS) return

    for (const [sessionID, st] of this.runs) {
      if (this.runs.size <= MAX_TRACKED_RUNS) return

      if (st.phase === "running") continue
      this.dropSession(sessionID)
    }
  }

  private ensureStep(sessionID: string, assistantMessageID: string, now: number, replace = false): StepState | null {
    const st = this.state(sessionID)

    if (st.settledSteps.has(assistantMessageID) || (st.phase === "ended" && st.frozen !== null)) return null

    if (st.phase !== "running") this.beginRun(sessionID)
    const running = this.state(sessionID)

    if (running.activeStep?.assistantMessageID === assistantMessageID) return running.activeStep

    if (running.activeStep && !replace) return null

    if (running.activeStep) this.settleActiveStep(running, undefined)

    const step: StepState = {
      assistantMessageID,
      startedAt: now,
      streamedAt: null,
      lastBoundaryAt: null,
      observableBytes: 0,
      blocks: new Map(),
      samples: [],
    }

    running.activeStep = step
    running.frozen = null

    return step
  }

  beginStep(sessionID: string, assistantMessageID: string, now = Date.now()): void {
    const st = this.state(sessionID)

    if (st.phase !== "running") {
      if (st.settledSteps.has(assistantMessageID)) return
      this.beginRun(sessionID)
    }

    if (st.activeStep?.assistantMessageID === assistantMessageID) return
    this.ensureStep(sessionID, assistantMessageID, now, true)
  }

  beginBlock(sessionID: string, assistantMessageID: string, blockID: string, now: number): void {
    const step = this.ensureStep(sessionID, assistantMessageID, now)

    if (!step) return

    if (!step.blocks.has(blockID)) step.blocks.set(blockID, { streamedBytes: 0, finalBytes: null })
  }

  push(
    sessionID: string,
    delta: string,
    now: number,
    assistantMessageID = "implicit",
    blockID = "implicit",
  ): void {
    if (!delta) return
    const step = this.ensureStep(sessionID, assistantMessageID, now)

    if (!step) return
    let block = step.blocks.get(blockID)

    if (!block) {
      block = { streamedBytes: 0, finalBytes: null }
      step.blocks.set(blockID, block)
    }

    if (block.finalBytes !== null) return
    const bytes = Buffer.byteLength(delta, "utf8")
    block.streamedBytes += bytes
    step.observableBytes += bytes

    // A resumed attempt reuses the active message ID: new observable bytes
    // after an earlier stream-end boundary reopen live calculation instead of
    // staying frozen behind it.
    if (step.streamedAt !== null && now > step.streamedAt) step.streamedAt = null

    step.samples.push({ bytes, timestamp: now })
    const oldest = now - LIVE_WINDOW_MS

    while (step.samples[0] && step.samples[0].timestamp < oldest) step.samples.shift()
  }

  finishBlock(
    sessionID: string,
    assistantMessageID: string,
    blockID: string,
    text: string,
    now: number,
  ): void {
    const st = this.runs.get(sessionID)
    const step = st?.activeStep

    if (!step || step.assistantMessageID !== assistantMessageID) return
    let block = step.blocks.get(blockID)

    if (!block) {
      block = { streamedBytes: 0, finalBytes: null }
      step.blocks.set(blockID, block)
    }

    if (block.finalBytes !== null) return
    block.finalBytes = Buffer.byteLength(text, "utf8")
    step.observableBytes += block.finalBytes - block.streamedBytes
    step.lastBoundaryAt = Math.max(step.lastBoundaryAt ?? now, now)
  }

  /**
   * The host's authoritative end of the model stream, published after the
   * provider stream exits and before local tools join. Assigned rather than
   * maxed so a retried attempt reusing the message ID moves the boundary to its
   * own completion. Captures the live estimate at this boundary for the held
   * running display; a buffered-only step leaves any prior held rate alone.
   */
  markStreamed(sessionID: string, assistantMessageID: string, now: number): void {
    const st = this.runs.get(sessionID)
    const step = st?.activeStep

    if (!step || step.assistantMessageID !== assistantMessageID) return
    step.streamedAt = now
    const live = this.liveTps(step, now)

    if (live !== null && st) st.heldLiveTps = live
  }

  private settleActiveStep(st: RunState, generatedTokens: number | undefined): void {
    const step = st.activeStep

    if (!step) return

    // Preserve the running display before samples are discarded. Capture at
    // the boundary, never at delayed settlement time, and skip when it
    // predates the newest sample: those newer bytes would be divided by a
    // duration clamped to the live minimum, inflating the held rate.
    const boundary = step.streamedAt ?? step.lastBoundaryAt
    const lastSample = step.samples.at(-1)

    if (boundary !== null && lastSample !== undefined && boundary >= lastSample.timestamp) {
      const live = this.liveTps(step, boundary)

      if (live !== null) st.heldLiveTps = live
    }

    const exact = generatedTokens !== undefined && Number.isFinite(generatedTokens) && generatedTokens >= 0
    st.settledTokens += exact ? generatedTokens : estimateTokens(step.observableBytes, this.config.bytesPerToken)

    if (!exact) {
      st.tokensEstimated = true
      st.partial = true
    }

    // `session.step.streamed` is the exact stream end; the last content boundary
    // remains the fallback for hosts that do not publish it.
    const end = step.streamedAt ?? step.lastBoundaryAt

    if (end !== null) st.settledDurationMs += Math.max(0, end - step.startedAt)
    st.settledSteps.add(step.assistantMessageID)
    st.activeStep = null
  }

  finishStep(sessionID: string, assistantMessageID: string, generatedTokens: number | undefined, _now: number): void {
    const st = this.runs.get(sessionID)

    if (st?.activeStep?.assistantMessageID !== assistantMessageID) return
    this.settleActiveStep(st, generatedTokens)
  }

  finish(sessionID: string, _now: number): void {
    const st = this.runs.get(sessionID)

    if (!st || st.phase === "ended") return

    if (st.activeStep) this.settleActiveStep(st, undefined)
    st.phase = "ended"
    const tokens = st.settledTokens

    if (tokens <= 0) {
      this.evictStale()

      return
    }

    const tps = st.settledDurationMs > 0 ? tokens / (st.settledDurationMs / 1000) : null
    st.frozen = { tps, tokens, tokensEstimated: st.tokensEstimated, partial: st.partial }
    this.evictStale()
  }

  private dropSession(sessionID: string): void {
    this.runs.delete(sessionID)
  }

  evict(sessionID: string): void {
    this.dropSession(sessionID)
  }

  hasRunning(now = Date.now()): boolean {
    for (const st of this.runs.values()) {
      if (st.phase !== "running") continue
      const step = st.activeStep

      if (!step || step.streamedAt !== null) continue
      const last = step.samples.at(-1)

      if (last && now < last.timestamp + LIVE_STALE_MS) return true
    }

    return false
  }

  private liveTps(step: StepState, now: number): number | null {
    const last = step.samples.at(-1)

    if (!last) return null

    // Once the stream end is known the clock stops there: no further
    // time-driven decay while tools run. The stale-tail clamp still applies
    // up to that boundary.
    const streamCap = step.streamedAt ?? Number.POSITIVE_INFINITY
    const effectiveNow = Math.min(now, last.timestamp + LIVE_STALE_MS, streamCap)
    const oldest = effectiveNow - LIVE_WINDOW_MS
    const samples = step.samples.filter((sample) => sample.timestamp >= oldest)
    const first = samples[0]

    if (!first) return null
    const bytes = samples.reduce((total, sample) => total + sample.bytes, 0)
    const durationMs = Math.max(effectiveNow - first.timestamp, LIVE_MIN_DURATION_MS)

    return estimateTokens(bytes, this.config.bytesPerToken) / (durationMs / 1000)
  }

  value(sessionID: string, now: number): TpsValue | null {
    const st = this.runs.get(sessionID)

    if (!st) return null

    if (st.frozen)
      return {
        ...st.frozen,
        frozen: true,
        tpsEstimated: true,
      }

    if (st.phase !== "running") return null
    const active = st.activeStep
    const activeTokens = active ? estimateTokens(active.observableBytes, this.config.bytesPerToken) : 0
    const tokens = st.settledTokens + activeTokens

    if (tokens <= 0) return null
    const settledTps = st.settledDurationMs > 0 ? st.settledTokens / (st.settledDurationMs / 1000) : null

    // A settled average never displaces the held live value; the frozen final
    // average is computed separately in `finish()`.
    const tps = active ? (this.liveTps(active, now) ?? st.heldLiveTps ?? settledTps) : (st.heldLiveTps ?? settledTps)

    return {
      tps,
      tokens,
      frozen: false,
      tokensEstimated: st.tokensEstimated || active !== null,
      tpsEstimated: true,
      partial: st.partial,
    }
  }
}

// The rate keys from `cli.json`, validated beside the engine that uses them.
// The standalone's `display` option is deliberately absent: this plugin never
// shows the generated token count.

export interface TpsOptions extends TpsConfig {
  readonly refreshHz: number
}

/** A value as it can arrive from `cli.json`: arbitrary JSON, nothing more. */
export type TpsOptionValue =
  | string
  | number
  | boolean
  | null
  | readonly TpsOptionValue[]
  | { readonly [key: string]: TpsOptionValue }

/** Raw `cli.json` values, before validation. */
export interface TpsOptionsInput {
  readonly refreshHz?: TpsOptionValue
  readonly bytesPerToken?: TpsOptionValue
}

export const DEFAULT_TPS_OPTIONS: TpsOptions = {
  ...DEFAULT_CONFIG,
  refreshHz: 8,
}

export const REFRESH_HZ_MIN = 1

export const REFRESH_HZ_MAX = 60

function isFiniteNumber(value: TpsOptionValue | undefined): value is number {
  return Number.isFinite(value)
}

function clampOption(value: TpsOptionValue | undefined, fallback: number, min: number, max: number): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(Math.max(value, min), max)
}

export function resolveTpsOptions(raw: TpsOptionsInput): TpsOptions {
  return {
    bytesPerToken: clampOption(raw.bytesPerToken, DEFAULT_TPS_OPTIONS.bytesPerToken, BYTES_PER_TOKEN_MIN, BYTES_PER_TOKEN_MAX),
    refreshHz: clampOption(raw.refreshHz, DEFAULT_TPS_OPTIONS.refreshHz, REFRESH_HZ_MIN, REFRESH_HZ_MAX),
  }
}
