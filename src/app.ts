import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { CameraEventBroker } from "./events.js";
import { CameraService } from "./camera-service.js";
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
    pigatewayUrl: config.pigatewayUrl,
    presetsFilePath: config.presetsFilePath,
    thumbnailsDir: config.thumbnailsDir
  });

  app.addHook("onReady", async () => {
    await cameraService.init();
  });

  registerCameraRoutes(app, cameraService, eventBroker);

  return { app, cameraService, eventBroker };
}
