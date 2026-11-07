import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import http from "node:http";
import https from "node:https";

import { createProxyAgent } from "./linode.js";

const API_VERSION = "20160918";
const SIGNING_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const OCID_PATTERNS = {
  tenancy: /^ocid1\.tenancy\.oc1\.[a-z0-9._-]+$/i,
  user: /^ocid1\.user\.oc1\.[a-z0-9._-]+$/i,
  compartment: /^ocid1\.compartment\.oc1\.[a-z0-9._-]+$/i,
  instance: /^ocid1\.instance\.oc1\.[a-z0-9._-]+$/i,
};

export class OracleError extends Error {
  constructor(
    status,
    message,
    { code = "ORACLE_API_ERROR", details = [], path = "" } = {},
  ) {
    super(message);
    this.name = "OracleError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.path = path;
  }
}

function invalidConfig(message) {
  return new OracleError(400, message, { code: "INVALID_ORACLE_CONFIG" });
}

function normalizeString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeOcid(value, kind) {
  const ocid = normalizeString(value, 512);
  if (!ocid || !OCID_PATTERNS[kind].test(ocid)) {
    throw invalidConfig(`请输入有效的 Oracle ${kind} OCID。`);
  }
  return ocid;
}

function normalizeCompartmentLikeId(value) {
  const ocid = normalizeString(value, 512);
  if (
    !OCID_PATTERNS.compartment.test(ocid) &&
    !OCID_PATTERNS.tenancy.test(ocid)
  ) {
    throw invalidConfig("请输入有效的 Oracle Compartment 或 Tenancy OCID。");
  }
  return ocid;
}

function normalizeRegion(value) {
  const region = normalizeString(value, 64).toLowerCase();
  if (!/^[a-z]{2,}(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    throw invalidConfig("Oracle 区域格式无效，例如 us-ashburn-1。");
  }
  return region;
}

function normalizeFingerprint(value) {
  const fingerprint = normalizeString(value, 64).toLowerCase();
  if (
    !/^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/.test(fingerprint) &&
    !/^[0-9a-f]{32}$/.test(fingerprint)
  ) {
    throw invalidConfig("API 密钥指纹应为 32 位十六进制，可带冒号。");
  }
  return fingerprint;
}

function normalizePrivateKey(value) {
  const privateKey = normalizeString(value, 32_768);
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw invalidConfig("请输入 PEM 格式的 OCI API 私钥。");
  }

  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw invalidConfig("OCI API 私钥无法解析，请检查 PEM 内容是否完整。");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw invalidConfig("OCI API 私钥必须是 RSA 私钥。");
  }
  return { privateKey, key };
}

export function normalizeOracleAccountInput(input = {}) {
  const tenancyId = normalizeOcid(input.tenancyId ?? input.tenancy, "tenancy");
  const userId = normalizeOcid(input.userId ?? input.user, "user");
  const fingerprint = normalizeFingerprint(input.fingerprint);
  const region = normalizeRegion(input.region);
  const rawCompartmentId = normalizeString(
    input.compartmentId ?? input.compartment,
    512,
  );
  const compartmentId = rawCompartmentId
    ? normalizeCompartmentLikeId(rawCompartmentId)
    : "";
  const label = normalizeString(input.label, 64);
  const { privateKey, key } = normalizePrivateKey(
    input.privateKey ?? input.private_key,
  );

  return {
    label,
    tenancyId,
    userId,
    fingerprint,
    region,
    compartmentId,
    privateKey,
    key,
  };
}

export function isOracleInstanceId(value) {
  return OCID_PATTERNS.instance.test(String(value || ""));
}

function defaultEndpoint({ service, region }) {
  if (service === "compute") {
    return `https://iaas.${region}.oci.oraclecloud.com`;
  }
  if (service === "identity") {
    return `https://identity.${region}.oci.oraclecloud.com`;
  }
  throw invalidConfig(`不支持的 Oracle API 服务：${service}`);
}

function normalizeEndpointBase(value) {
  const url = new URL(String(value || ""));
  return url.toString().replace(/\/+$/, "");
}

function normalizeErrorDetails(payload) {
  if (Array.isArray(payload?.errors)) {
    return payload.errors.map((entry) => ({
      field: typeof entry?.field === "string" ? entry.field : "",
      reason:
        typeof entry?.reason === "string" ? entry.reason : "Oracle API error",
    }));
  }

  if (payload && (payload.code || payload.message)) {
    return [
      {
        field: normalizeString(payload.code, 120),
        reason: normalizeString(payload.message, 500) || "Oracle API error",
      },
    ];
  }
  return [];
}

function errorMessage(status, details) {
  if (details.length > 0) {
    return details.map((entry) => entry.reason).join("；");
  }
  if (status === 401) {
    return "Oracle API 签名验证失败，请检查用户 OCID、指纹和私钥。";
  }
  if (status === 403) {
    return "Oracle API 凭据没有执行此操作的权限。";
  }
  if (status === 404) {
    return "Oracle 资源或 Compartment 不存在，或当前凭据无权访问。";
  }
  if (status === 429) {
    return "Oracle API 请求频率超限，请稍后重试。";
  }
  return `Oracle API 请求失败（HTTP ${status}）。`;
}

async function performRequest(
  url,
  {
    method = "GET",
    headers = {},
    body = "",
    agent = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const transport = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    const request = transport.request(
      url,
      {
        method,
        headers,
        agent: agent || undefined,
      },
      (response) => {
        const chunks = [];
        let size = 0;

        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(
              new Error("Oracle API response exceeded the size limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(resolve, {
            status: response.statusCode || 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => finish(reject, error));
      },
    );

    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy(new Error("Request timed out"));
    });
    request.on("error", (error) => {
      if (timedOut) {
        finish(
          reject,
          new OracleError(504, "Oracle API request timed out.", {
            code: "ORACLE_TIMEOUT",
          }),
        );
        return;
      }
      finish(
        reject,
        new OracleError(
          502,
          "无法连接 Oracle Cloud API，请检查网络或 SOCKS 代理设置。",
          {
            code: "ORACLE_NETWORK_ERROR",
            details: [{ field: "", reason: error?.message || "Network error" }],
          },
        ),
      );
    });

    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function buildSigningString(method, requestTarget, host, headers, hasBody) {
  const signedHeaders = ["date", "(request-target)", "host"];
  if (hasBody) {
    signedHeaders.push(
      "content-length",
      "content-type",
      "x-content-sha256",
    );
  }

  const values = {
    date: headers.date,
    "(request-target)": `${method.toLowerCase()} ${requestTarget}`,
    host,
    "content-length": headers["content-length"] || "",
    "content-type": headers["content-type"] || "",
    "x-content-sha256": headers["x-content-sha256"] || "",
  };

  return {
    signedHeaders,
    signingString: signedHeaders
      .map((header) => `${header}: ${values[header]}`)
      .join("\n"),
  };
}

function buildAuthorization({ keyId, signedHeaders, signingString, key }) {
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingString, "utf8"),
    key,
  ).toString("base64");
  return `Signature version="${SIGNING_VERSION}",headers="${signedHeaders.join(" ")}",keyId="${keyId}",algorithm="rsa-sha256",signature="${signature}"`;
}

function normalizeVnic(vnic) {
  return {
    id: normalizeString(vnic?.id, 512),
    privateIp: normalizeString(vnic?.privateIp, 128),
    publicIp: normalizeString(vnic?.publicIp, 128),
    ipv6Addresses: Array.isArray(vnic?.ipv6Addresses)
      ? vnic.ipv6Addresses
          .map((entry) => normalizeString(entry, 128))
          .filter(Boolean)
      : [],
  };
}

export function normalizeOracleLifecycleState(value) {
  const state = normalizeString(value, 64).toUpperCase();
  const states = {
    RUNNING: "running",
    STOPPED: "offline",
    STARTING: "booting",
    STOPPING: "shutting_down",
    SOFTSTOPPING: "shutting_down",
    RESETTING: "rebooting",
    REBOOTING: "rebooting",
    SOFTRESETTING: "rebooting",
    PROVISIONING: "provisioning",
    TERMINATING: "deleting",
    TERMINATED: "deleting",
    RESTORING: "restoring",
    MOVING: "migrating",
    UPDATING: "rebuilding",
    FAILED: "failed",
  };
  return states[state] || "transitional";
}

export function normalizeOracleInstance(instance, { region, account } = {}) {
  const shapeConfig = instance?.shapeConfig || {};
  const memoryGb = Number(shapeConfig.memoryInGBs);
  const ocpus = Number(shapeConfig.ocpus);
  const displayName = normalizeString(instance?.displayName, 255);
  const compartmentId = normalizeString(instance?.compartmentId, 512);

  return {
    id: normalizeString(instance?.id, 512),
    provider: "oracle",
    providerLabel: "Oracle Cloud",
    label: displayName || "未命名 OCI 实例",
    status: normalizeOracleLifecycleState(instance?.lifecycleState),
    providerStatus: normalizeString(instance?.lifecycleState, 64),
    region: normalizeString(instance?.region, 64) || region || "",
    availabilityDomain: normalizeString(instance?.availabilityDomain, 128),
    compartmentId,
    compartmentName: account?.compartmentName || "",
    type: normalizeString(instance?.shape, 128),
    image:
      normalizeString(instance?.sourceDetails?.imageId, 512) ||
      normalizeString(instance?.imageId, 512),
    specs: {
      ocpus: Number.isFinite(ocpus) && ocpus > 0 ? ocpus : null,
      vcpus: null,
      memory:
        Number.isFinite(memoryGb) && memoryGb > 0
          ? Math.round(memoryGb * 1024)
          : null,
      disk: null,
    },
    created: normalizeString(instance?.timeCreated, 64),
    updated: "",
    tags: Object.keys(instance?.freeformTags || {})
      .map((tag) => normalizeString(tag, 64))
      .filter(Boolean),
    ipv4: [],
    ipv6: "",
    accountId: account?.id || "",
    tokenId: account?.id || "",
    tokenLabel: account?.label || "",
    accountLabel: account?.label || "",
  };
}

export function collectOracleIps(vnics = []) {
  const privateIpv4s = [
    ...new Set(vnics.map((vnic) => vnic.privateIp).filter(Boolean)),
  ];
  const publicIpv4s = [
    ...new Set(vnics.map((vnic) => vnic.publicIp).filter(Boolean)),
  ];
  const ipv6s = [
    ...new Set(vnics.flatMap((vnic) => vnic.ipv6Addresses || []).filter(Boolean)),
  ];

  return {
    privateIpv4: privateIpv4s[0] || "",
    publicIpv4: publicIpv4s[0] || "",
    ipv6: ipv6s[0] || "",
    privateIpv4s,
    publicIpv4s,
    ipv6s,
  };
}

export class OracleClient {
  constructor({
    tenancyId,
    userId,
    fingerprint,
    privateKey,
    region,
    compartmentId = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    proxy = null,
    endpointResolver = null,
  }) {
    const config = normalizeOracleAccountInput({
      tenancyId,
      userId,
      fingerprint,
      privateKey,
      region,
      compartmentId,
    });

    this.tenancyId = config.tenancyId;
    this.userId = config.userId;
    this.fingerprint = config.fingerprint;
    this.region = config.region;
    this.compartmentId = config.compartmentId;
    this.timeoutMs = timeoutMs;
    this.key = config.key;
    this.endpointResolver =
      typeof endpointResolver === "function"
        ? endpointResolver
        : defaultEndpoint;

    try {
      this.agent = createProxyAgent(proxy || {});
    } catch (error) {
      throw invalidConfig(error?.message || "SOCKS 代理配置无效。");
    }
  }

  endpoint(service) {
    const resolved = this.endpointResolver({
      service,
      region: this.region,
    });
    return normalizeEndpointBase(resolved);
  }

  async requestWithMeta(
    service,
    path,
    { method = "GET", query, body, headers = {} } = {},
  ) {
    const url = new URL(`${this.endpoint(service)}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const upperMethod = String(method).toUpperCase();
    const hasBody = ["POST", "PUT", "PATCH"].includes(upperMethod);
    const requestBody = hasBody
      ? body === undefined
        ? ""
        : JSON.stringify(body)
      : "";
    const requestHeaders = {
      Accept: "application/json",
      Date: new Date().toUTCString(),
      Host: url.host,
      "User-Agent": "CloudVMController/1.1",
      ...headers,
    };

    if (hasBody) {
      requestHeaders["content-length"] = String(
        Buffer.byteLength(requestBody),
      );
      requestHeaders["content-type"] = "application/json";
      requestHeaders["x-content-sha256"] = createHash("sha256")
        .update(requestBody)
        .digest("base64");
    }

    const requestTarget = `${url.pathname}${url.search}`;
    const { signedHeaders, signingString } = buildSigningString(
      upperMethod,
      requestTarget,
      url.host,
      Object.fromEntries(
        Object.entries(requestHeaders).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
      hasBody,
    );
    requestHeaders.Authorization = buildAuthorization({
      keyId: `${this.tenancyId}/${this.userId}/${this.fingerprint}`,
      signedHeaders,
      signingString,
      key: this.key,
    });

    let response;
    try {
      response = await performRequest(url, {
        method: upperMethod,
        headers: requestHeaders,
        body: requestBody,
        agent: this.agent,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof OracleError) {
        error.path = path;
        throw error;
      }
      throw new OracleError(
        502,
        "无法连接 Oracle Cloud API，请检查网络或 SOCKS 代理设置。",
        {
          code: "ORACLE_NETWORK_ERROR",
          details: [{ field: "", reason: error?.message || "Network error" }],
          path,
        },
      );
    }

    let payload = null;
    if (response.text) {
      try {
        payload = JSON.parse(response.text);
      } catch {
        if (response.status >= 200 && response.status < 300) {
          throw new OracleError(
            502,
            "Oracle API 返回了无效的 JSON 响应。",
            { code: "ORACLE_INVALID_RESPONSE", path },
          );
        }
      }
    }

    if (response.status < 200 || response.status >= 300) {
      const details = normalizeErrorDetails(payload);
      throw new OracleError(
        response.status,
        errorMessage(response.status, details),
        {
          code: payload?.code || "ORACLE_API_ERROR",
          details,
          path,
        },
      );
    }

    return {
      data: payload,
      headers: response.headers,
      status: response.status,
    };
  }

  async request(service, path, options) {
    return (await this.requestWithMeta(service, path, options)).data;
  }

  async paginate(service, path, query = {}) {
    const data = [];
    let nextPage = "";

    for (let page = 0; page < 20; page += 1) {
      const response = await this.requestWithMeta(service, path, {
        query: {
          ...query,
          limit: query.limit || 1000,
          ...(nextPage ? { page: nextPage } : {}),
        },
      });
      if (Array.isArray(response.data)) {
        data.push(...response.data);
      }
      nextPage = normalizeString(response.headers["opc-next-page"], 2048);
      if (!nextPage) {
        break;
      }
    }

    return data;
  }

  async listCompartments() {
    return this.paginate("identity", `/${API_VERSION}/compartments`, {
      compartmentId: this.tenancyId,
      compartmentIdInSubtree: true,
      accessLevel: "ACCESSIBLE",
      lifecycleState: "ACTIVE",
    });
  }

  async listCompartmentIds() {
    if (this.compartmentId) {
      return [this.compartmentId];
    }

    let compartments = [];
    try {
      compartments = await this.listCompartments();
    } catch (error) {
      if (
        !(error instanceof OracleError) ||
        ![403, 404].includes(error.status)
      ) {
        throw error;
      }
    }

    return [
      ...new Set([
        this.tenancyId,
        ...compartments
          .filter(
            (compartment) =>
              compartment?.lifecycleState === "ACTIVE" &&
              OCID_PATTERNS.compartment.test(compartment?.id || ""),
          )
          .map((compartment) => compartment.id),
      ]),
    ].slice(0, 200);
  }

  async listInstances() {
    const compartmentIds = await this.listCompartmentIds();
    const slices = [];
    for (let index = 0; index < compartmentIds.length; index += 6) {
      const batch = compartmentIds.slice(index, index + 6);
      slices.push(
        ...(await Promise.all(
          batch.map((compartmentId) =>
            this.paginate("compute", `/${API_VERSION}/instances`, {
              compartmentId,
            }),
          ),
        )),
      );
    }
    const seen = new Set();
    return slices
      .flat()
      .filter((instance) => {
        const id = normalizeString(instance?.id, 512);
        if (!id || seen.has(id)) {
          return false;
        }
        seen.add(id);
        return true;
      });
  }

  async getInstance(instanceId) {
    if (!isOracleInstanceId(instanceId)) {
      throw new OracleError(400, "无效的 Oracle 实例 OCID。", {
        code: "INVALID_ORACLE_INSTANCE_ID",
      });
    }
    return this.request(
      "compute",
      `/${API_VERSION}/instances/${encodeURIComponent(instanceId)}`,
    );
  }

  async listVnicAttachments(compartmentId, instanceId) {
    if (
      !OCID_PATTERNS.compartment.test(compartmentId || "") &&
      !OCID_PATTERNS.tenancy.test(compartmentId || "")
    ) {
      throw new OracleError(400, "无效的 Oracle Compartment OCID。", {
        code: "INVALID_ORACLE_COMPARTMENT_ID",
      });
    }
    return this.paginate("compute", `/${API_VERSION}/vnicAttachments`, {
      compartmentId,
      instanceId,
    });
  }

  async getVnic(vnicId) {
    return this.request(
      "compute",
      `/${API_VERSION}/vnics/${encodeURIComponent(vnicId)}`,
    );
  }

  async getInstanceIps(instance) {
    const attachments = await this.listVnicAttachments(
      instance.compartmentId,
      instance.id,
    );
    const vnicIds = [
      ...new Set(
        attachments
          .filter(
            (attachment) =>
              String(attachment?.instanceId) === String(instance.id) &&
              normalizeString(attachment?.lifecycleState, 64) !== "DETACHED",
          )
          .map((attachment) => normalizeString(attachment?.vnicId, 512))
          .filter(Boolean),
      ),
    ].slice(0, 16);

    const vnics = (
      await Promise.all(
        vnicIds.map((vnicId) =>
          this.getVnic(vnicId).catch((error) => {
            if (error instanceof OracleError && error.status === 404) {
              return null;
            }
            throw error;
          }),
        ),
      )
    )
      .filter(Boolean)
      .map(normalizeVnic);

    return collectOracleIps(vnics);
  }

  async invokeAction(instanceId, action) {
    const allowed = new Set(["START", "STOP", "RESET"]);
    if (!allowed.has(action)) {
      throw new OracleError(400, `不支持的 Oracle 实例操作：${action}`, {
        code: "UNSUPPORTED_ORACLE_ACTION",
      });
    }
    return this.request(
      "compute",
      `/${API_VERSION}/instances/${encodeURIComponent(instanceId)}`,
      {
        method: "POST",
        query: { action },
        headers: { "opc-retry-token": randomUUID() },
      },
    );
  }

  async verify() {
    const startedAt = performance.now();
    const compartmentId = this.compartmentId || this.tenancyId;
    await this.requestWithMeta(
      "compute",
      `/${API_VERSION}/instances`,
      {
        query: { compartmentId, limit: 1 },
      },
    );
    return {
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
