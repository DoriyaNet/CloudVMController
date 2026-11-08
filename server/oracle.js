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
  bootVolume: /^ocid1\.bootvolume\.oc1\.[a-z0-9._-]+$/i,
  bootVolumeBackup: /^ocid1\.bootvolumebackup\.oc1\.[a-z0-9._-]+$/i,
  consoleConnection:
    /^ocid1\.instanceconsoleconnection\.oc1\.[a-z0-9._-]+$/i,
  consoleHistory:
    /^ocid1\.instanceconsolehistory\.oc1\.[a-z0-9._-]+$/i,
  image: /^ocid1\.image\.oc1\.[a-z0-9._-]+$/i,
  subnet: /^ocid1\.subnet\.oc1\.[a-z0-9._-]+$/i,
  vcn: /^ocid1\.vcn\.oc1\.[a-z0-9._-]+$/i,
};

const METRIC_WINDOWS = {
  "1h": { durationMs: 60 * 60 * 1000, resolution: "1m" },
  "6h": { durationMs: 6 * 60 * 60 * 1000, resolution: "5m" },
  "24h": { durationMs: 24 * 60 * 60 * 1000, resolution: "5m" },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1000, resolution: "5m" },
};

const BOOT_VOLUME_BACKUP_TYPES = new Set(["INCREMENTAL", "FULL"]);
const SSH_PUBLIC_KEY_PATTERN =
  /^(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521))\s+[a-z0-9+/]+={0,2}(?:\s+[^\r\n]*)?$/i;
const RSA_PUBLIC_KEY_PATTERN =
  /^ssh-rsa\s+[a-z0-9+/]+={0,2}(?:\s+[^\r\n]*)?$/i;
const SHAPE_NAME_PATTERN = /^[a-z0-9_.-]+$/i;
const AVAILABILITY_DOMAIN_PATTERN = /^[a-z0-9:_-]+$/i;

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

function normalizeOptionalNumber(value, { min = 0, max = Number.MAX_VALUE } = {}) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }
  return number;
}

function normalizeSshPublicKey(value, { rsaOnly = false } = {}) {
  const key = normalizeString(value, 16_384)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  const pattern = rsaOnly ? RSA_PUBLIC_KEY_PATTERN : SSH_PUBLIC_KEY_PATTERN;
  if (!key || key.includes("\0") || !pattern.test(key)) {
    throw invalidConfig(
      rsaOnly
        ? "OCI 串口控制台只接受 OpenSSH RSA 公钥（ssh-rsa ...）。"
        : "请输入有效的 OpenSSH 公钥。",
    );
  }
  return key;
}

function normalizeSshAuthorizedKeys(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n/);
  const keys = values
    .map((entry) => normalizeString(entry, 16_384))
    .filter(Boolean)
    .map((entry) => normalizeSshPublicKey(entry))
    .slice(0, 10);
  return keys;
}

function normalizeAvailabilityDomain(value) {
  const availabilityDomain = normalizeString(value, 128);
  if (
    !availabilityDomain ||
    !AVAILABILITY_DOMAIN_PATTERN.test(availabilityDomain)
  ) {
    throw invalidConfig("请输入有效的 Oracle 可用域名称。");
  }
  return availabilityDomain;
}

function normalizeDisplayName(value, fallback = "") {
  const displayName = normalizeString(value, 255) || fallback;
  if (!displayName) {
    throw invalidConfig("请输入资源显示名称。");
  }
  return displayName;
}

function normalizeBootVolumeBackupType(value) {
  const type = normalizeString(value, 32).toUpperCase() || "INCREMENTAL";
  if (!BOOT_VOLUME_BACKUP_TYPES.has(type)) {
    throw invalidConfig("启动卷备份类型必须是 INCREMENTAL 或 FULL。");
  }
  return type;
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

export function isOracleBootVolumeBackupId(value) {
  return OCID_PATTERNS.bootVolumeBackup.test(String(value || ""));
}

export function isOracleConsoleConnectionId(value) {
  return OCID_PATTERNS.consoleConnection.test(String(value || ""));
}

export function isOracleConsoleHistoryId(value) {
  return OCID_PATTERNS.consoleHistory.test(String(value || ""));
}

export function buildOracleInstanceCreatePayload(input = {}) {
  const compartmentId = normalizeCompartmentLikeId(input.compartmentId);
  const availabilityDomain = normalizeAvailabilityDomain(
    input.availabilityDomain,
  );
  const displayName = normalizeDisplayName(input.displayName);
  const shape = normalizeString(input.shape, 128);
  if (!shape || !SHAPE_NAME_PATTERN.test(shape)) {
    throw invalidConfig("请输入有效的 OCI Shape 名称。");
  }
  const imageId = normalizeOcid(input.imageId, "image");
  const subnetId = normalizeOcid(input.subnetId, "subnet");
  const sshAuthorizedKeys = normalizeSshAuthorizedKeys(
    input.sshAuthorizedKeys,
  );
  if (sshAuthorizedKeys.length === 0) {
    throw invalidConfig("至少需要一个 SSH 公钥才能登录新实例。");
  }

  const rawUserData =
    typeof input.userData === "string" ? input.userData.trim() : "";
  if (Buffer.byteLength(rawUserData, "utf8") > 65_536) {
    throw invalidConfig("Cloud-init 用户数据不能超过 64 KB。");
  }
  const userData = rawUserData;

  const ocpus = normalizeOptionalNumber(input.ocpus, { min: 0.1, max: 256 });
  const memoryInGBs = normalizeOptionalNumber(input.memoryInGBs, {
    min: 1,
    max: 2_048,
  });
  if ((ocpus === null) !== (memoryInGBs === null)) {
    throw invalidConfig("请同时填写 OCI 实例的 OCPU 和内存。");
  }

  const metadata = {
    ssh_authorized_keys: sshAuthorizedKeys.join("\n"),
  };
  if (userData) {
    metadata.user_data = Buffer.from(userData, "utf8").toString("base64");
  }

  const payload = {
    availabilityDomain,
    compartmentId,
    displayName,
    shape,
    sourceDetails: {
      sourceType: "image",
      imageId,
    },
    createVnicDetails: {
      subnetId,
      assignPublicIp: input.assignPublicIp !== false,
    },
    metadata,
  };
  if (ocpus !== null) {
    payload.shapeConfig = {
      ocpus,
      memoryInGBs,
    };
  }
  return payload;
}

function defaultEndpoint({ service, region }) {
  if (["compute", "network", "blockstorage"].includes(service)) {
    return `https://iaas.${region}.oci.oraclecloud.com`;
  }
  if (service === "monitoring") {
    return `https://telemetry.${region}.oci.oraclecloud.com`;
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

function normalizeBootVolume(bootVolume) {
  return {
    id: normalizeString(bootVolume?.id, 512),
    displayName: normalizeString(bootVolume?.displayName, 255),
    lifecycleState: normalizeString(bootVolume?.lifecycleState, 64),
    sizeInGBs: Number(bootVolume?.sizeInGBs),
  };
}

function normalizeBootVolumeBackup(backup) {
  return {
    id: normalizeString(backup?.id, 512),
    bootVolumeId: normalizeString(backup?.bootVolumeId, 512),
    displayName: normalizeString(backup?.displayName, 255),
    lifecycleState: normalizeString(backup?.lifecycleState, 64),
    type: normalizeString(backup?.type, 32),
    sizeInGBs: Number(backup?.sizeInGBs),
    uniqueSizeInGBs: Number(backup?.uniqueSizeInGBs),
    timeCreated: normalizeString(backup?.timeCreated, 64),
    expirationTime: normalizeString(backup?.expirationTime, 64),
  };
}

function normalizeConsoleConnection(connection) {
  return {
    id: normalizeString(connection?.id, 512),
    instanceId: normalizeString(connection?.instanceId, 512),
    lifecycleState: normalizeString(connection?.lifecycleState, 64),
    connectionString: normalizeString(connection?.connectionString, 16_384),
    vncConnectionString: normalizeString(
      connection?.vncConnectionString,
      16_384,
    ),
    fingerprint: normalizeString(connection?.fingerprint, 255),
    serviceHostKeyFingerprint: normalizeString(
      connection?.serviceHostKeyFingerprint,
      255,
    ),
    timeCreated: normalizeString(connection?.timeCreated, 64),
  };
}

function normalizeConsoleHistory(history) {
  return {
    id: normalizeString(history?.id, 512),
    instanceId: normalizeString(history?.instanceId, 512),
    displayName: normalizeString(history?.displayName, 255),
    lifecycleState: normalizeString(history?.lifecycleState, 64),
    timeCreated: normalizeString(history?.timeCreated, 64),
  };
}

function normalizeShape(shape, availabilityDomain) {
  const name = normalizeString(shape?.shape, 128);
  const ocpuOptions = Array.isArray(shape?.ocpuOptions)
    ? shape.ocpuOptions
    : shape?.ocpuOptions
      ? [shape.ocpuOptions]
      : [];
  const memoryOptions = Array.isArray(shape?.memoryOptions)
    ? shape.memoryOptions
    : shape?.memoryOptions
      ? [shape.memoryOptions]
      : [];
  const ocpuValues = ocpuOptions
    .flatMap((option) => [option?.min, option?.max])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const memoryValues = memoryOptions
    .flatMap((option) => [option?.minInGBs, option?.maxInGBs])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const flexible =
    shape?.isFlexible === true ||
    /\.Flex(?:\.[A-Za-z0-9]+)?$/i.test(name);

  return {
    name,
    label: name,
    availabilityDomain,
    isFlexible: flexible,
    ocpus:
      Number.isFinite(Number(shape?.ocpus)) && Number(shape?.ocpus) > 0
        ? Number(shape.ocpus)
        : null,
    memoryInGBs:
      Number.isFinite(Number(shape?.memoryInGBs)) &&
      Number(shape?.memoryInGBs) > 0
        ? Number(shape.memoryInGBs)
        : null,
    ocpuMin: ocpuValues.length > 0 ? Math.min(...ocpuValues) : 1,
    ocpuMax: ocpuValues.length > 0 ? Math.max(...ocpuValues) : 1,
    memoryMinInGBs:
      memoryValues.length > 0 ? Math.min(...memoryValues) : 1,
    memoryMaxInGBs:
      memoryValues.length > 0 ? Math.max(...memoryValues) : 1,
    gpus: Number(shape?.gpus) || 0,
    localDisks: Number(shape?.localDisks) || 0,
    networkPorts: Number(shape?.networkPorts) || 0,
  };
}

function normalizeImage(image) {
  return {
    id: normalizeString(image?.id, 512),
    displayName: normalizeString(image?.displayName, 255),
    operatingSystem: normalizeString(image?.operatingSystem, 128),
    operatingSystemVersion: normalizeString(
      image?.operatingSystemVersion,
      128,
    ),
    lifecycleState: normalizeString(image?.lifecycleState, 64),
    sizeInGBs: Number(image?.sizeInGBs),
    timeCreated: normalizeString(image?.timeCreated, 64),
  };
}

function normalizeVcn(vcn) {
  return {
    id: normalizeString(vcn?.id, 512),
    displayName: normalizeString(vcn?.displayName, 255),
    cidrBlock: normalizeString(vcn?.cidrBlock, 128),
    lifecycleState: normalizeString(vcn?.lifecycleState, 64),
  };
}

function normalizeSubnet(subnet) {
  return {
    id: normalizeString(subnet?.id, 512),
    displayName: normalizeString(subnet?.displayName, 255),
    vcnId: normalizeString(subnet?.vcnId, 512),
    cidrBlock: normalizeString(subnet?.cidrBlock, 128),
    lifecycleState: normalizeString(subnet?.lifecycleState, 64),
    prohibitPublicIpOnVnic: subnet?.prohibitPublicIpOnVnic === true,
  };
}

function metricPoints(payload, name) {
  if (!Array.isArray(payload)) {
    return [];
  }
  const points = [];
  for (const aggregation of payload) {
    if (normalizeString(aggregation?.name, 128) !== name) {
      continue;
    }
    for (const point of aggregation?.aggregatedDatapoints || []) {
      const timestamp = Date.parse(point?.timestamp || "");
      const value = Number(point?.value);
      if (Number.isFinite(timestamp) && Number.isFinite(value)) {
        points.push([timestamp, value]);
      }
    }
  }
  return points
    .filter(
      (point, index, entries) =>
        index === 0 || point[0] !== entries[index - 1][0],
    )
    .sort((left, right) => left[0] - right[0]);
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
    {
      method = "GET",
      query,
      body,
      headers = {},
      responseType = "json",
    } = {},
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
      Accept:
        responseType === "text"
          ? "text/plain, application/octet-stream, application/json"
          : "application/json",
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

    if (response.status < 200 || response.status >= 300) {
      let payload = null;
      if (response.text) {
        try {
          payload = JSON.parse(response.text);
        } catch {
          const detail = normalizeString(response.text, 500);
          if (detail) {
            payload = { code: "ORACLE_API_ERROR", message: detail };
          }
        }
      }
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

    let payload = null;
    if (response.text) {
      if (responseType === "text") {
        payload = response.text;
      } else {
        try {
          payload = JSON.parse(response.text);
        } catch {
          throw new OracleError(
            502,
            "Oracle API 返回了无效的 JSON 响应。",
            { code: "ORACLE_INVALID_RESPONSE", path },
          );
        }
      }
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

  async listAvailabilityDomains() {
    const domains = await this.paginate(
      "compute",
      `/${API_VERSION}/availabilityDomains`,
      {
        compartmentId: this.tenancyId,
      },
    );
    return domains
      .map((domain) => ({
        name: normalizeString(domain?.name, 128),
        compartmentId: normalizeString(domain?.compartmentId, 512),
      }))
      .filter((domain) => domain.name);
  }

  async listCompartmentsForCreate() {
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

    if (this.compartmentId) {
      const configured = compartments.find(
        (compartment) => compartment?.id === this.compartmentId,
      );
      return [
        {
          id: this.compartmentId,
          name:
            normalizeString(configured?.name, 255) ||
            normalizeString(this.compartmentId, 512),
        },
      ];
    }

    const options = compartments
      .filter(
        (compartment) =>
          compartment?.lifecycleState === "ACTIVE" &&
          OCID_PATTERNS.compartment.test(compartment?.id || ""),
      )
      .map((compartment) => ({
        id: compartment.id,
        name:
          normalizeString(compartment?.name, 255) ||
          normalizeString(compartment?.id, 512),
      }));
    return [
      { id: this.tenancyId, name: "Tenancy 根 Compartment" },
      ...options,
    ].filter(
      (option, index, entries) =>
        entries.findIndex((entry) => entry.id === option.id) === index,
    );
  }

  async listShapes(compartmentId, availabilityDomain) {
    const validCompartmentId = normalizeCompartmentLikeId(compartmentId);
    const validAvailabilityDomain =
      normalizeAvailabilityDomain(availabilityDomain);
    const shapes = await this.paginate("compute", `/${API_VERSION}/shapes`, {
      compartmentId: validCompartmentId,
      availabilityDomain: validAvailabilityDomain,
    });
    return shapes
      .map((shape) => normalizeShape(shape, validAvailabilityDomain))
      .filter((shape) => shape.name);
  }

  async listImages(compartmentId) {
    const validCompartmentId = normalizeCompartmentLikeId(compartmentId);
    const images = await this.paginate("compute", `/${API_VERSION}/images`, {
      compartmentId: validCompartmentId,
      lifecycleState: "AVAILABLE",
    });
    return images.map(normalizeImage).filter((image) => image.id);
  }

  async listVcns(compartmentId) {
    const validCompartmentId = normalizeCompartmentLikeId(compartmentId);
    const vcns = await this.paginate("compute", `/${API_VERSION}/vcns`, {
      compartmentId: validCompartmentId,
    });
    return vcns.map(normalizeVcn).filter((vcn) => vcn.id);
  }

  async listSubnets(compartmentId) {
    const validCompartmentId = normalizeCompartmentLikeId(compartmentId);
    const subnets = await this.paginate(
      "compute",
      `/${API_VERSION}/subnets`,
      {
        compartmentId: validCompartmentId,
      },
    );
    return subnets.map(normalizeSubnet).filter((subnet) => subnet.id);
  }

  async getLaunchCatalog(compartmentId, availabilityDomain = "") {
    const validCompartmentId = normalizeCompartmentLikeId(
      compartmentId || this.compartmentId || this.tenancyId,
    );
    const requestedCompartmentId = normalizeCompartmentLikeId(
      compartmentId || this.compartmentId || this.tenancyId,
    );
    const compartments = await this.listCompartmentsForCreate();
    const availabilityDomains = await this.listAvailabilityDomains();
    if (availabilityDomains.length === 0) {
      throw new OracleError(
        404,
        "当前 OCI 区域没有可用的可用域。",
        { code: "ORACLE_AVAILABILITY_DOMAIN_NOT_FOUND" },
      );
    }
    const selectedAvailabilityDomain = availabilityDomain
      ? normalizeAvailabilityDomain(availabilityDomain)
      : availabilityDomains[0].name;
    if (
      !availabilityDomains.some(
        (entry) => entry.name === selectedAvailabilityDomain,
      )
    ) {
      throw invalidConfig("所选 OCI 可用域不在当前区域的可用域列表中。");
    }

    const [shapes, images, vcns, subnets] = await Promise.all([
      this.listShapes(validCompartmentId, selectedAvailabilityDomain),
      this.listImages(validCompartmentId),
      this.listVcns(validCompartmentId),
      this.listSubnets(validCompartmentId),
    ]);
    return {
      accountCompartmentId: requestedCompartmentId,
      compartmentId: validCompartmentId,
      availabilityDomain: selectedAvailabilityDomain,
      compartments,
      availabilityDomains,
      shapes,
      images,
      vcns,
      subnets,
    };
  }

  async createInstance(payload) {
    return this.request("compute", `/${API_VERSION}/instances`, {
      method: "POST",
      body: payload,
      headers: { "opc-retry-token": randomUUID() },
    });
  }

  async getMetrics(instance, window = "24h") {
    const selectedWindow =
      Object.hasOwn(METRIC_WINDOWS, window) ? window : "24h";
    const { durationMs, resolution } = METRIC_WINDOWS[selectedWindow];
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - durationMs);
    const resourceId = normalizeString(instance?.id, 512);
    const compartmentId = normalizeString(instance?.compartmentId, 512);
    if (!isOracleInstanceId(resourceId) || !compartmentId) {
      throw new OracleError(400, "无效的 Oracle 实例信息。", {
        code: "INVALID_ORACLE_INSTANCE_ID",
      });
    }

    const definitions = [
      {
        key: "cpu",
        label: "CPU 使用率",
        unit: "percent",
        metric: "CpuUtilization",
        operation: "mean",
      },
      {
        key: "memory",
        label: "内存使用率",
        unit: "percent",
        metric: "MemoryUtilization",
        operation: "mean",
      },
      {
        key: "load",
        label: "1 分钟负载",
        unit: "load",
        metric: "LoadAverage",
        operation: "mean",
      },
      {
        key: "networkIn",
        label: "网络入站",
        unit: "bytesPerSecond",
        metric: "NetworksBytesIn",
        operation: "rate",
      },
      {
        key: "networkOut",
        label: "网络出站",
        unit: "bytesPerSecond",
        metric: "NetworksBytesOut",
        operation: "rate",
      },
      {
        key: "diskRead",
        label: "磁盘读取",
        unit: "bytesPerSecond",
        metric: "DiskBytesRead",
        operation: "rate",
      },
      {
        key: "diskWrite",
        label: "磁盘写入",
        unit: "bytesPerSecond",
        metric: "DiskBytesWritten",
        operation: "rate",
      },
    ];
    const settled = await Promise.allSettled(
      definitions.map((definition) => {
        const operation =
          definition.operation === "rate"
            ? "rate()"
            : "mean()";
        return this.request(
          "monitoring",
          "/20180401/metrics/actions/summarizeMetricsData",
          {
            method: "POST",
            query: {
              compartmentId,
              compartmentIdInSubtree: "false",
            },
            body: {
              namespace: "oci_computeagent",
              query: `${definition.metric}[${resolution}]{resourceId = ${JSON.stringify(resourceId)}}.${operation}`,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString(),
              resolution,
            },
          },
        );
      }),
    );

    const metrics = [];
    const errors = [];
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      const result = settled[index];
      if (result.status === "rejected") {
        errors.push({
          metric: definition.key,
          message:
            normalizeString(result.reason?.message, 500) ||
            "指标查询失败。",
        });
        continue;
      }
      metrics.push({
        key: definition.key,
        label: definition.label,
        unit: definition.unit,
        points: metricPoints(result.value, definition.metric),
      });
    }

    const available = metrics.some((metric) => metric.points.length > 0);
    return {
      available,
      window: selectedWindow,
      resolution,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      metrics,
      errors,
      emptyReason:
        !available && errors.length === 0
          ? "OCI 未返回指标数据。请确认实例已启用 Compute Instance Monitoring 插件、Oracle Cloud Agent 正在运行，并且实例可访问 OCI 监控服务。"
          : "",
    };
  }

  async listBootVolumeAttachments(instance) {
    const compartmentId = normalizeString(instance?.compartmentId, 512);
    const availabilityDomain = normalizeString(
      instance?.availabilityDomain,
      128,
    );
    const instanceId = normalizeString(instance?.id, 512);
    if (!isOracleInstanceId(instanceId)) {
      throw new OracleError(400, "无效的 Oracle 实例 OCID。", {
        code: "INVALID_ORACLE_INSTANCE_ID",
      });
    }
    return this.paginate("compute", `/${API_VERSION}/bootVolumeAttachments`, {
      compartmentId,
      availabilityDomain,
      instanceId,
    });
  }

  async getBootVolume(bootVolumeId) {
    const validId = normalizeOcid(bootVolumeId, "bootVolume");
    return this.request(
      "compute",
      `/${API_VERSION}/bootVolumes/${encodeURIComponent(validId)}`,
    );
  }

  async getBootVolumeForInstance(instance) {
    const attachments = await this.listBootVolumeAttachments(instance);
    const attachment = attachments.find(
      (entry) =>
        String(entry?.instanceId) === String(instance?.id) &&
        normalizeString(entry?.bootVolumeId, 512) &&
        ["ATTACHED", "ATTACHING"].includes(
          normalizeString(entry?.lifecycleState, 64).toUpperCase(),
        ),
    );
    const bootVolumeId = normalizeString(attachment?.bootVolumeId, 512);
    if (!bootVolumeId) {
      throw new OracleError(
        404,
        "未能找到该实例的启动卷附件，可能实例尚未完成创建或当前凭据无权读取。",
        { code: "ORACLE_BOOT_VOLUME_NOT_FOUND" },
      );
    }
    return normalizeBootVolume(await this.getBootVolume(bootVolumeId));
  }

  async listBootVolumeBackups(instance, bootVolumeId) {
    const validBootVolumeId = normalizeOcid(bootVolumeId, "bootVolume");
    const compartmentId = normalizeString(instance?.compartmentId, 512);
    const backups = await this.paginate(
      "compute",
      `/${API_VERSION}/bootVolumeBackups`,
      {
        compartmentId,
        bootVolumeId: validBootVolumeId,
      },
    );
    return backups.map(normalizeBootVolumeBackup);
  }

  async getBootVolumeBackup(backupId) {
    const validId = normalizeOcid(backupId, "bootVolumeBackup");
    return this.request(
      "compute",
      `/${API_VERSION}/bootVolumeBackups/${encodeURIComponent(validId)}`,
    );
  }

  async createBootVolumeBackup(bootVolumeId, { displayName, type } = {}) {
    const validBootVolumeId = normalizeOcid(bootVolumeId, "bootVolume");
    return normalizeBootVolumeBackup(
      await this.request("compute", `/${API_VERSION}/bootVolumeBackups`, {
        method: "POST",
        body: {
          bootVolumeId: validBootVolumeId,
          displayName: normalizeDisplayName(displayName),
          type: normalizeBootVolumeBackupType(type),
        },
        headers: { "opc-retry-token": randomUUID() },
      }),
    );
  }

  async deleteBootVolumeBackup(backupId) {
    const validId = normalizeOcid(backupId, "bootVolumeBackup");
    return this.request(
      "compute",
      `/${API_VERSION}/bootVolumeBackups/${encodeURIComponent(validId)}`,
      { method: "DELETE" },
    );
  }

  async getOwnedBootVolumeBackup(instance, backupId) {
    const bootVolume = await this.getBootVolumeForInstance(instance);
    const backup = normalizeBootVolumeBackup(
      await this.getBootVolumeBackup(backupId),
    );
    if (backup.bootVolumeId !== bootVolume.id) {
      throw new OracleError(
        404,
        "该备份不属于目标实例的启动卷，已拒绝操作。",
        { code: "ORACLE_BACKUP_OWNERSHIP_MISMATCH" },
      );
    }
    return { bootVolume, backup };
  }

  async listConsoleConnections(instance) {
    const compartmentId = normalizeString(instance?.compartmentId, 512);
    const connections = await this.paginate(
      "compute",
      `/${API_VERSION}/instanceConsoleConnections`,
      { compartmentId, instanceId: instance?.id },
    );
    return connections.map(normalizeConsoleConnection);
  }

  async createConsoleConnection(instanceId, publicKey) {
    const validInstanceId = normalizeOcid(instanceId, "instance");
    return normalizeConsoleConnection(
      await this.request(
        "compute",
        `/${API_VERSION}/instanceConsoleConnections`,
        {
          method: "POST",
          body: {
            instanceId: validInstanceId,
            publicKey: normalizeSshPublicKey(publicKey, { rsaOnly: true }),
          },
          headers: { "opc-retry-token": randomUUID() },
        },
      ),
    );
  }

  async deleteConsoleConnection(connectionId) {
    const validId = normalizeOcid(connectionId, "consoleConnection");
    return this.request(
      "compute",
      `/${API_VERSION}/instanceConsoleConnections/${encodeURIComponent(validId)}`,
      { method: "DELETE" },
    );
  }

  async listConsoleHistories(instance) {
    const compartmentId = normalizeString(instance?.compartmentId, 512);
    const histories = await this.paginate(
      "compute",
      `/${API_VERSION}/instanceConsoleHistories`,
      { compartmentId, instanceId: instance?.id },
    );
    return histories.map(normalizeConsoleHistory);
  }

  async createConsoleHistory(instanceId, displayName) {
    const validInstanceId = normalizeOcid(instanceId, "instance");
    return normalizeConsoleHistory(
      await this.request(
        "compute",
        `/${API_VERSION}/instanceConsoleHistories`,
        {
          method: "POST",
          body: {
            instanceId: validInstanceId,
            displayName: normalizeDisplayName(
              displayName,
              `console-${validInstanceId.slice(-12)}`,
            ),
          },
          headers: { "opc-retry-token": randomUUID() },
        },
      ),
    );
  }

  async getConsoleHistory(historyId) {
    const validId = normalizeOcid(historyId, "consoleHistory");
    return normalizeConsoleHistory(
      await this.request(
        "compute",
        `/${API_VERSION}/instanceConsoleHistories/${encodeURIComponent(validId)}`,
      ),
    );
  }

  async getConsoleHistoryData(historyId, { offset = 0, length = 32_768 } = {}) {
    const validId = normalizeOcid(historyId, "consoleHistory");
    const validOffset = normalizeOptionalNumber(offset, {
      min: 0,
      max: 16 * 1024 * 1024,
    });
    const validLength = normalizeOptionalNumber(length, {
      min: 1,
      max: 262_144,
    });
    return this.request(
      "compute",
      `/${API_VERSION}/instanceConsoleHistories/${encodeURIComponent(validId)}/data`,
      {
        query: {
          offset: validOffset === null ? 0 : validOffset,
          length: validLength === null ? 32_768 : validLength,
        },
        responseType: "text",
      },
    );
  }

  async deleteConsoleHistory(historyId) {
    const validId = normalizeOcid(historyId, "consoleHistory");
    return this.request(
      "compute",
      `/${API_VERSION}/instanceConsoleHistories/${encodeURIComponent(validId)}`,
      { method: "DELETE" },
    );
  }

  async terminateInstance(
    instanceId,
    {
      preserveBootVolume = false,
      preserveDataVolumesCreatedAtLaunch = false,
    } = {},
  ) {
    const validId = normalizeOcid(instanceId, "instance");
    return this.request(
      "compute",
      `/${API_VERSION}/instances/${encodeURIComponent(validId)}`,
      {
        method: "DELETE",
        query: {
          preserveBootVolume: preserveBootVolume === true,
          preserveDataVolumesCreatedAtLaunch:
            preserveDataVolumesCreatedAtLaunch === true,
        },
        headers: { "opc-retry-token": randomUUID() },
      },
    );
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
