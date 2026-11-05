import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { createRequestHandler } from "./app.js";
import { DEFAULT_API_BASE } from "./linode.js";
import { openSettingsStore } from "./settings-store.js";

function loadEnvFile(filePath = path.resolve(process.cwd(), ".env")) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const host = process.env.HOST || "127.0.0.1";
const rawPort = Number(process.env.PORT || 4173);
const port = Number.isFinite(rawPort) ? rawPort : 4173;
const apiBase = process.env.LINODE_API_BASE || DEFAULT_API_BASE;
const envToken = String(process.env.LINODE_API_TOKEN || "").trim();
const dataDir = path.resolve(
  process.env.CLOUDVM_DATA_DIR ||
    process.env.LINODE_PILOT_DATA_DIR ||
    path.join(process.cwd(), "data"),
);

let settingsStore;
try {
  settingsStore = openSettingsStore({ dataDir, envToken });
} catch (error) {
  console.error("[server] Failed to load local settings:", error.message);
  process.exit(1);
}

const publicSettings = settingsStore.getPublicSettings();
const handler = createRequestHandler({ settingsStore, apiBase });
const server = http.createServer(handler);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. Set PORT in .env or stop the other process.`,
    );
  } else {
    console.error("[server] Failed to start:", error);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log("");
  console.log("  CloudVMController");
  console.log(`  Local:   http://${displayHost}:${port}`);
  console.log(`  API:     ${apiBase}`);
  console.log(
    `  Token:   ${
      publicSettings.credentialSource === "none"
        ? "not configured"
        : publicSettings.poolSize > 1
          ? `${publicSettings.poolSize} tokens (multi-account)`
          : publicSettings.credentialLabel
    }`,
  );
  console.log(`  Data:    ${dataDir}`);
  console.log("");
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
