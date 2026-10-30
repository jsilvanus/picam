import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PresetStore } from "../src/preset-store.js";
import { CameraSettlingTracker } from "../src/settling-tracker.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("PresetStore persists presets and extracts base64 thumbnail into file", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "picam-test-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const filePath = path.join(tmpDir, "presets.json");
  const thumbnailsDir = path.join(tmpDir, "thumbnails");
  const store = new PresetStore({ filePath, thumbnailsDir });
  await store.init({
    cam1: [{ id: 1, name: "Initial" }]
  });

  assert.equal(store.getPresets("cam1").length, 1);
  assert.equal(store.getPresets("cam1")[0]?.name, "Initial");

  // Save preset with coordinates
  await store.savePreset(
    "cam1",
    1,
    "Pulpit",
    { pan: 42.5, tilt: -5.0, zoom: 12000, focus: 5500 }
  );

  // Save base64 thumbnail
  const sample1x1PngBase64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const savedWithThumb = await store.saveThumbnail("cam1", 1, sample1x1PngBase64);
  assert.equal(savedWithThumb.thumbnail, "/api/v1/cameras/cam1/presets/1/thumbnail");

  // Verify file was written
  const thumbFile = await store.getThumbnailFile("cam1", 1);
  assert.ok(thumbFile);
  assert.equal(thumbFile.contentType, "image/png");
  assert.ok(thumbFile.buffer.length > 0);

  // Re-read with a fresh PresetStore instance from disk
  const freshStore = new PresetStore({ filePath, thumbnailsDir });
  await freshStore.init();
  const preset = freshStore.getPreset("cam1", 1);
  assert.ok(preset);
  assert.equal(preset.name, "Pulpit");
  assert.equal(preset.coordinates?.pan, 42.5);
  assert.equal(preset.coordinates?.tilt, -5.0);
  assert.equal(preset.coordinates?.zoom, 12000);
  assert.equal(preset.thumbnail, "/api/v1/cameras/cam1/presets/1/thumbnail");
});

test("CameraSettlingTracker tracks motion and declares settled when inside tolerance", () => {
  const tracker = new CameraSettlingTracker({
    panToleranceDeg: 0.3,
    tiltToleranceDeg: 0.3,
    zoomTolerance: 500,
    minStationaryFrames: 3,
    motionThresholdPanDeg: 0.05
  });

  const presets = [
    {
      id: 1,
      name: "Pulpit",
      coordinates: { pan: 50.0, tilt: 10.0, zoom: 5000 }
    },
    {
      id: 2,
      name: "Altar",
      coordinates: { pan: -30.0, tilt: 5.0, zoom: 8000 }
    }
  ];

  tracker.setTargetPreset("cam1", 1);
  assert.equal(tracker.getTargetPreset("cam1"), 1);

  // Frame 1: start moving
  const ev1 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 10.0, tilt: 0.0, zoom: 1000 }, presets);
  assert.equal(ev1, null);

  // Frame 2: moving quickly towards pulpit
  const ev2 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 30.0, tilt: 5.0, zoom: 3000 }, presets);
  assert.ok(ev2);
  assert.equal(ev2.action, "motion:moving");
  assert.equal(tracker.isCameraMoving("cam1"), true);

  // Frame 3: approaching pulpit
  const ev3 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 49.9, tilt: 9.95, zoom: 4980 }, presets);
  assert.equal(ev3, null);

  // Frame 4: arriving at pulpit (still small motion: 49.9 -> 50.0 is 0.1 deg)
  const ev4 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 50.0, tilt: 10.0, zoom: 5000 }, presets);
  assert.equal(ev4, null);

  // Frame 5: stopped (stationary frame 1)
  const ev5 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 50.0, tilt: 10.0, zoom: 5000 }, presets);
  assert.equal(ev5, null);

  // Frame 6: stopped (stationary frame 2)
  const ev6 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 50.0, tilt: 10.0, zoom: 5000 }, presets);
  assert.equal(ev6, null);

  // Frame 7: stopped (stationary frame 3 -> threshold met!)
  const ev7 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 50.0, tilt: 10.0, zoom: 5000 }, presets);
  assert.ok(ev7);
  assert.equal(ev7.action, "preset:settled");
  assert.equal(ev7.presetId, 1);
  assert.equal(ev7.name, "Pulpit");
  assert.equal(ev7.coordinates?.pan, 50.0);
  assert.equal(tracker.isCameraMoving("cam1"), false);

  // Frame 8: staying still should not duplicate settled event
  const ev8 = tracker.ingestTelemetry("cam1", { camId: 101, pan: 50.0, tilt: 10.0, zoom: 5000 }, presets);
  assert.equal(ev8, null);
});

test("API routes support saving preset with FreeD & thumbnail, retrieving thumbnail and settling", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "picam-routes-test-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const config = loadConfig({
    PICAM_MODE: "simulation",
    PICAM_PORT: "0",
    PICAM_PRESETS_FILE: path.join(tmpDir, "presets.json"),
    PICAM_THUMBNAILS_DIR: path.join(tmpDir, "thumbnails")
  });

  const { app, cameraService, eventBroker } = buildApp(config);
  await app.ready();

  t.after(async () => {
    await cameraService.close();
    await app.close();
  });

  const capturedEvents: any[] = [];
  const unsubscribe = eventBroker.subscribe((e) => {
    if (e.type === "camera") {
      capturedEvents.push(e.data);
    }
  });
  t.after(() => unsubscribe());

  // 1. Save preset 1 with FreeD coordinates and base64 thumbnail
  const sample1x1Png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const saveRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/presets/1/save",
    payload: {
      name: "Lectern",
      coordinates: { pan: 12.34, tilt: -2.5, zoom: 4400 },
      thumbnail: sample1x1Png
    }
  });
  assert.equal(saveRes.statusCode, 200);

  // 2. Fetch preset thumbnail via HTTP
  const thumbRes = await app.inject({
    method: "GET",
    url: "/api/v1/cameras/cam1/presets/1/thumbnail"
  });
  assert.equal(thumbRes.statusCode, 200);
  assert.equal(thumbRes.headers["content-type"], "image/png");
  assert.ok(thumbRes.rawPayload.length > 0);

  // 3. Verify snapshot contains the saved preset details
  const camRes = await app.inject({
    method: "GET",
    url: "/api/v1/cameras/cam1"
  });
  assert.equal(camRes.statusCode, 200);
  const camJson = camRes.json();
  const p1 = camJson.presets.find((p: any) => p.id === 1);
  assert.ok(p1);
  assert.equal(p1.name, "Lectern");
  assert.equal(p1.coordinates?.pan, 12.34);
  assert.ok(p1.thumbnail);

  // 4. Recall preset 1
  const recallRes = await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/presets/1/recall"
  });
  assert.equal(recallRes.statusCode, 200);

  // 5. Ingest moving telemetry
  await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/telemetry",
    payload: { pan: 0, tilt: 0, zoom: 0 }
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/cameras/cam1/telemetry",
    payload: { pan: 6.0, tilt: -1.0, zoom: 2000 }
  });

  // 6. Ingest settling telemetry at Lectern target (12.34, -2.5, 4400)
  for (let i = 0; i < 4; i++) {
    await app.inject({
      method: "POST",
      url: "/api/v1/cameras/cam1/telemetry",
      payload: { pan: 12.34, tilt: -2.5, zoom: 4400 }
    });
  }

  // 7. Verify events emitted on the bus
  const settledEv = capturedEvents.find((e) => e.action === "preset:settled" && e.presetId === 1);
  assert.ok(settledEv, "preset:settled event should be emitted on the event bus");
  assert.equal(settledEv.id, "cam1");
  assert.equal(settledEv.name, "Lectern");
  assert.equal(settledEv.coordinates?.pan, 12.34);
});
