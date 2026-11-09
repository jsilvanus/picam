import type { FastifyBaseLogger } from "fastify";
import type { CameraEventBroker } from "./events.js";
import {
  type CameraAdapter,
  type CameraPreset,
  type CameraPresetCoordinates,
  type CameraSnapshot,
  type FocusMode,
  type FreedState,
  type FreedTarget,
  SimulatedCameraAdapter,
  UdpViscaCameraAdapter
} from "./camera-adapter.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";
import type { ImageSettings, ImageSettingsPatch, StreamSettings, StreamSettingsPatch } from "./camera-settings.js";
import { PresetStore } from "./preset-store.js";
import { PipoePowerCycler, PowerCycleError } from "./power-cycler.js";
import { HealthTracker, type CameraHealth } from "./camera-health.js";
import { CameraContextTracker, type CameraContext } from "./camera-context.js";
import {
  CameraSettlingTracker,
  type FreedTelemetry,
  type SettlingEvent,
  type SettlingTrackerOptions
} from "./settling-tracker.js";

export interface CameraServiceOptions {
  mode: "simulation" | "production";
  eventBroker?: CameraEventBroker | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** Near focus limit (metres) restored when privacy blur goes off. */
  nearLimitM?: number | undefined;
  /** Cameras whose privacy blur is sticky: re-applied after every preset recall. */
  blurCameras?: string[] | undefined;
  /** Delay (ms) before re-applying the blur after a recall. Default 4000. */
  blurReapplyMs?: number | undefined;
  /** When set, FreeD is switched on towards this target while a stream runs and off when it stops. */
  freedTarget?: { addr: string; port: number } | undefined;
  /** MediaMTX control API base; when set, running camera paths are picked up at startup. */
  mediaMtxApiUrl?: string | undefined;
  cam1Name?: string | undefined;
  cam1Host?: string | undefined;
  cam1ViscaPort?: number | undefined;
  cam1CgiPort?: number | undefined;
  cam1CgiUser?: string | undefined;
  cam1CgiPassword?: string | undefined;
  cam2Name?: string | undefined;
  cam2Host?: string | undefined;
  cam2ViscaPort?: number | undefined;
  cam2CgiPort?: number | undefined;
  cam2CgiUser?: string | undefined;
  cam2CgiPassword?: string | undefined;
  mediaMtxRtspBaseUrl?: string | undefined;
  mediaMtxRtmpBaseUrl?: string | undefined;
  pigatewayUrl?: string | undefined;
  presetsFilePath?: string | undefined;
  thumbnailsDir?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Cameras whose RTMP push picam restarts when the camera is healthy but not pushing (PICAM_KEEP_STREAMS). */
  keepStreams?: string[] | undefined;
  /** Hard power-cycle through pipoe; unset = not available. */
  powerCycler?: PipoePowerCycler | undefined;
  presetStore?: PresetStore | undefined;
  settlingTrackerOptions?: SettlingTrackerOptions | undefined;
}

function basicAuth(user?: string, password?: string): { user: string; password: string } | undefined {
  return user && password ? { user, password } : undefined;
}

export class CameraService {
  private readonly cameras = new Map<string, CameraAdapter>();
  private readonly eventBroker?: CameraEventBroker | undefined;
  private readonly logger?: FastifyBaseLogger | undefined;
  private readonly presetStore: PresetStore;
  private readonly settlingTracker: CameraSettlingTracker;
  private readonly context = new CameraContextTracker(Number.parseInt(process.env["PICAM_CONTEXT_STALE_MS"] ?? "3000", 10) || 3000);
  private readonly health = new Map<string, HealthTracker>();
  private healthTimer: NodeJS.Timeout | undefined;
  private readonly contextSig = new Map<string, string>();
  private readonly pigatewayUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly powerCycler?: PipoePowerCycler | undefined;
  private readonly cycling = new Set<string>();
  private readonly keepStreams: Set<string>;
  private healthRounds = 0;
  /** Cameras that should be blurred; set when blur is turned on, cleared by an explicit off or autofocus. */
  private readonly stickyBlur = new Set<string>();
  private readonly blurCameras: Set<string>;
  private readonly blurReapplyMs: number;
  private readonly blurTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: CameraServiceOptions) {
    this.eventBroker = options.eventBroker;
    this.blurCameras = new Set(options.blurCameras ?? []);
    this.blurReapplyMs = options.blurReapplyMs ?? 4000;
    this.freedTarget = options.freedTarget;
    this.mediaMtxApiUrl = options.mediaMtxApiUrl?.replace(/\/+$/, "");
    this.logger = options.logger;
    this.pigatewayUrl = (options.pigatewayUrl ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.powerCycler = options.powerCycler;
    this.keepStreams = new Set(options.keepStreams ?? []);
    this.presetStore =
      options.presetStore ??
      new PresetStore({
        filePath: options.presetsFilePath,
        thumbnailsDir: options.thumbnailsDir
      });
    this.settlingTracker = new CameraSettlingTracker(options.settlingTrackerOptions);

    const cam1Label = options.cam1Name?.trim() || "Camera 1";
    const cam2Label = options.cam2Name?.trim() || "Camera 2";

    if (options.mode === "production" && options.cam1Host) {
      this.cameras.set(
        "cam1",
        new UdpViscaCameraAdapter({
          id: "cam1",
          label: cam1Label,
          host: options.cam1Host,
          viscaPort: options.cam1ViscaPort,
          cgiPort: options.cam1CgiPort,
          powerCgiOn: process.env["PICAM_CAM1_POWER_CGI_ON"] || undefined,
          powerCgiOff: process.env["PICAM_CAM1_POWER_CGI_OFF"] || undefined,
          auth: basicAuth(options.cam1CgiUser, options.cam1CgiPassword),
          rtspUrl: options.mediaMtxRtspBaseUrl ? `${options.mediaMtxRtspBaseUrl}/cam1` : undefined,
          rtmpServer: options.mediaMtxRtmpBaseUrl,
          rtmpKey: "cam1",
          nearLimitM: options.nearLimitM,
          monitorIntervalMs: Number.parseInt(process.env["PICAM_CAMERA_MONITOR_MS"] ?? "30000", 10) || 0,
          logger: options.logger
        })
      );
    } else {
      this.cameras.set("cam1", new SimulatedCameraAdapter("cam1", cam1Label));
    }

    if (options.mode === "production" && options.cam2Host) {
      this.cameras.set(
        "cam2",
        new UdpViscaCameraAdapter({
          id: "cam2",
          label: cam2Label,
          host: options.cam2Host,
          viscaPort: options.cam2ViscaPort,
          cgiPort: options.cam2CgiPort,
          powerCgiOn: process.env["PICAM_CAM2_POWER_CGI_ON"] || undefined,
          powerCgiOff: process.env["PICAM_CAM2_POWER_CGI_OFF"] || undefined,
          auth: basicAuth(options.cam2CgiUser, options.cam2CgiPassword),
          rtspUrl: options.mediaMtxRtspBaseUrl ? `${options.mediaMtxRtspBaseUrl}/cam2` : undefined,
          rtmpServer: options.mediaMtxRtmpBaseUrl,
          rtmpKey: "cam2",
          nearLimitM: options.nearLimitM,
          monitorIntervalMs: Number.parseInt(process.env["PICAM_CAMERA_MONITOR_MS"] ?? "30000", 10) || 0,
          logger: options.logger
        })
      );
    } else {
      this.cameras.set("cam2", new SimulatedCameraAdapter("cam2", cam2Label));
    }
  }

  async init(): Promise<void> {
    const defaultPresets: Record<string, CameraPreset[]> = {};
    for (const [id, cam] of this.cameras.entries()) {
      defaultPresets[id] = cam.getSnapshot().presets;
    }
    await this.presetStore.init(defaultPresets);

    for (const [id, cam] of this.cameras.entries()) {
      const presets = this.presetStore.getPresets(id);
      if (presets.length > 0) {
        cam.initPresets?.(presets);
      }
    }
  }

  list(): CameraSnapshot[] {
    return [...this.cameras.values()].map((cam) => cam.getSnapshot());
  }

  /** Asks the camera for its current state (connection and position) before a read. */
  async refresh(id?: string): Promise<void> {
    const cams = id ? [this.cameras.get(id)] : [...this.cameras.values()];
    await Promise.all(cams.map((cam) => cam?.refresh?.()));
  }

  get(id: string): CameraSnapshot | undefined {
    return this.cameras.get(id)?.getSnapshot();
  }

  async move(
    id: string,
    direction: PanTiltDirection,
    panSpeed?: number,
    tiltSpeed?: number
  ): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.move(direction, panSpeed, tiltSpeed);
    this.context.driving(id, direction !== "stop");
    this.emitContext(id);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `move:${direction}`,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  async zoom(id: string, action: ZoomAction, speed?: number): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.zoom(action, speed);
    this.context.driving(id, action !== "stop");
    this.emitContext(id);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `zoom:${action}`,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  async recallPreset(id: string, presetId: number): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    this.settlingTracker.setTargetPreset(id, presetId);
    await cam.recallPreset(presetId);
    this.context.recall(id, presetId);
    this.emitContext(id);
    const snapshot = cam.getSnapshot();
    const preset = this.presetStore.getPreset(id, presetId);
    this.scheduleBlurReapply(id);

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:recall",
        presetId,
        targetPresetId: presetId,
        name: preset?.name,
        coordinates: preset?.coordinates,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  async savePreset(
    id: string,
    presetId: number,
    name?: string,
    coordinates?: CameraPresetCoordinates,
    thumbnail?: string
  ): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    let resolvedCoordinates = coordinates;
    if (!resolvedCoordinates) {
      try {
        const res = await this.fetchFn(`${this.pigatewayUrl}/api/v1/cameras/${id}/freed`);
        if (res.ok) {
          const body = (await res.json()) as any;
          if (body?.telemetry) {
            resolvedCoordinates = {
              pan: body.telemetry.pan,
              tilt: body.telemetry.tilt,
              roll: body.telemetry.roll,
              zoom: body.telemetry.zoom,
              focus: body.telemetry.focus
            };
          }
        }
      } catch (err) {
        this.logger?.debug({ err, id }, "Could not fetch FreeD telemetry from pigateway");
      }
    }

    if (!resolvedCoordinates) {
      const pos = cam.getSnapshot().position;
      resolvedCoordinates = {
        pan: pos.pan,
        tilt: pos.tilt,
        zoom: pos.zoom
      };
    }

    await cam.savePreset(presetId, name, resolvedCoordinates);
    if (thumbnail) {
      await cam.savePresetThumbnail(presetId, thumbnail);
    }

    const saved = await this.presetStore.savePreset(
      id,
      presetId,
      name,
      resolvedCoordinates,
      thumbnail
    );

    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:save",
        presetId,
        name: saved.name,
        thumbnail: saved.thumbnail,
        coordinates: saved.coordinates,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  async savePresetThumbnail(id: string, presetId: number, thumbnail: string): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    const saved = await this.presetStore.saveThumbnail(id, presetId, thumbnail);
    await cam.savePresetThumbnail(presetId, saved.thumbnail ?? thumbnail);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:thumbnail",
        presetId,
        name: saved.name,
        thumbnail: saved.thumbnail,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  async resetPreset(id: string, presetId: number): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.resetPreset(presetId);
    await this.presetStore.deletePreset(id, presetId);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:reset",
        presetId,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  /** Starts the liveness probes of all cameras (read-only). intervalMs 0 = off. */
  startHealthMonitor(intervalMs: number): void {
    if (intervalMs <= 0 || this.healthTimer) return;
    for (const id of this.cameras.keys()) this.health.set(id, new HealthTracker(id));
    const round = async (): Promise<void> => {
      await Promise.all(
        [...this.cameras].map(async ([id, cam]) => {
          const tracker = this.health.get(id)!;
          let changed: CameraHealth | null;
          try {
            changed = tracker.record(await cam.probe());
          } catch (err) {
            this.logger?.warn({ err, camera: id }, "Health probe round failed");
            return;
          }
          if (changed) {
            this.logger?.warn({ camera: id, state: changed.state, failing: changed.failing }, "Camera health changed");
            this.eventBroker?.emit({ type: "health", data: changed });
          }
          // After a power-cycle, reboot or power cut the camera comes back without its RTMP push.
          // Check right after it turns ok, then every 4th round.
          if (tracker.get().state === "ok" && (changed?.state === "ok" || this.healthRounds % 4 === 0)) {
            await this.keepStream(id);
          }
        })
      );
      this.healthRounds++;
    };
    this.healthTimer = setInterval(() => void round(), intervalMs);
    this.healthTimer.unref();
    void round();
  }

  /**
   * Hard power-cycle over PoE (pipoe). Manual only: nothing calls this automatically.
   * Refused (reason "healthy") while the health monitor says the camera is ok, unless force is set,
   * because cutting power also cuts the camera's SDI picture to the switcher.
   */
  async powerCycle(
    id: string,
    options: { offMs?: number; force?: boolean } = {}
  ): Promise<{ cameraId: string; port: string; health: string; result: unknown }> {
    if (!this.cameras.has(id)) throw new Error(`Camera '${id}' not found`);
    if (!this.powerCycler) throw new PowerCycleError("Power-cycle is not configured (set PICAM_PIPOE_URL)", 503);
    const health = this.health.get(id)?.get().state ?? "unknown";
    if (health === "ok" && !options.force) {
      throw new PowerCycleError(
        `Camera ${id} looks healthy; a power-cycle cuts its picture. Add force to do it anyway`,
        409
      );
    }
    if (this.cycling.has(id)) throw new PowerCycleError(`A power-cycle of ${id} is already running`, 409);
    this.cycling.add(id);
    const port = this.powerCycler.portFor(id);
    this.logger?.warn({ camera: id, port, health, force: Boolean(options.force) }, "Power-cycling camera over PoE");
    this.eventBroker?.emit({ type: "camera", data: { id, action: "power:cycle-start" } });
    try {
      const result = await this.powerCycler.cycle(id, options.offMs);
      this.eventBroker?.emit({ type: "camera", data: { id, action: "power:cycle-done" } });
      return { cameraId: id, port, health, result };
    } catch (err) {
      this.eventBroker?.emit({ type: "camera", data: { id, action: "power:cycle-failed" } });
      throw err;
    } finally {
      this.cycling.delete(id);
    }
  }

  /**
   * Restarts the RTMP push of a PICAM_KEEP_STREAMS camera when the camera says it is stopped.
   * Read-first: does nothing when it streams or the state is unknown. Returns true when it started the push.
   */
  async keepStream(id: string): Promise<boolean> {
    const cam = this.cameras.get(id);
    if (!cam || !this.keepStreams.has(id) || this.cycling.has(id)) return false;
    try {
      if ((await cam.getRtmpState()) !== "stopped") return false;
      this.logger?.warn({ camera: id }, "RTMP push is stopped; restarting it (PICAM_KEEP_STREAMS)");
      await this.startStream(id);
      return true;
    } catch (err) {
      this.logger?.warn({ err, camera: id }, "Could not restart the RTMP push");
      return false;
    }
  }

  getHealth(id: string): CameraHealth | null {
    if (!this.cameras.has(id)) return null;
    return this.health.get(id)?.get() ?? null;
  }

  /**
   * Ends a pending recall that the settling tracker will never report: the camera was already at the preset
   * (no motion at all), the preset has no stored coordinates, or it stopped somewhere else.
   * Still for RECALL_STILL_MS after the recall (or after the last motion) = landed.
   */
  private resolveRecall(
    cameraId: string,
    telemetry: FreedTelemetry,
    presets: CameraPreset[],
    event: SettlingEvent | null
  ): void {
    const pending = this.context.pendingRecall(cameraId);
    if (!pending) return;
    const preset = presets.find((p) => p.id === pending.presetId);
    const atPreset = preset?.coordinates ? this.settlingTracker.matchesCoordinates(telemetry, preset.coordinates) : false;
    if (event?.action === "motion:settled" || event?.action === "motion:stopped") {
      this.context.landed(cameraId, atPreset ? pending.presetId : null);
      return;
    }
    if (this.settlingTracker.isCameraMoving(cameraId)) return;
    const stillMs = Number.parseInt(process.env["PICAM_RECALL_STILL_MS"] ?? "1500", 10) || 1500;
    if (pending.movedSinceRecall) return; // it moved: wait for the tracker's settle (or the timeout)
    if (atPreset && pending.sinceMs >= stillMs) this.context.landed(cameraId, pending.presetId);
    else if (!atPreset && pending.sinceMs >= stillMs * 2) this.context.landed(cameraId, null);
  }

  /** Motion state of a camera for consumers (preset, settled/moving, position, stale). */
  getContext(id: string): CameraContext | null {
    const snap = this.cameras.get(id)?.getSnapshot();
    if (!snap) return null;
    this.context.focus(id, snap.privacyBlur, snap.focusMode);
    return this.context.get(id);
  }

  private emitContext(id: string): void {
    const snap = this.cameras.get(id)?.getSnapshot();
    if (snap) this.context.focus(id, snap.privacyBlur, snap.focusMode);
    const sig = this.context.signature(id);
    if (this.contextSig.get(id) === sig) return;
    this.contextSig.set(id, sig);
    this.eventBroker?.emit({ type: "context", data: this.context.get(id) });
  }

  processFreedTelemetry(telemetry: FreedTelemetry): SettlingEvent | null {
    const cameraId =
      telemetry.camId === 101 || telemetry.camId === 1
        ? "cam1"
        : telemetry.camId === 102 || telemetry.camId === 2
          ? "cam2"
          : `cam${telemetry.camId}`;

    const presets = this.presetStore.getPresets(cameraId);
    const event = this.settlingTracker.ingestTelemetry(cameraId, telemetry, presets);
    this.context.telemetry(
      cameraId,
      { pan: telemetry.pan, tilt: telemetry.tilt, zoom: telemetry.zoom },
      this.settlingTracker.isCameraMoving(cameraId)
    );
    if (event?.action === "preset:settled" && event.presetId !== undefined) this.context.settledOn(cameraId, event.presetId);
    else this.resolveRecall(cameraId, telemetry, presets, event);
    this.emitContext(cameraId);
    if (event) {
      this.eventBroker?.emit({
        type: "camera",
        data: {
          id: cameraId,
          action: event.action,
          presetId: event.presetId,
          name: event.name,
          position: event.position,
          coordinates: event.coordinates
        }
      });
    }
    return event;
  }

  async getThumbnailFile(
    cameraId: string,
    presetId: number
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    return this.presetStore.getThumbnailFile(cameraId, presetId);
  }

  getPresetStore(): PresetStore {
    return this.presetStore;
  }

  getSettlingTracker(): CameraSettlingTracker {
    return this.settlingTracker;
  }

  async setSmartFrame(id: string, mode: SmartFrameMode): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.setSmartFrame(mode);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `smartframe:${mode}`,
        smartFrame: snapshot.smartFrame
      }
    });

    return snapshot;
  }

  async setPower(id: string, on: boolean): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.setPower(on);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `power:${on ? "on" : "standby"}`
      }
    });

    return snapshot;
  }

  /** VISCA power state: on, standby, or unreachable. */
  async getPower(id: string): Promise<"on" | "standby" | "unreachable"> {
    const cam = this.cameras.get(id);
    if (!cam) throw new Error(`Camera '${id}' not found`);
    return cam.getPowerState();
  }

  async getFreed(id: string): Promise<FreedState> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }
    return cam.getFreed();
  }

  async setFreed(id: string, enabled: boolean, target?: FreedTarget): Promise<FreedState> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    const freed = await cam.setFreed(enabled, target);

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `freed:${enabled ? "on" : "off"}`
      }
    });

    return freed;
  }

  /**
   * A preset recall brings the camera's stored focus back. For a camera in PICAM_BLUR_CAMERAS whose
   * blur is on, the blur is applied again once the move is done, so it holds on every preset.
   */
  private scheduleBlurReapply(id: string): void {
    if (!this.blurCameras.has(id) || !this.stickyBlur.has(id)) return;
    clearTimeout(this.blurTimers.get(id));
    const timer = setTimeout(() => {
      this.blurTimers.delete(id);
      if (!this.stickyBlur.has(id)) return;
      this.setPrivacyBlur(id, true).catch((err) => {
        this.logger?.warn({ camera: id, err }, "Could not re-apply privacy blur after preset recall");
      });
    }, this.blurReapplyMs);
    timer.unref?.();
    this.blurTimers.set(id, timer);
  }

  async setPrivacyBlur(id: string, enabled: boolean): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.setPrivacyBlur(enabled);
    if (enabled) this.stickyBlur.add(id);
    else this.stickyBlur.delete(id);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `privacyblur:${enabled ? "on" : "off"}`,
        privacyBlur: snapshot.privacyBlur
      }
    });

    this.emitContext(id);
    return snapshot;
  }

  async setFocusMode(id: string, mode: FocusMode): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.setFocusMode(mode);
    if (mode === "auto") this.stickyBlur.delete(id);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `focus:${mode}`,
        focusMode: snapshot.focusMode,
        privacyBlur: snapshot.privacyBlur
      }
    });

    this.emitContext(id);
    return snapshot;
  }

  async startStream(id: string, options: { restart?: boolean } = {}): Promise<{ snapshot: CameraSnapshot; streamUrl: string | null; action: string; targetMatches: boolean | null }> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    const { streamUrl, action, targetMatches } = await cam.startStream(options);
    await this.autoFreed(id, true);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "stream:start",
        streaming: true
      }
    });

    return { snapshot, streamUrl, action, targetMatches };
  }

  async getStreamSettings(id: string): Promise<StreamSettings> {
    return this.requireCamera(id).getStreamSettings();
  }

  async setStreamSettings(id: string, patch: StreamSettingsPatch): Promise<StreamSettings> {
    const settings = await this.requireCamera(id).setStreamSettings(patch);
    this.eventBroker?.emit({ type: "camera", data: { id, action: "settings:stream" } });
    return settings;
  }

  async getImageSettings(id: string): Promise<ImageSettings> {
    return this.requireCamera(id).getImageSettings();
  }

  async setImageSettings(id: string, patch: ImageSettingsPatch): Promise<ImageSettings> {
    const settings = await this.requireCamera(id).setImageSettings(patch);
    this.eventBroker?.emit({ type: "camera", data: { id, action: "settings:image" } });
    return settings;
  }

  private requireCamera(id: string): CameraAdapter {
    const cam = this.cameras.get(id);
    if (!cam) throw new Error(`Camera '${id}' not found`);
    return cam;
  }

  async stopStream(id: string): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.stopStream();
    await this.autoFreed(id, false);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "stream:stop",
        streaming: false
      }
    });

    return snapshot;
  }

  /** FreeD only runs while a stream does, so an idle camera sends no tracking data. Failures are logged, never fatal. */
  private readonly mediaMtxApiUrl: string | undefined;
  private readonly freedTarget: { addr: string; port: number } | undefined;
  private readonly freedAuto = new Set<string>();

  private async autoFreed(id: string, enabled: boolean): Promise<void> {
    const target = this.freedTarget;
    if (!target) return;
    if (!enabled && !this.freedAuto.has(id)) return;
    try {
      const camId = 100 + (Number.parseInt(id.replace(/\D/g, ""), 10) || 0);
      await this.setFreed(id, enabled, enabled ? { camId, addr: target.addr, port: target.port } : undefined);
      if (enabled) this.freedAuto.add(id);
      else this.freedAuto.delete(id);
    } catch (err) {
      this.logger?.warn({ err, camera: id }, "Automatic FreeD switch failed");
    }
  }

  /**
   * After a restart a camera may still be pushing its stream. Ask MediaMTX which paths are live,
   * mark those cameras as streaming and switch FreeD on for them, as a stream start would.
   */
  async syncStreams(): Promise<void> {
    if (!this.mediaMtxApiUrl) return;
    try {
      const res = await this.fetchFn(`${this.mediaMtxApiUrl}/v3/paths/list`);
      if (!res.ok) return;
      const body = (await res.json()) as { items?: Array<{ name?: string; ready?: boolean }> };
      for (const item of body.items ?? []) {
        const cam = item.name ? this.cameras.get(item.name) : undefined;
        if (!cam || !item.ready || !cam.markStreaming) continue;
        cam.markStreaming(true);
        await this.autoFreed(item.name!, true);
      }
    } catch (err) {
      this.logger?.warn({ err }, "Could not read stream state from MediaMTX");
    }
  }

  async close(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const t of this.blurTimers.values()) clearTimeout(t);
    this.blurTimers.clear();
    for (const id of [...this.freedAuto]) {
      await this.autoFreed(id, false);
    }
    for (const cam of this.cameras.values()) {
      await cam.close();
    }
  }
}
