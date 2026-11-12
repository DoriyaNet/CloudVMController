import { Buffer } from "node:buffer";

import { AuthError } from "./errors.js";

export const REQUIRED_ENV_NAMES = Object.freeze([
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "SESSION_SECRET",
]);

export function normalizePrivateKey(value) {
  if (typeof value !== "string") {
    return "";
  }

  let key = value.trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1);
  }

  return key.replace(/\\n/g, "\n").trim();
}

function normalizeAppOrigin(value) {
  if (!value) {
    return { appOrigin: null, error: null };
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return { appOrigin: url.origin, error: null };
  } catch {
    return {
      appOrigin: null,
      error: "APP_ORIGIN must be a valid absolute http(s) URL.",
    };
  }
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAllowedUsers(value) {
  return [
    ...new Set(parseCsv(value).map((entry) => entry.toLowerCase())),
  ];
}

function parseAllowedUserIds(value, errors) {
  const ids = [];
  for (const entry of parseCsv(value)) {
    if (!/^[1-9]\d*$/.test(entry)) {
      errors.push(
        `CLOUDVM_ALLOWED_GITHUB_IDS contains an invalid user ID: ${entry}`,
      );
      continue;
    }
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed)) {
      errors.push(
        `CLOUDVM_ALLOWED_GITHUB_IDS contains an out-of-range user ID: ${entry}`,
      );
      continue;
    }
    ids.push(parsed);
  }
  return [...new Set(ids)];
}

function readAuthMode(env, allRequiredPresent) {
  const explicit = String(env.CLOUDVM_AUTH_MODE || "")
    .trim()
    .toLowerCase();
  if (!explicit) {
    return { mode: allRequiredPresent ? "github" : "local", error: null };
  }
  if (explicit !== "github" && explicit !== "local") {
    return {
      mode: "local",
      error: "CLOUDVM_AUTH_MODE must be either github or local.",
    };
  }
  return { mode: explicit, error: null };
}

export function readAuthConfig(env = process.env) {
  const values = {};
  for (const name of REQUIRED_ENV_NAMES) {
    values[name] = typeof env[name] === "string" ? env[name].trim() : "";
  }

  const missing = REQUIRED_ENV_NAMES.filter((name) => !values[name]);
  const allRequiredPresent = missing.length === 0;
  const modeResult = readAuthMode(env, allRequiredPresent);
  const mode = modeResult.mode;
  const configErrors = [];
  if (modeResult.error) {
    configErrors.push(modeResult.error);
  }

  const appOriginValue =
    typeof env.APP_ORIGIN === "string" ? env.APP_ORIGIN.trim() : "";
  const origin = normalizeAppOrigin(appOriginValue);
  if (origin.error) {
    configErrors.push(origin.error);
  }

  const privateKey = normalizePrivateKey(values.GITHUB_APP_PRIVATE_KEY);
  const sessionSecret = values.SESSION_SECRET;
  if (
    mode === "github" &&
    sessionSecret &&
    Buffer.byteLength(sessionSecret, "utf8") < 32
  ) {
    configErrors.push("SESSION_SECRET must contain at least 32 bytes.");
  }
  if (mode === "github" && !sessionSecret) {
    // Missing values already appear in `missing`; keep this branch explicit
    // so callers can render a useful configuration error.
    configErrors.push("SESSION_SECRET is required in github mode.");
  }

  const allowedUsers = parseAllowedUsers(
    env.CLOUDVM_ALLOWED_GITHUB_USERS,
  );
  const allowedUserIds = parseAllowedUserIds(
    env.CLOUDVM_ALLOWED_GITHUB_IDS,
    configErrors,
  );
  const allowAnyUser = env.CLOUDVM_ALLOW_ANY_GITHUB_USER === "1";
  const isProduction =
    env.NODE_ENV === "production" ||
    env.CLOUDVM_SECURE_COOKIES === "1" ||
    origin.appOrigin?.startsWith("https://") === true;

  const githubConfigured =
    allRequiredPresent && configErrors.length === 0;

  return {
    mode,
    configured: mode === "github" ? githubConfigured : true,
    githubConfigured,
    missing,
    configErrors,
    appId: values.GITHUB_APP_ID,
    clientId: values.GITHUB_APP_CLIENT_ID,
    clientSecret: values.GITHUB_APP_CLIENT_SECRET,
    privateKey,
    slug: values.GITHUB_APP_SLUG,
    sessionSecret,
    appOrigin: origin.appOrigin,
    isProduction,
    trustProxy: env.CLOUDVM_TRUST_PROXY === "1",
    allowedUsers,
    allowedUserIds,
    allowAnyUser,
  };
}

export function assertAuthConfigured(config) {
  if (config.mode !== "github") {
    throw new AuthError(
      503,
      "not_configured",
      "GitHub authentication mode is not enabled.",
    );
  }
  if (!config.githubConfigured) {
    const details = [];
    if (config.missing.length > 0) {
      details.push(`missing ${config.missing.join(", ")}`);
    }
    details.push(...config.configErrors);
    throw new AuthError(
      503,
      "not_configured",
      `GitHub App backend is not configured (${details.join("; ")}).`,
    );
  }
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    value = value[0];
  }
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

export function getRequestOrigin(req, config) {
  if (config.appOrigin) {
    return config.appOrigin;
  }

  const forwardedHost = config.trustProxy
    ? firstHeaderValue(req.headers["x-forwarded-host"])
    : "";
  const host = forwardedHost || req.headers.host;
  if (!host) {
    throw new AuthError(
      400,
      "invalid_host",
      "The request Host header is missing.",
    );
  }

  const forwardedProto = config.trustProxy
    ? firstHeaderValue(req.headers["x-forwarded-proto"])
    : "";
  const proto =
    forwardedProto || (req.socket?.encrypted ? "https" : "http");
  if (proto !== "http" && proto !== "https") {
    throw new AuthError(
      400,
      "invalid_host",
      "The request protocol is invalid.",
    );
  }

  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    throw new AuthError(
      400,
      "invalid_host",
      "The request Host header is invalid.",
    );
  }
}

export function getOAuthRedirectUri(req, config) {
  return `${getRequestOrigin(req, config)}/api/auth/callback`;
}
