import fs from "node:fs/promises";
import path from "node:path";
import type { CameraPreset, CameraPresetCoordinates } from "./camera-adapter.js";

export interface PresetStoreOptions {
  filePath?: string | undefined;
  thumbnailsDir?: string | undefined;
}

export class PresetStore {
  readonly filePath: string;
  readonly thumbnailsDir: string;
  private presets = new Map<string, Map<number, CameraPreset>>();
  private loaded = false;

  constructor(options: PresetStoreOptions = {}) {
    this.filePath = options.filePath ?? "data/presets.json";
    this.thumbnailsDir = options.thumbnailsDir ?? "data/thumbnails";
  }

  async init(defaultPresets?: Record<string, CameraPreset[]>): Promise<void> {
    if (this.loaded) return;
    await this.ensureDirectories();
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(data) as Record<string, CameraPreset[]>;
      for (const [camId, list] of Object.entries(parsed)) {
        const camMap = new Map<number, CameraPreset>();
        for (const p of list) {
          camMap.set(p.id, p);
        }
        this.presets.set(camId, camMap);
      }
    } catch {
      // If file doesn't exist, populate with defaults if provided
      if (defaultPresets) {
        for (const [camId, list] of Object.entries(defaultPresets)) {
          const camMap = new Map<number, CameraPreset>();
          for (const p of list) {
            camMap.set(p.id, { ...p });
          }
          this.presets.set(camId, camMap);
        }
        await this.persist();
      }
    }
    this.loaded = true;
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.mkdir(this.thumbnailsDir, { recursive: true });
  }

  getPresets(cameraId: string): CameraPreset[] {
    const camMap = this.presets.get(cameraId);
    if (!camMap) return [];
    return [...camMap.values()].sort((a, b) => a.id - b.id);
  }

  getPreset(cameraId: string, presetId: number): CameraPreset | undefined {
    return this.presets.get(cameraId)?.get(presetId);
  }

  async savePreset(
    cameraId: string,
    presetId: number,
    name?: string,
    coordinates?: CameraPresetCoordinates,
    thumbnail?: string
  ): Promise<CameraPreset> {
    let camMap = this.presets.get(cameraId);
    if (!camMap) {
      camMap = new Map();
      this.presets.set(cameraId, camMap);
    }
    const existing = camMap.get(presetId);
    const updated: CameraPreset = {
      id: presetId,
      ...(name ?? existing?.name ? { name: name ?? existing?.name } : {}),
      ...(thumbnail ?? existing?.thumbnail ? { thumbnail: thumbnail ?? existing?.thumbnail } : {}),
      ...(coordinates ?? existing?.coordinates ? { coordinates: coordinates ?? existing?.coordinates } : {}),
      updatedAt: new Date().toISOString()
    };
    camMap.set(presetId, updated);
    await this.persist();
    return updated;
  }

  async saveThumbnail(
    cameraId: string,
    presetId: number,
    thumbnail: string
  ): Promise<CameraPreset> {
    let camMap = this.presets.get(cameraId);
    if (!camMap) {
      camMap = new Map();
      this.presets.set(cameraId, camMap);
    }
    const existing = camMap.get(presetId);

    let resolvedThumbnail = thumbnail;
    if (thumbnail.startsWith("data:image/")) {
      const match = thumbnail.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const buffer = Buffer.from(match[2]!, "base64");
        const filename = `${cameraId}-preset-${presetId}.${ext}`;
        const targetPath = path.join(this.thumbnailsDir, filename);
        await fs.writeFile(targetPath, buffer);
        resolvedThumbnail = `/api/v1/cameras/${cameraId}/presets/${presetId}/thumbnail`;
      }
    }

    const updated: CameraPreset = {
      id: presetId,
      ...(existing?.name ? { name: existing.name } : {}),
      ...(existing?.coordinates ? { coordinates: existing.coordinates } : {}),
      thumbnail: resolvedThumbnail,
      updatedAt: new Date().toISOString()
    };
    camMap.set(presetId, updated);
    await this.persist();
    return updated;
  }

  async deletePreset(cameraId: string, presetId: number): Promise<boolean> {
    const camMap = this.presets.get(cameraId);
    if (!camMap || !camMap.has(presetId)) return false;
    camMap.delete(presetId);
    await this.persist();
    return true;
  }

  async getThumbnailFile(
    cameraId: string,
    presetId: number
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      const filename = `${cameraId}-preset-${presetId}.${ext}`;
      const filePath = path.join(this.thumbnailsDir, filename);
      try {
        const buffer = await fs.readFile(filePath);
        const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
        return { buffer, contentType };
      } catch {
        // continue
      }
    }
    const preset = this.getPreset(cameraId, presetId);
    if (preset?.thumbnail?.startsWith("data:image/")) {
      const match = preset.thumbnail.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (match) {
        const contentType = `image/${match[1]}`;
        const buffer = Buffer.from(match[2]!, "base64");
        return { buffer, contentType };
      }
    }
    return null;
  }

  private async persist(): Promise<void> {
    await this.ensureDirectories();
    const obj: Record<string, CameraPreset[]> = {};
    for (const [camId, camMap] of this.presets.entries()) {
      obj[camId] = [...camMap.values()].sort((a, b) => a.id - b.id);
    }
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(obj, null, 2), "utf-8");
    await fs.rename(tempPath, this.filePath);
  }
}
