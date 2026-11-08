/**
 * Hard power-cycle of a camera by switching its PoE port off and on through pipoe
 * (POST /api/v1/poe/ports/:port/cycle). This is what helps when a camera hangs; VISCA standby does not.
 * picam only asks; pipoe holds the switch login and refuses ports that are not named in its config.
 */
export interface PowerCyclerOptions {
  /** pipoe base URL, e.g. http://127.0.0.1:3108 (PICAM_PIPOE_URL). */
  baseUrl: string;
  /** Bearer token if pipoe has PIPOE_API_KEY set (PICAM_PIPOE_API_KEY). */
  apiKey?: string | undefined;
  /** pipoe port name or number per camera id; defaults to the camera id (pipoe's PIPOE_PORT_NAMES, e.g. cam1=7). */
  ports?: Record<string, string> | undefined;
  /** pipoe waits offMs between off and on; its own limits are 1-60 s. Time allowed on top of that (ms). */
  timeoutMarginMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class PowerCycleError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = "PowerCycleError";
  }
}

export class PipoePowerCycler {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: PowerCyclerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  portFor(cameraId: string): string {
    return this.options.ports?.[cameraId] ?? cameraId;
  }

  /** Returns pipoe's port state after the cycle. Throws PowerCycleError with pipoe's message on failure. */
  async cycle(cameraId: string, offMs?: number): Promise<unknown> {
    const port = this.portFor(cameraId);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) headers["authorization"] = `Bearer ${this.options.apiKey}`;
    const waitMs = Math.min(60_000, Math.max(1_000, offMs ?? 5_000));
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/v1/poe/ports/${encodeURIComponent(port)}/cycle`, {
        method: "POST",
        headers,
        body: JSON.stringify(offMs !== undefined ? { offMs } : {}),
        signal: AbortSignal.timeout(waitMs + (this.options.timeoutMarginMs ?? 20_000))
      });
    } catch (err) {
      throw new PowerCycleError(`pipoe did not answer: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep the raw text
    }
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error && typeof (body as { error: unknown }).error === "object"
              ? ((body as { error: { message?: unknown } }).error.message ?? JSON.stringify((body as { error: unknown }).error))
              : (body as { error: unknown }).error)
          : text || `HTTP ${res.status}`;
      throw new PowerCycleError(`pipoe refused the cycle of port '${port}': ${msg}`, res.status);
    }
    return body;
  }
}

/** Parses PICAM_POE_PORTS=cam1=7,cam2=8 (values are pipoe port names or numbers). */
export function parsePoePorts(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? "").split(",")) {
    const m = /^\s*([\w-]+)\s*=\s*([\w-]+)\s*$/.exec(part);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
