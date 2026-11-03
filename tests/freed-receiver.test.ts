import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { decodeFreedPacket, encodeFreedPacket, verifyFreedChecksum, FreedUdpReceiver } from "../src/freed-receiver.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("FreeD packets round-trip with checksum", () => {
  const packet = encodeFreedPacket({ camId: 1, panDeg: 45.5, tiltDeg: -12.25, zoom: 50000, focus: 12000 });
  assert.equal(verifyFreedChecksum(packet), true);
  const d = decodeFreedPacket(packet)!;
  assert.deepEqual([d.camId, d.pan, d.tilt, d.zoom], [1, 45.5, -12.25, 50000]);
  packet[5] ^= 0xff;
  assert.equal(decodeFreedPacket(packet), null, "bad checksum is rejected");
});

test("UDP FreeD feeds the camera context and settles on a preset (simulation)", async () => {
  const { app, cameraService } = buildApp(loadConfig({ PICAM_MODE: "simulation", PICAM_FREED_UDP_PORT: "0", PICAM_FREED_UDP_HOST: "127.0.0.1" } as NodeJS.ProcessEnv));
  await app.ready();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const stats0 = (await app.inject({ method: "GET", url: "/api/v1/freed/stats" })).json();
    assert.equal(stats0.listening, true);
    await cameraService.getPresetStore().savePreset("cam1", 3, "Altar", { pan: 10, tilt: 5, zoom: 1000 });
    const sock = dgram.createSocket("udp4");
    const send = (pan: number) =>
      new Promise<void>((r) => sock.send(encodeFreedPacket({ camId: 1, panDeg: pan, tiltDeg: 5, zoom: 1000 }), stats0.port, "127.0.0.1", () => r()));
    for (const pan of [0, 4, 8, 10, 10, 10, 10, 10]) {
      await send(pan);
      await new Promise((r) => setTimeout(r, 10));
    }
    sock.close();
    await new Promise((r) => setTimeout(r, 50));
    const ctx = (await app.inject({ method: "GET", url: "/api/v1/cameras/cam1/context" })).json();
    assert.equal(ctx.stale, false);
    assert.equal(ctx.presetId, 3);
    assert.equal(ctx.moving, false);
  } finally {
    await app.close();
  }
});
