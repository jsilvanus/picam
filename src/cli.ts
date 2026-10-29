#!/usr/bin/env node
import { PiCamClient } from "./client.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";

const DEFAULT_URL = process.env["PICAM_URL"] ?? "http://127.0.0.1:3300";

function printUsage(): void {
  console.log(`
picam - PTZ Camera Controller CLI

USAGE:
  picam [--url <url>] <command> [args...]

COMMANDS:
  list                          List all configured cameras
  get <camId>                   Get status and position for a camera
  move <camId> <direction> [panSpeed] [tiltSpeed]
                                Pan/tilt camera (up, down, left, right, diagonals, stop, home, reset)
  zoom <camId> <in|out|stop> [speed]
                                Drive optical zoom
  preset recall <camId> <id>    Recall preset (0-254)
  preset save <camId> <id> [name]
                                Save current position to preset
  preset reset <camId> <id>     Reset/clear preset
  smartframe <camId> <enable|disable|trigger>
                                Configure AVer SmartFrame auto-framing
  power <camId> <on|off>        Wake or standby camera
  focus <camId> <auto|manual>   Set focus mode
  privacy <camId> <on|off>      Toggle privacy blur
  freed <camId>                 Get FreeD tracking output configuration
  stream <camId> <start|stop>   Start/stop RTMP streaming

GLOBAL OPTIONS:
  --url <url>                   picam server URL (default: http://127.0.0.1:3300 or PICAM_URL)
  --json                        Format output as raw JSON
`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let url = DEFAULT_URL;
  let json = false;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--url") {
      url = args[++i] ?? DEFAULT_URL;
    } else if (a === "--json") {
      json = true;
    } else {
      filteredArgs.push(a);
    }
  }

  const client = new PiCamClient(url);
  const command = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);

  try {
    switch (command) {
      case "list": {
        const res = await client.listCameras();
        if (json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Configured Cameras (${res.items.length}):`);
          for (const c of res.items) {
            console.log(`  - [${c.id}] "${c.label}" (${c.connection}) - Pos: pan=${c.position.pan}, tilt=${c.position.tilt}, zoom=${c.position.zoom} - Presets: ${c.presets.length}`);
          }
        }
        break;
      }

      case "get": {
        const [camId] = subArgs;
        if (!camId) throw new Error("Usage: picam get <camId>");
        const res = await client.getCamera(camId);
        console.log(json ? JSON.stringify(res, null, 2) : res);
        break;
      }

      case "move": {
        const [camId, dir, panSpeed, tiltSpeed] = subArgs;
        if (!camId || !dir) throw new Error("Usage: picam move <camId> <direction> [panSpeed] [tiltSpeed]");
        const pSpeed = panSpeed ? Number.parseInt(panSpeed, 10) : undefined;
        const tSpeed = tiltSpeed ? Number.parseInt(tiltSpeed, 10) : undefined;
        const res = await client.moveCamera(camId, dir as PanTiltDirection, pSpeed, tSpeed);
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} moved: ${dir}`);
        break;
      }

      case "zoom": {
        const [camId, action, speed] = subArgs;
        if (!camId || !action) throw new Error("Usage: picam zoom <camId> <in|out|stop> [speed]");
        const zSpeed = speed ? Number.parseInt(speed, 10) : undefined;
        const res = await client.zoomCamera(camId, action as ZoomAction, zSpeed);
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} zoom: ${action}`);
        break;
      }

      case "preset": {
        const [sub, camId, idStr, name] = subArgs;
        if (!sub || !camId || !idStr) throw new Error("Usage: picam preset <recall|save|reset> <camId> <presetId> [name]");
        const presetId = Number.parseInt(idStr, 10);
        if (Number.isNaN(presetId)) throw new Error("presetId must be an integer (0-254)");

        if (sub === "recall") {
          const res = await client.recallPreset(camId, presetId);
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} recalled preset ${presetId}`);
        } else if (sub === "save") {
          const res = await client.savePreset(camId, presetId, name);
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} saved preset ${presetId}${name ? ` ("${name}")` : ""}`);
        } else if (sub === "reset") {
          const res = await client.resetPreset(camId, presetId);
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} reset preset ${presetId}`);
        } else {
          throw new Error(`Unknown preset subcommand: ${sub}`);
        }
        break;
      }

      case "smartframe": {
        const [camId, mode] = subArgs;
        if (!camId || !mode) throw new Error("Usage: picam smartframe <camId> <enable|disable|trigger>");
        const res = await client.setSmartFrame(camId, mode as SmartFrameMode);
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} smartframe: ${mode}`);
        break;
      }

      case "power": {
        const [camId, state] = subArgs;
        if (!camId || !state) throw new Error("Usage: picam power <camId> <on|off>");
        const on = state === "on" || state === "true";
        const res = await client.setPower(camId, on);
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} power: ${on ? "on" : "standby"}`);
        break;
      }

      case "focus": {
        const [camId, mode] = subArgs;
        if (!camId || (mode !== "auto" && mode !== "manual")) throw new Error("Usage: picam focus <camId> <auto|manual>");
        const res = await client.setFocusMode(camId, mode);
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} focus: ${mode}`);
        break;
      }

      case "privacy": {
        const [camId, state] = subArgs;
        if (!camId || !state) throw new Error("Usage: picam privacy <camId> <on|off>");
        const enabled = state === "on" || state === "true";
        const res = await client.setPrivacyBlur(camId, enabled);
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} privacy blur: ${enabled ? "enabled" : "disabled"}`);
        break;
      }

      case "freed": {
        const [camId] = subArgs;
        if (!camId) throw new Error("Usage: picam freed <camId>");
        const res = await client.getFreed(camId);
        console.log(json ? JSON.stringify(res, null, 2) : res);
        break;
      }

      case "stream": {
        const [camId, action] = subArgs;
        if (!camId || !action) throw new Error("Usage: picam stream <camId> <start|stop>");
        if (action === "start") {
          const res = await client.startStream(camId);
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} streaming started: ${res.streamUrl ?? "unknown URL"}`);
        } else if (action === "stop") {
          const res = await client.stopStream(camId);
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} streaming stopped`);
        } else {
          throw new Error("action must be 'start' or 'stop'");
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void run();
