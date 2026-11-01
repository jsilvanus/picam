import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { parseRtmpStatus, UdpViscaCameraAdapter } from "../src/camera-adapter.js";

test("parseRtmpStatus maps numeric and word answers", () => {
  assert.equal(parseRtmpStatus("rtmp_status:2;").state, "streaming");
  assert.equal(parseRtmpStatus("rtmp_status:0;").state, "stopped");
  assert.equal(parseRtmpStatus("rtmp_status:7;").state, "unknown");
  assert.equal(parseRtmpStatus("rtmp_status:7;").code, 7);
  assert.equal(parseRtmpStatus('{"rtmp_status":"failed"}').state, "failed");
  const withTarget = parseRtmpStatus("rtmp_status:2;server=rtmp://10.0.0.5:1935;key=cam1;");
  assert.equal(withTarget.server, "rtmp://10.0.0.5:1935");
  assert.equal(withTarget.key, "cam1");
});

/** A fake AVer CGI: status code and optional target; records commands. */
async function fakeCgi(initial: { code: number; target?: string }) {
  const state = { ...initial };
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const cmd = decodeURIComponent(new URL(req.url ?? "", "http://x").search.replace(/^\?cmd=/, ""));
    calls.push(cmd);
    if (cmd.startsWith("get_rtmp_status")) res.end(`rtmp_status:${state.code};${state.target ? `server=${state.target};key=cam1;` : ""}`);
    else if (cmd.startsWith("set_rtmp_stop")) { state.code = 0; res.end("ok"); }
    else if (cmd.startsWith("set_rtmp_start")) { state.code = 2; res.end("ok"); }
    else res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { server, calls, port };
}

function adapter(port: number, server = "rtmp://192.168.1.78:1935") {
  return new UdpViscaCameraAdapter({
    id: "cam1", label: "Cam", host: "127.0.0.1", cgiPort: port, rtmpServer: server, rtmpKey: "cam1", rtspUrl: "rtsp://x/cam1"
  });
}

test("start on a camera that already streams changes nothing and reports a different target", async () => {
  const cgi = await fakeCgi({ code: 2, target: "rtmp://192.168.1.103:1935" });
  const cam = adapter(cgi.port);
  try {
    const res = await cam.startStream();
    assert.equal(res.action, "already-streaming");
    assert.equal(res.targetMatches, false);
    assert.ok(!cgi.calls.some((c) => c.startsWith("set_rtmp")));
  } finally { await cam.close(); cgi.server.close(); }
});

test("start with restart stops and re-applies the configured target", async () => {
  const cgi = await fakeCgi({ code: 2, target: "rtmp://192.168.1.103:1935" });
  const cam = adapter(cgi.port);
  try {
    const res = await cam.startStream({ restart: true });
    assert.equal(res.action, "restarted");
    const stops = cgi.calls.filter((c) => c.startsWith("set_rtmp_stop")).length;
    const starts = cgi.calls.filter((c) => c.startsWith("set_rtmp_start(server=rtmp://192.168.1.78:1935;key=cam1)")).length;
    assert.equal(stops, 1);
    assert.equal(starts, 1);
  } finally { await cam.close(); cgi.server.close(); }
});

test("start on an idle camera just starts it", async () => {
  const cgi = await fakeCgi({ code: 0 });
  const cam = adapter(cgi.port);
  try {
    const res = await cam.startStream();
    assert.equal(res.action, "started");
    assert.ok(cgi.calls.some((c) => c.startsWith("set_rtmp_start")));
    assert.ok(!cgi.calls.some((c) => c.startsWith("set_rtmp_stop")));
  } finally { await cam.close(); cgi.server.close(); }
});
