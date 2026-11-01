import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { UdpViscaCameraAdapter } from "../src/camera-adapter.js";

type Mode = "obeys" | "ignores" | "silent";

/** A fake camera: answers power inquiries from its state, and obeys (or ignores) power commands. */
async function fakeCamera(mode: Mode) {
  const state = { power: 2 };
  const seen: number[][] = [];
  const server = dgram.createSocket("udp4");
  server.on("message", (msg, rinfo) => {
    const payload = [...msg.subarray(8)];
    seen.push(payload);
    if (mode === "silent" && payload[1] === 0x01) return;
    const respond = (bytes: number[]) => {
      const header = Buffer.from([0x01, 0x11, 0x00, bytes.length, 0, 0, 0, 0]);
      server.send(Buffer.concat([header, Buffer.from(bytes)]), rinfo.port, rinfo.address);
    };
    if (payload[1] === 0x09 && payload[2] === 0x04 && payload[3] === 0x00) {
      respond([0x90, 0x50, state.power, 0xff]);
    } else if (payload[1] === 0x01 && payload[2] === 0x04 && payload[3] === 0x00) {
      if (mode === "obeys") state.power = payload[4]!;
      respond([0x90, 0x41, 0xff]);
    } else {
      respond([0x90, 0x41, 0xff]);
    }
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
  return { server, seen, port: server.address().port };
}

test("setPower standby is verified with a power inquiry", async () => {
  process.env["PICAM_POWER_SETTLE_MS"] = "3000";
  const cam = await fakeCamera("obeys");
  const adapter = new UdpViscaCameraAdapter({ id: "cam2", label: "Cam 2", host: "127.0.0.1", viscaPort: cam.port, viscaSourcePort: 0 });
  try {
    assert.equal(await adapter.getPowerState(), "on");
    await adapter.setPower(false);
    assert.equal(await adapter.getPowerState(), "standby");
    assert.ok(cam.seen.some((p) => p[4] === 0x03), "standby payload 81 01 04 00 03 FF was sent");
    await adapter.setPower(true);
    assert.equal(await adapter.getPowerState(), "on");
  } finally {
    await adapter.close();
    cam.server.close();
  }
});

test("setPower reports failure when the camera acknowledges but stays on", async () => {
  const cam = await fakeCamera("ignores");
  const adapter = new UdpViscaCameraAdapter({ id: "cam2", label: "Cam 2", host: "127.0.0.1", viscaPort: cam.port, viscaSourcePort: 0 });
  try {
    process.env["PICAM_POWER_SETTLE_MS"] = "1";
    const failing = new UdpViscaCameraAdapter({ id: "cam2", label: "Cam 2", host: "127.0.0.1", viscaPort: cam.port, viscaSourcePort: 0 });
    await assert.rejects(failing.setPower(false), /did not enter standby.*no CGI power command/);
    await failing.close();
  } finally {
    await adapter.close();
    cam.server.close();
  }
});
