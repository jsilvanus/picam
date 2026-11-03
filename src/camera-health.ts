export type HealthState = "ok" | "degraded" | "frozen";

export interface ProbeResult {
  visca: boolean;
  http: boolean;
  rtsp: boolean;
}

export interface CameraHealth {
  cameraId: string;
  state: HealthState;
  /** Latest probe round; null before the first one. */
  probes: ProbeResult | null;
  /** Failing probe names right now. */
  failing: Array<keyof ProbeResult>;
  since: string;
  checkedAt: string | null;
  /** Recent state changes, newest last (at most 50). */
  transitions: Array<{ at: string; from: HealthState; to: HealthState; failing: Array<keyof ProbeResult> }>;
}

export interface HealthOptions {
  /** Consecutive failed rounds of one probe before the camera counts as degraded (default 3). */
  degradedAfterRounds?: number;
  /** How long two or more probes must fail continuously before "frozen" (default 30000 ms). */
  frozenAfterMs?: number;
  /** Consecutive all-good rounds needed to return to ok (default 3). */
  recoverRounds?: number;
  now?: () => number;
}

const NAMES: Array<keyof ProbeResult> = ["visca", "http", "rtsp"];

/**
 * Liveness model per camera: ok -> degraded (one probe failing for 3 rounds) -> frozen (two or more probes
 * failing for 30 s), back to ok after 3 good rounds. Pure: feed it probe results, read the state.
 */
export class HealthTracker {
  private readonly opts: Required<HealthOptions>;
  private state: HealthState = "ok";
  private since: number;
  private probes: ProbeResult | null = null;
  private checkedAt: number | null = null;
  private readonly failRounds: Record<keyof ProbeResult, number> = { visca: 0, http: 0, rtsp: 0 };
  private multiFailSince: number | null = null;
  private goodRounds = 0;
  private readonly transitions: CameraHealth["transitions"] = [];

  constructor(
    private readonly cameraId: string,
    options: HealthOptions = {}
  ) {
    this.opts = {
      degradedAfterRounds: options.degradedAfterRounds ?? 3,
      frozenAfterMs: options.frozenAfterMs ?? 30_000,
      recoverRounds: options.recoverRounds ?? 3,
      now: options.now ?? Date.now
    };
    this.since = this.opts.now();
  }

  /** Records one probe round. Returns the new health when the state changed, else null. */
  record(result: ProbeResult): CameraHealth | null {
    const now = this.opts.now();
    this.probes = result;
    this.checkedAt = now;
    for (const n of NAMES) this.failRounds[n] = result[n] ? 0 : this.failRounds[n] + 1;
    const failing = NAMES.filter((n) => !result[n]);

    if (failing.length >= 2) this.multiFailSince ??= now;
    else this.multiFailSince = null;
    this.goodRounds = failing.length === 0 ? this.goodRounds + 1 : 0;

    let next: HealthState = this.state;
    if (this.multiFailSince !== null && now - this.multiFailSince >= this.opts.frozenAfterMs) next = "frozen";
    else if (this.state !== "frozen" && NAMES.some((n) => this.failRounds[n] >= this.opts.degradedAfterRounds)) next = "degraded";
    else if (this.state === "frozen" && failing.length < 2 && this.goodRounds < this.opts.recoverRounds) next = "degraded";
    if (this.goodRounds >= this.opts.recoverRounds) next = "ok";

    if (next === this.state) return null;
    this.transitions.push({ at: new Date(now).toISOString(), from: this.state, to: next, failing });
    if (this.transitions.length > 50) this.transitions.shift();
    this.state = next;
    this.since = now;
    return this.get();
  }

  get(): CameraHealth {
    return {
      cameraId: this.cameraId,
      state: this.state,
      probes: this.probes,
      failing: this.probes ? NAMES.filter((n) => !this.probes![n]) : [],
      since: new Date(this.since).toISOString(),
      checkedAt: this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
      transitions: [...this.transitions]
    };
  }
}
