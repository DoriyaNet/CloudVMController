import { createPrivateKey } from "node:crypto";
import http from "node:http";
import path from "node:path";

import { createRequestHandler } from "./app.js";
import { readAuthConfig } from "./auth/config.js";
import { createAuthController } from "./auth/controller.js";
import { loadEnvFile } from "./env.js";
import { DEFAULT_API_BASE } from "./linode.js";
import { openSettingsStore } from "./settings-store.js";
import { openVaultSettingsStore } from "./vault-store.js";

loadEnvFile(path.resolve(process.cwd(), ".env"));

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

function isLoopbackHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "localhost"
  );
}

const authConfig = readAuthConfig(process.env);
const loopback = isLoopbackHost(host);

if (
  authConfig.configErrors.some((message) =>
    message.includes("CLOUDVM_AUTH_MODE"),
  )
) {
  console.error(
    `[server] Invalid auth configuration: ${authConfig.configErrors.join("; ")}`,
  );
  process.exit(1);
}

if (authConfig.mode === "github") {
  if (!authConfig.configured) {
    const details = [
      ...authConfig.missing.map((name) => `missing ${name}`),
      ...authConfig.configErrors,
    ];
    console.error(
      `[server] GitHub auth is not configured: ${details.join("; ")}`,
    );
    process.exit(1);
  }
  if (
    !authConfig.allowAnyUser &&
    authConfig.allowedUsers.length === 0 &&
    authConfig.allowedUserIds.length === 0
  ) {
    console.error(
      "[server] Refusing to start without an allowlist. Set " +
        "CLOUDVM_ALLOWED_GITHUB_USERS or CLOUDVM_ALLOWED_GITHUB_IDS, " +
        "or explicitly set CLOUDVM_ALLOW_ANY_GITHUB_USER=1.",
    );
    process.exit(1);
  }
  try {
    createPrivateKey(authConfig.privateKey);
  } catch {
    console.error(
      "[server] GITHUB_APP_PRIVATE_KEY is not a valid RSA private key.",
    );
    process.exit(1);
  }
  if (!loopback && !authConfig.appOrigin?.startsWith("https://")) {
    console.warn(
      "[server] GitHub auth is enabled, but APP_ORIGIN is not an https URL. " +
        "Use HTTPS in production so session cookies are marked Secure.",
    );
  }
} else if (
  !loopback &&
  process.env.CLOUDVM_ALLOW_INSECURE_REMOTE !== "1"
) {
  console.error(
    `[server] Refusing to bind local auth mode to ${host}. ` +
      "Configure GitHub App auth, or set CLOUDVM_ALLOW_INSECURE_REMOTE=1 " +
      "only when HTTPS and authentication are enforced by a reverse proxy.",
  );
  process.exit(1);
}

let settingsStore = null;
try {
  settingsStore = openSettingsStore({ dataDir, envToken });
} catch (error) {
  if (authConfig.mode === "github") {
    console.warn(
      "[server] Local settings are unavailable for vault import:",
      error.message,
    );
  } else {
    console.error("[server] Failed to load local settings:", error.message);
    process.exit(1);
  }
}

const auth =
  authConfig.mode === "github"
    ? createAuthController({
        config: authConfig,
        vaultStoreFactory: openVaultSettingsStore,
        localSettingsStore: settingsStore,
      })
    : null;

const publicSettings = auth ? null : settingsStore?.getPublicSettings() || null;
const handler = createRequestHandler({ settingsStore, auth, apiBase });
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
  if (auth) {
    console.log("  Auth:    GitHub App");
    console.log("  Vault:   locked (unlock in the browser)");
    if (!authConfig.allowAnyUser) {
      const users = authConfig.allowedUsers.join(", ");
      const ids = authConfig.allowedUserIds.join(", ");
      console.log(
        `  Allowed: ${[users && `users ${users}`, ids && `ids ${ids}`]
          .filter(Boolean)
          .join("; ")}`,
      );
    }
  } else if (publicSettings) {
    console.log(
      `  Token:   ${
        publicSettings.credentialSource === "none"
          ? "not configured"
          : publicSettings.poolSize > 1
            ? `${publicSettings.poolSize} tokens (multi-account)`
            : publicSettings.credentialLabel
      }`,
    );
  }
  console.log(
    `  Data:    ${auth ? `${dataDir} (local import source only)` : dataDir}`,
  );
  console.log("");
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
