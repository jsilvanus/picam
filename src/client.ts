import type {
  CameraSnapshot,
  FreedState,
  FreedTarget,
  FocusMode
} from "./camera-adapter.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";

export interface PiCamClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class PiCamClient {
  private readonly baseUrl: string;
  private readonly customFetch: typeof globalThis.fetch;

  constructor(options: PiCamClientOptions | string) {
    if (typeof options === "string") {
      this.baseUrl = options.replace(/\/+$/, "");
      this.customFetch = globalThis.fetch;
    } else {
      this.baseUrl = options.baseUrl.replace(/\/+$/, "");
      this.customFetch = options.fetch ?? globalThis.fetch;
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {};
    if (options.body !== undefined && options.body !== null) {
      headers["content-type"] = "application/json";
    }
    const res = await this.customFetch(url, {
      ...options,
      headers: {
        ...headers,
        ...options.headers
      }
    });

    if (!res.ok) {
      let errBody: any;
      try {
        errBody = await res.json();
      } catch {
        errBody = { message: await res.text() };
      }
      const message = errBody?.error?.message ?? errBody?.message ?? `Request failed with status ${res.status}`;
      const err = new Error(message);
      (err as any).status = res.status;
      (err as any).code = errBody?.error?.code;
      throw err;
    }

    return (await res.json()) as T;
  }

  async health(): Promise<{ status: string; service: string }> {
    return this.request("/health");
  }

  async listCameras(): Promise<{ items: CameraSnapshot[] }> {
    return this.request("/api/v1/cameras");
  }

  async getCamera(cameraId: string): Promise<CameraSnapshot> {
    return this.request(`/api/v1/cameras/${cameraId}`);
  }

  async moveCamera(
    cameraId: string,
    direction: PanTiltDirection,
    panSpeed?: number,
    tiltSpeed?: number
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/move`, {
      method: "POST",
      body: JSON.stringify({ direction, panSpeed, tiltSpeed })
    });
  }

  async zoomCamera(
    cameraId: string,
    action: ZoomAction,
    speed?: number
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/zoom`, {
      method: "POST",
      body: JSON.stringify({ action, speed })
    });
  }

  async recallPreset(
    cameraId: string,
    presetId: number
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/presets/${presetId}/recall`, {
      method: "POST"
    });
  }

  async savePreset(
    cameraId: string,
    presetId: number,
    name?: string
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/presets/${presetId}/save`, {
      method: "POST",
      body: JSON.stringify({ name })
    });
  }

  async resetPreset(
    cameraId: string,
    presetId: number
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/presets/${presetId}/reset`, {
      method: "POST"
    });
  }

  async savePresetThumbnail(
    cameraId: string,
    presetId: number,
    thumbnail: string
  ): Promise<{ cameraId: string; presetId: number; success: boolean; action: string; camera: CameraSnapshot }> {
    return this.request(`/api/v1/cameras/${cameraId}/presets/${presetId}/thumbnail`, {
      method: "POST",
      body: JSON.stringify({ thumbnail })
    });
  }

  async setSmartFrame(
    cameraId: string,
    mode: SmartFrameMode
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/smartframe`, {
      method: "POST",
      body: JSON.stringify({ mode })
    });
  }

  async setPower(
    cameraId: string,
    on: boolean
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/power`, {
      method: "POST",
      body: JSON.stringify({ on })
    });
  }

  async getFreed(cameraId: string): Promise<{ cameraId: string; freed: FreedState }> {
    return this.request(`/api/v1/cameras/${cameraId}/freed`);
  }

  async setFreed(
    cameraId: string,
    enabled: boolean,
    target?: FreedTarget
  ): Promise<{ cameraId: string; success: boolean; action: string; freed: FreedState }> {
    return this.request(`/api/v1/cameras/${cameraId}/freed`, {
      method: "POST",
      body: JSON.stringify({ enabled, target })
    });
  }

  async setPrivacyBlur(
    cameraId: string,
    enabled: boolean
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/privacy-blur`, {
      method: "POST",
      body: JSON.stringify({ enabled })
    });
  }

  async setFocusMode(
    cameraId: string,
    mode: FocusMode
  ): Promise<{ cameraId: string; success: boolean; action: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/focus`, {
      method: "POST",
      body: JSON.stringify({ mode })
    });
  }

  async startStream(
    cameraId: string
  ): Promise<{ cameraId: string; streaming: boolean; streamUrl: string | null; message: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/stream/start`, {
      method: "POST"
    });
  }

  async stopStream(
    cameraId: string
  ): Promise<{ cameraId: string; streaming: boolean; streamUrl: null; message: string }> {
    return this.request(`/api/v1/cameras/${cameraId}/stream/stop`, {
      method: "POST"
    });
  }
}
