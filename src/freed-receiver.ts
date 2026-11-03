import dgram from "node:dgram";
import type { FastifyBaseLogger } from "fastify";

export const FREED_MESSAGE_TYPE_D1 = 0xd1;
export const FREED_PACKET_LENGTH = 29;

export interface FreedTelemetry {
  camId: number;
  /** Pan angle in degrees (-180 to 180 or vendor range). */
  pan: number;
  /** Tilt angle in degrees (-180 to 180). */
  tilt: number;
  /** Roll angle in degrees. */
  roll: number;
  /** X coordinate in mm. */
  x: number;
  /** Y coordinate in mm. */
  y: number;
  /** Z coordinate (height) in mm. */
  z: number;
  /** Optical zoom raw position (0 - 16777215). */
  zoom: number;
  /** Focus raw position (0 - 16777215). */
  focus: number;
  receivedAt: string;
}

export function readInt24BE(buf: Buffer, offset: number): number {
  const val = (buf[offset]! << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!;
  return val & 0x800000 ? val - 0x1000000 : val;
}

export function readUInt24BE(buf: Buffer, offset: number): number {
  return (buf[offset]! << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!;
}

/**
 * FreeD D1 checksum validation.
 * Standard FreeD rule: sum(buf[0..27]) + buf[28] == 0x40 (modulo 256).
 */
export function verifyFreedChecksum(buf: Buffer): boolean {
  if (buf.length < FREED_PACKET_LENGTH) return false;
  let sum = 0;
  for (let i = 0; i < FREED_PACKET_LENGTH; i++) {
    sum = (sum + buf[i]!) & 0xff;
  }
  return sum === 0x40;
}

/**
 * Encodes a valid FreeD D1 29-byte packet (useful for tests and simulators).
 */
export function encodeFreedPacket(data: {
  camId: number;
  panDeg?: number;
  tiltDeg?: number;
  rollDeg?: number;
  xMm?: number;
  yMm?: number;
  zMm?: number;
  zoom?: number;
  focus?: number;
}): Buffer {
  const buf = Buffer.alloc(FREED_PACKET_LENGTH);
  buf[0] = FREED_MESSAGE_TYPE_D1;
  buf[1] = data.camId & 0xff;

  const writeInt24BE = (value: number, offset: number) => {
    const v = Math.round(value) & 0xffffff;
    buf[offset] = (v >> 16) & 0xff;
    buf[offset + 1] = (v >> 8) & 0xff;
    buf[offset + 2] = v & 0xff;
  };

  const writeUInt24BE = (value: number, offset: number) => {
    const v = Math.max(0, Math.round(value)) & 0xffffff;
    buf[offset] = (v >> 16) & 0xff;
    buf[offset + 1] = (v >> 8) & 0xff;
    buf[offset + 2] = v & 0xff;
  };

  writeInt24BE((data.panDeg ?? 0) * 32768, 2);
  writeInt24BE((data.tiltDeg ?? 0) * 32768, 5);
  writeInt24BE((data.rollDeg ?? 0) * 32768, 8);
  writeInt24BE((data.xMm ?? 0) * 64, 11);
  writeInt24BE((data.yMm ?? 0) * 64, 14);
  writeInt24BE((data.zMm ?? 0) * 64, 17);
  writeUInt24BE(data.zoom ?? 0, 20);
  writeUInt24BE(data.focus ?? 0, 23);

  // Spare bytes 26, 27 are 0

  let sum = 0;
  for (let i = 0; i < 28; i++) {
    sum = (sum + buf[i]!) & 0xff;
  }
  buf[28] = (0x40 - sum) & 0xff;

  return buf;
}

export function decodeFreedPacket(buf: Buffer): FreedTelemetry | null {
  if (buf.length < FREED_PACKET_LENGTH) return null;
  if (buf[0] !== FREED_MESSAGE_TYPE_D1) return null;
  if (!verifyFreedChecksum(buf)) return null;

  const camId = buf[1]!;
  const rawPan = readInt24BE(buf, 2);
  const rawTilt = readInt24BE(buf, 5);
  const rawRoll = readInt24BE(buf, 8);
  const rawX = readInt24BE(buf, 11);
  const rawY = readInt24BE(buf, 14);
  const rawZ = readInt24BE(buf, 17);
  const zoom = readUInt24BE(buf, 20);
  const focus = readUInt24BE(buf, 23);

  return {
    camId,
    pan: Math.round((rawPan / 32768.0) * 100) / 100,
    tilt: Math.round((rawTilt / 32768.0) * 100) / 100,
    roll: Math.round((rawRoll / 32768.0) * 100) / 100,
    x: Math.round((rawX / 64.0) * 10) / 10,
    y: Math.round((rawY / 64.0) * 10) / 10,
    z: Math.round((rawZ / 64.0) * 10) / 10,
    zoom,
    focus,
    receivedAt: new Date().toISOString()
  };
}

export interface FreedReceiverStats {
  received: number;
  decoded: number;
  droppedNotAllowed: number;
  invalid: number;
  lastSource: string | null;
  lastBytes: number | null;
  listening: boolean;
  port: number;
}

export interface FreedUdpReceiverOptions {
  host: string;
  port: number;
  allowedIps?: string[] | undefined;
  /** Called for every valid datagram. */
  onTelemetry?: ((telemetry: FreedTelemetry) => void) | undefined;
  logger?: FastifyBaseLogger | undefined;
}

export class FreedUdpReceiver {
  private readonly options: FreedUdpReceiverOptions;
  private readonly allowedIps?: Set<string> | undefined;
  private readonly stats = { received: 0, decoded: 0, droppedNotAllowed: 0, invalid: 0, lastSource: null as string | null, lastBytes: null as number | null };
  private readonly telemetryByCamId = new Map<number, FreedTelemetry>();
  private socket: dgram.Socket | null = null;

  constructor(options: FreedUdpReceiverOptions) {
    this.options = options;
    if (options.allowedIps?.length) {
      this.allowedIps = new Set(options.allowedIps.map((ip) => ip.trim()));
    }
  }

  getTelemetry(camId: number): FreedTelemetry | undefined {
    return (
      this.telemetryByCamId.get(camId) ??
      this.telemetryByCamId.get(100 + camId) ??
      (camId > 100 ? this.telemetryByCamId.get(camId - 100) : undefined)
    );
  }

  getAllTelemetry(): FreedTelemetry[] {
    return [...this.telemetryByCamId.values()];
  }

  /** Datagram counters, to tell "nothing arrives" from "arrives but is dropped or invalid". */
  getStats(): FreedReceiverStats {
    return { ...this.stats, listening: this.socket !== null, port: this.getBoundPort() };
  }

  getBoundPort(): number {
    const address = this.socket?.address();
    return address && typeof address === "object" ? address.port : this.options.port;
  }

  start(): Promise<void> {
    if (this.socket) return Promise.resolve();

    const socket = dgram.createSocket("udp4");
    this.socket = socket;

    socket.on("message", (buf, remote) => {
      const remoteIp = remote.address.startsWith("::ffff:") ? remote.address.slice(7) : remote.address;
      this.stats.received += 1;
      this.stats.lastSource = remoteIp;
      this.stats.lastBytes = buf.length;
      if (this.stats.received === 1) {
        this.options.logger?.info({ from: remoteIp, bytes: buf.length }, "FreeD: first datagram received");
      }
      if (this.allowedIps && !this.allowedIps.has(remoteIp)) {
        if (this.stats.droppedNotAllowed++ === 0) {
          this.options.logger?.warn({ from: remoteIp }, "FreeD datagram dropped: source is not in PICAM_FREED_ALLOWED_HOSTS");
        }
        return;
      }

      const telemetry = decodeFreedPacket(buf);
      if (!telemetry) {
        if (this.stats.invalid++ === 0) {
          this.options.logger?.warn({ from: remoteIp, bytes: buf.length }, "FreeD datagram invalid (length or checksum)");
        }
        return;
      }
      this.stats.decoded += 1;

      this.telemetryByCamId.set(telemetry.camId, telemetry);

      this.options.onTelemetry?.(telemetry);
    });

    socket.on("error", (err) => {
      this.options.logger?.error({ err }, "FreeD UDP telemetry receiver error");
    });

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        socket.off("listening", onListening);
        this.socket = null;
        reject(err);
      };

      const onListening = () => {
        socket.off("error", onError);
        this.options.logger?.info(
          { host: this.options.host, port: this.options.port },
          "FreeD UDP telemetry receiver listening"
        );
        resolve();
      };

      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(this.options.port, this.options.host);
    });
  }

  stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => socket.close(() => resolve()));
  }
}
