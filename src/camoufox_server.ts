import { firefox } from "playwright-core";
import { buildCamoufoxLaunchOptions } from "./lib/camoufox/browser.ts";
import {
    fingerprintOperatingSystem,
    prepareCamoufoxInstall,
} from "./lib/camoufox/install.ts";

const port = Number(Deno.env.get("CAMOUFOX_SERVER_PORT") ?? 9223);
const host = Deno.env.get("CAMOUFOX_SERVER_HOST") ?? "0.0.0.0";
// Playwright randomizes the wsEndpoint path per launch unless pinned here.
// Pin it so consumers can hardcode a stable URL across server restarts —
// the path doubles as a shared secret, same role as SERVER_SECRET_KEY plays
// between Invidious and the companion.
const wsPath = Deno.env.get("CAMOUFOX_WS_PATH");
if (!wsPath) {
    throw new Error("CAMOUFOX_WS_PATH must be set to a stable, secret path");
}

await prepareCamoufoxInstall();

const options = await buildCamoufoxLaunchOptions(fingerprintOperatingSystem());
const server = await firefox.launchServer({ ...options, port, host, wsPath });

console.log("[INFO] Camoufox server listening", {
    wsEndpoint: server.wsEndpoint(),
});

function stop(signal: string) {
    console.log(`[INFO] Received ${signal}, shutting down Camoufox server`);
    server.close().then(() => Deno.exit(0));
}

Deno.addSignalListener("SIGTERM", () => stop("SIGTERM"));
Deno.addSignalListener("SIGINT", () => stop("SIGINT"));

await new Promise(() => {});
