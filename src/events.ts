import { EventEmitter } from "node:events";

export interface CameraEventPayload {
  id: string;
  action: string;
  streaming?: boolean | undefined;
  presetId?: number | undefined;
  targetPresetId?: number | undefined;
  name?: string | undefined;
  thumbnail?: string | undefined;
  smartFrame?: string | undefined;
  privacyBlur?: boolean | undefined;
  focusMode?: string | undefined;
  position?: { pan: number; tilt: number; zoom: number } | undefined;
  coordinates?:
    | {
        pan: number;
        tilt: number;
        roll?: number | undefined;
        zoom: number;
        focus?: number | undefined;
      }
    | undefined;
}

export type CameraEvent =
  | { type: "camera"; data: CameraEventPayload }
  | { type: "ready"; data: { status: string; time: string } };

export class CameraEventBroker {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: CameraEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: CameraEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}
