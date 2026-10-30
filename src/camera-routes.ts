import { isIPv4 } from "node:net";
import type { FastifyInstance } from "fastify";
import { CameraCgiError } from "./camera-adapter.js";
import type { CameraService } from "./camera-service.js";
import type { CameraEventBroker } from "./events.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";

function sendCameraCgiError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof CameraCgiError) {
    const code =
      err.reason === "auth" ? "CAMERA_LOGIN_REJECTED" : err.reason === "unreachable" ? "CAMERA_UNREACHABLE" : "CAMERA_REJECTED";
    return reply.code(502).send({ error: { code, message: err.message } });
  }
  throw err;
}

export function registerCameraRoutes(
  app: FastifyInstance,
  cameraService: CameraService,
  eventBroker?: CameraEventBroker,
  hooks: { onPower?: (cameraId: string, on: boolean) => void } = {}
): void {
  // Health check
  app.get("/health", async () => ({ status: "ok", service: "picam" }));
  app.get("/api/v1/health", async () => ({ status: "ok", service: "picam" }));

  // SSE event stream
  if (eventBroker) {
    const sseHandler = (request: any, reply: any) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });

      const send = (data: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send({ type: "ready", data: { status: "connected", time: new Date().toISOString() } });

      const unsubscribe = eventBroker.subscribe((event) => {
        send(event);
      });

      request.raw.on("close", () => {
        unsubscribe();
      });
    };

    app.get("/events", sseHandler);
    app.get("/api/v1/events", sseHandler);
  }

  // Camera endpoints
  app.get("/api/v1/cameras", async () => ({ items: cameraService.list() }));

  app.get<{ Params: { cameraId: string } }>("/api/v1/cameras/:cameraId", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }
    return reply.code(200).send(camera);
  });

  const validDirections = new Set([
    "up",
    "down",
    "left",
    "right",
    "upleft",
    "upright",
    "downleft",
    "downright",
    "stop",
    "home",
    "reset"
  ]);

  app.post<{
    Params: { cameraId: string };
    Body: { direction?: unknown; panSpeed?: unknown; tiltSpeed?: unknown };
  }>("/api/v1/cameras/:cameraId/move", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const direction = String(request.body?.direction ?? "");
    if (!validDirections.has(direction)) {
      return reply.code(422).send({
        error: {
          code: "INVALID_DIRECTION",
          message: `direction must be one of: ${[...validDirections].join(", ")}`
        }
      });
    }

    const panSpeed = request.body?.panSpeed !== undefined ? Number(request.body.panSpeed) : undefined;
    if (panSpeed !== undefined && (!Number.isInteger(panSpeed) || panSpeed < 1 || panSpeed > 24)) {
      return reply.code(422).send({
        error: { code: "INVALID_PAN_SPEED", message: "panSpeed must be an integer between 1 and 24" }
      });
    }

    const tiltSpeed = request.body?.tiltSpeed !== undefined ? Number(request.body.tiltSpeed) : undefined;
    if (tiltSpeed !== undefined && (!Number.isInteger(tiltSpeed) || tiltSpeed < 1 || tiltSpeed > 23)) {
      return reply.code(422).send({
        error: { code: "INVALID_TILT_SPEED", message: "tiltSpeed must be an integer between 1 and 23" }
      });
    }

    await cameraService.move(
      request.params.cameraId,
      direction as PanTiltDirection,
      panSpeed,
      tiltSpeed
    );

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `move:${direction}`
    });
  });

  const validZoomActions = new Set(["in", "out", "stop"]);

  app.post<{
    Params: { cameraId: string };
    Body: { action?: unknown; speed?: unknown };
  }>("/api/v1/cameras/:cameraId/zoom", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const action = String(request.body?.action ?? "");
    if (!validZoomActions.has(action)) {
      return reply.code(422).send({
        error: { code: "INVALID_ZOOM_ACTION", message: "action must be 'in', 'out', or 'stop'" }
      });
    }

    const speed = request.body?.speed !== undefined ? Number(request.body.speed) : undefined;
    if (speed !== undefined && (!Number.isInteger(speed) || speed < 0 || speed > 7)) {
      return reply.code(422).send({
        error: { code: "INVALID_ZOOM_SPEED", message: "speed must be an integer between 0 and 7" }
      });
    }

    await cameraService.zoom(request.params.cameraId, action as ZoomAction, speed);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `zoom:${action}`
    });
  });

  app.post<{ Params: { cameraId: string; presetId: string } }>(
    "/api/v1/cameras/:cameraId/presets/:presetId/recall",
    async (request, reply) => {
      const camera = cameraService.get(request.params.cameraId);
      if (!camera) {
        return reply.code(404).send({
          error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
        });
      }

      const presetId = Number(request.params.presetId);
      if (!Number.isInteger(presetId) || presetId < 0 || presetId > 254) {
        return reply.code(422).send({
          error: { code: "INVALID_PRESET_ID", message: "presetId must be an integer between 0 and 254" }
        });
      }

      await cameraService.recallPreset(request.params.cameraId, presetId);

      return reply.code(200).send({
        cameraId: request.params.cameraId,
        success: true,
        action: `preset:recall:${presetId}`
      });
    }
  );

  app.post<{
    Params: { cameraId: string; presetId: string };
    Body: { name?: unknown; thumbnail?: unknown; coordinates?: unknown };
  }>("/api/v1/cameras/:cameraId/presets/:presetId/save", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const presetId = Number(request.params.presetId);
    if (!Number.isInteger(presetId) || presetId < 0 || presetId > 254) {
      return reply.code(422).send({
        error: { code: "INVALID_PRESET_ID", message: "presetId must be an integer between 0 and 254" }
      });
    }

    const name = typeof request.body?.name === "string" ? request.body.name.trim() : undefined;
    const thumbnail = typeof request.body?.thumbnail === "string" ? request.body.thumbnail.trim() : undefined;
    const coordinates =
      request.body?.coordinates && typeof request.body.coordinates === "object"
        ? (request.body.coordinates as any)
        : undefined;

    await cameraService.savePreset(request.params.cameraId, presetId, name, coordinates, thumbnail);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `preset:save:${presetId}`
    });
  });

  app.get<{ Params: { cameraId: string; presetId: string } }>(
    "/api/v1/cameras/:cameraId/presets/:presetId/thumbnail",
    async (request, reply) => {
      const camera = cameraService.get(request.params.cameraId);
      if (!camera) {
        return reply.code(404).send({
          error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
        });
      }

      const presetId = Number(request.params.presetId);
      const file = await cameraService.getThumbnailFile(request.params.cameraId, presetId);
      if (!file) {
        return reply.code(404).send({
          error: { code: "THUMBNAIL_NOT_FOUND", message: `Thumbnail for preset ${presetId} not found` }
        });
      }

      return reply.type(file.contentType).send(file.buffer);
    }
  );

  app.post<{
    Params: { cameraId: string };
    Body: { pan?: unknown; tilt?: unknown; roll?: unknown; zoom?: unknown; focus?: unknown };
  }>("/api/v1/cameras/:cameraId/telemetry", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const pan = Number(request.body?.pan ?? 0);
    const tilt = Number(request.body?.tilt ?? 0);
    const zoom = Number(request.body?.zoom ?? 0);
    const focus = request.body?.focus !== undefined ? Number(request.body.focus) : undefined;
    const roll = request.body?.roll !== undefined ? Number(request.body.roll) : undefined;

    const match = request.params.cameraId.match(/\d+$/);
    const camId = match ? Number.parseInt(match[0]!, 10) : 1;

    const event = cameraService.processFreedTelemetry({
      camId,
      pan,
      tilt,
      roll,
      zoom,
      focus
    });

    return reply.code(200).send({
      success: true,
      event: event ?? null
    });
  });

  app.post<{
    Params: { cameraId: string; presetId: string };
    Body: { thumbnail?: unknown };
  }>("/api/v1/cameras/:cameraId/presets/:presetId/thumbnail", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const presetId = Number(request.params.presetId);
    if (!Number.isInteger(presetId) || presetId < 0 || presetId > 254) {
      return reply.code(422).send({
        error: { code: "INVALID_PRESET_ID", message: "presetId must be an integer between 0 and 254" }
      });
    }

    const thumbnail = typeof request.body?.thumbnail === "string" ? request.body.thumbnail.trim() : "";
    if (!thumbnail) {
      return reply.code(422).send({
        error: { code: "THUMBNAIL_REQUIRED", message: "thumbnail data URL or string is required" }
      });
    }

    const updated = await cameraService.savePresetThumbnail(request.params.cameraId, presetId, thumbnail);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      presetId,
      success: true,
      action: `preset:thumbnail:${presetId}`,
      camera: updated
    });
  });

  app.post<{ Params: { cameraId: string; presetId: string } }>(
    "/api/v1/cameras/:cameraId/presets/:presetId/reset",
    async (request, reply) => {
      const camera = cameraService.get(request.params.cameraId);
      if (!camera) {
        return reply.code(404).send({
          error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
        });
      }

      const presetId = Number(request.params.presetId);
      if (!Number.isInteger(presetId) || presetId < 0 || presetId > 254) {
        return reply.code(422).send({
          error: { code: "INVALID_PRESET_ID", message: "presetId must be an integer between 0 and 254" }
        });
      }

      await cameraService.resetPreset(request.params.cameraId, presetId);

      return reply.code(200).send({
        cameraId: request.params.cameraId,
        success: true,
        action: `preset:reset:${presetId}`
      });
    }
  );

  const validSmartFrameModes = new Set(["enable", "disable", "trigger"]);

  app.post<{
    Params: { cameraId: string };
    Body: { mode?: unknown };
  }>("/api/v1/cameras/:cameraId/smartframe", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const mode = String(request.body?.mode ?? "");
    if (!validSmartFrameModes.has(mode)) {
      return reply.code(422).send({
        error: { code: "INVALID_SMARTFRAME_MODE", message: "mode must be 'enable', 'disable', or 'trigger'" }
      });
    }

    await cameraService.setSmartFrame(request.params.cameraId, mode as SmartFrameMode);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `smartframe:${mode}`
    });
  });

  app.post<{
    Params: { cameraId: string };
    Body: { on?: unknown };
  }>("/api/v1/cameras/:cameraId/power", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const on = request.body?.on;
    if (typeof on !== "boolean") {
      return reply.code(422).send({
        error: { code: "INVALID_POWER", message: "on must be true (wake) or false (standby)" }
      });
    }

    await cameraService.setPower(request.params.cameraId, on);
    hooks.onPower?.(request.params.cameraId, on);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `power:${on ? "on" : "standby"}`
    });
  });

  app.get<{ Params: { cameraId: string } }>("/api/v1/cameras/:cameraId/freed", async (request, reply) => {
    if (!cameraService.get(request.params.cameraId)) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    try {
      const freed = await cameraService.getFreed(request.params.cameraId);
      return reply.code(200).send({ cameraId: request.params.cameraId, freed });
    } catch (err) {
      return sendCameraCgiError(reply, err);
    }
  });

  app.post<{
    Params: { cameraId: string };
    Body: { enabled?: unknown; target?: unknown };
  }>("/api/v1/cameras/:cameraId/freed", async (request, reply) => {
    const cameraId = request.params.cameraId;
    if (!cameraService.get(cameraId)) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${cameraId}` }
      });
    }

    const enabled = request.body?.enabled;
    if (typeof enabled !== "boolean") {
      return reply.code(422).send({
        error: { code: "INVALID_FREED", message: "enabled must be true or false" }
      });
    }

    let target: { camId: number; addr: string; port: number } | undefined;
    if (request.body?.target !== undefined) {
      const t = request.body.target as { camId?: unknown; addr?: unknown; port?: unknown } | null;
      const validPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
      if (
        !t ||
        typeof t !== "object" ||
        !validPort(t.camId) ||
        typeof t.addr !== "string" ||
        !isIPv4(t.addr) ||
        !validPort(t.port)
      ) {
        return reply.code(422).send({
          error: {
            code: "INVALID_FREED_TARGET",
            message: "target needs camId (1-65535), addr (IPv4) and port (1-65535)"
          }
        });
      }
      target = { camId: t.camId as number, addr: t.addr, port: t.port as number };
    }

    try {
      const freed = await cameraService.setFreed(cameraId, enabled, target);
      return reply.code(200).send({
        cameraId,
        success: true,
        action: `freed:${enabled ? "on" : "off"}`,
        freed
      });
    } catch (err) {
      return sendCameraCgiError(reply, err);
    }
  });

  app.post<{
    Params: { cameraId: string };
    Body: { enabled?: unknown };
  }>("/api/v1/cameras/:cameraId/privacy-blur", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const enabled = request.body?.enabled;
    if (typeof enabled !== "boolean") {
      return reply.code(422).send({
        error: { code: "INVALID_PRIVACY_BLUR", message: "enabled must be true or false" }
      });
    }

    await cameraService.setPrivacyBlur(request.params.cameraId, enabled);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `privacyblur:${enabled ? "on" : "off"}`
    });
  });

  app.post<{
    Params: { cameraId: string };
    Body: { mode?: unknown };
  }>("/api/v1/cameras/:cameraId/focus", async (request, reply) => {
    const camera = cameraService.get(request.params.cameraId);
    if (!camera) {
      return reply.code(404).send({
        error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
      });
    }

    const mode = request.body?.mode;
    if (mode !== "auto" && mode !== "manual") {
      return reply.code(422).send({
        error: { code: "INVALID_FOCUS_MODE", message: "mode must be auto or manual" }
      });
    }

    await cameraService.setFocusMode(request.params.cameraId, mode);

    return reply.code(200).send({
      cameraId: request.params.cameraId,
      success: true,
      action: `focus:${mode}`
    });
  });

  app.post<{ Params: { cameraId: string } }>(
    "/api/v1/cameras/:cameraId/stream/start",
    async (request, reply) => {
      const camera = cameraService.get(request.params.cameraId);
      if (!camera) {
        return reply.code(404).send({
          error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
        });
      }

      try {
        const { streamUrl } = await cameraService.startStream(request.params.cameraId);
        return reply.code(200).send({
          cameraId: request.params.cameraId,
          streaming: true,
          streamUrl,
          message: "Camera stream started"
        });
      } catch (err) {
        return sendCameraCgiError(reply, err);
      }
    }
  );

  app.post<{ Params: { cameraId: string } }>(
    "/api/v1/cameras/:cameraId/stream/stop",
    async (request, reply) => {
      const camera = cameraService.get(request.params.cameraId);
      if (!camera) {
        return reply.code(404).send({
          error: { code: "CAMERA_NOT_FOUND", message: `Unknown camera ID: ${request.params.cameraId}` }
        });
      }

      try {
        await cameraService.stopStream(request.params.cameraId);
      } catch (err) {
        return sendCameraCgiError(reply, err);
      }

      return reply.code(200).send({
        cameraId: request.params.cameraId,
        streaming: false,
        streamUrl: null,
        message: "Camera stream stopped"
      });
    }
  );
}
