import test from "node:test";
import assert from "node:assert/strict";
import { parseCgiFields, parseImageSettings, parseStreamSettings, validateStreamPatch } from "../src/camera-settings.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("parses both key=value and key:value styles", () => {
  assert.equal(parseCgiFields("a=1;b:2;\nc = x").get("b"), "2");
  assert.deepEqual(parseStreamSettings("vres=1280x720;fps=25;bitrate=4000000;ratectrl=0;vcodec=h264;"), {
    vres: "1280x720", fps: 25, bitrate: 4000000, ratectrl: 0, vcodec: "h264"
  });
  assert.equal(parseImageSettings("expmode:0;awb:1;colortemp:5000;rgain:3;bgain:4;").colortemp, 5000);
});

test("validates stream patches against the camera's limits", () => {
  assert.equal(validateStreamPatch({ fps: 7 }).ok, false);
  assert.equal(validateStreamPatch({ vres: "800x600" }).ok, false);
  assert.equal(validateStreamPatch({ bitrate: 100 }).ok, false);
  assert.equal(validateStreamPatch({ foo: 1 }).ok, false);
  assert.equal(validateStreamPatch({}).ok, false);
  assert.deepEqual(validateStreamPatch({ vres: "1280x720", fps: 30 }), { ok: true, patch: { vres: "1280x720", fps: 30 } });
});

test("settings API: reads work, writes need the flag (simulation)", async () => {
  const { app } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  try {
    delete process.env["PICAM_ALLOW_SETTINGS_WRITE"];
    const read = (await app.inject({ method: "GET", url: "/api/v1/cameras/cam1/settings" })).json();
    assert.equal(read.writeAllowed, false);
    assert.equal(read.stream.fps, 5);
    const denied = await app.inject({ method: "PUT", url: "/api/v1/cameras/cam1/settings/stream", payload: { fps: 15 } });
    assert.equal(denied.statusCode, 403);
    process.env["PICAM_ALLOW_SETTINGS_WRITE"] = "1";
    const bad = await app.inject({ method: "PUT", url: "/api/v1/cameras/cam1/settings/stream", payload: { fps: 7 } });
    assert.equal(bad.statusCode, 422);
    const ok = await app.inject({ method: "PUT", url: "/api/v1/cameras/cam1/settings/stream", payload: { fps: 15 } });
    assert.equal(ok.json().stream.fps, 15);
  } finally {
    delete process.env["PICAM_ALLOW_SETTINGS_WRITE"];
    await app.close();
  }
});

test("real adapter sends set_* only for changed values and reads back (fake camera CGI)", async () => {
  const http = await import("node:http");
  const { UdpViscaCameraAdapter } = await import("../src/camera-adapter.js");
  const seen: string[] = [];
  let fps = 5;
  const server = http.createServer((req, res) => {
    const cmd = new URL(req.url ?? "", "http://x").searchParams.get("cmd") ?? "";
    seen.push(`${req.method} ${cmd.replace(/\(\d+\)/, "()")}`);
    const m = /^set_fps:(\d+)/.exec(cmd);
    if (m) fps = Number(m[1]);
    res.end(cmd.startsWith("get_av_cfg") ? `vres=640x480;fps=${fps};bitrate=1000000;ratectrl=0;vcodec=h264;` : "ok;");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const cam = new UdpViscaCameraAdapter({ id: "camx", label: "x", host: "127.0.0.1", cgiPort: port, viscaPort: 9, monitorIntervalMs: 0 } as never);
  try {
    const after = await cam.setStreamSettings({ fps: 30 });
    assert.equal(after.fps, 30);
    assert.deepEqual(seen, ["POST set_fps:30", "GET get_av_cfg()"]);
  } finally {
    await cam.close();
    server.close();
  }
});

test("image patches are validated and applied (simulation)", async () => {
  const { validateImagePatch } = await import("../src/camera-settings.js");
  assert.equal(validateImagePatch({ expmode: 4 }).ok, false);
  assert.equal(validateImagePatch({ wb: 5 }).ok, false);
  assert.equal(validateImagePatch({ nope: 1 }).ok, false);
  const { app } = buildApp(loadConfig({ PICAM_MODE: "simulation" } as NodeJS.ProcessEnv));
  try {
    process.env["PICAM_ALLOW_SETTINGS_WRITE"] = "1";
    const r = await app.inject({ method: "PUT", url: "/api/v1/cameras/cam2/settings/image", payload: { expmode: 3, shutter: 7, wb: 6 } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual([r.json().image.expmode, r.json().image.shutter, r.json().image.awb], [3, 7, 6]);
  } finally {
    delete process.env["PICAM_ALLOW_SETTINGS_WRITE"];
    await app.close();
  }
});
