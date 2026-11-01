import assert from "node:assert/strict";
import test from "node:test";
import { parseViscaPosition } from "../src/camera-adapter.js";

test("parseViscaPosition decodes signed pan/tilt and zoom", () => {
  const pt = Uint8Array.from([0x90, 0x50, 0x0f, 0x0f, 0x0f, 0x0e, 0x00, 0x00, 0x01, 0x02, 0xff]);
  const zoom = Uint8Array.from([0x90, 0x50, 0x01, 0x02, 0x03, 0x04, 0xff]);
  assert.deepEqual(parseViscaPosition(pt, zoom), { pan: -2, tilt: 0x12, zoom: 0x1234 });
});

test("parseViscaPosition rejects non-reply data", () => {
  assert.equal(parseViscaPosition(Uint8Array.from([0x90, 0x41, 0xff]), Uint8Array.from([0x90, 0x50, 0, 0, 0, 0, 0xff])), null);
});
