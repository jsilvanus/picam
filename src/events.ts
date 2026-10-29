import { EventEmitter } from "node:events";

export interface CameraEventPayload {
  id: string;
  action: string;
  streaming?: boolean;
  presetId?: number;
  thumbnail?: string;
  smartFrame?: string;
  privacyBlur?: boolean;
  focusMode?: string;
  position?: { pan: number; tilt: number; zoom: number };
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
