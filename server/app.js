import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_API_BASE,
  LinodeClient,
  LinodeError,
  createProxyAgent,
  probeUrl,
} from "./linode.js";
import { SettingsStoreError } from "./settings-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, "../public");
const MAX_BODY_BYTES = 96 * 1024;
const MAX_PAGE_SIZE = 500;
const ALLOWED_ACTIONS = new Set(["boot", "shutdown", "reboot"]);
const CSRF_HEADER = "x-linode-pilot";
const CSRF_VALUE = "1";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
]);

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_ERROR", details = []) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  );
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function methodNotAllowed(response, methods) {
  response.setHeader("Allow", methods.join(", "));
  sendJson(response, 405, {
    error: "Method not allowed.",
    code: "METHOD_NOT_ALLOWED",
  });
}

function cleanString(value, { maxLength = 255 } = {}) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function requireCredential(settingsStore) {
  const credential = settingsStore.getCredential();
  if (!credential.token) {
    throw new HttpError(
      401,
      "Connect a Linode API token to continue.",
      "TOKEN_REQUIRED",
    );
  }
  return credential;
}

function requireCsrfHeader(request) {
  if (request.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw new HttpError(
      403,
      "Missing the Linode Pilot request header.",
      "CSRF_CHECK_FAILED",
    );
  }
}

async function readJsonBody(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(
      415,
      "Content-Type must be application/json.",
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.", "PAYLOAD_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Body must be an object");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "INVALID_JSON");
  }
}

function optionalResult(result) {
  if (result.status === "fulfilled") {
    return result.value;
  }

  if (result.reason instanceof LinodeError) {
    if ([403, 404].includes(result.reason.status)) {
      return null;
    }
  }

  throw result.reason;
}

function normalizeArrayPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  return Array.isArray(payload?.data) ? payload.data : [];
}

function validateInstanceId(value) {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, "Invalid instance ID.", "INVALID_INSTANCE_ID");
  }
  return value;
}

function validateCreatePayload(input) {
  const region = cleanString(input.region, { maxLength: 64 });
  const type = cleanString(input.type, { maxLength: 64 });
  const image = cleanString(input.image, { maxLength: 128 });
  const label = cleanString(input.label, { maxLength: 64 });
  const rootPass =
    typeof input.root_pass === "string" ? input.root_pass.slice(0, 128) : "";
  const cloudInit =
    typeof input.cloud_init === "string" ? input.cloud_init.slice(0, 65_535) : "";

  if (!region) {
    throw new HttpError(400, "A region is required.", "REGION_REQUIRED");
  }
  if (!type) {
    throw new HttpError(400, "A plan type is required.", "TYPE_REQUIRED");
  }
  if (!image) {
    throw new HttpError(400, "An image is required.", "IMAGE_REQUIRED");
  }

  const tags = Array.isArray(input.tags)
    ? input.tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  const authorizedKeys = Array.isArray(input.authorized_keys)
    ? input.authorized_keys
        .filter((key) => typeof key === "string")
        .map((key) => key.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  if (rootPass && (rootPass.length < 7 || rootPass.length > 128)) {
    throw new HttpError(
      400,
      "The root password must contain between 7 and 128 characters.",
      "INVALID_ROOT_PASSWORD",
    );
  }

  if (!rootPass && authorizedKeys.length === 0) {
    throw new HttpError(
      400,
      "A root password or at least one SSH key is required when deploying an image.",
      "ROOT_AUTH_REQUIRED",
    );
  }

  const payload = {
    region,
    type,
    image,
    booted: input.booted !== false,
    backups_enabled: input.backups_enabled === true,
    private_ip: input.private_ip === true,
  };

  if (label) {
    payload.label = label;
  }
  if (rootPass) {
    payload.root_pass = rootPass;
  }
  if (tags.length > 0) {
    payload.tags = tags;
  }
  if (authorizedKeys.length > 0) {
    payload.authorized_keys = authorizedKeys;
  }
  if (cloudInit) {
    payload.metadata = {
      user_data: Buffer.from(cloudInit, "utf8").toString("base64"),
    };
  }

  return payload;
}

async function serveStatic(request, response, pathname, publicDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Malformed URL.", "MALFORMED_URL");
  }

  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, relativePath);
  const insidePublicDir =
    resolved === publicDir || resolved.startsWith(`${publicDir}${path.sep}`);

  if (!insidePublicDir) {
    throw new HttpError(403, "Forbidden.", "FORBIDDEN");
  }

  let filePath = resolved;
  let stat;

  try {
    stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = await fs.stat(filePath);
    }
  } catch {
    if (path.extname(decoded)) {
      throw new HttpError(404, "Not found.", "NOT_FOUND");
    }
    filePath = path.join(publicDir, "index.html");
    stat = await fs.stat(filePath);
  }

  const content = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    MIME_TYPES.get(extension) || "application/octet-stream",
  );
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Length", stat.size);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(content);
}

async function buildOverview(client) {
  const [instances, accountResult, transferResult, eventsResult] =
    await Promise.all([
      client.listAll("/linode/instances"),
      Promise.allSettled([client.request("/account")]).then(([result]) =>
        optionalResult(result),
      ),
      Promise.allSettled([client.request("/account/transfer")]).then(([result]) =>
        optionalResult(result),
      ),
      Promise.allSettled([
        client.request("/account/events", {
          query: { page_size: 25 },
        }),
      ]).then(([result]) => optionalResult(result)),
    ]);

  return {
    account: accountResult,
    transfer: transferResult,
    instances,
    events: Array.isArray(eventsResult?.data) ? eventsResult.data : [],
    fetchedAt: new Date().toISOString(),
  };
}

async function buildCatalog(client) {
  const [regions, types, images] = await Promise.all([
    client.listAll("/regions"),
    client.listAll("/linode/types"),
    client.listAll("/images"),
  ]);

  return {
    regions,
    types,
    images,
    fetchedAt: new Date().toISOString(),
  };
}

async function buildDetail(client, instanceId) {
  const instance = await client.request(`/linode/instances/${instanceId}`);

  const [statsResult, backupsResult, eventsResult] = await Promise.allSettled([
    client.request(`/linode/instances/${instanceId}/stats`),
    client.request(`/linode/instances/${instanceId}/backups`),
    client.request("/account/events", { query: { page_size: 50 } }),
  ]);

  const stats = optionalResult(statsResult);
  const backups = optionalResult(backupsResult);
  const eventPayload = optionalResult(eventsResult);
  const events = Array.isArray(eventPayload?.data)
    ? eventPayload.data
        .filter((event) => String(event?.entity?.id) === String(instanceId))
        .slice(0, 20)
    : [];

  return { instance, stats, backups, events };
}

function accountLabel(account) {
  if (!account) {
    return "";
  }
  return (
    [account.first_name, account.last_name].filter(Boolean).join(" ") ||
    account.company ||
    account.email ||
    ""
  );
}

async function verifyApiToken({ token, apiBase, proxy, timeoutMs = 20_000 }) {
  const startedAt = performance.now();
  const client = new LinodeClient({ token, apiBase, proxy, timeoutMs });
  await client.request("/linode/instances", {
    query: { page_size: 25 },
  });

  let account = null;
  try {
    account = await client.request("/account");
  } catch (error) {
    if (!(error instanceof LinodeError) || error.status !== 403) {
      throw error;
    }
  }

  return {
    latencyMs: Math.round(performance.now() - startedAt),
    accountLabel: accountLabel(account),
  };
}

function buildProxyDraft(settingsStore, input = {}, { enabledByDefault = true } = {}) {
  const saved = settingsStore.getProxyConfig();
  return {
    enabled:
      input.enabled === undefined ? enabledByDefault : input.enabled === true,
    url: cleanString(input.url, { maxLength: 512 }) || saved.url,
    username:
      input.username === undefined
        ? saved.username
        : cleanString(input.username, { maxLength: 128 }),
    password:
      typeof input.password === "string" && input.password.length > 0
        ? input.password.slice(0, 256)
        : saved.password,
  };
}

function createRouter({ settingsStore, apiBase, publicDir }) {
  return async function route(request, response) {
    const url = new URL(request.url, "http://localhost");
    const { pathname } = url;

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      sendJson(response, 200, { ok: true, timestamp: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/session") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      sendJson(response, 200, {
        ...settingsStore.getPublicSettings(),
        apiBase: apiBase || DEFAULT_API_BASE,
        version: "1.0.0",
      });
      return;
    }

    if (!pathname.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(request.method)) {
        methodNotAllowed(response, ["GET", "HEAD"]);
        return;
      }
      await serveStatic(request, response, pathname, publicDir);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      requireCsrfHeader(request);
    }

    if (pathname === "/api/settings" && request.method === "GET") {
      sendJson(response, 200, settingsStore.getPublicSettings());
      return;
    }

    if (pathname === "/api/settings/tokens" && request.method === "POST") {
      const body = await readJsonBody(request);
      const token = cleanString(body.token, { maxLength: 512 });
      const proxy = settingsStore.getProxyConfig();
      const verification = await verifyApiToken({ token, apiBase, proxy });
      const tokenId = settingsStore.addToken({
        label: body.label,
        token,
        accountLabel: verification.accountLabel,
      });
      sendJson(response, 201, {
        ok: true,
        tokenId,
        verification,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    if (
      pathname === "/api/settings/tokens/import-env" &&
      request.method === "POST"
    ) {
      const envToken = settingsStore.getEnvToken();
      if (!envToken) {
        throw new HttpError(
          400,
          "No LINODE_API_TOKEN is configured on the server.",
          "ENV_TOKEN_MISSING",
        );
      }
      const proxy = settingsStore.getProxyConfig();
      const verification = await verifyApiToken({
        token: envToken,
        apiBase,
        proxy,
      });
      const tokenId = settingsStore.addToken({
        label: "从 .env 导入",
        token: envToken,
        accountLabel: verification.accountLabel,
      });
      sendJson(response, 201, {
        ok: true,
        tokenId,
        verification,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    const tokenActivateMatch = pathname.match(
      /^\/api\/settings\/tokens\/([0-9a-f-]+)\/activate$/,
    );
    if (tokenActivateMatch && request.method === "POST") {
      const record = settingsStore.getTokenById(tokenActivateMatch[1]);
      const proxy = settingsStore.getProxyConfig();
      const verification = await verifyApiToken({
        token: record.token,
        apiBase,
        proxy,
      });
      settingsStore.activateToken(record.id);
      settingsStore.recordVerification(record.id, {
        accountLabel: verification.accountLabel,
      });
      sendJson(response, 200, {
        ok: true,
        verification,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    const tokenTestMatch = pathname.match(
      /^\/api\/settings\/tokens\/([0-9a-f-]+)\/test$/,
    );
    if (tokenTestMatch && request.method === "POST") {
      const record = settingsStore.getTokenById(tokenTestMatch[1]);
      const proxy = settingsStore.getProxyConfig();
      const verification = await verifyApiToken({
        token: record.token,
        apiBase,
        proxy,
      });
      settingsStore.recordVerification(record.id, {
        accountLabel: verification.accountLabel,
      });
      sendJson(response, 200, {
        ok: true,
        verification,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    const tokenDeleteMatch = pathname.match(
      /^\/api\/settings\/tokens\/([0-9a-f-]+)$/,
    );
    if (tokenDeleteMatch && request.method === "DELETE") {
      settingsStore.removeToken(tokenDeleteMatch[1]);
      sendJson(response, 200, {
        ok: true,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    if (pathname === "/api/settings/proxy" && request.method === "PUT") {
      const body = await readJsonBody(request);
      const draft = buildProxyDraft(settingsStore, body, {
        enabledByDefault: false,
      });
      createProxyAgent({ ...draft, enabled: true });
      settingsStore.updateProxy({
        enabled: body.enabled === true,
        url: draft.url,
        username: draft.username,
        password:
          typeof body.password === "string" ? body.password : undefined,
      });
      sendJson(response, 200, {
        ok: true,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    if (
      pathname === "/api/settings/proxy/test" &&
      request.method === "POST"
    ) {
      const body = await readJsonBody(request);
      const draft = buildProxyDraft(settingsStore, body);
      const result = await probeUrl(`${apiBase}/regions`, {
        proxy: draft,
        timeoutMs: 20_000,
      });
      sendJson(response, 200, {
        ok: result.statusCode < 500,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        message:
          result.statusCode < 500
            ? "SOCKS 代理已连通 Linode API。"
            : `代理已连通，但 Linode API 返回 HTTP ${result.statusCode}。`,
      });
      return;
    }

    if (
      pathname === "/api/settings/test-connection" &&
      request.method === "POST"
    ) {
      const credential = settingsStore.getCredential();
      const proxy = settingsStore.getProxyConfig();
      const checks = {
        proxy: { enabled: proxy.enabled, ok: true, message: "未启用代理" },
        token: { ok: false, message: "尚未配置 API 令牌" },
        ok: false,
      };

      if (proxy.enabled) {
        try {
          const probe = await probeUrl(`${apiBase}/regions`, {
            proxy,
            timeoutMs: 20_000,
          });
          checks.proxy = {
            enabled: true,
            ok: probe.statusCode < 500,
            statusCode: probe.statusCode,
            latencyMs: probe.latencyMs,
            message:
              probe.statusCode < 500
                ? "SOCKS 代理连接正常"
                : `代理可达，但 API 返回 HTTP ${probe.statusCode}`,
          };
        } catch (error) {
          checks.proxy = {
            enabled: true,
            ok: false,
            message: error.message || "SOCKS 代理连接失败",
          };
        }
      }

      if (credential.token) {
        try {
          const verification = await verifyApiToken({
            token: credential.token,
            apiBase,
            proxy,
          });
          checks.token = {
            ok: true,
            source: credential.source,
            label: credential.label,
            latencyMs: verification.latencyMs,
            accountLabel: verification.accountLabel,
            message: "API 令牌验证通过",
          };
        } catch (error) {
          checks.token = {
            ok: false,
            source: credential.source,
            label: credential.label,
            message: error.message || "API 令牌验证失败",
          };
        }
      }

      checks.ok = checks.token.ok && checks.proxy.ok;
      checks.checkedAt = new Date().toISOString();
      sendJson(response, 200, checks);
      return;
    }

    const credential = requireCredential(settingsStore);
    const proxy = settingsStore.getProxyConfig();
    const client = new LinodeClient({
      token: credential.token,
      apiBase,
      proxy,
    });

    if (pathname === "/api/overview") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      sendJson(response, 200, await buildOverview(client));
      return;
    }

    if (pathname === "/api/catalog") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      sendJson(response, 200, await buildCatalog(client));
      return;
    }

    if (pathname === "/api/instances") {
      if (request.method === "GET") {
        sendJson(response, 200, {
          data: await client.listAll("/linode/instances"),
        });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const payload = validateCreatePayload(body);
        const instance = await client.request("/linode/instances", {
          method: "POST",
          body: payload,
        });
        sendJson(response, 201, { instance });
        return;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return;
    }

    const availabilityMatch = pathname.match(/^\/api\/availability\/([a-z0-9-]+)$/);
    if (availabilityMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const region = availabilityMatch[1];
      const payload = await client.request(`/regions/${region}/availability`);
      const entries = normalizeArrayPayload(payload);
      const plans = Object.fromEntries(
        entries
          .filter((entry) => typeof entry?.plan === "string")
          .map((entry) => [entry.plan, entry.available !== false]),
      );
      sendJson(response, 200, { region, plans });
      return;
    }

    const detailMatch = pathname.match(/^\/api\/instances\/(\d+)\/detail$/);
    if (detailMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const instanceId = validateInstanceId(detailMatch[1]);
      sendJson(response, 200, await buildDetail(client, instanceId));
      return;
    }

    const actionMatch = pathname.match(
      /^\/api\/instances\/(\d+)\/actions\/([a-z-]+)$/,
    );
    if (actionMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }
      const instanceId = validateInstanceId(actionMatch[1]);
      const action = actionMatch[2];
      if (!ALLOWED_ACTIONS.has(action)) {
        throw new HttpError(
          400,
          `Unsupported instance action: ${action}`,
          "UNSUPPORTED_ACTION",
        );
      }
      const result = await client.request(
        `/linode/instances/${instanceId}/${action}`,
        { method: "POST" },
      );
      sendJson(response, 200, { ok: true, action, result });
      return;
    }

    const instanceMatch = pathname.match(/^\/api\/instances\/(\d+)$/);
    if (instanceMatch) {
      if (request.method !== "GET" && request.method !== "DELETE") {
        methodNotAllowed(response, ["GET", "DELETE"]);
        return;
      }
      const instanceId = validateInstanceId(instanceMatch[1]);
      if (request.method === "GET") {
        sendJson(
          response,
          200,
          await client.request(`/linode/instances/${instanceId}`),
        );
      } else {
        await client.request(`/linode/instances/${instanceId}`, {
          method: "DELETE",
        });
        sendJson(response, 200, { ok: true });
      }
      return;
    }

    throw new HttpError(404, "API route not found.", "NOT_FOUND");
  };
}

function formatError(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof LinodeError) {
    return {
      status: error.status,
      code: "LINODE_API_ERROR",
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof SettingsStoreError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: [],
    };
  }

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected server error occurred.",
    details: [],
  };
}

export function createRequestHandler({
  settingsStore,
  apiBase = DEFAULT_API_BASE,
  publicDir = DEFAULT_PUBLIC_DIR,
  logger = console,
} = {}) {
  if (!settingsStore) {
    throw new Error("A settingsStore instance is required.");
  }
  const route = createRouter({ settingsStore, apiBase, publicDir });

  return async function handler(request, response) {
    const startedAt = performance.now();
    setSecurityHeaders(response);

    try {
      await route(request, response);
    } catch (error) {
      const formatted = formatError(error);
      if (!response.headersSent) {
        sendJson(response, formatted.status, {
          error: formatted.message,
          code: formatted.code,
          details: formatted.details,
        });
      } else {
        response.destroy();
      }

      if (formatted.status >= 500 && formatted.status !== 504) {
        logger.error?.(`[server] ${request.method} ${request.url}`, error);
      }
    } finally {
      if (request.url?.startsWith("/api/")) {
        const elapsed = Math.round(performance.now() - startedAt);
        logger.info?.(
          `[api] ${request.method} ${new URL(request.url, "http://localhost").pathname} ${response.statusCode} ${elapsed}ms`,
        );
      }
    }
  };
}

export { DEFAULT_PUBLIC_DIR, MAX_PAGE_SIZE };
