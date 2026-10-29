import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { PiCamClient } from "../src/client.js";

test("API routes handle camera listing and movements", async (t) => {
  const config = loadConfig({
    PICAM_MODE: "simulation",
    PICAM_PORT: "0" // ephemeral port
  });

  const { app, cameraService } = buildApp(config);
  t.after(async () => {
    await cameraService.close();
    await app.close();
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const client = new PiCamClient(address);

  // 1. Health
  const health = await client.health();
  assert.equal(health.status, "ok");
  assert.equal(health.service, "picam");

  // 2. List cameras
  const list = await client.listCameras();
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]?.id, "cam1");
  assert.equal(list.items[1]?.id, "cam2");

  // 3. Move camera
  const moveRes = await client.moveCamera("cam1", "up");
  assert.equal(moveRes.success, true);
  assert.equal(moveRes.action, "move:up");

  const camAfterMove = await client.getCamera("cam1");
  assert.ok(camAfterMove.position.tilt > 0);

  // 4. Zoom camera
  const zoomRes = await client.zoomCamera("cam1", "in");
  assert.equal(zoomRes.success, true);
  assert.equal(zoomRes.action, "zoom:in");

  // 5. Preset recall & save
  const saveRes = await client.savePreset("cam1", 3, "Pulpit");
  assert.equal(saveRes.success, true);

  const recallRes = await client.recallPreset("cam1", 3);
  assert.equal(recallRes.success, true);

  // 6. Focus & Power
  const focusRes = await client.setFocusMode("cam1", "manual");
  assert.equal(focusRes.success, true);

  const powerRes = await client.setPower("cam1", false);
  assert.equal(powerRes.success, true);
});
