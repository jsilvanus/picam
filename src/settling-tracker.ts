import type { CameraPreset, CameraPresetCoordinates } from "./camera-adapter.js";

export interface FreedTelemetry {
  camId: number;
  pan: number;
  tilt: number;
  roll?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
  z?: number | undefined;
  zoom: number;
  focus?: number | undefined;
  receivedAt?: string | undefined;
}

export interface SettlingEvent {
  cameraId: string;
  action: "preset:settled" | "motion:moving";
  presetId?: number | undefined;
  name?: string | undefined;
  position: { pan: number; tilt: number; zoom: number };
  coordinates?: CameraPresetCoordinates | undefined;
}

export interface SettlingTrackerOptions {
  /** Degrees pan tolerance to consider preset matched (default 0.3°). */
  panToleranceDeg?: number | undefined;
  /** Degrees tilt tolerance to consider preset matched (default 0.3°). */
  tiltToleranceDeg?: number | undefined;
  /** Zoom unit tolerance (default 500). */
  zoomTolerance?: number | undefined;
  /** Consecutive stationary frames needed to declare settled (default 3, ~50ms at 60Hz). */
  minStationaryFrames?: number | undefined;
  /** Delta threshold below which axis is stationary (default 0.05° pan/tilt, 20 zoom). */
  motionThresholdPanDeg?: number | undefined;
  motionThresholdTiltDeg?: number | undefined;
  motionThresholdZoom?: number | undefined;
}

interface InternalTrackerOptions {
  panToleranceDeg: number;
  tiltToleranceDeg: number;
  zoomTolerance: number;
  minStationaryFrames: number;
  motionThresholdPanDeg: number;
  motionThresholdTiltDeg: number;
  motionThresholdZoom: number;
}

interface CameraMotionState {
  activeTargetPresetId: number | null;
  history: Array<{ pan: number; tilt: number; zoom: number; time: number }>;
  isMoving: boolean;
  stationaryCount: number;
  lastSettledPresetId: number | null;
}

export class CameraSettlingTracker {
  private readonly states = new Map<string, CameraMotionState>();
  private readonly options: InternalTrackerOptions;

  constructor(options: SettlingTrackerOptions = {}) {
    this.options = {
      panToleranceDeg: options.panToleranceDeg ?? 0.3,
      tiltToleranceDeg: options.tiltToleranceDeg ?? 0.3,
      zoomTolerance: options.zoomTolerance ?? 500,
      minStationaryFrames: options.minStationaryFrames ?? 3,
      motionThresholdPanDeg: options.motionThresholdPanDeg ?? 0.05,
      motionThresholdTiltDeg: options.motionThresholdTiltDeg ?? 0.05,
      motionThresholdZoom: options.motionThresholdZoom ?? 20
    };
  }

  setTargetPreset(cameraId: string, presetId: number): void {
    const state = this.getOrCreateState(cameraId);
    state.activeTargetPresetId = presetId;
    state.lastSettledPresetId = null;
    state.stationaryCount = 0;
  }

  getTargetPreset(cameraId: string): number | null {
    return this.states.get(cameraId)?.activeTargetPresetId ?? null;
  }

  isCameraMoving(cameraId: string): boolean {
    return this.states.get(cameraId)?.isMoving ?? false;
  }

  ingestTelemetry(
    cameraId: string,
    telemetry: FreedTelemetry,
    presets: CameraPreset[]
  ): SettlingEvent | null {
    const state = this.getOrCreateState(cameraId);
    const now = Date.now();
    const current = { pan: telemetry.pan, tilt: telemetry.tilt, zoom: telemetry.zoom, time: now };

    state.history.push(current);
    if (state.history.length > 10) {
      state.history.shift();
    }

    if (state.history.length < 2) {
      return null;
    }

    const prev = state.history[state.history.length - 2]!;
    const dPan = Math.abs(current.pan - prev.pan);
    const dTilt = Math.abs(current.tilt - prev.tilt);
    const dZoom = Math.abs(current.zoom - prev.zoom);

    const isFrameMoving =
      dPan > this.options.motionThresholdPanDeg ||
      dTilt > this.options.motionThresholdTiltDeg ||
      dZoom > this.options.motionThresholdZoom;

    if (isFrameMoving) {
      state.stationaryCount = 0;
      if (!state.isMoving) {
        state.isMoving = true;
        state.lastSettledPresetId = null;
        return {
          cameraId,
          action: "motion:moving",
          position: { pan: current.pan, tilt: current.tilt, zoom: current.zoom }
        };
      }
      return null;
    }

    // Frame is stationary
    state.stationaryCount++;

    if (state.stationaryCount >= this.options.minStationaryFrames && state.isMoving) {
      // Transition from moving -> settled
      state.isMoving = false;

      // Check which preset it matches
      let matchedPreset: CameraPreset | undefined;

      // 1. Check actively targeted preset first
      if (state.activeTargetPresetId !== null) {
        const candidate = presets.find((p) => p.id === state.activeTargetPresetId);
        if (candidate?.coordinates && this.matchesCoordinates(current, candidate.coordinates)) {
          matchedPreset = candidate;
        }
      }

      // 2. If no target set or target coordinates didn't match, search all presets with coordinates
      if (!matchedPreset) {
        matchedPreset = presets.find(
          (p) => p.coordinates && this.matchesCoordinates(current, p.coordinates)
        );
      }

      state.activeTargetPresetId = null;

      if (matchedPreset && matchedPreset.id !== state.lastSettledPresetId) {
        state.lastSettledPresetId = matchedPreset.id;
        return {
          cameraId,
          action: "preset:settled",
          presetId: matchedPreset.id,
          name: matchedPreset.name,
          position: { pan: current.pan, tilt: current.tilt, zoom: current.zoom },
          coordinates: matchedPreset.coordinates
        };
      }
    }

    return null;
  }

  matchesCoordinates(
    current: { pan: number; tilt: number; zoom: number },
    target: { pan: number; tilt: number; zoom: number }
  ): boolean {
    return (
      Math.abs(current.pan - target.pan) <= this.options.panToleranceDeg &&
      Math.abs(current.tilt - target.tilt) <= this.options.tiltToleranceDeg &&
      Math.abs(current.zoom - target.zoom) <= this.options.zoomTolerance
    );
  }

  private getOrCreateState(cameraId: string): CameraMotionState {
    let state = this.states.get(cameraId);
    if (!state) {
      state = {
        activeTargetPresetId: null,
        history: [],
        isMoving: false,
        stationaryCount: 0,
        lastSettledPresetId: null
      };
      this.states.set(cameraId, state);
    }
    return state;
  }
}
