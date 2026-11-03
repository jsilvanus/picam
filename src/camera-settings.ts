/** Stream encoding settings of an AVer PTZ330 (get_av_cfg). Values are what the camera reports. */
export interface StreamSettings {
  /** e.g. "1280x720" */
  vres: string | null;
  fps: number | null;
  /** bits per second */
  bitrate: number | null;
  /** 0 = VBR (as seen on the camera) */
  ratectrl: number | null;
  vcodec: string | null;
}

export type StreamSettingsPatch = Partial<{ vres: string; fps: number; bitrate: number }>;

/** Exposure and white balance (get_img_cfg). expmode: 0 full auto, 1 shutter priority, 2 iris priority, 3 manual. */
export interface ImageSettings {
  expmode: number | null;
  awb: number | null;
  colortemp: number | null;
  rgain: number | null;
  bgain: number | null;
}

export const EXPOSURE_MODES: Record<number, string> = { 0: "auto", 1: "shutter-priority", 2: "iris-priority", 3: "manual" };

/** Reads `key=value;` or `key:value;` pairs (the camera uses both styles). Later keys win. */
export function parseCgiFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of body.split(/[;\r\n&]/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*[:=]\s*(.*?)\s*$/.exec(part);
    if (m) fields.set(m[1]!, m[2]!);
  }
  return fields;
}

function int(v: string | undefined): number | null {
  return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null;
}

export function parseStreamSettings(body: string): StreamSettings {
  const f = parseCgiFields(body);
  return {
    vres: f.get("vres") || null,
    fps: int(f.get("fps")),
    bitrate: int(f.get("bitrate")),
    ratectrl: int(f.get("ratectrl")),
    vcodec: f.get("vcodec") || null
  };
}

export function parseImageSettings(body: string): ImageSettings {
  const f = parseCgiFields(body);
  return {
    expmode: int(f.get("expmode")),
    awb: int(f.get("awb")),
    colortemp: int(f.get("colortemp")),
    rgain: int(f.get("rgain")),
    bgain: int(f.get("bgain"))
  };
}

/** Limits seen in the camera's web UI: 640x360..1920x1080, 1-60 fps, 512 kbps..32 Mbps. */
export function validateStreamPatch(patch: Record<string, unknown>): { ok: true; patch: StreamSettingsPatch } | { ok: false; message: string } {
  const out: StreamSettingsPatch = {};
  const allowed = new Set(["vres", "fps", "bitrate"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return { ok: false, message: `unknown setting '${key}' (allowed: vres, fps, bitrate)` };
  }
  if (patch["vres"] !== undefined) {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(patch["vres"]));
    if (!m) return { ok: false, message: "vres must look like 1280x720" };
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w < 640 || w > 1920 || h < 360 || h > 1080) return { ok: false, message: "vres must be between 640x360 and 1920x1080" };
    out.vres = `${w}x${h}`;
  }
  if (patch["fps"] !== undefined) {
    const n = patch["fps"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 60) return { ok: false, message: "fps must be an integer 1-60" };
    out.fps = n;
  }
  if (patch["bitrate"] !== undefined) {
    const n = patch["bitrate"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 512_000 || n > 32_000_000) {
      return { ok: false, message: "bitrate must be an integer in bits per second, 512000-32000000" };
    }
    out.bitrate = n;
  }
  if (Object.keys(out).length === 0) return { ok: false, message: "give at least one of vres, fps, bitrate" };
  return { ok: true, patch: out };
}
