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
import { PresetStore } from "./preset-store.js";
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
  private readonly pigatewayUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: CameraServiceOptions) {
    this.eventBroker = options.eventBroker;
    this.logger = options.logger;
    this.pigatewayUrl = (options.pigatewayUrl ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
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
          auth: basicAuth(options.cam1CgiUser, options.cam1CgiPassword),
          rtspUrl: options.mediaMtxRtspBaseUrl ? `${options.mediaMtxRtspBaseUrl}/cam1` : undefined,
          rtmpServer: options.mediaMtxRtmpBaseUrl,
          rtmpKey: "cam1",
          nearLimitM: options.nearLimitM,
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
          auth: basicAuth(options.cam2CgiUser, options.cam2CgiPassword),
          rtspUrl: options.mediaMtxRtspBaseUrl ? `${options.mediaMtxRtspBaseUrl}/cam2` : undefined,
          rtmpServer: options.mediaMtxRtmpBaseUrl,
          rtmpKey: "cam2",
          nearLimitM: options.nearLimitM,
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
    const snapshot = cam.getSnapshot();
    const preset = this.presetStore.getPreset(id, presetId);

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

  processFreedTelemetry(telemetry: FreedTelemetry): SettlingEvent | null {
    const cameraId =
      telemetry.camId === 101 || telemetry.camId === 1
        ? "cam1"
        : telemetry.camId === 102 || telemetry.camId === 2
          ? "cam2"
          : `cam${telemetry.camId}`;

    const presets = this.presetStore.getPresets(cameraId);
    const event = this.settlingTracker.ingestTelemetry(cameraId, telemetry, presets);
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

  async setPrivacyBlur(id: string, enabled: boolean): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.setPrivacyBlur(enabled);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: `privacyblur:${enabled ? "on" : "off"}`,
        privacyBlur: snapshot.privacyBlur
      }
    });

    return snapshot;
  }

  async setFocusMode(id: string, mode: FocusMode): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.setFocusMode(mode);
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

    return snapshot;
  }

  async startStream(id: string): Promise<{ snapshot: CameraSnapshot; streamUrl: string | null }> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    const streamUrl = await cam.startStream();
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "stream:start",
        streaming: true
      }
    });

    return { snapshot, streamUrl };
  }

  async stopStream(id: string): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.stopStream();
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

  async close(): Promise<void> {
    for (const cam of this.cameras.values()) {
      await cam.close();
    }
  }
}
