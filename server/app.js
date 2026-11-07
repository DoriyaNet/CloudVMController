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
import {
  OracleClient,
  OracleError,
  isOracleInstanceId,
  normalizeOracleAccountInput,
  normalizeOracleInstance,
} from "./oracle.js";
import { SettingsStoreError } from "./settings-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, "../public");
const MAX_BODY_BYTES = 96 * 1024;
const MAX_PAGE_SIZE = 500;
const ALLOWED_ACTIONS = new Set(["boot", "shutdown", "reboot"]);
const IP_SWAP_KINDS = new Set(["ipv4", "ipv6"]);
const CSRF_HEADERS = ["x-cloudvmcontroller", "x-linode-pilot"];
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

function requireCredentials(settingsStore) {
  const credentials = settingsStore.getCredentials();
  if (credentials.length === 0) {
    throw new HttpError(
      401,
      "Connect a Linode API token to continue.",
      "TOKEN_REQUIRED",
    );
  }
  return credentials;
}

function resolveCredential(settingsStore, tokenId) {
  const credentials = requireCredentials(settingsStore);
  const requestedId = cleanString(tokenId, { maxLength: 256 });
  if (!requestedId) {
    return settingsStore.getCredential();
  }

  const credential = credentials.find(
    (entry) => entry.tokenId === requestedId,
  );
  if (!credential) {
    throw new HttpError(
      404,
      "The selected API token does not exist.",
      "TOKEN_NOT_FOUND",
    );
  }
  return credential;
}

function createCredentialClient(credential, apiBase, proxy) {
  return new LinodeClient({
    token: credential.token,
    apiBase,
    proxy,
  });
}

function optionalCredentialEntries(settingsStore, apiBase, proxy) {
  return settingsStore
    .getCredentials()
    .slice()
    .sort((left, right) => Number(right.active) - Number(left.active))
    .map((credential) => ({
      credential,
      client: createCredentialClient(credential, apiBase, proxy),
    }));
}

function credentialEntries(settingsStore, apiBase, proxy) {
  requireCredentials(settingsStore);
  return optionalCredentialEntries(settingsStore, apiBase, proxy);
}

function createOracleCredentialClient(account, proxy, endpointResolver) {
  return new OracleClient({
    tenancyId: account.tenancyId,
    userId: account.userId,
    fingerprint: account.fingerprint,
    privateKey: account.privateKey,
    region: account.region,
    compartmentId: account.compartmentId,
    proxy,
    endpointResolver,
  });
}

function optionalOracleEntries(settingsStore, proxy, endpointResolver) {
  return settingsStore.getOracleAccounts().map((account) => ({
    account,
    client: createOracleCredentialClient(account, proxy, endpointResolver),
  }));
}

function annotateOracleInstance(instance, account) {
  return {
    ...normalizeOracleInstance(instance, {
      region: account.region,
      account,
    }),
    accountId: account.id,
    tokenId: account.id,
    tokenLabel: account.label,
    accountLabel: account.label,
  };
}

function annotateInstance(instance, credential, account = null) {
  if (!instance) {
    return instance;
  }
  return {
    ...instance,
    provider: "linode",
    providerLabel: "Akamai Cloud",
    tokenId: credential.tokenId,
    tokenLabel: credential.label,
    accountLabel:
      accountLabel(account) ||
      credential.accountLabel ||
      credential.label ||
      "",
  };
}

function requireCsrfHeader(request) {
  if (!CSRF_HEADERS.some((header) => request.headers[header] === CSRF_VALUE)) {
    throw new HttpError(
      403,
      "Missing the CloudVMController request header.",
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

function settledValue(result) {
  if (result.status === "fulfilled") {
    return { value: result.value, error: null };
  }
  if (
    result.reason instanceof LinodeError &&
    [403, 404].includes(result.reason.status)
  ) {
    return { value: null, error: null };
  }
  return { value: null, error: result.reason };
}

function sumFinite(values) {
  const numbers = values.filter((value) => Number.isFinite(Number(value)));
  if (numbers.length === 0) {
    return null;
  }
  return numbers.reduce((total, value) => total + Number(value), 0);
}

function errorMessage(error) {
  return error?.message || "账户数据读取失败";
}

async function buildOverview(entries, oracleEntries = []) {
  const slices = await Promise.all(
    entries.map(async ({ credential, client }) => {
      const [instancesResult, accountResult, transferResult, eventsResult] =
        await Promise.allSettled([
          client.listAll("/linode/instances"),
          client.request("/account"),
          client.request("/account/transfer"),
          client.request("/account/events", {
            query: { page_size: 25 },
          }),
        ]);

      const instancesSettled = settledValue(instancesResult);
      const accountSettled = settledValue(accountResult);
      const transferSettled = settledValue(transferResult);
      const eventsSettled = settledValue(eventsResult);
      const account = accountSettled.value;
      const label =
        accountLabel(account) ||
        credential.accountLabel ||
        credential.label ||
        "";
      const instances = normalizeArrayPayload(instancesSettled.value).map(
        (instance) =>
          annotateInstance(instance, credential, account),
      );
      const events = normalizeArrayPayload(eventsSettled.value).map(
        (event) => ({
          ...event,
          tokenId: credential.tokenId,
          tokenLabel: credential.label,
          accountLabel: label,
        }),
      );

      return {
        provider: "linode",
        providerLabel: "Akamai Cloud",
        tokenId: credential.tokenId,
        tokenLabel: credential.label,
        accountLabel: label,
        account,
        transfer: transferSettled.value,
        instances,
        events,
        error: instancesSettled.error,
        accountError: accountSettled.error,
      };
    }),
  );
  const oracleSlices = await Promise.all(
    oracleEntries.map(async ({ account, client }) => {
      try {
        const rawInstances = await client.listInstances();
        const instances = rawInstances.map((instance) =>
          annotateOracleInstance(instance, account),
        );
        return {
          provider: "oracle",
          providerLabel: "Oracle Cloud",
          accountId: account.id,
          tokenId: account.id,
          tokenLabel: account.label,
          accountLabel: account.label,
          account: null,
          transfer: null,
          instances,
          events: [],
          error: null,
          accountError: null,
        };
      } catch (error) {
        return {
          provider: "oracle",
          providerLabel: "Oracle Cloud",
          accountId: account.id,
          tokenId: account.id,
          tokenLabel: account.label,
          accountLabel: account.label,
          account: null,
          transfer: null,
          instances: [],
          events: [],
          error,
          accountError: null,
        };
      }
    }),
  );
  const allSlices = [...slices, ...oracleSlices];

  const seenInstances = new Set();
  const instances = allSlices
    .flatMap((slice) => slice.instances)
    .filter((instance) => {
      const key = `${instance.provider || "linode"}:${instance.id}`;
      if (seenInstances.has(key)) {
        return false;
      }
      seenInstances.add(key);
      return true;
    });
  const seenEvents = new Set();
  const events = allSlices
    .flatMap((slice) => slice.events)
    .filter((event) => {
      const key = String(event.id);
      if (seenEvents.has(key)) {
        return false;
      }
      seenEvents.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        (Date.parse(right.created) || 0) - (Date.parse(left.created) || 0),
    )
    .slice(0, 30);
  const accountSlices = slices.filter((slice) => slice.account);
  const transfers = slices
    .map((slice) => slice.transfer)
    .filter(Boolean);
  const detectedTransfer = transfers.length
    ? {
        used: sumFinite(transfers.map((transfer) => transfer.used)),
        quota: sumFinite(transfers.map((transfer) => transfer.quota)),
        billable: sumFinite(transfers.map((transfer) => transfer.billable)),
        pooled: true,
        accountCount: transfers.length,
      }
    : null;
  const aggregateAccount = accountSlices.length
    ? {
        ...accountSlices[0].account,
        balance: sumFinite(
          accountSlices.map((slice) => slice.account.balance),
        ),
        balance_uninvoiced: sumFinite(
          accountSlices.map((slice) => slice.account.balance_uninvoiced),
        ),
        pooled: true,
        accountCount: accountSlices.length,
      }
    : null;
  const accounts = allSlices.map((slice) => ({
    provider: slice.provider,
    providerLabel: slice.providerLabel,
    tokenId: slice.tokenId,
    accountId: slice.accountId || "",
    tokenLabel: slice.tokenLabel,
    label: slice.accountLabel,
    email: slice.account?.email || "",
    balance: slice.account?.balance ?? null,
    balance_uninvoiced: slice.account?.balance_uninvoiced ?? null,
    instanceCount: slice.instances.length,
    transfer: slice.transfer,
    ok: !slice.error && !slice.accountError,
    error:
      slice.error || slice.accountError
        ? errorMessage(slice.error || slice.accountError)
        : "",
    accountAvailable: Boolean(slice.account) || slice.provider === "oracle",
  }));

  return {
    account: aggregateAccount,
    accounts,
    transfer: detectedTransfer,
    instances,
    events,
    poolSize: entries.length + oracleEntries.length,
    errors: allSlices
      .filter((slice) => slice.error)
      .map((slice) => ({
        tokenId: slice.tokenId,
        tokenLabel: slice.tokenLabel,
        message: errorMessage(slice.error),
      })),
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

async function buildDetail(client, instanceId, credential) {
  const rawInstance = await client.request(
    `/linode/instances/${instanceId}`,
  );
  const instance = annotateInstance(rawInstance, credential);

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

  return {
    instance,
    stats,
    backups,
    events,
    tokenId: credential.tokenId,
    tokenLabel: credential.label,
    accountLabel: instance.accountLabel,
  };
}

async function listAggregateInstances(entries, oracleEntries = []) {
  const linodeSlices = await Promise.all(
    entries.map(async ({ credential, client }) => {
      try {
        const instances = await client.listAll("/linode/instances");
        return {
          instances: instances.map((instance) =>
            annotateInstance(instance, credential),
          ),
          error: null,
        };
      } catch (error) {
        return { instances: [], error };
      }
    }),
  );
  const oracleSlices = await Promise.all(
    oracleEntries.map(async ({ account, client }) => {
      try {
        const instances = await client.listInstances();
        return {
          instances: instances.map((instance) =>
            annotateOracleInstance(instance, account),
          ),
          error: null,
          label: account.label,
        };
      } catch (error) {
        return {
          instances: [],
          error,
          label: account.label,
        };
      }
    }),
  );
  const slices = [...linodeSlices, ...oracleSlices];

  return {
    data: slices.flatMap((slice) => slice.instances),
    errors: slices
      .filter((slice) => slice.error)
      .map((slice) => `${slice.label || "云账户"}: ${errorMessage(slice.error)}`),
  };
}

async function resolveInstanceTarget(
  settingsStore,
  apiBase,
  proxy,
  instanceId,
  tokenId,
) {
  if (tokenId) {
    const credential = resolveCredential(settingsStore, tokenId);
    return {
      credential,
      client: createCredentialClient(credential, apiBase, proxy),
    };
  }

  for (const entry of credentialEntries(settingsStore, apiBase, proxy)) {
    try {
      const instance = await entry.client.request(
        `/linode/instances/${instanceId}`,
      );
      return {
        ...entry,
        instance: annotateInstance(instance, entry.credential),
      };
    } catch (error) {
      if (
        error instanceof LinodeError &&
        [401, 403, 404].includes(error.status)
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new HttpError(
    404,
    "The instance was not found in any connected account.",
    "INSTANCE_NOT_FOUND",
  );
}

function oracleAccountSummary(account) {
  return {
    id: account.id,
    label: account.label,
    tenancyId: account.tenancyId,
    userId: account.userId,
    region: account.region,
    compartmentId: account.compartmentId || "",
  };
}

async function resolveOracleTarget(
  settingsStore,
  proxy,
  instanceId,
  accountId,
  endpointResolver,
) {
  const accounts = settingsStore.getOracleAccounts();
  if (accounts.length === 0) {
    throw new HttpError(
      401,
      "Connect an Oracle Cloud account to continue.",
      "ORACLE_ACCOUNT_REQUIRED",
    );
  }

  const requestedId = cleanString(accountId, { maxLength: 128 });
  const candidates = requestedId
    ? accounts.filter((account) => account.id === requestedId)
    : accounts;
  if (candidates.length === 0) {
    throw new HttpError(
      404,
      "The selected Oracle Cloud account does not exist.",
      "ORACLE_ACCOUNT_NOT_FOUND",
    );
  }

  for (const account of candidates) {
    const client = createOracleCredentialClient(
      account,
      proxy,
      endpointResolver,
    );
    try {
      const instance = await client.getInstance(instanceId);
      return {
        account,
        client,
        instance: annotateOracleInstance(instance, account),
      };
    } catch (error) {
      if (
        error instanceof OracleError &&
        [401, 403, 404].includes(error.status)
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new HttpError(
    404,
    "The Oracle Cloud instance was not found in any connected account.",
    "ORACLE_INSTANCE_NOT_FOUND",
  );
}

async function buildOracleDetail(target) {
  const { account, client, instance } = target;
  let ips;
  let ipsError = null;
  try {
    ips = await client.getInstanceIps(instance);
  } catch (error) {
    if (error instanceof OracleError && error.status === 403) {
      ipsError = "当前 OCI 凭据没有读取 VNIC 的权限。";
    } else {
      throw error;
    }
  }

  return {
    provider: "oracle",
    providerLabel: "Oracle Cloud",
    instance,
    stats: null,
    backups: null,
    events: [],
    ips: ips || null,
    ipsError,
    tokenId: account.id,
    tokenLabel: account.label,
    accountLabel: account.label,
    account: oracleAccountSummary(account),
  };
}

function findPublicIpv4Record(payload) {
  const sharedAddresses = new Set(
    Array.isArray(payload?.ipv4?.shared)
      ? payload.ipv4.shared
          .map((entry) => entry?.address)
          .filter((address) => typeof address === "string")
      : [],
  );

  if (!Array.isArray(payload?.ipv4?.public)) {
    return null;
  }

  return (
    payload.ipv4.public.find(
      (entry) =>
        typeof entry?.address === "string" &&
        entry.public !== false &&
        !sharedAddresses.has(entry.address),
    ) || null
  );
}

function normalizeIpInfo(payload) {
  const publicIpv4 = findPublicIpv4Record(payload);
  const ipv6Ranges = Array.isArray(payload?.ipv6?.global)
    ? payload.ipv6.global
        .map((entry) => {
          const rawRange = cleanString(entry?.range, { maxLength: 128 });
          const prefix = Number(entry?.prefix);
          if (
            !rawRange ||
            !Number.isInteger(prefix) ||
            ![56, 64].includes(prefix)
          ) {
            return null;
          }
          return {
            range: rawRange.includes("/")
              ? rawRange
              : `${rawRange}/${prefix}`,
            prefix,
            routeTarget: cleanString(entry?.route_target, { maxLength: 128 }),
          };
        })
        .filter(Boolean)
    : [];

  return {
    publicIpv4: publicIpv4?.address || "",
    ipv6Slaac: cleanString(payload?.ipv6?.slaac?.address, {
      maxLength: 128,
    }),
    ipv6Ranges,
  };
}

function requireRenewableInstance(instance) {
  if (!["running", "offline"].includes(instance?.status)) {
    throw new HttpError(
      409,
      "The instance is changing state. Wait for it to settle before renewing IPs.",
      "INSTANCE_TRANSITIONAL",
    );
  }
}

function normalizeIpv6RangeResult(payload, prefix) {
  const range = cleanString(payload?.range, { maxLength: 128 });
  if (!range) {
    return "";
  }
  return range.includes("/") ? range : `${range}/${prefix}`;
}

function ipv6RangeAddress(range) {
  return cleanString(range, { maxLength: 128 }).split("/")[0] || "";
}

function ipOperationErrorMessage(error) {
  return (
    cleanString(error?.message, { maxLength: 240 }) ||
    "Linode API 未返回错误详情。"
  );
}

function ipOperationErrorDetails(error) {
  return Array.isArray(error?.details) ? error.details : [];
}

function buildIpSwapSummary(instance, ipInfo) {
  return {
    instanceId: Number(instance.id),
    label: instance.label || `linode-${instance.id}`,
    region: instance.region || "",
    status: instance.status || "",
    publicIpv4: ipInfo.publicIpv4,
    ipv6Slaac: ipInfo.ipv6Slaac,
    ipv6Ranges: ipInfo.ipv6Ranges,
    ipv4Swappable: Boolean(ipInfo.publicIpv4),
    ipv6Swappable: ipInfo.ipv6Ranges.length > 0,
  };
}

function requireSwappableInstance(instance, ipInfo) {
  if (!["running", "offline"].includes(instance?.status)) {
    throw new HttpError(
      409,
      "The instance is changing state. Wait for it to settle before swapping IPs.",
      "INSTANCE_TRANSITIONAL",
    );
  }
  if (!ipInfo.publicIpv4 && ipInfo.ipv6Ranges.length === 0) {
    throw new HttpError(
      400,
      "The instance has no swappable public IP addresses.",
      "NO_SWAPPABLE_IP",
    );
  }
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

async function verifyOracleAccount({
  account,
  proxy,
  endpointResolver,
  timeoutMs = 20_000,
}) {
  const client = new OracleClient({
    tenancyId: account.tenancyId,
    userId: account.userId,
    fingerprint: account.fingerprint,
    privateKey: account.privateKey,
    region: account.region,
    compartmentId: account.compartmentId,
    proxy,
    timeoutMs,
    endpointResolver,
  });
  const verification = await client.verify();
  return {
    ...verification,
    accountLabel: account.label || account.region,
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

function oracleComputeProbeUrl(account, endpointResolver) {
  const base =
    typeof endpointResolver === "function"
      ? endpointResolver({
          service: "compute",
          region: account.region,
        })
      : `https://iaas.${account.region}.oci.oraclecloud.com`;
  return `${String(base).replace(/\/+$/, "")}/20160918/instances`;
}

function createRouter({
  settingsStore,
  apiBase,
  publicDir,
  oracleEndpointResolver,
}) {
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
        version: "1.1.0",
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

    if (
      pathname === "/api/settings/oracle-accounts" &&
      request.method === "POST"
    ) {
      const body = await readJsonBody(request);
      const normalized = normalizeOracleAccountInput(body);
      const proxy = settingsStore.getProxyConfig();
      const verification = await verifyOracleAccount({
        account: {
          ...normalized,
          label: normalized.label || `Oracle · ${normalized.region}`,
        },
        proxy,
        endpointResolver: oracleEndpointResolver,
      });
      const accountId = settingsStore.addOracleAccount({
        label: normalized.label,
        tenancyId: normalized.tenancyId,
        userId: normalized.userId,
        fingerprint: normalized.fingerprint,
        region: normalized.region,
        compartmentId: normalized.compartmentId,
        privateKey: normalized.privateKey,
        accountLabel: `Oracle · ${normalized.region}`,
      });
      sendJson(response, 201, {
        ok: true,
        accountId,
        verification,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    const oracleTestMatch = pathname.match(
      /^\/api\/settings\/oracle-accounts\/([0-9a-f-]+)\/test$/,
    );
    if (oracleTestMatch && request.method === "POST") {
      const account = settingsStore.getOracleAccountById(oracleTestMatch[1]);
      const proxy = settingsStore.getProxyConfig();
      const verification = await verifyOracleAccount({
        account,
        proxy,
        endpointResolver: oracleEndpointResolver,
      });
      settingsStore.recordOracleVerification(account.id);
      sendJson(response, 200, {
        ok: true,
        verification,
        settings: settingsStore.getPublicSettings(),
      });
      return;
    }

    const oracleDeleteMatch = pathname.match(
      /^\/api\/settings\/oracle-accounts\/([0-9a-f-]+)$/,
    );
    if (oracleDeleteMatch && request.method === "DELETE") {
      settingsStore.removeOracleAccount(oracleDeleteMatch[1]);
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
      const oracleAccounts = settingsStore.getOracleAccounts();
      const linodeCredentials = settingsStore.getCredentials();
      const probeTarget =
        linodeCredentials.length === 0 && oracleAccounts.length > 0
          ? oracleComputeProbeUrl(oracleAccounts[0], oracleEndpointResolver)
          : `${apiBase}/regions`;
      const result = await probeUrl(probeTarget, {
        proxy: draft,
        timeoutMs: 20_000,
      });
      sendJson(response, 200, {
        ok: result.statusCode < 500,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        message:
          result.statusCode < 500
            ? "SOCKS 代理已连通云 API 端点。"
            : `代理已连通，但 API 端点返回 HTTP ${result.statusCode}。`,
      });
      return;
    }

    if (
      pathname === "/api/settings/test-connection" &&
      request.method === "POST"
    ) {
      const credentials = settingsStore.getCredentials();
      const oracleAccounts = settingsStore.getOracleAccounts();
      const proxy = settingsStore.getProxyConfig();
      const checks = {
        proxy: { enabled: proxy.enabled, ok: true, message: "未启用代理" },
        token: { ok: false, message: "尚未配置 API 令牌" },
        tokens: [],
        oracle: {
          configured: false,
          ok: true,
          message: "尚未配置 Oracle Cloud 账户",
        },
        oracles: [],
        ok: false,
      };

      if (proxy.enabled) {
        try {
          const probeTarget =
            credentials.length === 0 && oracleAccounts.length > 0
              ? oracleComputeProbeUrl(
                  oracleAccounts[0],
                  oracleEndpointResolver,
                )
              : `${apiBase}/regions`;
          const probe = await probeUrl(probeTarget, {
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

      checks.tokens = await Promise.all(
        credentials.map(async (credential) => {
          try {
            const verification = await verifyApiToken({
              token: credential.token,
              apiBase,
              proxy,
            });
            return {
              tokenId: credential.tokenId,
              ok: true,
              source: credential.source,
              label: credential.label,
              latencyMs: verification.latencyMs,
              accountLabel: verification.accountLabel,
              message: "API 令牌验证通过",
            };
          } catch (error) {
            return {
              tokenId: credential.tokenId,
              ok: false,
              source: credential.source,
              label: credential.label,
              message: error.message || "API 令牌验证失败",
            };
          }
        }),
      );

      if (checks.tokens.length > 0) {
        const okCount = checks.tokens.filter((token) => token.ok).length;
        checks.token = {
          ok: okCount === checks.tokens.length,
          source: "pool",
          label: `${checks.tokens.length} 个令牌`,
          okCount,
          total: checks.tokens.length,
          latencyMs: Math.max(
            ...checks.tokens.map((token) => token.latencyMs || 0),
          ),
          message:
            okCount === checks.tokens.length
              ? `${okCount} 个 API 令牌全部验证通过`
              : `${okCount}/${checks.tokens.length} 个 API 令牌可用`,
        };
      }

      checks.oracles = await Promise.all(
        oracleAccounts.map(async (account) => {
          try {
            const verification = await verifyOracleAccount({
              account,
              proxy,
              endpointResolver: oracleEndpointResolver,
            });
            return {
              accountId: account.id,
              ok: true,
              label: account.label,
              latencyMs: verification.latencyMs,
              region: account.region,
              message: "OCI 请求签名与实例读取验证通过",
            };
          } catch (error) {
            return {
              accountId: account.id,
              ok: false,
              label: account.label,
              region: account.region,
              message: error.message || "Oracle Cloud 账户验证失败",
            };
          }
        }),
      );
      if (checks.oracles.length > 0) {
        const okCount = checks.oracles.filter((account) => account.ok).length;
        checks.oracle = {
          configured: true,
          ok: okCount === checks.oracles.length,
          label: `${checks.oracles.length} 个 Oracle 账户`,
          okCount,
          total: checks.oracles.length,
          latencyMs: Math.max(
            ...checks.oracles.map((account) => account.latencyMs || 0),
          ),
          message:
            okCount === checks.oracles.length
              ? `${okCount} 个 Oracle Cloud 账户全部验证通过`
              : `${okCount}/${checks.oracles.length} 个 Oracle Cloud 账户可用`,
        };
      }

      const hasProvider =
        checks.tokens.length > 0 || checks.oracles.length > 0;
      const providersOk =
        (checks.tokens.length === 0 || checks.token.ok === true) &&
        (checks.oracles.length === 0 || checks.oracle.ok === true);
      checks.ok = checks.proxy.ok && hasProvider && providersOk;
      checks.checkedAt = new Date().toISOString();
      sendJson(response, 200, checks);
      return;
    }

    const proxy = settingsStore.getProxyConfig();
    const entries = optionalCredentialEntries(settingsStore, apiBase, proxy);
    const oracleEntries = optionalOracleEntries(
      settingsStore,
      proxy,
      oracleEndpointResolver,
    );
    const hasConfiguredCredentials =
      entries.length > 0 || oracleEntries.length > 0;

    if (pathname === "/api/overview") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      if (!hasConfiguredCredentials) {
        throw new HttpError(
          401,
          "Connect a Linode API token or Oracle Cloud account to continue.",
          "TOKEN_REQUIRED",
        );
      }
      sendJson(response, 200, await buildOverview(entries, oracleEntries));
      return;
    }

    if (pathname === "/api/catalog") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const credential = resolveCredential(
        settingsStore,
        url.searchParams.get("tokenId"),
      );
      const client = createCredentialClient(credential, apiBase, proxy);
      sendJson(response, 200, await buildCatalog(client));
      return;
    }

    if (pathname === "/api/instances") {
      if (request.method === "GET") {
        if (!hasConfiguredCredentials) {
          throw new HttpError(
            401,
            "Connect a Linode API token or Oracle Cloud account to continue.",
            "TOKEN_REQUIRED",
          );
        }
        sendJson(
          response,
          200,
          await listAggregateInstances(entries, oracleEntries),
        );
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const credential = resolveCredential(settingsStore, body.tokenId);
        const client = createCredentialClient(credential, apiBase, proxy);
        const payload = validateCreatePayload(body);
        const instance = await client.request("/linode/instances", {
          method: "POST",
          body: payload,
        });
        sendJson(response, 201, {
          instance: annotateInstance(instance, credential),
          tokenId: credential.tokenId,
          tokenLabel: credential.label,
        });
        return;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return;
    }

    if (pathname === "/api/oracle/instances") {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      if (oracleEntries.length === 0) {
        throw new HttpError(
          401,
          "Connect an Oracle Cloud account to continue.",
          "ORACLE_ACCOUNT_REQUIRED",
        );
      }

      const accountId = cleanString(url.searchParams.get("accountId"), {
        maxLength: 128,
      });
      const selected = accountId
        ? oracleEntries.filter((entry) => entry.account.id === accountId)
        : oracleEntries;
      if (selected.length === 0) {
        throw new HttpError(
          404,
          "The selected Oracle Cloud account does not exist.",
          "ORACLE_ACCOUNT_NOT_FOUND",
        );
      }

      const slices = await Promise.all(
        selected.map(async ({ account, client }) => {
          try {
            const instances = await client.listInstances();
            return {
              instances: instances.map((instance) =>
                annotateOracleInstance(instance, account),
              ),
              error: null,
            };
          } catch (error) {
            return {
              instances: [],
              error: `${account.label}: ${errorMessage(error)}`,
            };
          }
        }),
      );
      sendJson(response, 200, {
        data: slices.flatMap((slice) => slice.instances),
        errors: slices.map((slice) => slice.error).filter(Boolean),
      });
      return;
    }

    const oracleDetailMatch = pathname.match(
      /^\/api\/oracle\/instances\/([^/]+)\/detail$/,
    );
    if (oracleDetailMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const instanceId = oracleDetailMatch[1];
      if (!isOracleInstanceId(instanceId)) {
        throw new HttpError(
          400,
          "Invalid Oracle instance OCID.",
          "INVALID_ORACLE_INSTANCE_ID",
        );
      }
      const target = await resolveOracleTarget(
        settingsStore,
        proxy,
        instanceId,
        url.searchParams.get("accountId"),
        oracleEndpointResolver,
      );
      sendJson(response, 200, await buildOracleDetail(target));
      return;
    }

    const oracleActionMatch = pathname.match(
      /^\/api\/oracle\/instances\/([^/]+)\/actions\/([a-z-]+)$/,
    );
    if (oracleActionMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }
      const instanceId = oracleActionMatch[1];
      if (!isOracleInstanceId(instanceId)) {
        throw new HttpError(
          400,
          "Invalid Oracle instance OCID.",
          "INVALID_ORACLE_INSTANCE_ID",
        );
      }
      const operation = oracleActionMatch[2];
      const actionMap = {
        boot: "START",
        shutdown: "STOP",
        reboot: "RESET",
      };
      const oracleAction = actionMap[operation];
      if (!oracleAction) {
        throw new HttpError(
          400,
          `Unsupported Oracle instance action: ${operation}`,
          "UNSUPPORTED_ACTION",
        );
      }
      const target = await resolveOracleTarget(
        settingsStore,
        proxy,
        instanceId,
        url.searchParams.get("accountId"),
        oracleEndpointResolver,
      );
      const result = await target.client.invokeAction(
        instanceId,
        oracleAction,
      );
      sendJson(response, 200, {
        ok: true,
        provider: "oracle",
        action: operation,
        oracleAction,
        result: result ? annotateOracleInstance(result, target.account) : null,
      });
      return;
    }

    const oracleInstanceMatch = pathname.match(
      /^\/api\/oracle\/instances\/([^/]+)$/,
    );
    if (oracleInstanceMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const instanceId = oracleInstanceMatch[1];
      if (!isOracleInstanceId(instanceId)) {
        throw new HttpError(
          400,
          "Invalid Oracle instance OCID.",
          "INVALID_ORACLE_INSTANCE_ID",
        );
      }
      const target = await resolveOracleTarget(
        settingsStore,
        proxy,
        instanceId,
        url.searchParams.get("accountId"),
        oracleEndpointResolver,
      );
      sendJson(response, 200, target.instance);
      return;
    }

    const availabilityMatch = pathname.match(/^\/api\/availability\/([a-z0-9-]+)$/);
    if (availabilityMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const region = availabilityMatch[1];
      const credential = resolveCredential(
        settingsStore,
        url.searchParams.get("tokenId"),
      );
      const client = createCredentialClient(credential, apiBase, proxy);
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
      const target = await resolveInstanceTarget(
        settingsStore,
        apiBase,
        proxy,
        instanceId,
        url.searchParams.get("tokenId"),
      );
      sendJson(
        response,
        200,
        await buildDetail(target.client, instanceId, target.credential),
      );
      return;
    }

    const instanceIpsMatch = pathname.match(
      /^\/api\/instances\/(\d+)\/ips$/,
    );
    if (instanceIpsMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      const instanceId = validateInstanceId(instanceIpsMatch[1]);
      const target = await resolveInstanceTarget(
        settingsStore,
        apiBase,
        proxy,
        instanceId,
        url.searchParams.get("tokenId"),
      );
      const [instance, ipPayload] = await Promise.all([
        target.client.request(`/linode/instances/${instanceId}`),
        target.client.request(`/linode/instances/${instanceId}/ips`),
      ]);
      sendJson(
        response,
        200,
        buildIpSwapSummary(instance, normalizeIpInfo(ipPayload)),
      );
      return;
    }

    const ipSwapMatch = pathname.match(
      /^\/api\/instances\/(\d+)\/ip-swap$/,
    );
    if (ipSwapMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }
      const instanceId = validateInstanceId(ipSwapMatch[1]);
      const body = await readJsonBody(request);
      const targetId = validateInstanceId(String(body.targetId || ""));
      const kind = cleanString(body.kind, { maxLength: 16 });
      if (!IP_SWAP_KINDS.has(kind)) {
        throw new HttpError(
          400,
          "IP swap kind must be either ipv4 or ipv6.",
          "INVALID_IP_SWAP_KIND",
        );
      }
      if (targetId === instanceId) {
        throw new HttpError(
          400,
          "Choose a different instance for the IP swap.",
          "SAME_INSTANCE",
        );
      }

      const target = await resolveInstanceTarget(
        settingsStore,
        apiBase,
        proxy,
        instanceId,
        url.searchParams.get("tokenId"),
      );
      let sourceInstance;
      let targetInstance;
      let sourceIpPayload;
      let targetIpPayload;
      try {
        [sourceInstance, targetInstance, sourceIpPayload, targetIpPayload] =
          await Promise.all([
            target.client.request(`/linode/instances/${instanceId}`),
            target.client.request(`/linode/instances/${targetId}`),
            target.client.request(`/linode/instances/${instanceId}/ips`),
            target.client.request(`/linode/instances/${targetId}/ips`),
          ]);
      } catch (error) {
        if (error instanceof LinodeError && error.status === 404) {
          throw new HttpError(
            404,
            "The target instance was not found in the selected account.",
            "TARGET_INSTANCE_NOT_FOUND",
          );
        }
        throw error;
      }

      if (sourceInstance.region !== targetInstance.region) {
        throw new HttpError(
          400,
          "Both instances must be in the same region to swap IP addresses.",
          "INSTANCE_REGION_MISMATCH",
        );
      }

      const sourceIps = normalizeIpInfo(sourceIpPayload);
      const targetIps = normalizeIpInfo(targetIpPayload);
      requireSwappableInstance(sourceInstance, sourceIps);
      requireSwappableInstance(targetInstance, targetIps);

      let sourceAddress;
      let targetAddress;
      if (kind === "ipv4") {
        sourceAddress = sourceIps.publicIpv4;
        targetAddress = targetIps.publicIpv4;
        if (!sourceAddress || !targetAddress) {
          throw new HttpError(
            400,
            "Both instances must have a public IPv4 address.",
            "NO_PUBLIC_IPV4",
          );
        }
      } else {
        sourceAddress = sourceIps.ipv6Ranges[0]?.range;
        targetAddress = targetIps.ipv6Ranges[0]?.range;
        if (!sourceAddress || !targetAddress) {
          throw new HttpError(
            400,
            "Both instances must have an IPv6 /56 or /64 routed range. SLAAC /128 addresses cannot be transferred.",
            "NO_IPV6_RANGE",
          );
        }
      }

      const assignments = [
        { address: sourceAddress, linode_id: Number(targetId) },
        { address: targetAddress, linode_id: Number(instanceId) },
      ];
      await target.client.request("/networking/ips/assign", {
        method: "POST",
        body: {
          region: sourceInstance.region,
          assignments,
        },
      });

      sendJson(response, 200, {
        ok: true,
        kind,
        region: sourceInstance.region,
        source: {
          id: Number(instanceId),
          label: sourceInstance.label || `linode-${instanceId}`,
          address: sourceAddress,
          newAddress: targetAddress,
        },
        target: {
          id: Number(targetId),
          label: targetInstance.label || `linode-${targetId}`,
          address: targetAddress,
          newAddress: sourceAddress,
        },
        requiresReboot: true,
      });
      return;
    }

    const ipRenewMatch = pathname.match(
      /^\/api\/instances\/(\d+)\/ip-renew$/,
    );
    if (ipRenewMatch) {
      if (request.method !== "POST") {
        methodNotAllowed(response, ["POST"]);
        return;
      }

      const instanceId = validateInstanceId(ipRenewMatch[1]);
      const body = await readJsonBody(request);
      const kind = cleanString(body.kind, { maxLength: 16 });
      if (!IP_SWAP_KINDS.has(kind)) {
        throw new HttpError(
          400,
          "IP renewal kind must be either ipv4 or ipv6.",
          "INVALID_IP_RENEW_KIND",
        );
      }

      let ipv6Prefix = 64;
      if (kind === "ipv6" && body.ipv6Prefix !== undefined) {
        ipv6Prefix = Number(body.ipv6Prefix);
        if (![56, 64].includes(ipv6Prefix)) {
          throw new HttpError(
            400,
            "IPv6 prefix must be either 56 or 64.",
            "INVALID_IPV6_PREFIX",
          );
        }
      }

      const target = await resolveInstanceTarget(
        settingsStore,
        apiBase,
        proxy,
        instanceId,
        url.searchParams.get("tokenId"),
      );
      const [instance, ipPayload] = await Promise.all([
        target.client.request(`/linode/instances/${instanceId}`),
        target.client.request(`/linode/instances/${instanceId}/ips`),
      ]);
      requireRenewableInstance(instance);
      const ipInfo = normalizeIpInfo(ipPayload);

      if (kind === "ipv4") {
        const oldRecord = findPublicIpv4Record(ipPayload);
        const oldAddress = cleanString(oldRecord?.address, { maxLength: 64 });
        if (!oldAddress) {
          throw new HttpError(
            400,
            "The instance does not have a public IPv4 address to renew.",
            "NO_PUBLIC_IPV4",
          );
        }

        let newAddress;
        try {
          const allocation = await target.client.request(
            `/linode/instances/${instanceId}/ips`,
            {
              method: "POST",
              body: { type: "ipv4", public: true },
            },
          );
          newAddress = cleanString(allocation?.address, { maxLength: 64 });
          if (!newAddress) {
            throw new HttpError(
              502,
              "Linode API did not return the allocated IPv4 address.",
              "IPV4_ALLOCATION_FAILED",
            );
          }
        } catch (error) {
          if (error instanceof HttpError) {
            throw error;
          }
          throw new HttpError(
            502,
            `未能为实例分配新的公网 IPv4：${ipOperationErrorMessage(error)}。Akamai 要求账户具备额外 IPv4 配额，通常需先提交支持工单；额外 IPv4 会单独计费。旧地址未删除。`,
            "IPV4_ALLOCATION_FAILED",
            ipOperationErrorDetails(error),
          );
        }

        const warnings = [];

        let requiresManualCleanup = false;
        try {
          await target.client.request(
            `/linode/instances/${instanceId}/ips/${encodeURIComponent(oldAddress)}`,
            { method: "DELETE" },
          );
        } catch (error) {
          requiresManualCleanup = true;
          warnings.push(
            `新 IPv4 ${newAddress} 已分配到实例，但旧地址 ${oldAddress} 未能自动释放：${ipOperationErrorMessage(error)}。两个公网 IPv4 会短暂并存，多出的地址可能继续计费；请在 Akamai 控制台手动释放旧地址。`,
          );
        }

        const result = {
          ok: true,
          kind,
          region: instance.region || "",
          oldAddress,
          newAddress,
          requiresReboot: true,
          warnings,
        };
        if (requiresManualCleanup) {
          result.requiresManualCleanup = true;
        }
        sendJson(response, 200, result);
        return;
      }

      const oldRange = ipInfo.ipv6Ranges[0]?.range || null;
      if (oldRange) {
        const oldRangeAddress = ipv6RangeAddress(oldRange);
        try {
          await target.client.request(
            `/networking/ipv6/ranges/${encodeURIComponent(oldRangeAddress)}`,
            { method: "DELETE" },
          );
        } catch (error) {
          throw new HttpError(
            502,
            `旧 IPv6 路由段未能释放：${ipOperationErrorMessage(error)}`,
            "IPV6_RANGE_DELETE_FAILED",
            ipOperationErrorDetails(error),
          );
        }
      }

      let newRange;
      try {
        const created = await target.client.request(
          "/networking/ipv6/ranges",
          {
            method: "POST",
            body: {
              prefix_length: ipv6Prefix,
              linode_id: Number(instanceId),
            },
          },
        );
        newRange = normalizeIpv6RangeResult(created, ipv6Prefix);
        if (!newRange) {
          throw new Error("Linode API did not return the new IPv6 range.");
        }
      } catch (error) {
        if (oldRange) {
          throw new HttpError(
            502,
            `旧 IPv6 路由段已释放，但新的 /${ipv6Prefix} 路由段申请失败：${ipOperationErrorMessage(error)}`,
            "IPV6_RANGE_REPLACE_FAILED",
            ipOperationErrorDetails(error),
          );
        }
        throw new HttpError(
          502,
          `新的 /${ipv6Prefix} IPv6 路由段申请失败：${ipOperationErrorMessage(error)}`,
          "IPV6_RANGE_CREATE_FAILED",
          ipOperationErrorDetails(error),
        );
      }

      sendJson(response, 200, {
        ok: true,
        kind,
        region: instance.region || "",
        oldRange,
        newRange,
        prefix: ipv6Prefix,
        requiresReboot: true,
        warnings: [],
      });
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
      const target = await resolveInstanceTarget(
        settingsStore,
        apiBase,
        proxy,
        instanceId,
        url.searchParams.get("tokenId"),
      );
      const result = await target.client.request(
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
      const target = await resolveInstanceTarget(
        settingsStore,
        apiBase,
        proxy,
        instanceId,
        url.searchParams.get("tokenId"),
      );
      if (request.method === "GET") {
        sendJson(
          response,
          200,
          target.instance ||
            annotateInstance(
              await target.client.request(
                `/linode/instances/${instanceId}`,
              ),
              target.credential,
            ),
        );
      } else {
        await target.client.request(`/linode/instances/${instanceId}`, {
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

  if (error instanceof OracleError) {
    return {
      status: error.status,
      code: error.code || "ORACLE_API_ERROR",
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
  oracleEndpointResolver = null,
  logger = console,
} = {}) {
  if (!settingsStore) {
    throw new Error("A settingsStore instance is required.");
  }
  const route = createRouter({
    settingsStore,
    apiBase,
    publicDir,
    oracleEndpointResolver,
  });

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
