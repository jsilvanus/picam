import test from "node:test";
import assert from "node:assert/strict";
import { HealthTracker } from "../src/camera-health.js";

const good = { visca: true, http: true, rtsp: true };

test("health: one failing probe degrades after 3 rounds, three good rounds recover", () => {
  let t = 0;
  const h = new HealthTracker("cam1", { now: () => t });
  for (let i = 0; i < 2; i++) assert.equal(h.record({ ...good, rtsp: false }), null);
  assert.equal(h.record({ ...good, rtsp: false })?.state, "degraded");
  h.record(good);
  h.record(good);
  assert.equal(h.record(good)?.state, "ok");
});

test("health: two probes failing for 30 s is frozen, and recovery goes through degraded rounds", () => {
  let t = 0;
  const h = new HealthTracker("cam1", { now: () => t });
  const bad = { visca: false, http: false, rtsp: true };
  h.record(bad);
  t += 15_000;
  h.record(bad);
  t += 15_000;
  const frozen = h.record(bad);
  assert.equal(frozen?.state, "frozen");
  assert.deepEqual(frozen?.failing, ["visca", "http"]);
  t += 15_000;
  assert.equal(h.record(good)?.state, "degraded");
  h.record(good);
  assert.equal(h.record(good)?.state, "ok");
  assert.deepEqual(h.get().transitions.map((x) => x.to), ["frozen", "degraded", "ok"]);
});

test("adapter probe: HTTP and RTSP answers are seen, a silent VISCA port is a failure", async () => {
  const http = await import("node:http");
  const net = await import("node:net");
  const { UdpViscaCameraAdapter } = await import("../src/camera-adapter.js");
  const web = http.createServer((_q, r) => {
    r.statusCode = 401; // a login prompt still proves the web server is alive
    r.end();
  });
  const rtsp = net.createServer((s) => s.on("data", () => s.end("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n")));
  await Promise.all([new Promise<void>((r) => web.listen(0, "127.0.0.1", r)), new Promise<void>((r) => rtsp.listen(0, "127.0.0.1", r))]);
  const cam = new UdpViscaCameraAdapter({
    id: "camx", label: "x", host: "127.0.0.1", viscaPort: 9, monitorIntervalMs: 0,
    cgiPort: (web.address() as { port: number }).port, rtspPort: (rtsp.address() as { port: number }).port
  } as never);
  try {
    assert.deepEqual(await cam.probe(), { visca: false, http: true, rtsp: true });
  } finally {
    await cam.close();
    web.close();
    rtsp.close();
  }
});
