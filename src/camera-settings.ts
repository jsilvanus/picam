/** Stream encoding settings of an AVer PTZ330 (get_av_cfg). Values are what the camera reports. */
export interface StreamSettings {
  /** e.g. "1280x720" */
  vres: string | null;
  fps: number | null;
  /** bits per second */
  bitrate: number | null;
  /** 0 = VBR, 1 = CBR */
  ratectrl: number | null;
  /** "h264" (camera value 1) or "mjpeg" (0) */
  vcodec: string | null;
}

export type StreamSettingsPatch = Partial<{ vres: string; fps: number; bitrate: number }>;

/** Exposure and white balance (get_img_cfg). expmode: 0 full auto, 1 shutter priority, 2 iris priority, 3 manual. */
export interface ImageSettings {
  expmode: number | null;
  /** Exposure compensation slider + 5 (5 = 0 EV) */
  expval: number | null;
  shutter: number | null;
  iris: number | null;
  /** Gain step 0-16 (get_img_cfg `img_gain`) */
  gain: number | null;
  /** White balance mode: 0 auto, 2 indoor, 3 outdoor, 4 one push, 6 manual */
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
    vcodec: ({ "1": "h264", "0": "mjpeg" } as Record<string, string>)[f.get("vcodec") ?? ""] ?? (f.get("vcodec") || null)
  };
}

export function parseImageSettings(body: string): ImageSettings {
  const f = parseCgiFields(body);
  return {
    expmode: int(f.get("expmode")),
    expval: int(f.get("expval")),
    shutter: int(f.get("shutter")),
    iris: int(f.get("iris")),
    gain: int(f.get("img_gain")),
    awb: int(f.get("awb")),
    colortemp: int(f.get("colortemp")),
    rgain: int(f.get("rgain")),
    bgain: int(f.get("bgain"))
  };
}

export const VRES_OPTIONS = ["640x360", "640x480", "960x540", "1280x720", "1920x1080"];
export const FPS_OPTIONS = [1, 5, 10, 15, 20, 30, 60];

/** Options from the camera's web UI: five resolutions, seven frame rates, 512 kbps..32 Mbps. */
export function validateStreamPatch(patch: Record<string, unknown>): { ok: true; patch: StreamSettingsPatch } | { ok: false; message: string } {
  const out: StreamSettingsPatch = {};
  const allowed = new Set(["vres", "fps", "bitrate"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) return { ok: false, message: `unknown setting '${key}' (allowed: vres, fps, bitrate)` };
  }
  if (patch["vres"] !== undefined) {
    if (!VRES_OPTIONS.includes(String(patch["vres"]))) return { ok: false, message: `vres must be one of ${VRES_OPTIONS.join(", ")}` };
    out.vres = String(patch["vres"]);
  }
  if (patch["fps"] !== undefined) {
    const n = patch["fps"];
    if (typeof n !== "number" || !FPS_OPTIONS.includes(n)) return { ok: false, message: `fps must be one of ${FPS_OPTIONS.join(", ")}` };
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

export type ImageSettingsPatch = Partial<{
  expmode: number;
  expval: number;
  shutter: number;
  iris: number;
  gain: number;
  wb: number;
  colortemp: number;
  rgain: number;
  bgain: number;
}>;

const IMAGE_LIMITS: Record<keyof ImageSettingsPatch, [number, number]> = {
  expmode: [0, 3],
  expval: [0, 10],
  shutter: [0, 15],
  iris: [0, 13],
  gain: [0, 16],
  wb: [0, 6],
  colortemp: [0, 100000],
  rgain: [0, 255],
  bgain: [0, 255]
};

/** Exposure and white balance writes (set_expmode, set_expval, set_shutter, set_iris, set_gain, set_wb, ...). Untested on a real camera. */
export function validateImagePatch(patch: Record<string, unknown>): { ok: true; patch: ImageSettingsPatch } | { ok: false; message: string } {
  const out: ImageSettingsPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    const limits = IMAGE_LIMITS[key as keyof ImageSettingsPatch];
    if (!limits) return { ok: false, message: `unknown setting '${key}' (allowed: ${Object.keys(IMAGE_LIMITS).join(", ")})` };
    if (typeof value !== "number" || !Number.isInteger(value) || value < limits[0] || value > limits[1]) {
      return { ok: false, message: `${key} must be an integer ${limits[0]}-${limits[1]}` };
    }
    out[key as keyof ImageSettingsPatch] = value;
  }
  if (out.wb !== undefined && ![0, 2, 3, 4, 6].includes(out.wb)) return { ok: false, message: "wb must be 0 auto, 2 indoor, 3 outdoor, 4 one push or 6 manual" };
  if (Object.keys(out).length === 0) return { ok: false, message: "give at least one setting" };
  return { ok: true, patch: out };
}

/** The camera command for each image setting. */
export const IMAGE_COMMANDS: Record<keyof ImageSettingsPatch, string> = {
  expmode: "set_expmode",
  expval: "set_expval",
  shutter: "set_shutter",
  iris: "set_iris",
  gain: "set_gain",
  wb: "set_wb",
  colortemp: "set_colortemp",
  rgain: "set_img_wb_r_gain",
  bgain: "set_img_wb_b_gain"
};
