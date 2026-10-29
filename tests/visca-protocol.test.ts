import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPanTiltDrive,
  buildZoom,
  buildPresetRecall,
  buildPresetSave,
  buildPower,
  createViscaPacket,
  parseViscaResponse
} from "../src/visca-protocol.js";

test("buildPanTiltDrive produces valid VISCA bytes", () => {
  const up = buildPanTiltDrive("up", 10, 10);
  assert.deepEqual(up, [0x81, 0x01, 0x06, 0x01, 0x0a, 0x0a, 0x03, 0x01, 0xff]);

  const stop = buildPanTiltDrive("stop");
  assert.deepEqual(stop, [0x81, 0x01, 0x06, 0x01, 0x0a, 0x0a, 0x03, 0x03, 0xff]);

  const home = buildPanTiltDrive("home");
  assert.deepEqual(home, [0x81, 0x01, 0x06, 0x04, 0xff]);
});

test("buildZoom produces valid VISCA bytes", () => {
  const zoomIn = buildZoom("in", 4);
  assert.deepEqual(zoomIn, [0x81, 0x01, 0x04, 0x07, 0x24, 0xff]);

  const stop = buildZoom("stop");
  assert.deepEqual(stop, [0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
});

test("buildPresetRecall and buildPresetSave produce valid bytes", () => {
  const recall1 = buildPresetRecall(1);
  assert.deepEqual(recall1, [0x81, 0x01, 0x04, 0x3f, 0x02, 0x01, 0xff]);

  const save5 = buildPresetSave(5);
  assert.deepEqual(save5, [0x81, 0x01, 0x04, 0x3f, 0x01, 0x05, 0xff]);
});

test("createViscaPacket and parseViscaResponse work symmetrically", () => {
  const payload = [0x90, 0x41, 0xff];
  const packet = createViscaPacket(payload, 42, 0x0111);
  assert.equal(packet.length, 8 + 3);

  const parsed = parseViscaResponse(packet);
  assert.ok(parsed);
  assert.equal(parsed.sequenceNumber, 42);
  assert.equal(parsed.type, 0x0111);
  assert.equal(parsed.isAck, true);
  assert.equal(parsed.isCompletion, false);
});
