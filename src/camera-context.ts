/**
 * One small, stable view of a camera's motion state for consumers such as piperception:
 * which preset it is on, whether it is settled or moving, and where it points.
 * `stale` means "do not trust": no telemetry (FreeD) has arrived recently, so the state is a guess.
 */
export interface CameraContext {
  cameraId: string;
  /** The preset the camera has settled on, or null when it is elsewhere, moving or unknown. */
  presetId: number | null;
  /** The preset a recall is travelling to, or null. */
  targetPresetId: number | null;
  /** True while a recall is under way or the picture is moving (driven pan/tilt/zoom or FreeD motion). */
  moving: boolean;
  /** True when the camera is standing still (no recall pending, not moving). */
  settled: boolean;
  ptz: { pan: number; tilt: number; zoom: number } | null;
  /** Privacy blur (defocus) is on: the picture, including the analysis stream, is deliberately unsharp. Detectors must treat it as unreliable, not as "nothing seen". */
  privacyBlur: boolean;
  focusMode: "auto" | "manual";
  updatedAt: string;
  /** No telemetry for longer than the stale window: the fields above may be out of date. */
  stale: boolean;
}

interface Entry {
  presetId: number | null;
  targetPresetId: number | null;
  driving: boolean;
  fieldMoving: boolean;
  ptz: { pan: number; tilt: number; zoom: number } | null;
  updatedAt: number;
  telemetryAt: number | null;
  privacyBlur: boolean;
  focusMode: "auto" | "manual";
}

export class CameraContextTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly staleMs = 3000,
    private readonly now: () => number = Date.now
  ) {}

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { presetId: null, targetPresetId: null, driving: false, fieldMoving: false, ptz: null, updatedAt: this.now(), telemetryAt: null, privacyBlur: false, focusMode: "auto" };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Focus state of the lens, from the camera snapshot. */
  focus(id: string, privacyBlur: boolean, focusMode: "auto" | "manual"): void {
    const e = this.entry(id);
    e.privacyBlur = privacyBlur;
    e.focusMode = focusMode;
    e.updatedAt = this.now();
  }

  /** A recall was sent: the camera is on its way. */
  recall(id: string, presetId: number): void {
    const e = this.entry(id);
    e.targetPresetId = presetId;
    e.presetId = null;
    e.updatedAt = this.now();
  }

  /** Pan/tilt/zoom is being driven by hand (true) or was stopped (false). */
  driving(id: string, active: boolean): void {
    const e = this.entry(id);
    e.driving = active;
    if (active) {
      e.presetId = null;
      e.targetPresetId = null;
    }
    e.updatedAt = this.now();
  }

  /** Position and motion from FreeD telemetry. */
  telemetry(id: string, ptz: { pan: number; tilt: number; zoom: number }, moving: boolean): void {
    const e = this.entry(id);
    e.ptz = ptz;
    e.fieldMoving = moving;
    e.telemetryAt = e.updatedAt = this.now();
    if (moving) e.presetId = null;
  }

  /** The settling tracker matched a preset. */
  settledOn(id: string, presetId: number): void {
    const e = this.entry(id);
    e.presetId = presetId;
    e.targetPresetId = null;
    e.fieldMoving = false;
    e.updatedAt = this.now();
  }

  get(id: string): CameraContext {
    const e = this.entry(id);
    const moving = e.driving || e.fieldMoving || e.targetPresetId !== null;
    return {
      cameraId: id,
      presetId: e.presetId,
      targetPresetId: e.targetPresetId,
      moving,
      settled: !moving,
      ptz: e.ptz,
      privacyBlur: e.privacyBlur,
      focusMode: e.focusMode,
      updatedAt: new Date(e.updatedAt).toISOString(),
      stale: e.telemetryAt === null || this.now() - e.telemetryAt > this.staleMs
    };
  }

  /** Short signature used to emit an event only when something a consumer cares about changed. */
  signature(id: string): string {
    const c = this.get(id);
    return `${c.presetId}|${c.targetPresetId}|${c.moving}|${c.stale}|${c.privacyBlur}|${c.focusMode}`;
  }
}
