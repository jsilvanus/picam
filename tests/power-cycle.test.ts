import test from "node:test";
import assert from "node:assert/strict";
import { PipoePowerCycler, PowerCycleError, parsePoePorts } from "../src/power-cycler.js";
import { CameraService } from "../src/camera-service.js";
import { PresetStore } from "../src/preset-store.js";

function fakePipoe(status = 200, body: unknown = { port: 7, poe: true }) {
  const calls: Array<{ url: string; auth: string | null; body: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

test("parsePoePorts maps camera ids to pipoe ports", () => {
  assert.deepEqual(parsePoePorts("cam1=7, cam2=port8,bad"), { cam1: "7", cam2: "port8" });
});

test("cycler posts to pipoe with the mapped port, offMs and bearer token", async () => {
  const { calls, fetchFn } = fakePipoe();
  const c = new PipoePowerCycler({ baseUrl: "http://pipoe:3108/", apiKey: "k", ports: { cam1: "7" }, fetchFn });
  await c.cycle("cam1", 8000);
  await c.cycle("cam2");
  assert.equal(calls[0]!.url, "http://pipoe:3108/api/v1/poe/ports/7/cycle");
  assert.equal(calls[0]!.auth, "Bearer k");
  assert.deepEqual(JSON.parse(calls[0]!.body), { offMs: 8000 });
  assert.equal(calls[1]!.url, "http://pipoe:3108/api/v1/poe/ports/cam2/cycle", "default port is the camera id");
});

test("cycler reports pipoe's refusal", async () => {
  const { fetchFn } = fakePipoe(409, { error: "port busy" });
  const c = new PipoePowerCycler({ baseUrl: "http://pipoe", fetchFn });
  await assert.rejects(c.cycle("cam1"), (e: unknown) => e instanceof PowerCycleError && e.status === 409 && /port busy/.test(e.message));
});

function service(powerCycler?: PipoePowerCycler, keepStreams: string[] = []) {
  return new CameraService({ mode: "simulation", powerCycler, keepStreams, presetStore: new PresetStore({}) });
}

test("power-cycle: unconfigured is 503, a healthy camera needs force", async () => {
  await assert.rejects(service().powerCycle("cam1"), (e: unknown) => e instanceof PowerCycleError && e.status === 503);
  const { calls, fetchFn } = fakePipoe();
  const svc = service(new PipoePowerCycler({ baseUrl: "http://pipoe", fetchFn }));
  // Health unknown (monitor off): allowed. Mark it healthy and it is refused without force.
  await svc.powerCycle("cam1");
  assert.equal(calls.length, 1);
  svc.startHealthMonitor(60_000);
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 3; i++) (svc as unknown as { health: Map<string, { record(p: object): void }> }).health.get("cam1")!.record({ visca: true, http: true, rtsp: true });
  await assert.rejects(svc.powerCycle("cam1"), (e: unknown) => e instanceof PowerCycleError && e.status === 409);
  await svc.powerCycle("cam1", { force: true });
  assert.equal(calls.length, 2);
  await svc.close();
});

test("keepStream restarts a stopped push only for listed cameras", async () => {
  const svc = service(undefined, ["cam1"]);
  assert.equal(await svc.keepStream("cam2"), false, "not listed");
  assert.equal(await svc.keepStream("cam1"), true, "stopped push is restarted");
  assert.equal(svc.get("cam1")!.streaming, true);
  assert.equal(await svc.keepStream("cam1"), false, "already streaming: nothing sent");
  await svc.close();
});
