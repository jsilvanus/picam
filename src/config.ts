export interface AppConfig {
  host: string;
  port: number;
  mode: "simulation" | "production";
  nearLimitM: number;
  /** Cameras whose privacy blur is sticky: re-applied after every preset recall (PICAM_BLUR_CAMERAS=cam1,cam2). */
  blurCameras: string[];
  /** Delay before the blur is re-applied after a recall, so the camera has finished moving (ms). */
  blurReapplyMs: number;
  /** Where cameras send FreeD while a stream runs (PICAM_FREED_TARGET=host:port). Unset = FreeD is not switched automatically. */
  freedTarget?: { addr: string; port: number } | undefined;
  /** UDP port to receive the cameras' FreeD telemetry on (PICAM_FREED_UDP_PORT). Unset = no receiver; telemetry can still be posted to /telemetry. */
  freedUdpPort?: number | undefined;
  freedUdpHost: string;
  /** Source IPs accepted for FreeD datagrams (PICAM_FREED_ALLOWED_HOSTS, comma list). Empty = any. */
  freedAllowedHosts: string[];
  /** Liveness probe interval in ms (PICAM_HEALTH_INTERVAL_MS, default 15000, 0 = off); production only. */
  healthIntervalMs: number;
  cam1Name: string;
  cam1Host: string;
  cam1ViscaPort: number;
  cam1CgiPort: number;
  cam1CgiUser?: string | undefined;
  cam1CgiPassword?: string | undefined;
  cam2Name: string;
  cam2Host: string;
  cam2ViscaPort: number;
  cam2CgiPort: number;
  cam2CgiUser?: string | undefined;
  cam2CgiPassword?: string | undefined;
  mediaMtxRtspBaseUrl?: string | undefined;
  /** MediaMTX control API, e.g. http://127.0.0.1:9997; used at startup to learn which camera paths are already live. */
  mediaMtxApiUrl?: string | undefined;
  mediaMtxRtmpBaseUrl?: string | undefined;
  pigatewayUrl: string;
  presetsFilePath?: string | undefined;
  thumbnailsDir?: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = env["PICAM_MODE"] === "production" ? "production" : "simulation";
  const port = Number.parseInt(env["PICAM_PORT"] ?? "3102", 10);
  const host = env["PICAM_HOST"] ?? "0.0.0.0";
  const nearLimitM = Number.parseFloat(env["PICAM_NEAR_LIMIT_M"] ?? "5.0");
  const freedTarget = parseFreedTarget(env["PICAM_FREED_TARGET"]);
  const pigatewayUrl = env["PIGATEWAY_URL"]?.trim() || "http://127.0.0.1:3000";
  const presetsFilePath = env["PICAM_PRESETS_FILE"]?.trim() || undefined;
  const thumbnailsDir = env["PICAM_THUMBNAILS_DIR"]?.trim() || undefined;

  return {
    host,
    port: Number.isNaN(port) ? 3102 : port,
    mode,
    nearLimitM: Number.isNaN(nearLimitM) ? 5.0 : nearLimitM,
    freedTarget,
    blurCameras: (env["PICAM_BLUR_CAMERAS"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    blurReapplyMs: Math.max(0, Number.parseInt(env["PICAM_BLUR_REAPPLY_MS"] ?? "4000", 10) || 0),
    pigatewayUrl,
    presetsFilePath,
    thumbnailsDir,

    freedUdpPort: parseUdpPort(env["PICAM_FREED_UDP_PORT"]),
    freedUdpHost: env["PICAM_FREED_UDP_HOST"]?.trim() || "0.0.0.0",
    freedAllowedHosts: (env["PICAM_FREED_ALLOWED_HOSTS"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    healthIntervalMs: Math.max(0, Number.parseInt(env["PICAM_HEALTH_INTERVAL_MS"] ?? "15000", 10) || 0),
    cam1Name: env["PICAM_CAM1_NAME"] ?? "Camera 1",
    cam1Host: env["PICAM_CAM1_HOST"] ?? "",
    cam1ViscaPort: Number.parseInt(env["PICAM_CAM1_VISCA_PORT"] ?? "52381", 10) || 52381,
    cam1CgiPort: Number.parseInt(env["PICAM_CAM1_CGI_PORT"] ?? "80", 10) || 80,
    cam1CgiUser: env["PICAM_CAM1_CGI_USER"] || undefined,
    cam1CgiPassword: env["PICAM_CAM1_CGI_PASSWORD"] || undefined,

    cam2Name: env["PICAM_CAM2_NAME"] ?? "Camera 2",
    cam2Host: env["PICAM_CAM2_HOST"] ?? "",
    cam2ViscaPort: Number.parseInt(env["PICAM_CAM2_VISCA_PORT"] ?? "52381", 10) || 52381,
    cam2CgiPort: Number.parseInt(env["PICAM_CAM2_CGI_PORT"] ?? "80", 10) || 80,
    cam2CgiUser: env["PICAM_CAM2_CGI_USER"] || undefined,
    cam2CgiPassword: env["PICAM_CAM2_CGI_PASSWORD"] || undefined,

    mediaMtxRtspBaseUrl: env["PICAM_MEDIAMTX_RTSP_BASE_URL"] || undefined,
    mediaMtxApiUrl: env["PICAM_MEDIAMTX_API_URL"] || (env["PICAM_MEDIAMTX_RTSP_BASE_URL"] ? "http://127.0.0.1:9997" : undefined),
    mediaMtxRtmpBaseUrl: env["PICAM_MEDIAMTX_RTMP_BASE_URL"] || undefined
  };
}

function parseFreedTarget(value: string | undefined): { addr: string; port: number } | undefined {
  const match = /^(.+):(\d{1,5})$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const port = Number.parseInt(match[2]!, 10);
  return port > 0 && port < 65536 ? { addr: match[1]!, port } : undefined;
}

function parseUdpPort(value: string | undefined): number | undefined {
  const n = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : undefined;
}
