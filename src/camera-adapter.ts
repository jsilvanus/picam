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

export interface CameraPresetCoordinates {
  pan: number;
  tilt: number;
  roll?: number | undefined;
  zoom: number;
  focus?: number | undefined;
}

export interface CameraPreset {
  id: number;
  name?: string | undefined;
  thumbnail?: string | undefined;
  coordinates?: CameraPresetCoordinates | undefined;
  updatedAt?: string | undefined;
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

/** What startStream did. "already-streaming" means nothing was changed on the camera. */
export interface StartStreamResult {
  streamUrl: string | null;
  action: "started" | "already-streaming" | "restarted";
  /** Whether the target the camera pushes to equals the configured one; null when the camera does not say. */
  targetMatches: boolean | null;
}

export type RtmpState = "streaming" | "stopped" | "failed" | "unknown";

/**
 * Reads the camera's get_rtmp_status answer. The AVer PTZ330 (FW V90) answers numerically
 * (`rtmp_status:2;`, 2 = streaming as seen on the Pi); older/other answers use words. Only the codes
 * seen or obvious are mapped (0 = stopped); any other code is "unknown", never a failure.
 * A server/key in the answer, when present, is returned so the target can be compared.
 */
export function parseRtmpStatus(body: string): { state: RtmpState; code: number | null; server?: string; key?: string } {
  let state: RtmpState = "unknown";
  let code: number | null = null;
  const word = /rtmp_status\W+(streaming|stopped|failed)/i.exec(body);
  if (word) {
    state = word[1]!.toLowerCase() as RtmpState;
  } else {
    const num = /rtmp_status\W+(\d+)/i.exec(body);
    if (num) {
      code = Number.parseInt(num[1]!, 10);
      if (code === 2) state = "streaming";
      else if (code === 0) state = "stopped";
    }
  }
  const server = /(?:server|url)\W{1,3}(rtmps?:\/\/[^;&"'\s,]+)/i.exec(body)?.[1];
  const key = /key\W{1,3}([^;&"'\s,]+)/i.exec(body)?.[1];
  return { state, code, ...(server ? { server } : {}), ...(key ? { key } : {}) };
}

export interface CameraAdapter {
  readonly id: string;
  readonly label: string;
  getSnapshot(): CameraSnapshot;
  move(direction: PanTiltDirection, panSpeed?: number, tiltSpeed?: number): Promise<void>;
  zoom(action: ZoomAction, speed?: number): Promise<void>;
  recallPreset(presetId: number): Promise<void>;
  savePreset(presetId: number, name?: string, coordinates?: CameraPresetCoordinates): Promise<void>;
  savePresetThumbnail(presetId: number, thumbnail: string): Promise<void>;
  initPresets?(presets: CameraPreset[]): void;
  resetPreset(presetId: number): Promise<void>;
  setSmartFrame(mode: SmartFrameMode): Promise<void>;
  /** VISCA CAM_Power: true wakes the camera, false puts it in standby. */
  setPower(on: boolean): Promise<void>;
  /** VISCA power inquiry: on, standby, or unreachable when the camera does not answer. */
  getPowerState(): Promise<"on" | "standby" | "unreachable">;
  /** Reads the camera's FreeD output settings. */
  getFreed(): Promise<FreedState>;
  /** Sets the FreeD target (when given) and turns FreeD output on or off. Returns the state read back. */
  setFreed(enabled: boolean, target?: FreedTarget): Promise<FreedState>;
  /**
   * On: AF to MF, near limit to the closest distance, focus driven near. Off: back to AF.
   *
   * The blur is made in the camera lens, so it is in every output of that camera: the SDI picture
   * the ATEM uses (the broadcast) and the RTMP stream that goes to MediaMTX. They are two separate
   * outputs. The RTMP/MediaMTX stream is only for picture analysis and the like; the ATEM switcher
   * takes the SDI picture. So a mask or blur applied to the MediaMTX stream would NOT reach the
   * broadcast; only the camera's own focus (or something on the SDI/ATEM side) does.
   */
  setPrivacyBlur(enabled: boolean): Promise<void>;
  /** Plain VISCA CAM_Focus auto (AF) or manual (MF). */
  setFocusMode(mode: FocusMode): Promise<void>;
  /** Marks the stream as running when something else (a restart) already started it. */
  markStreaming?(streaming: boolean): void;
  startStream(options?: { restart?: boolean }): Promise<StartStreamResult>;
  stopStream(): Promise<void>;
  /** Re-reads connection and position from the camera (real cameras only). */
  refresh?(): Promise<void>;
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
  private readonly presets = new Map<
    number,
    {
      position: CameraPosition;
      name?: string;
      thumbnail?: string;
      coordinates?: CameraPresetCoordinates;
      updatedAt?: string;
    }
  >([
    [1, { position: { pan: 100, tilt: 50, zoom: 10 }, name: "Pulpit", coordinates: { pan: 100, tilt: 50, zoom: 10 } }],
    [2, { position: { pan: -200, tilt: 30, zoom: 15 }, name: "Altar", coordinates: { pan: -200, tilt: 30, zoom: 15 } }],
    [3, { position: { pan: 0, tilt: 10, zoom: 5 }, name: "Organ", coordinates: { pan: 0, tilt: 10, zoom: 5 } }],
    [4, { position: { pan: 300, tilt: -10, zoom: 20 }, name: "Choir", coordinates: { pan: 300, tilt: -10, zoom: 20 } }],
    [5, { position: { pan: -150, tilt: 0, zoom: 8 }, name: "Lectern", coordinates: { pan: -150, tilt: 0, zoom: 8 } }],
    [6, { position: { pan: 0, tilt: 0, zoom: 0 }, name: "Wide Hall", coordinates: { pan: 0, tilt: 0, zoom: 0 } }]
  ]);

  private freed: FreedState = { enabled: false, camId: null, addr: null, port: null };

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  initPresets(presets: CameraPreset[]): void {
    this.presets.clear();
    for (const p of presets) {
      this.presets.set(p.id, {
        position: p.coordinates
          ? { pan: p.coordinates.pan, tilt: p.coordinates.tilt, zoom: p.coordinates.zoom }
          : { pan: 0, tilt: 0, zoom: 0 },
        ...(p.name ? { name: p.name } : {}),
        ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
        ...(p.coordinates ? { coordinates: p.coordinates } : {}),
        ...(p.updatedAt ? { updatedAt: p.updatedAt } : {})
      });
    }
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
          ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
          ...(p.coordinates ? { coordinates: p.coordinates } : {}),
          ...(p.updatedAt ? { updatedAt: p.updatedAt } : {})
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

  async savePreset(presetId: number, name?: string, coordinates?: CameraPresetCoordinates): Promise<void> {
    const existing = this.presets.get(presetId);
    const resolvedName = name ?? existing?.name;
    const resolvedCoordinates = coordinates ?? existing?.coordinates ?? {
      pan: this.position.pan,
      tilt: this.position.tilt,
      zoom: this.position.zoom
    };
    this.presets.set(presetId, {
      position: { ...this.position },
      ...(resolvedName ? { name: resolvedName } : {}),
      ...(existing?.thumbnail ? { thumbnail: existing.thumbnail } : {}),
      coordinates: resolvedCoordinates,
      updatedAt: new Date().toISOString()
    });
  }

  async savePresetThumbnail(presetId: number, thumbnail: string): Promise<void> {
    const existing = this.presets.get(presetId);
    this.presets.set(presetId, {
      position: existing ? { ...existing.position } : { ...this.position },
      ...(existing?.name ? { name: existing.name } : {}),
      ...(existing?.coordinates ? { coordinates: existing.coordinates } : {}),
      thumbnail,
      updatedAt: new Date().toISOString()
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

  private power: "on" | "standby" = "on";

  async setPower(on: boolean): Promise<void> {
    this.power = on ? "on" : "standby";
  }

  async getPowerState(): Promise<"on" | "standby" | "unreachable"> {
    return this.power;
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

  async startStream(): Promise<StartStreamResult> {
    const was = this.streaming;
    this.streaming = true;
    return { streamUrl: `rtsp://127.0.0.1:8554/${this.id}`, action: was ? "already-streaming" : "started", targetMatches: null };
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

/** The RTMP server the camera pushes to, from a get_net_cfg answer (`rtmp_server=rtmp://host:1935/;`). */
export function parseNetCfgRtmp(body: string): { server: string | null; status: number | null } {
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const server = fields.get("rtmp_server") || null;
  const status = fields.get("rtmp_status");
  return { server, status: status !== undefined && /^\d+$/.test(status) ? Number(status) : null };
}

/** Two RTMP server URLs are the same target when they differ only in case and trailing slashes. */
export function sameRtmpServer(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
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
  /** Optional CGI command (the part after `/storks?cmd=`) tried when VISCA power gets no reply or has no effect. */
  powerCgiOn?: string | undefined;
  powerCgiOff?: string | undefined;
  /** Send a VISCA power inquiry this often (ms) to keep the connection state true to the camera. 0 = off. */
  monitorIntervalMs?: number | undefined;
  /** How long the near drive runs before the stop, default 2500 ms. */
  focusDriveMs?: number | undefined;
  /** Near focus limit in metres restored when privacy blur goes off, default 1.5. */
  nearLimitM?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
}

/**
 * Binds the shared VISCA source port. Another service on the same host (picam and pigateway
 * both use 52381) may hold it for the length of one command, so EADDRINUSE is retried briefly.
 */
async function bindWithRetry(socket: dgram.Socket, port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        socket.once("error", onError);
        socket.bind(port, () => {
          socket.off("error", onError);
          resolve();
        });
      });
      return;
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!busy || port === 0 || attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Decodes Pan-TiltPosInq (90 50 0p0p0p0p 0t0t0t0t FF) and ZoomPosInq (90 50 0z0z0z0z FF) replies. */
export function parseViscaPosition(pt: Uint8Array, zoom: Uint8Array): CameraPosition | null {
  if (pt.length < 11 || pt[0] !== 0x90 || pt[1] !== 0x50 || zoom.length < 7 || zoom[0] !== 0x90 || zoom[1] !== 0x50) {
    return null;
  }
  const word = (b: Uint8Array, o: number) => ((b[o]! & 0xf) << 12) | ((b[o + 1]! & 0xf) << 8) | ((b[o + 2]! & 0xf) << 4) | (b[o + 3]! & 0xf);
  const signed = (v: number) => (v > 0x7fff ? v - 0x10000 : v);
  return { pan: signed(word(pt, 2)), tilt: signed(word(pt, 6)), zoom: word(zoom, 2) };
}

/** How long to wait for the camera's VISCA ACK before reporting an error. */
const VISCA_REPLY_TIMEOUT_MS = Number.parseInt(process.env["PICAM_VISCA_REPLY_TIMEOUT_MS"] ?? "1000", 10) || 1000;

/** Serialises VISCA sends: all cameras share one UDP source port. */
let viscaSendQueue: Promise<unknown> = Promise.resolve();

export class UdpViscaCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly label: string;
  readonly model = "AVer PTZ330";
  private readonly host: string;
  private readonly viscaPort: number;
  private readonly cgiPort: number;
  private readonly powerCgiOn: string | undefined;
  private readonly powerCgiOff: string | undefined;
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
  private monitorTimer: NodeJS.Timeout | null = null;
  private streaming = false;
  private smartFrame: SmartFrameState = "disabled";
  private privacyBlur = false;
  private focusMode: FocusMode = "auto";
  private position: CameraPosition = { pan: 0, tilt: 0, zoom: 0 };
  private readonly presets = new Map<
    number,
    {
      position: CameraPosition;
      name?: string;
      thumbnail?: string;
      coordinates?: CameraPresetCoordinates;
      updatedAt?: string;
    }
  >();

  constructor(config: UdpViscaCameraConfig) {
    this.id = config.id;
    this.label = config.label;
    this.host = config.host;
    this.viscaPort = config.viscaPort ?? 52381;
    this.cgiPort = config.cgiPort ?? 80;
    this.powerCgiOn = config.powerCgiOn;
    this.powerCgiOff = config.powerCgiOff;
    this.authHeader = config.auth
      ? `Basic ${Buffer.from(`${config.auth.user}:${config.auth.password}`).toString("base64")}`
      : null;
    this.rtspUrl = config.rtspUrl ?? `rtsp://${config.host}:554/live_st1`;
    this.rtmpServer = config.rtmpServer ?? null;
    this.rtmpKey = config.rtmpKey ?? null;
    this.viscaSourcePort = config.viscaSourcePort ?? 52381;
    if ((config.monitorIntervalMs ?? 0) > 0) {
      this.monitorTimer = setInterval(() => void this.checkConnection(), config.monitorIntervalMs);
      this.monitorTimer.unref();
      void this.checkConnection();
    }
    this.focusDriveMs = config.focusDriveMs ?? 2500;
    this.nearLimitM = config.nearLimitM ?? 1.5;
    this.logger = config.logger;
  }

  initPresets(presets: CameraPreset[]): void {
    this.presets.clear();
    for (const p of presets) {
      this.presets.set(p.id, {
        position: p.coordinates
          ? { pan: p.coordinates.pan, tilt: p.coordinates.tilt, zoom: p.coordinates.zoom }
          : { pan: 0, tilt: 0, zoom: 0 },
        ...(p.name ? { name: p.name } : {}),
        ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
        ...(p.coordinates ? { coordinates: p.coordinates } : {}),
        ...(p.updatedAt ? { updatedAt: p.updatedAt } : {})
      });
    }
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
          ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
          ...(p.coordinates ? { coordinates: p.coordinates } : {}),
          ...(p.updatedAt ? { updatedAt: p.updatedAt } : {})
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
    const seq = this.sequenceNumber++;
    const packet = createViscaPacket(payload, seq);
    try {
      await this.sendFromViscaPort(packet);
      this.connected = true;
    } catch (err) {
      this.connected = false;
      this.logger?.warn({ err, camera: this.id }, "Failed to send VISCA UDP packet");
      throw err;
    }
  }

  /**
   * The camera answers (and, on the AVer PTZ330, obeys) only datagrams that come from the VISCA
   * source port. Every send therefore goes out from a short-lived socket bound to that port.
   * Sends are serialised process-wide, because all cameras share the one source port.
   */
  private sendFromViscaPort(packet: Buffer): Promise<Buffer> {
    const run = async (): Promise<Buffer> => {
      const socket = dgram.createSocket("udp4");
      try {
        await bindWithRetry(socket, this.viscaSourcePort);
        // Wait for the camera's ACK/completion so that "sent" is not reported as "moved".
        const reply = new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`no VISCA reply from ${this.host}:${this.viscaPort} within ${VISCA_REPLY_TIMEOUT_MS} ms`)),
            VISCA_REPLY_TIMEOUT_MS
          );
          socket.once("message", (msg: Buffer) => {
            clearTimeout(timer);
            resolve(msg);
          });
        });
        reply.catch(() => undefined);
        await new Promise<void>((resolve, reject) => {
          socket.send(packet, this.viscaPort, this.host, (err) => (err ? reject(err) : resolve()));
        });
        return await reply;
      } finally {
        socket.close();
      }
    };
    const next = viscaSendQueue.then(run, run);
    viscaSendQueue = next.catch(() => undefined);
    return next;
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

  async savePreset(presetId: number, name?: string, coordinates?: CameraPresetCoordinates): Promise<void> {
    const payload = buildPresetSave(presetId);
    await this.sendCommand(payload);
    const existing = this.presets.get(presetId);
    const resolvedName = name ?? existing?.name;
    const resolvedCoordinates = coordinates ?? existing?.coordinates ?? {
      pan: this.position.pan,
      tilt: this.position.tilt,
      zoom: this.position.zoom
    };
    this.presets.set(presetId, {
      position: { ...this.position },
      ...(resolvedName ? { name: resolvedName } : {}),
      ...(existing?.thumbnail ? { thumbnail: existing.thumbnail } : {}),
      coordinates: resolvedCoordinates,
      updatedAt: new Date().toISOString()
    });
  }

  async savePresetThumbnail(presetId: number, thumbnail: string): Promise<void> {
    const existing = this.presets.get(presetId);
    this.presets.set(presetId, {
      position: existing ? { ...existing.position } : { ...this.position },
      ...(existing?.name ? { name: existing.name } : {}),
      ...(existing?.coordinates ? { coordinates: existing.coordinates } : {}),
      thumbnail,
      updatedAt: new Date().toISOString()
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

  /** VISCA CAM_Power inquiry (81 09 04 00 FF): 90 50 02 = on, 03 = standby. */
  async getPowerState(): Promise<"on" | "standby" | "unreachable"> {
    const packet = createViscaPacket(buildPowerInquiry(), this.sequenceNumber++, 0x0110);
    let reply: Buffer;
    try {
      reply = await this.sendFromViscaPort(packet);
    } catch {
      return "unreachable";
    }
    for (let i = 0; i + 3 < reply.length; i++) {
      if (reply[i] === 0x90 && reply[i + 1] === 0x50 && reply[i + 3] === 0xff) {
        if (reply[i + 2] === 0x02) return "on";
        if (reply[i + 2] === 0x03) return "standby";
      }
    }
    return "on"; // answered, but not a power state: the camera is up
  }

  /**
   * Power on/standby. The VISCA command goes out from the VISCA source port; if it gets no reply, or
   * the camera does not change state, the optional CGI command is tried. The result is checked with
   * a power inquiry, so "sent" is never reported as "switched". Standby counts as done when the camera
   * stops answering VISCA at all.
   */
  async setPower(on: boolean): Promise<void> {
    let viscaError: unknown;
    try {
      await this.sendFromViscaPort(createViscaPacket(buildPower(on), this.sequenceNumber++));
    } catch (err) {
      viscaError = err;
    }
    const settled = async (waitMs: number): Promise<boolean> => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const state = await this.getPowerState();
        if (on ? state === "on" : state === "standby" || state === "unreachable") return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    // A reply-less command is only a failure if the camera also did not change state.
    if (await settled(viscaError ? 1 : this.powerSettleMs)) {
      if (on) this.connected = true;
      return;
    }
    const cgiCmd = on ? this.powerCgiOn : this.powerCgiOff;
    let cgiError: unknown;
    if (cgiCmd) {
      try {
        await this.cgiCommand(cgiCmd, "GET");
      } catch (err) {
        cgiError = err;
      }
      if (!cgiError && (await settled(this.powerSettleMs))) {
        if (on) this.connected = true;
        return;
      }
    }
    const parts = [`Camera ${this.id} did not ${on ? "wake" : "enter standby"}`];
    if (viscaError) parts.push(`VISCA: ${viscaError instanceof Error ? viscaError.message : String(viscaError)}`);
    if (cgiError) parts.push(`CGI: ${cgiError instanceof Error ? cgiError.message : String(cgiError)}`);
    else if (!cgiCmd) parts.push("no CGI power command configured (PICAM_CAMn_POWER_CGI_ON/OFF)");
    throw new Error(parts.join("; "));
  }

  private readonly cgiTimeoutMs = Number.parseInt(process.env["PICAM_CGI_TIMEOUT_MS"] ?? "4000", 10) || 4000;

  private readonly rtmpVerifyMs = Number.parseInt(process.env["PICAM_RTMP_VERIFY_MS"] ?? "8000", 10) || 8000;

  private readonly powerSettleMs = Number.parseInt(process.env["PICAM_POWER_SETTLE_MS"] ?? "8000", 10) || 8000;

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

  /**
   * Starts the RTMP push (one AVer call sets server and key and starts it). If the camera already
   * streams, nothing is sent: the camera ignores a new target while it pushes, and a stop is a visible
   * interruption. `restart: true` (explicit) stops it, waits and starts it again so a changed target
   * (host or IP change) takes effect. The answer says whether the camera's target equals the
   * configured one when the camera reports it. Failures are not hidden: CameraCgiError for a rejected
   * login, an unreachable camera or a "failed" status.
   */
  async startStream(options: { restart?: boolean } = {}): Promise<StartStreamResult> {
    if (!(this.rtmpServer && this.rtmpKey)) {
      this.streaming = true;
      return { streamUrl: this.rtspUrl, action: "started", targetMatches: null };
    }
    let before: ReturnType<typeof parseRtmpStatus> | null = null;
    // An empty or unrecognised answer is a failure: the start is never reported on a camera that does not say its state.
    before = parseRtmpStatus(await this.cgiCommand(`get_rtmp_status(${Date.now()})`, "GET"));
    if (before.state === "unknown") {
      this.logger?.warn({ camera: this.id, code: before.code }, "Camera RTMP status answer had no recognised rtmp_status");
      throw new CameraCgiError(
        `Camera ${this.id} answered the RTMP status request without a recognised status${before.code === null ? " (empty answer)" : ` (code ${before.code})`}`,
        "rejected"
      );
    }
    // get_rtmp_status carries no target on FW V90; get_net_cfg has rtmp_server (the key is not readable).
    let currentServer = before?.server ?? null;
    if (before?.state === "streaming" && !currentServer) {
      try {
        currentServer = parseNetCfgRtmp(await this.cgiCommand(`get_net_cfg(${Date.now()})`, "GET", "/storks/")).server;
      } catch {
        currentServer = null; // unknown target: reported as targetMatches null
      }
    }
    const targetMatches = currentServer
      ? sameRtmpServer(currentServer, this.rtmpServer) && (before?.key === undefined || before.key === this.rtmpKey)
      : null;
    let action: StartStreamResult["action"] = "started";
    if (before?.state === "streaming") {
      this.streaming = true;
      if (!options.restart) {
        if (targetMatches === false) {
          this.logger?.warn({ camera: this.id }, "Camera streams to a different RTMP target; start again with restart to apply the configured one");
        }
        return { streamUrl: this.rtspUrl, action: "already-streaming", targetMatches };
      }
      await this.cgiCommand("set_rtmp_stop", "POST");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      action = "restarted";
    }
    await this.cgiCommand(`set_rtmp_start(server=${this.rtmpServer};key=${this.rtmpKey})`, "POST");
    // The camera must say it streams; polled for a few seconds because the push takes a moment to come up.
    const deadline = Date.now() + this.rtmpVerifyMs;
    let last: RtmpState | null = null;
    for (;;) {
      last = await this.rtmpStatus();
      if (last === "streaming") break;
      if (last === "failed") {
        this.logger?.warn({ camera: this.id }, "Camera reported the RTMP push as failed");
        throw new CameraCgiError(`Camera ${this.id} reported the RTMP push as failed`, "rejected");
      }
      if (Date.now() >= deadline) {
        throw new CameraCgiError(
          `Camera ${this.id} did not report streaming after the start (status ${last ?? "empty or unrecognised"})`,
          "rejected"
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.streaming = true;
    return { streamUrl: this.rtspUrl, action, targetMatches: action === "restarted" ? true : targetMatches };
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
  private async rtmpStatus(): Promise<RtmpState | null> {
    const body = await this.cgiCommand(`get_rtmp_status(${Date.now()})`, "GET");
    const parsed = parseRtmpStatus(body);
    if (parsed.state === "unknown") {
      this.logger?.warn({ camera: this.id, code: parsed.code }, "Camera RTMP status answer had no recognised rtmp_status");
      return null;
    }
    return parsed.state;
  }

  /** One CGI call on /storks. The login goes only in the Authorization header. Returns the answer body. */
  private async cgiCommand(cmd: string, method: "GET" | "POST", base = "/storks"): Promise<string> {
    const url = `http://${this.host}:${this.cgiPort}${base}?cmd=${cmd}`;
    const headers: Record<string, string> = this.authHeader ? { Authorization: this.authHeader } : {};
    let res: Response | undefined;
    // Reads are retried once (a slow camera often answers the second time); commands are sent once.
    const attempts = method === "GET" ? 2 : 1;
    for (let attempt = 1; attempt <= attempts && !res; attempt++) {
      try {
        res = await fetch(url, { method, headers, signal: AbortSignal.timeout(this.cgiTimeoutMs) });
      } catch {
        if (attempt === attempts) {
          this.logger?.warn({ camera: this.id }, "Camera CGI unreachable");
          throw new CameraCgiError(`Camera ${this.id} did not answer the CGI request`, "unreachable");
        }
      }
    }
    if (!res) throw new CameraCgiError(`Camera ${this.id} did not answer the CGI request`, "unreachable");
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

  /**
   * Reads pan/tilt/zoom with VISCA position inquiries. Values are the camera's raw units
   * (signed 16-bit pan and tilt, unsigned zoom), not degrees. A failed read leaves the last value.
   */
  async readPosition(): Promise<CameraPosition | null> {
    try {
      const pt = await this.sendFromViscaPort(createViscaPacket([0x81, 0x09, 0x06, 0x12, 0xff], this.sequenceNumber++, 0x0110));
      const z = await this.sendFromViscaPort(createViscaPacket([0x81, 0x09, 0x04, 0x47, 0xff], this.sequenceNumber++, 0x0110));
      const position = parseViscaPosition(pt.subarray(8), z.subarray(8));
      if (position) this.position = position;
      return position;
    } catch {
      return null;
    }
  }

  async refresh(): Promise<void> {
    await this.checkConnection();
  }

  /** VISCA power inquiry: the camera is "connected" only while it answers. */
  markStreaming(streaming: boolean): void {
    this.streaming = streaming;
  }

  async checkConnection(): Promise<boolean> {
    const packet = createViscaPacket([0x81, 0x09, 0x04, 0x00, 0xff], this.sequenceNumber++, 0x0110);
    try {
      await this.sendFromViscaPort(packet);
      this.connected = true;
    } catch {
      this.connected = false;
    }
    if (this.connected) await this.readPosition();
    return this.connected;
  }

  async close(): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.streaming = false;
    this.connected = false;
  }
}
