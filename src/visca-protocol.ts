export type PanTiltDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "upleft"
  | "upright"
  | "downleft"
  | "downright"
  | "stop"
  | "home"
  | "reset";

export type ZoomAction = "in" | "out" | "stop";
export type SmartFrameMode = "enable" | "disable" | "trigger";

export const VISCA_PAYLOAD_TYPE_COMMAND = 0x0100;
export const VISCA_PAYLOAD_TYPE_INQUIRY = 0x0110;
export const VISCA_PAYLOAD_TYPE_REPLY = 0x0111;
export const VISCA_PAYLOAD_TYPE_DEVICE_SETTING = 0x0120;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function createViscaPacket(
  payload: number[],
  sequenceNumber: number,
  type = VISCA_PAYLOAD_TYPE_COMMAND
): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(sequenceNumber >>> 0, 4);
  for (let i = 0; i < payload.length; i++) {
    buf[8 + i] = payload[i]!;
  }
  return buf;
}

export function buildPanTiltDrive(
  direction: PanTiltDirection,
  panSpeed = 10,
  tiltSpeed = 10
): number[] {
  const vv = clamp(panSpeed, 1, 24);
  const ww = clamp(tiltSpeed, 1, 23);

  switch (direction) {
    case "up":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x03, 0x01, 0xff];
    case "down":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x03, 0x02, 0xff];
    case "left":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x01, 0x03, 0xff];
    case "right":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x02, 0x03, 0xff];
    case "upleft":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x01, 0x01, 0xff];
    case "upright":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x02, 0x01, 0xff];
    case "downleft":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x01, 0x02, 0xff];
    case "downright":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x02, 0x02, 0xff];
    case "stop":
      return [0x81, 0x01, 0x06, 0x01, vv, ww, 0x03, 0x03, 0xff];
    case "home":
      return [0x81, 0x01, 0x06, 0x04, 0xff];
    case "reset":
      return [0x81, 0x01, 0x06, 0x05, 0xff];
  }
}

export function buildZoom(action: ZoomAction, speed = 4): number[] {
  const p = clamp(speed, 0, 7);
  switch (action) {
    case "in":
      return [0x81, 0x01, 0x04, 0x07, 0x20 | p, 0xff];
    case "out":
      return [0x81, 0x01, 0x04, 0x07, 0x30 | p, 0xff];
    case "stop":
      return [0x81, 0x01, 0x04, 0x07, 0x00, 0xff];
  }
}

export function buildPresetRecall(presetId: number): number[] {
  const pp = clamp(presetId, 0, 254);
  return [0x81, 0x01, 0x04, 0x3f, 0x02, pp, 0xff];
}

export function buildPresetSave(presetId: number): number[] {
  const pp = clamp(presetId, 0, 254);
  return [0x81, 0x01, 0x04, 0x3f, 0x01, pp, 0xff];
}

export function buildPresetReset(presetId: number): number[] {
  const pp = clamp(presetId, 0, 254);
  return [0x81, 0x01, 0x04, 0x3f, 0x00, pp, 0xff];
}

export function buildSmartFrame(mode: SmartFrameMode): number[] {
  switch (mode) {
    case "enable":
      return [0x81, 0x01, 0x04, 0x3f, 0x02, 0x5a, 0xff];
    case "disable":
      return [0x81, 0x01, 0x04, 0x3f, 0x02, 0x5b, 0xff];
    case "trigger":
      return [0x81, 0x01, 0x04, 0x3f, 0x02, 0x5c, 0xff];
  }
}

/** Standard VISCA CAM_Focus: auto (AF) or manual (MF). */
export function buildFocusMode(mode: "auto" | "manual"): number[] {
  return [0x81, 0x01, 0x04, 0x38, mode === "auto" ? 0x02 : 0x03, 0xff];
}

/**
 * Standard VISCA CAM_Focus Near (variable speed 0-7), and stop. Unverified on the
 * AVer PTZ330: the AVer VISCA document has not been checked against these bytes.
 */
export function buildFocusNear(speed = 7): number[] {
  return [0x81, 0x01, 0x04, 0x08, 0x30 | clamp(speed, 0, 7), 0xff];
}

export function buildFocusStop(): number[] {
  return [0x81, 0x01, 0x04, 0x08, 0x00, 0xff];
}

/** Closest focus distance the near limit can take (standard VISCA scale, 0x1000 far .. 0xF000 near; unverified on the PTZ330). */
export const NEAREST_FOCUS_LIMIT = 0xf000;

/** Standard VISCA CAM_FocusNearLimit, four nibbles 0p 0q 0r 0s. */
export function buildFocusNearLimit(position = NEAREST_FOCUS_LIMIT): number[] {
  const v = clamp(position, 0, 0xffff);
  return [0x81, 0x01, 0x04, 0x28, (v >> 12) & 0xf, (v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf, 0xff];
}

/**
 * Rough VISCA near-limit position for a distance in metres. Unverified: the
 * real scale is lens-specific and the PTZ330 table has not been checked. It
 * interpolates linearly in 1/distance between 0x1000 (infinity) and
 * NEAREST_FOCUS_LIMIT (taken as 0.1 m), which is how focus positions usually
 * behave. Treat as an approximation until read from a camera.
 */
export function nearLimitPositionForMetres(metres: number): number {
  const closest = 0.1;
  const d = Math.min(Math.max(metres, closest), 1000);
  return Math.round(0x1000 + (NEAREST_FOCUS_LIMIT - 0x1000) * (closest / d));
}

export function buildPanTiltInquiry(): number[] {
  return [0x81, 0x09, 0x06, 0x12, 0xff];
}

export function buildZoomInquiry(): number[] {
  return [0x81, 0x09, 0x04, 0x47, 0xff];
}

/** Standard VISCA CAM_Power: on (wake from standby) or standby. Tested on cam1 only. */
export function buildPower(on: boolean): number[] {
  return [0x81, 0x01, 0x04, 0x00, on ? 0x02 : 0x03, 0xff];
}

export function buildPowerInquiry(): number[] {
  return [0x81, 0x09, 0x04, 0x00, 0xff];
}

export interface ParsedViscaResponse {
  type: number;
  length: number;
  sequenceNumber: number;
  payload: Buffer;
  isAck: boolean;
  isCompletion: boolean;
  isError: boolean;
  error?: string;
}

export function parseViscaResponse(buffer: Buffer): ParsedViscaResponse | null {
  if (buffer.length < 8) return null;
  const type = buffer.readUInt16BE(0);
  const length = buffer.readUInt16BE(2);
  const sequenceNumber = buffer.readUInt32BE(4);
  const payload = buffer.subarray(8, 8 + length);

  let isAck = false;
  let isCompletion = false;
  let isError = false;
  let error: string | undefined;

  if (payload.length >= 2) {
    const b1 = payload[1]!;
    if ((b1 & 0xf0) === 0x40) {
      isAck = true;
    } else if ((b1 & 0xf0) === 0x50) {
      isCompletion = true;
    } else if ((b1 & 0xf0) === 0x60) {
      isError = true;
      const code = payload[2];
      switch (code) {
        case 0x01:
          error = "Message length error";
          break;
        case 0x02:
          error = "Syntax error";
          break;
        case 0x03:
          error = "Command buffer full";
          break;
        case 0x04:
          error = "Command cancelled";
          break;
        case 0x05:
          error = "No socket";
          break;
        case 0x41:
          error = "Command not executable";
          break;
        default:
          error = `Error code 0x${code?.toString(16) ?? "unknown"}`;
      }
    }
  }

  return {
    type,
    length,
    sequenceNumber,
    payload,
    isAck,
    isCompletion,
    isError,
    ...(error ? { error } : {})
  };
}
