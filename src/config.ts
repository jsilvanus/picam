export interface AppConfig {
  host: string;
  port: number;
  mode: "simulation" | "production";
  nearLimitM: number;
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
  mediaMtxRtmpBaseUrl?: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = env["PICAM_MODE"] === "production" ? "production" : "simulation";
  const port = Number.parseInt(env["PICAM_PORT"] ?? "3300", 10);
  const host = env["PICAM_HOST"] ?? "0.0.0.0";
  const nearLimitM = Number.parseFloat(env["PICAM_NEAR_LIMIT_M"] ?? "5.0");

  return {
    host,
    port: Number.isNaN(port) ? 3300 : port,
    mode,
    nearLimitM: Number.isNaN(nearLimitM) ? 5.0 : nearLimitM,

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
    mediaMtxRtmpBaseUrl: env["PICAM_MEDIAMTX_RTMP_BASE_URL"] || undefined
  };
}
