# picam

PTZ camera controller service and CLI for VISCA-over-IP and HTTP/CGI cameras in the Raspberry Pi production ecosystem.

## Features

- **VISCA-over-IP (UDP)**: Direct binary VISCA packet encoding/decoding for real-time PTZ pan/tilt continuous driving, variable speeds, optical zoom, focus, and power.
- **Hardware Presets**: Save, recall, and reset camera hardware presets (0–254) with persistent FreeD ground-truth coordinates and thumbnail image attachments.
- **FreeD Settling Detection**: Passively evaluates real-time FreeD telemetry against target presets, detecting motion velocity and emitting `preset:in_transit` and `preset:settled` events onto the bus when physical travel halts.
- **CGI Control**: AVer SmartFrame auto-framing and FreeD target configuration.
- **Privacy Mode**: Defocus near-limit blur toggle. The blur is made in the camera lens, so it is in both outputs of the camera. The ATEM switcher uses the camera's SDI picture (the broadcast); the RTMP stream that reaches MediaMTX is a separate output used only for picture analysis and similar. Blurring or masking the MediaMTX stream therefore does not change what is broadcast.
- **Simulation Mode**: Built-in stateful simulation adapter for headless testing without physical cameras.
- **REST & SSE API**: Fastify server delivering JSON responses and real-time Server-Sent Events.
- **CLI & Client**: Typed TypeScript client library and standalone CLI `picam`.

---

## Quick Start

### Installation

```bash
pnpm install
pnpm run build
```

### Running

```bash
# Start in simulation mode
pnpm run dev

# Or in production
PICAM_MODE=production pnpm start
```

### CLI Usage

```bash
# List configured cameras
pnpm exec picam list

# Pan / tilt continuous driving
pnpm exec picam move cam1 up
pnpm exec picam move cam1 stop

# Zoom in / out
pnpm exec picam zoom cam1 in
pnpm exec picam zoom cam1 out 2        # zoom out for 2 seconds, then stop (the last number is seconds; --speed 0-7 sets speed)
pnpm exec picam zoom cam1 stop

# Preset management
pnpm exec picam preset recall cam1 1
pnpm exec picam preset save cam1 2 "Pulpit"

# Focus & privacy
pnpm exec picam focus cam1 auto
pnpm exec picam privacy cam1 on
```

---

## Configuration

Set via environment variables or a `.env` file:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PICAM_PORT` | `3102` | Port for the Fastify HTTP server |
| `PICAM_VISCA_REPLY_TIMEOUT_MS` | `1000` | How long to wait for a VISCA ACK before a command fails with "no VISCA reply" |
| `PICAM_HOST` | `0.0.0.0` | Host interface to bind |
| `PICAM_MODE` | `simulation` | `simulation` or `production` |
| `PICAM_BLUR_CAMERAS` | _(empty)_ | Comma list (e.g. `cam1`). Privacy blur on these cameras is re-applied after every preset recall, so it holds on all presets. Turn it on with `picam privacy cam1 on`; `off` or autofocus ends it |
| `PICAM_BLUR_REAPPLY_MS` | `4000` | Wait after a recall before the blur is re-applied |
| `PICAM_NEAR_LIMIT_M` | `5.0` | Distance limit in metres for focus blur restoration |
| `PICAM_CAM1_HOST` | | IP/Hostname of Camera 1 |
| `PICAM_CAM1_POWER_CGI_ON` / `_OFF` (same for CAM2) | unset | Optional camera CGI command (the part after `/storks?cmd=`) tried when VISCA power gets no reply or has no effect. Find the right command for your model and set it here |
| `PICAM_CGI_TIMEOUT_MS` | `4000` | Timeout of one camera CGI call; reads (GET) are retried once, commands are sent once |
| `PICAM_RTMP_VERIFY_MS` | `8000` | After `stream start`, how long picam waits for the camera to report `rtmp_status` streaming before it reports failure |
| `PICAM_POWER_SETTLE_MS` | `8000` | How long `power` waits for the camera to reach the new state (checked by VISCA power inquiry) before it reports failure (HTTP 502) |
| `PICAM_CAMERA_MONITOR_MS` | `30000` | VISCA power inquiry interval that drives the camera "connected" state (0 = off) |
| `PICAM_MEDIAMTX_API_URL` | `http://127.0.0.1:9997` when the RTSP base is set | MediaMTX control API; at startup picam marks cameras whose path is already live as streaming (and switches FreeD on) |
| `PICAM_FREED_TARGET` | | `host:port` the cameras send FreeD to while a stream runs (e.g. `192.168.1.78:40000`). FreeD is switched on at stream start and off at stream stop and shutdown; unset = never switched automatically |
| `PICAM_ALLOW_SETTINGS_WRITE` | _(off)_ | `1` allows `PUT /cameras/:id/settings/stream` (resolution, fps, bitrate). Reads (`GET .../settings`) are always allowed. Untested on real cameras |
| `PICAM_FREED_UDP_PORT` | _(unset = no receiver)_ | UDP port picam listens on for the cameras' FreeD D1 telemetry (e.g. `40000`, the port `PICAM_FREED_TARGET` points to). Feeds the settling tracker and the camera context. Only one process can own the port: stop pigateway's FreeD receiver first; picam retries binding every 15 s. `GET /api/v1/freed/stats` shows counters |
| `PICAM_FREED_UDP_HOST` / `PICAM_FREED_ALLOWED_HOSTS` | `0.0.0.0` / any | Bind address and accepted camera source IPs (comma list) |
| `PICAM_PIPOE_URL` / `PICAM_PIPOE_API_KEY` | _(unset = no power-cycle)_ | pipoe service for hard power-cycles over PoE (`POST /cameras/:id/power-cycle`) |
| `PICAM_POE_PORTS` | camera id | pipoe port per camera, e.g. `cam1=7,cam2=8`; without it picam asks pipoe for a port named like the camera (`PIPOE_PORT_NAMES`) |
| `PICAM_KEEP_STREAMS` | _(empty)_ | Comma list (e.g. `cam1,cam2`). When such a camera is healthy but reports its RTMP push stopped (after a power-cycle, reboot or power cut), picam starts the push again. Checked when health turns ok and every 4th health round; needs the health monitor |
| `PICAM_RECALL_STILL_MS` | `1500` | A recall to the preset the camera is already at (no motion) counts as landed after the camera is still this long; a recall with no stored coordinates ends as "unknown preset" after twice this. Any recall stops counting as moving after 20 s |
| `PICAM_SHUTDOWN_TIMEOUT_MS` | `10000` | On SIGTERM picam exits after this even if something still hangs |
| `PICAM_CONTEXT_STALE_MS` | `3000` | Camera context is `stale` when no FreeD telemetry arrived within this time |
| `PICAM_CAM1_VISCA_PORT` | `52381` | VISCA UDP port (typically 52381) |
| `PICAM_CAM1_CGI_PORT` | `80` | HTTP/CGI port |
| `PICAM_CAM1_CGI_USER` | | Camera HTTP admin username |
| `PICAM_CAM1_CGI_PASSWORD` | | Camera HTTP admin password |
| `PICAM_CAM2_*` | | Equivalent configuration for Camera 2 |

---

## Ecosystem Integration

- **`pigateway`**: Coordinates AV devices and hosts the **FreeD UDP tracking telemetry listener**, receiving 50/60 Hz D1 tracking packets and proxying camera commands to `picam`.
- **`picontrol`**: Central web UI and global CLI (`picontrol camera ...`).
- **`pimatrix`**: Ingests video feeds (RTSP/RTMP via MediaMTX) for SDI/HDMI routing and composition.

---

## Pi Ecosystem Integration & Status Updates

This project is an integral component of the [Pi Production Ecosystem](file:///d:/piecosystem).

> [!IMPORTANT]
> Any changes to this repository's architectural role, API routes, communication protocols, exposed ports, dependencies, or runtime status **must be documented in the central `piecosystem` coordination repository** (`docs/projects-catalog.md` and `docs/inter-service-matrix.md`).
> Always verify cross-system health with `pnpm run status` in `D:\piecosystem`.

## Stream start and RTMP target changes

`picam stream camX start` first reads the camera's `get_rtmp_status` (the AVer PTZ330 answers numerically, `rtmp_status:2;` = streaming; only 2 and 0 are mapped, other codes are logged as unknown). If the camera already streams, nothing is sent and the answer says `action: "already-streaming"`, plus `targetMatches` (read from `rtmp_server` in `get_net_cfg`, FW V90; `false` when it differs from the configured server, `null` when it cannot be read; the stream key is not readable). To apply a changed target (host or IP change) use `picam stream camX start --restart` (`POST .../stream/start?restart=1`): it stops the push, waits 1.5 s and starts it again, which interrupts the stream, so do it deliberately.

## Camera context (for piperception and other consumers)

`GET /api/v1/cameras/:id/context` and the SSE event `{"type":"context","data":{...}}` (sent only when something below changes) give one view of a camera's motion state:

| Field | Meaning |
| :--- | :--- |
| `presetId` | Preset the camera settled on, else `null` (moving, driven by hand, or unknown) |
| `targetPresetId` | Preset a recall is travelling to, else `null` |
| `moving` / `settled` | `moving` while a recall is pending, pan/tilt/zoom is driven, or FreeD shows motion; `settled` is the opposite |
| `ptz` | Last FreeD position, `null` before any telemetry |
| `privacyBlur`, `focusMode` | The lens is deliberately defocused: the picture, analysis stream included, is unreliable (not "nothing seen") |
| `stale` | No FreeD telemetry within `PICAM_CONTEXT_STALE_MS` (default 3000). Do not trust the state; without FreeD it is always stale |
| `updatedAt` | ISO time of the last change |

## Camera settings

`GET /api/v1/cameras/:id/settings` returns `stream` (`get_av_cfg`: `vres`, `fps`, `bitrate`, `ratectrl`, `vcodec`) and `image` (`get_img_cfg`: `expmode` 0 auto / 1 shutter / 2 iris / 3 manual, `expval`, `shutter`, `iris`, `gain`, `awb`, `colortemp`, `rgain`, `bgain`).

Writes need `PICAM_ALLOW_SETTINGS_WRITE=1` and send only the given values, then return the values read back:
- `PUT .../settings/stream` `{vres?, fps?, bitrate?}`: `vres` one of 640x360, 640x480, 960x540, 1280x720, 1920x1080; `fps` one of 1, 5, 10, 15, 20, 30, 60; `bitrate` 512000-32000000 (`set_vres`, `set_fps`, `set_bitrate`). A running RTMP stream may need `stream start --restart`.
- `PUT .../settings/image` `{expmode?, expval?, shutter?, iris?, gain?, wb?, colortemp?, rgain?, bgain?}` (`set_expmode`, `set_expval`, `set_shutter`, `set_iris`, `set_gain`, `set_wb` 0 auto / 2 indoor / 3 outdoor / 4 one push / 6 manual, `set_colortemp`, `set_img_wb_r_gain`, `set_img_wb_b_gain`).

The CGI calls come from the camera's web UI and have not been run against a real camera. Reboot, factory default, network and login settings are deliberately not exposed. CLI: `picam settings cam1`, `picam settings cam1 set --fps 15`.

## Camera health

In production mode picam probes each camera every `PICAM_HEALTH_INTERVAL_MS` (default 15000, 0 = off), read-only: VISCA power inquiry, an HTTP answer from the web server, and an RTSP `OPTIONS` answer on TCP 554. `GET /api/v1/cameras/:id/health` and the SSE event `health` give `state` (`ok`, `degraded` after one probe fails 3 rounds in a row, `frozen` after two or more probes fail for 30 s; 3 good rounds restore `ok`), the latest probes, which ones fail, and the last 50 transitions. The cameras have no log export on firmware V90, so this external view is the evidence for freezes. picam does not power-cycle cameras yet.

## Power-cycle (hung camera)

`POST /api/v1/cameras/:id/power-cycle` `{ offMs?, force? }` (CLI `picam power-cycle cam1 [--off-ms 8000] [--force]`) asks pipoe to switch the camera's PoE port off and on (`offMs` 1000-60000, default pipoe's). This is the fix for a camera that hangs; VISCA standby does not help then. It also cuts the camera's SDI picture to the switcher, so it is refused (409) while the health monitor reports the camera `ok`, unless `force` is set. Nothing calls it automatically. Events: `power:cycle-start`, `power:cycle-done`, `power:cycle-failed`. With `PICAM_KEEP_STREAMS` the RTMP push into MediaMTX is restarted once the camera is back; without it the push stays down until `stream start` is called.
