#!/usr/bin/env node
import dgram from "node:dgram";

const PORT = Number.parseInt(process.env["SIM_VISCA_PORT"] ?? "52381", 10);
const HOST = process.env["SIM_VISCA_HOST"] ?? "127.0.0.1";

const server = dgram.createSocket("udp4");

server.on("error", (err) => {
  console.error("Simulator UDP error:", err);
  server.close();
});

server.on("message", (msg, rinfo) => {
  if (msg.length < 8) return;
  const type = msg.readUInt16BE(0);
  const length = msg.readUInt16BE(2);
  const seq = msg.readUInt32BE(4);
  const payload = msg.subarray(8, 8 + length);

  console.log(`[VISCA Sim] Received packet from ${rinfo.address}:${rinfo.port}: type=0x${type.toString(16)} seq=${seq} payload=${payload.toString("hex")}`);

  // Send ACK: 0x0111 0x0003 <seq> 0x90 0x41 0xff
  const ack = Buffer.alloc(11);
  ack.writeUInt16BE(0x0111, 0);
  ack.writeUInt16BE(3, 2);
  ack.writeUInt32BE(seq, 4);
  ack[8] = 0x90;
  ack[9] = 0x41;
  ack[10] = 0xff;
  server.send(ack, rinfo.port, rinfo.address);

  // Send Completion: 0x0111 0x0003 <seq> 0x90 0x51 0xff
  setTimeout(() => {
    const comp = Buffer.alloc(11);
    comp.writeUInt16BE(0x0111, 0);
    comp.writeUInt16BE(3, 2);
    comp.writeUInt32BE(seq, 4);
    comp[8] = 0x90;
    comp[9] = 0x51;
    comp[10] = 0xff;
    server.send(comp, rinfo.port, rinfo.address);
  }, 10);
});

server.bind(PORT, HOST, () => {
  console.log(`[VISCA Sim] Listening for VISCA UDP on ${HOST}:${PORT}`);
});
