import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, cameraService } = buildApp(config);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    app.log.info("Shutting down picam...");
    // Last resort: never hang a service stop (camera CGI calls on the way out have their own timeouts).
    setTimeout(() => {
      app.log.warn("Shutdown took too long; exiting");
      process.exit(0);
    }, Number.parseInt(process.env["PICAM_SHUTDOWN_TIMEOUT_MS"] ?? "10000", 10) || 10000).unref();
    await cameraService.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ port: config.port, host: config.host, mode: config.mode }, "picam listening");
  } catch (err) {
    app.log.error(err, "Failed to start picam");
    process.exit(1);
  }
}

void main();
