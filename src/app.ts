import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { CameraEventBroker } from "./events.js";
import { CameraService } from "./camera-service.js";
import { FreedUdpReceiver } from "./freed-receiver.js";
import { registerCameraRoutes } from "./camera-routes.js";

export interface BuildAppResult {
  app: FastifyInstance;
  cameraService: CameraService;
  eventBroker: CameraEventBroker;
}

export function buildApp(config: AppConfig): BuildAppResult {
  const app = Fastify({
    logger: {
      level: process.env["NODE_ENV"] === "test" ? "silent" : "info"
    }
  });

  const eventBroker = new CameraEventBroker();

  const cameraService = new CameraService({
    mode: config.mode,
    eventBroker,
    logger: app.log,
    nearLimitM: config.nearLimitM,
    blurCameras: config.blurCameras,
    blurReapplyMs: config.blurReapplyMs,
    freedTarget: config.freedTarget,
    cam1Name: config.cam1Name,
    cam1Host: config.cam1Host,
    cam1ViscaPort: config.cam1ViscaPort,
    cam1CgiPort: config.cam1CgiPort,
    cam1CgiUser: config.cam1CgiUser,
    cam1CgiPassword: config.cam1CgiPassword,
    cam2Name: config.cam2Name,
    cam2Host: config.cam2Host,
    cam2ViscaPort: config.cam2ViscaPort,
    cam2CgiPort: config.cam2CgiPort,
    cam2CgiUser: config.cam2CgiUser,
    cam2CgiPassword: config.cam2CgiPassword,
    mediaMtxRtspBaseUrl: config.mediaMtxRtspBaseUrl,
    mediaMtxRtmpBaseUrl: config.mediaMtxRtmpBaseUrl,
    mediaMtxApiUrl: config.mediaMtxApiUrl,
    pigatewayUrl: config.pigatewayUrl,
    presetsFilePath: config.presetsFilePath,
    thumbnailsDir: config.thumbnailsDir
  });

  app.addHook("onReady", async () => {
    await cameraService.init();
    await cameraService.syncStreams();
    // Only real cameras are probed (simulated ones are always alive). 0 turns it off.
    if (config.mode === "production") cameraService.startHealthMonitor(config.healthIntervalMs);
  });

  const freedReceiver =
    config.freedUdpPort !== undefined
      ? new FreedUdpReceiver({
          host: config.freedUdpHost,
          port: config.freedUdpPort,
          allowedIps: config.freedAllowedHosts,
          logger: app.log,
          onTelemetry: (t) => {
            cameraService.processFreedTelemetry(t);
          }
        })
      : undefined;
  let freedRetry: NodeJS.Timeout | undefined;
  if (freedReceiver) {
    // A busy port (for example pigateway still listening) must not stop picam; retry until it is free.
    const startFreed = async (): Promise<void> => {
      try {
        await freedReceiver.start();
      } catch (err) {
        app.log.error({ err }, "FreeD receiver could not bind; retrying in 15 s");
        freedRetry = setTimeout(() => void startFreed(), 15_000);
        freedRetry.unref();
      }
    };
    app.addHook("onReady", startFreed);
    app.addHook("onClose", async () => {
      if (freedRetry) clearTimeout(freedRetry);
      await freedReceiver.stop();
    });
  }

  registerCameraRoutes(app, cameraService, eventBroker);
  app.get("/api/v1/freed/stats", async () => (freedReceiver ? freedReceiver.getStats() : { listening: false, port: null }));

  return { app, cameraService, eventBroker };
}
