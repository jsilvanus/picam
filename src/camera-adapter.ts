import dgram from "node:dgram";
import type { FastifyBaseLogger } from "fastify";
import {
  buildFocusMode,
  buildFocusNear,
  buildFocusNearLimit,
  buildFocusStop,
  buildPanTiltDrive,
  nearLimitPositionForMetres,
  buildPanTiltInquiry,
  buildPower,
  buildPowerInquiry,
  buildPresetRecall,
  buildPresetReset,
  buildPresetSave,
  buildSmartFrame,
  buildZoom,
  buildZoomInquiry,
  createViscaPacket,
  parseViscaResponse,
  type PanTiltDirection,
  type SmartFrameMode,
  type ZoomAction
} from "./visca-protocol.js";

export interface CameraPreset {
  id: number;
  name?: string;
  thumbnail?: string;
}

export interface CameraPosition {
  pan: number;
  tilt: number;
  zoom: number;
}

export type CameraConnectionState = "connected" | "disconnected" | "simulated";
export type FocusMode = "auto" | "manual";
export type SmartFrameState = "enabled" | "disabled" | "triggered" | "unsupported";

export interface CameraSnapshot {
  id: string;
  label: string;
  model: string;
  connection: CameraConnectionState;
  streaming: boolean;
  streamUrl: string | null;
  smartFrame: SmartFrameState;
  /** True while the privacy blur is on: manual focus driven to the nearest point. */
  privacyBlur: boolean;
  /** Focus mode as last set from here ("auto" until changed). */
  focusMode: FocusMode;
  position: CameraPosition;
  presets: CameraPreset[];
}

/** The camera's own FreeD output (AVer web UI, /storks CGI). */
export interface FreedState {
  enabled: boolean;
  camId: number | null;
  addr: string | null;
  port: number | null;
}

export interface FreedTarget {
  camId: number;
  addr: string;
  port: number;
}

export interface CameraAdapter {
  readonly id: string;
  readonly label: string;
  getSnapshot(): CameraSnapshot;
  move(direction: PanTiltDirection, panSpeed?: number, tiltSpeed?: number): Promise<void>;
  zoom(action: ZoomAction, speed?: number): Promise<void>;
  recallPreset(presetId: number): Promise<void>;
  savePreset(presetId: number, name?: string): Promise<void>;
  savePresetThumbnail(presetId: number, thumbnail: string): Promise<void>;
  resetPreset(presetId: number): Promise<void>;
  setSmartFrame(mode: SmartFrameMode): Promise<void>;
  /** VISCA CAM_Power: true wakes the camera, false puts it in standby. */
  setPower(on: boolean): Promise<void>;
  /** Reads the camera's FreeD output settings. */
  getFreed(): Promise<FreedState>;
  /** Sets the FreeD target (when given) and turns FreeD output on or off. Returns the state read back. */
  setFreed(enabled: boolean, target?: FreedTarget): Promise<FreedState>;
  /** On: AF to MF, near limit to the closest distance, focus driven near. Off: back to AF. */
  setPrivacyBlur(enabled: boolean): Promise<void>;
  /** Plain VISCA CAM_Focus auto (AF) or manual (MF). */
  setFocusMode(mode: FocusMode): Promise<void>;
  startStream(): Promise<string | null>;
  stopStream(): Promise<void>;
  close(): Promise<void>;
}

export class SimulatedCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly label: string;
  readonly model = "AVer PTZ330 (Simulated)";
  private streaming = false;
  private smartFrame: SmartFrameState = "disabled";
  private privacyBlur = false;
  private focusMode: FocusMode = "auto";
  private position: CameraPosition = { pan: 0, tilt: 0, zoom: 0 };
  private readonly presets = new Map<number, { position: CameraPosition; name?: string; thumbnail?: string }>([
    [1, { position: { pan: 100, tilt: 50, zoom: 10 }, name: "Pulpit" }],
    [2, { position: { pan: -200, tilt: 30, zoom: 15 }, name: "Altar" }],
    [3, { position: { pan: 0, tilt: 10, zoom: 5 }, name: "Organ" }],
    [4, { position: { pan: 300, tilt: -10, zoom: 20 }, name: "Choir" }],
    [5, { position: { pan: -150, tilt: 0, zoom: 8 }, name: "Lectern" }],
    [6, { position: { pan: 0, tilt: 0, zoom: 0 }, name: "Wide Hall" }]
  ]);

  private freed: FreedState = { enabled: false, camId: null, addr: null, port: null };

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  getSnapshot(): CameraSnapshot {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      connection: "simulated",
      streaming: this.streaming,
      streamUrl: this.streaming ? `rtsp://127.0.0.1:8554/${this.id}` : null,
      smartFrame: this.smartFrame,
      privacyBlur: this.privacyBlur,
      focusMode: this.focusMode,
      position: { ...this.position },
      presets: [...this.presets.entries()]
        .map(([id, p]) => ({
          id,
          ...(p.name ? { name: p.name } : {}),
          ...(p.thumbnail ? { thumbnail: p.thumbnail } : {})
        }))
        .sort((a, b) => a.id - b.id)
    };
  }

  async move(direction: PanTiltDirection, panSpeed = 10, tiltSpeed = 10): Promise<void> {
    switch (direction) {
      case "up":
        this.position.tilt = Math.min(this.position.tilt + tiltSpeed * 5, 900);
        break;
      case "down":
        this.position.tilt = Math.max(this.position.tilt - tiltSpeed * 5, -300);
        break;
      case "left":
        this.position.pan = Math.max(this.position.pan - panSpeed * 5, -1700);
        break;
      case "right":
        this.position.pan = Math.min(this.position.pan + panSpeed * 5, 1700);
        break;
      case "upleft":
        this.position.tilt = Math.min(this.position.tilt + tiltSpeed * 5, 900);
        this.position.pan = Math.max(this.position.pan - panSpeed * 5, -1700);
        break;
      case "upright":
        this.position.tilt = Math.min(this.position.tilt + tiltSpeed * 5, 900);
        this.position.pan = Math.min(this.position.pan + panSpeed * 5, 1700);
        break;
      case "downleft":
        this.position.tilt = Math.max(this.position.tilt - tiltSpeed * 5, -300);
        this.position.pan = Math.max(this.position.pan - panSpeed * 5, -1700);
        break;
      case "downright":
        this.position.tilt = Math.max(this.position.tilt - tiltSpeed * 5, -300);
        this.position.pan = Math.min(this.position.pan + panSpeed * 5, 1700);
        break;
      case "home":
      case "reset":
        this.position.pan = 0;
        this.position.tilt = 0;
        break;
      case "stop":
        break;
    }
  }

  async zoom(action: ZoomAction, speed = 4): Promise<void> {
    if (action === "in") {
      this.position.zoom = Math.min(this.position.zoom + (speed + 1) * 10, 16384);
    } else if (action === "out") {
      this.position.zoom = Math.max(this.position.zoom - (speed + 1) * 10, 0);
    }
  }

  async recallPreset(presetId: number): Promise<void> {
    const preset = this.presets.get(presetId);
    if (preset) {
      this.position = { ...preset.position };
    }
  }

  async savePreset(presetId: number, name?: string): Promise<void> {
    const existing = this.presets.get(presetId);
    const resolvedName = name ?? existing?.name;
    this.presets.set(presetId, {
      position: { ...this.position },
      ...(resolvedName ? { name: resolvedName } : {}),
      ...(existing?.thumbnail ? { thumbnail: existing.thumbnail } : {})
    });
  }

  async savePresetThumbnail(presetId: number, thumbnail: string): Promise<void> {
    const existing = this.presets.get(presetId);
    this.presets.set(presetId, {
      position: existing ? { ...existing.position } : { ...this.position },
      ...(existing?.name ? { name: existing.name } : {}),
      thumbnail
    });
  }

  async resetPreset(presetId: number): Promise<void> {
    this.presets.delete(presetId);
  }

  async setSmartFrame(mode: SmartFrameMode): Promise<void> {
    if (mode === "enable") {
      this.smartFrame = "enabled";
    } else if (mode === "disable") {
      this.smartFrame = "disabled";
    } else if (mode === "trigger") {
      this.smartFrame = "triggered";
    }
  }

  async setPower(_on: boolean): Promise<void> {
    // Simulated: nothing to switch.
  }

  async getFreed(): Promise<FreedState> {
    return { ...this.freed };
  }

  async setFreed(enabled: boolean, target?: FreedTarget): Promise<FreedState> {
    this.freed = target
      ? { enabled, camId: target.camId, addr: target.addr, port: target.port }
      : { ...this.freed, enabled };
    return { ...this.freed };
  }

  async setPrivacyBlur(enabled: boolean): Promise<void> {
    this.privacyBlur = enabled;
    this.focusMode = enabled ? "manual" : "auto";
  }

  async setFocusMode(mode: FocusMode): Promise<void> {
    this.focusMode = mode;
    if (mode === "auto") this.privacyBlur = false;
  }

  async startStream(): Promise<string | null> {
    this.streaming = true;
    return `rtsp://127.0.0.1:8554/${this.id}`;
  }

  async stopStream(): Promise<void> {
    this.streaming = false;
  }

  async close(): Promise<void> {
    this.streaming = false;
  }
}

/**
 * A camera CGI call failed. `reason` says why, so the API can answer clearly:
 * "auth" (401/403: wrong or missing login), "rejected" (other HTTP error) or
 * "unreachable" (no answer in time). The message never carries the login.
 */
export class CameraCgiError extends Error {
  constructor(
    message: string,
    readonly reason: "auth" | "rejected" | "unreachable",
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "CameraCgiError";
  }
}

/**
 * Reads the FreeD fields out of a get_net_cfg answer (";"-separated key=value pairs).
 * Returns null when freed_enable is missing or not 0/1/on/off.
 */
export function parseFreedState(body: string): FreedState | null {
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const raw = fields.get("freed_enable")?.toLowerCase();
  if (raw === undefined || !["0", "1", "on", "off"].includes(raw)) return null;
  const num = (key: string): number | null => {
    const v = fields.get(key);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
  };
  return {
    enabled: raw === "1" || raw === "on",
    camId: num("freed_cam_id"),
    addr: fields.get("freed_addr") || null,
    port: num("freed_port_num")
  };
}

export interface CameraLogin {
  user: string;
  password: string;
}

export interface UdpViscaCameraConfig {
  id: string;
  label: string;
  host: string;
  viscaPort?: number | undefined;
  cgiPort?: number | undefined;
  /** HTTP Basic login for the camera CGI. Sent only as an Authorization header. */
  auth?: CameraLogin | undefined;
  rtspUrl?: string | undefined;
  /** RTMP server base the camera pushes to, e.g. rtmp://192.168.1.103:1935. */
  rtmpServer?: string | undefined;
  /** Stream key (the MediaMTX path name), e.g. cam1. */
  rtmpKey?: string | undefined;
  /** UDP source port for power commands, default 52381 (the camera needs it). 0 picks any port. */
  viscaSourcePort?: number | undefined;
  /** How long the near drive runs before the stop, default 2500 ms. */
  focusDriveMs?: number | undefined;
  /** Near focus limit in metres restored when privacy blur goes off, default 1.5. */
  nearLimitM?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
}

export class UdpViscaCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly label: string;
  readonly model = "AVer PTZ330";
  private readonly host: string;
  private readonly viscaPort: number;
  private readonly cgiPort: number;
  private readonly authHeader: string | null;
  private readonly rtspUrl: string | null;
  private readonly rtmpServer: string | null;
  private readonly rtmpKey: string | null;
  private readonly viscaSourcePort: number;
  private readonly focusDriveMs: number;
  private readonly nearLimitM: number;
  private readonly logger?: FastifyBaseLogger | undefined;

  private socket: dgram.Socket | null = null;
  private sequenceNumber = 1;
  private connected = false;
  private streaming = false;
  private smartFrame: SmartFrameState = "disabled";
  private privacyBlur = false;
  private focusMode: FocusMode = "auto";
  private position: CameraPosition = { pan: 0, tilt: 0, zoom: 0 };
  private readonly presets = new Map<number, { position: CameraPosition; name?: string; thumbnail?: string }>();

  constructor(config: UdpViscaCameraConfig) {
    this.id = config.id;
    this.label = config.label;
    this.host = config.host;
    this.viscaPort = config.viscaPort ?? 52381;
    this.cgiPort = config.cgiPort ?? 80;
    this.authHeader = config.auth
      ? `Basic ${Buffer.from(`${config.auth.user}:${config.auth.password}`).toString("base64")}`
      : null;
    this.rtspUrl = config.rtspUrl ?? `rtsp://${config.host}:554/live_st1`;
    this.rtmpServer = config.rtmpServer ?? null;
    this.rtmpKey = config.rtmpKey ?? null;
    this.viscaSourcePort = config.viscaSourcePort ?? 52381;
    this.focusDriveMs = config.focusDriveMs ?? 2500;
    this.nearLimitM = config.nearLimitM ?? 1.5;
    this.logger = config.logger;
  }

  getSnapshot(): CameraSnapshot {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      connection: this.connected ? "connected" : "disconnected",
      streaming: this.streaming,
      streamUrl: this.streaming ? this.rtspUrl : null,
      smartFrame: this.smartFrame,
      privacyBlur: this.privacyBlur,
      focusMode: this.focusMode,
      position: { ...this.position },
      presets: [...this.presets.entries()]
        .map(([id, p]) => ({
          id,
          ...(p.name ? { name: p.name } : {}),
          ...(p.thumbnail ? { thumbnail: p.thumbnail } : {})
        }))
        .sort((a, b) => a.id - b.id)
    };
  }

  private async ensureSocket(): Promise<dgram.Socket> {
    if (!this.socket) {
      this.socket = dgram.createSocket("udp4");
      this.socket.on("error", (err) => {
        this.logger?.warn({ err, camera: this.id }, "Camera UDP socket error");
      });
    }
    return this.socket;
  }

  private async sendCommand(payload: number[]): Promise<void> {
    const socket = await this.ensureSocket();
    const seq = this.sequenceNumber++;
    const packet = createViscaPacket(payload, seq);

    return new Promise((resolve, reject) => {
      socket.send(packet, this.viscaPort, this.host, (err) => {
        if (err) {
          this.connected = false;
          this.logger?.warn({ err, camera: this.id }, "Failed to send VISCA UDP packet");
          reject(err);
        } else {
          this.connected = true;
          resolve();
        }
      });
    });
  }

  async move(direction: PanTiltDirection, panSpeed = 10, tiltSpeed = 10): Promise<void> {
    const payload = buildPanTiltDrive(direction, panSpeed, tiltSpeed);
    await this.sendCommand(payload);
  }

  async zoom(action: ZoomAction, speed = 4): Promise<void> {
    const payload = buildZoom(action, speed);
    await this.sendCommand(payload);
  }

  async recallPreset(presetId: number): Promise<void> {
    const payload = buildPresetRecall(presetId);
    await this.sendCommand(payload);
  }

  async savePreset(presetId: number, name?: string): Promise<void> {
    const payload = buildPresetSave(presetId);
    await this.sendCommand(payload);
    const existing = this.presets.get(presetId);
    const resolvedName = name ?? existing?.name;
    this.presets.set(presetId, {
      position: { ...this.position },
      ...(resolvedName ? { name: resolvedName } : {}),
      ...(existing?.thumbnail ? { thumbnail: existing.thumbnail } : {})
    });
  }

  async savePresetThumbnail(presetId: number, thumbnail: string): Promise<void> {
    const existing = this.presets.get(presetId);
    this.presets.set(presetId, {
      position: existing ? { ...existing.position } : { ...this.position },
      ...(existing?.name ? { name: existing.name } : {}),
      thumbnail
    });
  }

  async resetPreset(presetId: number): Promise<void> {
    const payload = buildPresetReset(presetId);
    await this.sendCommand(payload);
    this.presets.delete(presetId);
  }

  async setSmartFrame(mode: SmartFrameMode): Promise<void> {
    const payload = buildSmartFrame(mode);
    await this.sendCommand(payload);
    this.smartFrame = mode === "enable" ? "enabled" : mode === "disable" ? "disabled" : "triggered";
  }

  /**
   * Power commands go out from a short-lived socket bound to the VISCA source port,
   * because the camera answers only that port. The shared socket is left alone.
   */
  async setPower(on: boolean): Promise<void> {
    const packet = createViscaPacket(buildPower(on), this.sequenceNumber++);
    const socket = dgram.createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(this.viscaSourcePort, () => {
          socket.off("error", reject);
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.send(packet, this.viscaPort, this.host, (err) => (err ? reject(err) : resolve()));
      });
    } finally {
      socket.close();
    }
  }

  async setPrivacyBlur(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.sendCommand(buildFocusMode("manual"));
      await this.sendCommand(buildFocusNearLimit());
      await this.sendCommand(buildFocusNear(7));
      // Variable-speed focus keeps moving until the limit; stop it once it has had time to arrive.
      await new Promise((resolve) => setTimeout(resolve, this.focusDriveMs));
      await this.sendCommand(buildFocusStop());
    } else {
      // Put the normal near limit back first, so AF does not hunt at the blur distance.
      await this.sendCommand(buildFocusNearLimit(nearLimitPositionForMetres(this.nearLimitM)));
      await this.sendCommand(buildFocusMode("auto"));
    }
    this.privacyBlur = enabled;
    this.focusMode = enabled ? "manual" : "auto";
  }

  async setFocusMode(mode: FocusMode): Promise<void> {
    await this.sendCommand(buildFocusMode(mode));
    this.focusMode = mode;
    // Back to autofocus ends a blur; manual focus on its own leaves the blur state as it was.
    if (mode === "auto") this.privacyBlur = false;
  }

  async startStream(): Promise<string | null> {
    // One call sets the RTMP server and key and starts the push (AVer web UI API).
    // Failures are not hidden: a rejected login or an unreachable camera throws
    // CameraCgiError, and a "failed" status from the camera throws too.
    if (this.rtmpServer && this.rtmpKey) {
      await this.cgiCommand(`set_rtmp_start(server=${this.rtmpServer};key=${this.rtmpKey})`, "POST");
      const status = await this.rtmpStatus();
      if (status === "failed") {
        this.logger?.warn({ camera: this.id }, "Camera reported the RTMP push as failed");
        throw new CameraCgiError(`Camera ${this.id} reported the RTMP push as failed`, "rejected");
      }
    }
    this.streaming = true;
    return this.rtspUrl;
  }

  async stopStream(): Promise<void> {
    try {
      await this.cgiCommand("set_rtmp_stop", "POST");
    } finally {
      this.streaming = false;
    }
  }

  /**
   * Reads rtmp_status from get_rtmp_status. Returns null when the answer has no
   * recognisable status; that is logged, not treated as a failure.
   */
  private async rtmpStatus(): Promise<string | null> {
    const body = await this.cgiCommand(`get_rtmp_status(${Date.now()})`, "GET");
    const match = /rtmp_status\W+(streaming|stopped|failed)/.exec(body);
    if (!match) {
      this.logger?.warn({ camera: this.id }, "Camera RTMP status answer had no recognised rtmp_status");
      return null;
    }
    return match[1]!;
  }

  /** One CGI call on /storks. The login goes only in the Authorization header. Returns the answer body. */
  private async cgiCommand(cmd: string, method: "GET" | "POST", base = "/storks"): Promise<string> {
    const url = `http://${this.host}:${this.cgiPort}${base}?cmd=${cmd}`;
    const headers: Record<string, string> = this.authHeader ? { Authorization: this.authHeader } : {};
    let res: Response;
    try {
      res = await fetch(url, { method, headers, signal: AbortSignal.timeout(2000) });
    } catch {
      this.logger?.warn({ camera: this.id }, "Camera CGI unreachable");
      throw new CameraCgiError(`Camera ${this.id} did not answer the CGI request`, "unreachable");
    }
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      this.logger?.warn({ camera: this.id, status: res.status }, "Camera CGI rejected the login");
      throw new CameraCgiError(
        `Camera ${this.id} rejected the login (HTTP ${res.status}); check PIGATEWAY_${this.id.toUpperCase()}_USER and _PASSWORD`,
        "auth",
        res.status
      );
    }
    if (!res.ok) {
      throw new CameraCgiError(`Camera ${this.id} answered HTTP ${res.status} to the CGI request`, "rejected", res.status);
    }
    return body;
  }

  /** FreeD output state, read with get_net_cfg. Throws CameraCgiError when the camera cannot answer. */
  async getFreed(): Promise<FreedState> {
    const body = await this.cgiCommand(`get_net_cfg(${Date.now()})`, "GET", "/storks/");
    const state = parseFreedState(body);
    if (!state) {
      this.logger?.warn({ camera: this.id }, "Camera network answer had no recognised freed_enable");
      throw new CameraCgiError(`Camera ${this.id} answered without a FreeD state`, "rejected");
    }
    return state;
  }

  /** Sets the FreeD target (when given), switches FreeD on or off, then reads the state back. */
  async setFreed(enabled: boolean, target?: FreedTarget): Promise<FreedState> {
    if (target) {
      await this.cgiCommand(
        `set_freed_config{freed_cam_id:${target.camId},freed_addr:${target.addr},freed_port_num:${target.port}}`,
        "POST",
        "/storks/"
      );
    }
    await this.cgiCommand(`set_freed_enable:${enabled ? 1 : 0}`, "POST", "/storks/");
    return this.getFreed();
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.streaming = false;
    this.connected = false;
  }
}
