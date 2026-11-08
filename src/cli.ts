#!/usr/bin/env node
import { PiCamClient } from "./client.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";

const DEFAULT_URL = process.env["PICAM_URL"] ?? "http://127.0.0.1:3102";

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
  zoom <camId> <in|out|stop> [seconds] [--speed 0-7]
                                Drive optical zoom; with seconds, stops by itself after that long
  preset recall <camId> <id>    Recall preset (0-254)
  preset save <camId> <id> [name]
                                Save current position to preset
  preset reset <camId> <id>     Reset/clear preset
  smartframe <camId> <enable|disable|trigger>
                                Configure AVer SmartFrame auto-framing
  power <camId> [on|off]        Show power state, or wake/standby the camera (verified by inquiry)
  power-cycle <camId> [--off-ms N] [--force]
                                Cut and restore PoE power through pipoe (for a hung camera; cuts the picture).
                                Refused while health is ok unless --force
  focus <camId> <auto|manual>   Set focus mode
  privacy <camId> <on|off>      Toggle privacy blur
  context <camId>               Show preset, settled/moving, position, privacy blur and stale flag
  settings <camId>              Show stream settings, exposure and white balance
  settings <camId> set [--vres 1280x720] [--fps N] [--bitrate bps]
                                Change stream settings (server needs PICAM_ALLOW_SETTINGS_WRITE=1)
  freed <camId>                 Get FreeD tracking output configuration
  stream <camId> <start|stop>   Start/stop RTMP streaming (start --restart re-applies the target of a camera that already streams; interrupts the stream)

GLOBAL OPTIONS:
  --url <url>                   picam server URL (default: http://127.0.0.1:3102 or PICAM_URL)
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
  let restart = false;
  let speedOption: string | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--url") {
      url = args[++i] ?? DEFAULT_URL;
    } else if (a === "--speed") {
      speedOption = args[++i];
    } else if (a === "--json") {
      json = true;
    } else if (a === "--restart") {
      restart = true;
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
        const [camId, action, secondsArg] = subArgs;
        if (!camId || !action) throw new Error("Usage: picam zoom <camId> <in|out|stop> [seconds] [--speed 0-7]");
        const zSpeed = speedOption ? Number.parseInt(speedOption, 10) : undefined;
        const seconds = secondsArg === undefined ? undefined : Number(secondsArg);
        if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30)) {
          throw new Error("zoom seconds must be a number between 0 and 30");
        }
        if (seconds !== undefined && action === "stop") throw new Error("zoom stop takes no seconds");
        const res = await client.zoomCamera(camId, action as ZoomAction, zSpeed);
        if (seconds !== undefined) {
          try {
            await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          } finally {
            await client.zoomCamera(camId, "stop");
          }
        }
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} zoom: ${action}${seconds !== undefined ? ` for ${seconds}s, then stop` : ""}`);
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

      case "power-cycle": {
        const [camId] = subArgs;
        if (!camId) throw new Error("Usage: picam power-cycle <camId> [--off-ms N] [--force]");
        const i = args.indexOf("--off-ms");
        const offMs = i >= 0 ? Number(args[i + 1]) : undefined;
        const res = await client.powerCycle(camId, { ...(offMs !== undefined ? { offMs } : {}), force: args.includes("--force") });
        console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId}: PoE port ${res.port} power-cycled (health was ${res.health})`);
        break;
      }

      case "power": {
        const [camId, state] = subArgs;
        if (!camId) throw new Error("Usage: picam power <camId> [on|off]");
        if (!state) {
          const res = await client.getPower(camId);
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId} power: ${res.power}`);
          break;
        }
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

      case "context": {
        const [camId] = subArgs;
        if (!camId) throw new Error("Usage: picam context <camId>");
        console.log(JSON.stringify(await client.getContext(camId), null, 2));
        break;
      }

      case "settings": {
        const [camId, action] = subArgs;
        if (!camId) throw new Error("Usage: picam settings <camId> [set --vres W x H --fps N --bitrate bps]");
        if (action === "set") {
          const flag = (name: string) => {
            const i = args.indexOf(`--${name}`);
            return i >= 0 ? args[i + 1] : undefined;
          };
          const patch: Record<string, string | number> = {};
          const vres = flag("vres");
          const fps = flag("fps");
          const bitrate = flag("bitrate");
          if (vres) patch["vres"] = vres;
          if (fps) patch["fps"] = Number(fps);
          if (bitrate) patch["bitrate"] = Number(bitrate);
          console.log(JSON.stringify(await client.setStreamSettings(camId, patch), null, 2));
        } else {
          console.log(JSON.stringify(await client.getSettings(camId), null, 2));
        }
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
          const res = await client.startStream(camId, { restart });
          console.log(json ? JSON.stringify(res, null, 2) : `Camera ${camId}: ${res.message} (${res.streamUrl ?? "unknown URL"}); target matches configured: ${res.targetMatches === null ? "unknown" : res.targetMatches ? "yes" : "NO"}`);
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
