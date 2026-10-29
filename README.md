# picam

PTZ camera controller service and CLI for VISCA-over-IP and HTTP/CGI cameras in the Raspberry Pi production ecosystem.

## Features

- **VISCA-over-IP (UDP)**: Direct binary VISCA packet encoding/decoding for real-time PTZ pan/tilt continuous driving, variable speeds, optical zoom, focus, and power.
- **Hardware Presets**: Save, recall, and reset camera hardware presets (0–254) with thumbnail attachments.
- **CGI Control**: AVer SmartFrame auto-framing and FreeD target configuration.
- **Privacy Mode**: Defocus near-limit blur toggle.
- **Simulation Mode**: Built-in stateful simulation adapter for headless testing without physical cameras.
- **REST & SSE API**: Fastify server delivering JSON responses and real-time Server-Sent Events.
- **CLI & Client**: Typed TypeScript client library and standalone CLI `picam`.

---

## Quick Start

### Installation

```bash
npm install
npm run build
```

### Running

```bash
# Start in simulation mode
npm run dev

# Or in production
PICAM_MODE=production npm start
```

### CLI Usage

```bash
# List configured cameras
npx picam list

# Pan / tilt continuous driving
npx picam move cam1 up
npx picam move cam1 stop

# Zoom in / out
npx picam zoom cam1 in
npx picam zoom cam1 stop

# Preset management
npx picam preset recall cam1 1
npx picam preset save cam1 2 "Pulpit"

# Focus & privacy
npx picam focus cam1 auto
npx picam privacy cam1 on
```

---

## Configuration

Set via environment variables or a `.env` file:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PICAM_PORT` | `3300` | Port for the Fastify HTTP server |
| `PICAM_HOST` | `0.0.0.0` | Host interface to bind |
| `PICAM_MODE` | `simulation` | `simulation` or `production` |
| `PICAM_NEAR_LIMIT_M` | `5.0` | Distance limit in metres for focus blur restoration |
| `PICAM_CAM1_HOST` | | IP/Hostname of Camera 1 |
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
