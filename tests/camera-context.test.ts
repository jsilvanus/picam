import test from "node:test";
import assert from "node:assert/strict";
import { CameraContextTracker } from "../src/camera-context.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("context: recall makes the camera moving until it settles on the preset", () => {
  let t = 1000;
  const c = new CameraContextTracker(3000, () => t);
  assert.equal(c.get("cam1").stale, true, "no telemetry yet means stale");
  c.recall("cam1", 2);
  assert.deepEqual(
    { moving: c.get("cam1").moving, target: c.get("cam1").targetPresetId, preset: c.get("cam1").presetId },
    { moving: true, target: 2, preset: null }
  );
  c.telemetry("cam1", { pan: 1, tilt: 2, zoom: 3 }, true);
  c.telemetry("cam1", { pan: 5, tilt: 2, zoom: 3 }, false);
  c.settledOn("cam1", 2);
  const ctx = c.get("cam1");
  assert.equal(ctx.presetId, 2);
  assert.equal(ctx.settled, true);
  assert.equal(ctx.moving, false);
  assert.equal(ctx.stale, false);
  t += 3500;
  assert.equal(c.get("cam1").stale, true, "stale after the window");
});

test("context: driving by hand clears the preset and stop ends moving", () => {
  const c = new CameraContextTracker();
  c.settledOn("cam1", 1);
  c.driving("cam1", true);
  assert.equal(c.get("cam1").presetId, null);
  assert.equal(c.get("cam1").moving, true);
  c.driving("cam1", false);
  assert.equal(c.get("cam1").moving, false);
});

test("GET /cameras/:id/context follows recall and telemetry (simulation)", async () => {
  const { app } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  try {
    const bad = await app.inject({ method: "GET", url: "/api/v1/cameras/nope/context" });
    assert.equal(bad.statusCode, 404);
    await app.inject({ method: "POST", url: "/api/v1/cameras/cam1/presets/1/recall" });
    const moving = (await app.inject({ method: "GET", url: "/api/v1/cameras/cam1/context" })).json();
    assert.equal(moving.moving, true);
    assert.equal(moving.targetPresetId, 1);
  } finally {
    await app.close();
  }
});

test("context carries the privacy blur so detectors can distrust the picture", async () => {
  const { app } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  try {
    await app.inject({ method: "POST", url: "/api/v1/cameras/cam1/privacy-blur", payload: { enabled: true } });
    const ctx = (await app.inject({ method: "GET", url: "/api/v1/cameras/cam1/context" })).json();
    assert.equal(ctx.privacyBlur, true);
    assert.equal(ctx.focusMode, "manual");
  } finally {
    await app.close();
  }
});
