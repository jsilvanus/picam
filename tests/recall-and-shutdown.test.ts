import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CameraContextTracker } from "../src/camera-context.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("context: a recall nobody sees land stops counting as moving after the timeout", () => {
  let t = 0;
  const c = new CameraContextTracker(3000, () => t, 20_000);
  c.recall("cam2", 2);
  assert.equal(c.get("cam2").moving, true);
  t += 20_001;
  assert.equal(c.get("cam2").moving, false);
  assert.equal(c.get("cam2").targetPresetId, null);
});

test("recall to the preset the camera is already at lands without any motion (FreeD)", async () => {
  process.env["PICAM_RECALL_STILL_MS"] = "50";
  const { app, cameraService } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  try {
    await cameraService.getPresetStore().savePreset("cam1", 100, "Here", { pan: 10, tilt: 5, zoom: 1000 });
    const frame = () => cameraService.processFreedTelemetry({ camId: 1, pan: 10, tilt: 5, zoom: 1000 });
    frame();
    frame();
    await cameraService.recallPreset("cam1", 100);
    assert.equal(cameraService.getContext("cam1")!.moving, true);
    frame();
    await new Promise((r) => setTimeout(r, 60));
    frame();
    const ctx = cameraService.getContext("cam1")!;
    assert.equal(ctx.moving, false);
    assert.equal(ctx.presetId, 100);
  } finally {
    delete process.env["PICAM_RECALL_STILL_MS"];
    await app.close();
  }
});

test("recall to a preset without stored coordinates ends as unknown once the camera stays still", async () => {
  process.env["PICAM_RECALL_STILL_MS"] = "50";
  const { app, cameraService } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  try {
    const frame = () => cameraService.processFreedTelemetry({ camId: 2, pan: 1, tilt: 1, zoom: 1 });
    frame();
    await cameraService.recallPreset("cam2", 42);
    frame();
    await new Promise((r) => setTimeout(r, 110));
    frame();
    const ctx = cameraService.getContext("cam2")!;
    assert.equal(ctx.moving, false);
    assert.equal(ctx.presetId, null);
  } finally {
    delete process.env["PICAM_RECALL_STILL_MS"];
    await app.close();
  }
});

test("app.close() does not hang on an open SSE client", async () => {
  const { app } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  await new Promise<void>((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/events`, (res) => {
      res.once("data", () => resolve());
      res.on("error", () => {});
    });
    req.on("error", () => {});
  });
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 3000, "close finished quickly");
});
