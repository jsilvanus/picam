import type { FastifyBaseLogger } from "fastify";
import type { CameraEventBroker } from "./events.js";
import {
  type CameraAdapter,
  type CameraSnapshot,
  type FocusMode,
  type FreedState,
  type FreedTarget,
  SimulatedCameraAdapter,
  UdpViscaCameraAdapter
} from "./camera-adapter.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";

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
}

function basicAuth(user?: string, password?: string): { user: string; password: string } | undefined {
  return user && password ? { user, password } : undefined;
}

export class CameraService {
  private readonly cameras = new Map<string, CameraAdapter>();
  private readonly eventBroker?: CameraEventBroker | undefined;
  private readonly logger?: FastifyBaseLogger | undefined;

  constructor(options: CameraServiceOptions) {
    this.eventBroker = options.eventBroker;
    this.logger = options.logger;

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

    await cam.recallPreset(presetId);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:recall",
        presetId,
        position: snapshot.position
      }
    });

    return snapshot;
  }

  async savePreset(id: string, presetId: number, name?: string): Promise<CameraSnapshot> {
    const cam = this.cameras.get(id);
    if (!cam) {
      throw new Error(`Camera '${id}' not found`);
    }

    await cam.savePreset(presetId, name);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:save",
        presetId,
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

    await cam.savePresetThumbnail(presetId, thumbnail);
    const snapshot = cam.getSnapshot();

    this.eventBroker?.emit({
      type: "camera",
      data: {
        id,
        action: "preset:thumbnail",
        presetId,
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
