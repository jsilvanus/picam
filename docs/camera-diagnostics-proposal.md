# Proposal: diagnostic logs, freeze watchdog and power-cycle for AVer cameras

Status: proposal (research only, no code). Nothing here has been verified against the church cameras: no camera was touched, and no Pi access was used. Items marked **[verify]** need a read-only check on site.

## Problem

cam1 (192.168.1.41) and cam2 (192.168.1.42) freeze often and have to be power-cycled by hand. We have no log from the moment of failure, so we cannot tell whether the cause is firmware, network (VISCA/RTSP/RTMP load), power (PoE/adapter) or heat.

## Update: no camera-side logs on these cameras

Confirmed by Juha on the web UI of the PTZ330 (firmware V90): there is no Export Log and no syslog or remote log setting. So the camera cannot tell us why it froze, and section 1.2/1.3 below (log listener, CGI log pull) do not apply unless a future firmware adds them. The proposal therefore relies on **observing the camera from outside**: the watchdog (section 2) and the evidence below, plus a power-cycle path (section 3). Section 1 is kept for reference only.

External evidence picam (or pigateway) can record per camera, all read-only:

- Probe history from the watchdog: which of VISCA, HTTP, RTSP failed first, for how long, and what recovered it. This shows whether a freeze is a full hang or a partial one (for example video stalled while VISCA still answers).
- Stream health: bytes/frames per second of each camera's RTSP path in MediaMTX, and a periodic ffprobe or single-frame grab compared with the previous frame, to detect a frozen picture while the camera still responds.
- Last commands before the freeze: picam already sees every VISCA/CGI call (preset recalls, FreeD toggles, RTSP/RTMP starts). Keep a ring buffer of the last 50 and write it out on a freeze, so patterns (for example a freeze after a preset recall during FreeD) show up.
- Network: ping latency and loss, and the switch port counters and link state if the switch is managed (SNMP).
- Power and heat: a smart plug with energy metering (for example Shelly Plug) on each 12 V adapter records watts. A hang often shows as a power change, and an undervoltage or failing adapter would show too. This doubles as the power-cycle device.
- Load: the number of simultaneous RTSP/RTMP/web clients per camera at freeze time (MediaMTX readers, open web sessions).
- Camera on-screen/OSD or web System page (uptime, temperature if shown), read by hand after a recovery, and the reboot reason if shown.

If, after a few freezes, the evidence points at the camera itself, send the timeline to AVer support with the serial number and firmware V90.

## What AVer exposes (from public documents)

Both cameras are **AVer PTZ330** (confirmed by Juha; background in keskuskirkko `docs/hardware/aver-ptz330.md`). That is the original PTZ330 (2019 datasheet, PoE+ capable, 12 V/5 A adapter), not necessarily the V2 hardware (PTZ330UV2) that the release note below was written for. Installed firmware, as reported by Juha: **s000000.90**, i.e. series version **V90**, which is the newest PTZ310/330 release note I could find (2023-12-27, ONVIF change only; no freeze fix listed). So a firmware update is probably not available and not the fix; **[verify]** on AVer's download page that nothing newer than V90 exists. The PTZ310/330 series firmware notes (V75 to V90) apply to the original model; the V0.0.0000.x notes apply to the V2 models, so whether the log export exists on V90 has to be checked in the web UI.

AVer's firmware release note for PTZ211/PTZ231/PTZ310UV2/PTZ310UNV2/PTZ330UV2/PTZ330UNV2 and TR models (V0.0.0000.22 to .28, Sep to Dec 2023) documents:

- **System > Export Log** on the web page (V0.0.0000.22): download a log file by hand.
- **Continuous log export to a chosen IP and port** on the same page (V0.0.0000.22). The release note does not say whether the transport is UDP syslog, TCP or something else, or the line format. **[verify]**
- NTP setting (System > Network > NTP) and Set Date/Time on the web page, so log timestamps can be made trustworthy.
- VISCA Port Mode and FreeD settings on the Network page.
- V0.0.0000.28 fixes: "RTSP could not be activated when camera was power off", several VISCA inquiry corrections (CAM_Live Freeze among them, which is a picture-freeze command, not a hang fix).
- Newer PTZ series notes (V75, V83, V88, V90) add web reboot (V75), no-reboot RTSP and RTMP changes (V83, V88), SSHD/HTTPS toggles (V83). None of the notes I could read mention a freeze/hang fix, syslog or SNMP.

The camera's CGI is the `/storks/?cmd=...` pattern (for example `GET /storks/?cmd=get_net_cfg(<ms>)`, `POST /storks/?cmd=set_freed_enable:1`; trailing slash needed, else 301), already used by pimatrix/picam for FreeD. A log download will probably be a `cmd=` of the same kind, but that is a guess.

Not found in public sources: a documented CGI endpoint for log download, SNMP support, or a known-freeze errata. Absence in release notes is not proof that they do not exist. **[verify]** by reading the web UI network traffic (browser dev tools while pressing Export Log) to find the real request URL, and by checking whether the Network page has SNMP or syslog fields.

Freeze leads to check (hypotheses, not findings): old firmware (compare the installed version with AVer's current PTZ310/330 release, V90 at the time of the notes found); RTSP/RTMP session churn; many simultaneous clients; VISCA UDP flooding (picam polls power every 5 s, `PICAM_CAMERA_MONITOR_MS`); PoE or adapter undervoltage.

## Proposal

### 1. Log collection (not available on V90, kept for reference)

1. Manual: in each camera's web UI, use System > Export Log after the next freeze (or before power-cycling if the web UI still answers). Keep the file with a timestamp.
2. Continuous: point each camera's log export (IP and port) at the Pi, and add a small listener to picam (UDP/TCP, configurable ports, e.g. `PICAM_LOG_LISTEN_PORT_CAM1`), writing lines to `data/camera-logs/<camId>/YYYY-MM-DD.log` with size-based rotation and 14-day retention. Store the raw bytes first and parse later, since the format is unknown. Needs one change per camera in the camera settings by the operator; picam must not change camera settings itself.
3. Periodic pull (fallback if no continuous export works): if step 1 reveals a CGI URL for Export Log, picam fetches it with the existing basic-auth CGI client every N minutes (default 60) and on every detected freeze, and stores it as above. Read-only, so it is safe.
4. Also record every health transition (below) as a structured JSON line in the same directory, so the camera log and picam's view line up in time.

### 2. Health watchdog

picam already has a VISCA power inquiry monitor driving "connected" state. Extend it to a three-probe liveness model per camera:

| Probe | How | Frequency | Meaning of failure |
|---|---|---|---|
| VISCA | existing power inquiry, UDP 52381 | 5 s | control plane dead |
| HTTP | `GET /` (or a cheap CGI) with 2 s timeout | 15 s | web server dead |
| RTSP | RTSP `OPTIONS`, or `DESCRIBE`, TCP 554 | 15 s | stream server dead |

State machine: `ok` -> `degraded` (one probe failing for 3 consecutive tries) -> `frozen` (two or more probes failing for 30 s, or all three). Hysteresis on recovery (3 good rounds). A freeze where VISCA works but video is stalled needs a fourth probe: check the MediaMTX path for bytes received (via pimatrix/MediaMTX API) **[verify]** that this is exposed.

On `degraded` or `frozen`, picam: emits a `camera:health` event on the existing SSE bus (so picontrol and pigateway can show it), snapshots a log (step 1.3 if available), and writes the transition record. Expose `GET /api/v1/cameras/:id/health` and `picam health [cam]`, plus `GET /api/v1/cameras/:id/logs` (list/download stored logs).

### 3. Remote power-cycle

Ordered from least to most invasive. picam only detects and requests; actuation stays out of picam so it stays generic.

1. **Soft reboot** through the web UI reboot (exists since firmware V75), if its HTTP request can be identified **[verify]**. Often useless in a real hang.
2. **Switch PoE port cycle.** The 2020 installer diagram shows no PoE switch and most likely 12 V adapters, so this needs a change: the PTZ330 accepts PoE+ (802.3at, class 4), and the cameras are already on the LAN (.41/.42), so moving them to a managed PoE+ switch is the cleanest fix (no extra hardware at the camera, works in a full hang). **[verify]** how they are powered today and the cable run to the switch. Via SNMP (PoE MIB `pethPsePortAdminEnable`), or the switch's HTTP/SSH API. Best option: no extra hardware, works when the camera is fully hung.
3. **Smart plug / network relay** (Shelly, Tasmota) on the 12 V adapter's mains side, which is the zero-change option if PoE is not an option. HTTP call to the plug.
4. Scheduled nightly reboot: AVer's PTZ Management software supports scheduled reboot (a Windows app, not firmware, for the PTZ310/330). A Pi timer calling option 2 or 3 would do the same.

Note: IR (the AMX path) has no power-cycle function beyond the remote's standby, so it does not help with hangs either.

pimatrix and picam have a camera power endpoint (`POST /api/v1/cameras/{id}/power`, pimatrix #37, plus a VISCA power inquiry with CGI fallback in picam #9); that is VISCA standby/on, which will not help in a hang before reusing it. Proposed interface: a `PowerCycler` adapter in picam config (`PICAM_CAM1_POWER_CYCLE_URL` or a driver id) with `cycle(camId)`.

Auto power-cycle must be off by default and guarded: only when `frozen` for at least 60 s, never while pigateway reports the camera as the program source or while the stream is live (ask pigateway/ATEM), max 2 cycles per hour, and every cycle logged with the log snapshot taken first. Manual `picam power-cycle cam1` always allowed.

### 4. Suggested order

1. Smart plugs with energy metering on both cameras (also gives the power-cycle path). Or move to a PoE+ switch.
2. Health watchdog, event ring buffer and stream-health evidence (section 2 and the update above), stored under `data/camera-logs/`.
3. Health API and CLI (`picam health`).
4. Power-cycle adapter, manual first, then guarded auto.
5. Firmware is already V90, the latest found. If AVer support has a newer or beta build, install it only after logs are being collected, so there is a before/after comparison. Otherwise send the first captured logs to AVer support with the freeze times.

### Open questions for the operator

- (Answered: firmware V90, no Export Log or syslog in the web UI.)
- How are the cameras powered today (12 V adapters per the 2020 diagram), and is a PoE+ switch available or acceptable?
- Do freezes happen during streaming, idle, or after specific commands (preset recall, FreeD on)?
- Does the web UI still respond when frozen?

## Sources

- AVer release note for PTZ211/PTZ231/PTZ310UV2/PTZ310UNV2/PTZ330UV2/PTZ330UNV2/TR211/TR315/TR315N/TR335/TR335N, V0.0.0000.28, 2023-12-20 (averusa.com, pro-av firmware downloads).
- AVer PTZ series V90, V88, V83, V75 release notes (averusa.com, pro-av firmware downloads).
