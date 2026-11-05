import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const CONFIG_VERSION = 1;
const DEFAULT_PROXY = {
  enabled: false,
  url: "socks5h://127.0.0.1:7890",
  username: "",
  password: null,
  updatedAt: null,
};

export class SettingsStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SettingsStoreError";
    this.code = code;
    this.status = status;
  }
}

function defaultState() {
  return {
    version: CONFIG_VERSION,
    activeTokenId: null,
    tokens: [],
    proxy: { ...DEFAULT_PROXY },
    updatedAt: null,
  };
}

function ensurePrivateMode(filePath) {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows does not enforce POSIX modes; the file still remains local.
  }
}

function readOrCreateKey(keyPath) {
  if (existsSync(keyPath)) {
    const encoded = readFileSync(keyPath, "utf8").trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new SettingsStoreError(
        "INVALID_ENCRYPTION_KEY",
        "The local encryption key is invalid. Restore data/.key or delete the data directory to reset stored settings.",
        500,
      );
    }
    return key;
  }

  const key = randomBytes(32);
  writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  ensurePrivateMode(keyPath);
  return key;
}

function encrypt(plainText, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

function decrypt(encrypted, key) {
  if (typeof encrypted !== "string") {
    return "";
  }
  const [ivValue, tagValue, ciphertextValue] = encrypted.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) {
    throw new SettingsStoreError(
      "INVALID_ENCRYPTED_VALUE",
      "A stored credential could not be decrypted.",
      500,
    );
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivValue, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SettingsStoreError(
      "DECRYPTION_FAILED",
      "A stored credential could not be decrypted. The local key may have changed.",
      500,
    );
  }
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

function maskToken(token) {
  const value = String(token || "");
  return `••••••••${value.slice(-4)}`;
}

function normalizeLabel(label, fallback = "Linode 令牌") {
  const value = String(label || "").trim();
  return (value || fallback).slice(0, 64);
}

function normalizeProxyUrl(value) {
  return String(value || "").trim();
}

function publicProxyUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "");
  }
}

export class SettingsStore {
  constructor({ dataDir, envToken = "" }) {
    this.dataDir = path.resolve(dataDir);
    this.settingsPath = path.join(this.dataDir, "settings.json");
    this.keyPath = path.join(this.dataDir, ".key");
    this.envToken = String(envToken || "").trim();
    this.key = null;
    this.state = defaultState();
    this.load();
  }

  load() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.key = readOrCreateKey(this.keyPath);

    if (!existsSync(this.settingsPath)) {
      this.save();
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.settingsPath, "utf8"));
    } catch {
      throw new SettingsStoreError(
        "INVALID_SETTINGS_FILE",
        "data/settings.json is not valid JSON. Fix or remove it before starting CloudVMController.",
        500,
      );
    }

    const state = defaultState();
    state.activeTokenId =
      typeof parsed.activeTokenId === "string" ? parsed.activeTokenId : null;
    state.tokens = Array.isArray(parsed.tokens)
      ? parsed.tokens.filter(
          (token) =>
            token &&
            typeof token.id === "string" &&
            typeof token.encrypted === "string",
        )
      : [];
    state.proxy = {
      ...DEFAULT_PROXY,
      ...(parsed.proxy && typeof parsed.proxy === "object" ? parsed.proxy : {}),
    };
    state.updatedAt = parsed.updatedAt || null;

    if (
      state.activeTokenId &&
      !state.tokens.some((token) => token.id === state.activeTokenId)
    ) {
      state.activeTokenId = state.tokens[0]?.id || null;
    }
    this.state = state;
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    const tempPath = `${this.settingsPath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      mode: 0o600,
    });
    ensurePrivateMode(tempPath);
    renameSync(tempPath, this.settingsPath);
    ensurePrivateMode(this.settingsPath);
  }

  getActiveTokenRecord() {
    return (
      this.state.tokens.find(
        (token) => token.id === this.state.activeTokenId,
      ) || null
    );
  }

  getCredential() {
    const record = this.getActiveTokenRecord();
    if (record) {
      return {
        token: decrypt(record.encrypted, this.key),
        source: "web",
        label: record.label,
        tokenId: record.id,
        accountLabel: record.accountLabel || "",
        active: true,
      };
    }
    if (this.envToken) {
      return {
        token: this.envToken,
        source: "env",
        label: "服务端 .env 令牌",
        tokenId: "env",
        accountLabel: "",
        active: true,
      };
    }
    return {
      token: "",
      source: "none",
      label: "",
      tokenId: null,
      accountLabel: "",
      active: false,
    };
  }

  getCredentials() {
    const credentials = this.state.tokens.map((record) => ({
      token: decrypt(record.encrypted, this.key),
      source: "web",
      label: record.label,
      tokenId: record.id,
      accountLabel: record.accountLabel || "",
      active: record.id === this.state.activeTokenId,
    }));

    if (credentials.length === 0 && this.envToken) {
      credentials.push({
        token: this.envToken,
        source: "env",
        label: "服务端 .env 令牌",
        tokenId: "env",
        accountLabel: "",
        active: true,
      });
    }

    return credentials;
  }

  getTokenById(id) {
    const record = this.state.tokens.find((token) => token.id === id);
    if (!record) {
      throw new SettingsStoreError(
        "TOKEN_NOT_FOUND",
        "The selected API token does not exist.",
        404,
      );
    }
    return {
      ...record,
      token: decrypt(record.encrypted, this.key),
    };
  }

  getPublicSettings() {
    const credential = this.getCredential();
    const activeRecord = this.getActiveTokenRecord();
    const credentials = this.state.tokens.map((token) => ({
      id: token.id,
      label: token.label,
      accountLabel: token.accountLabel || "",
      source: "web",
      active: token.id === this.state.activeTokenId,
    }));
    if (credentials.length === 0 && this.envToken) {
      credentials.push({
        id: "env",
        label: "服务端 .env 令牌",
        accountLabel: "",
        source: "env",
        active: true,
      });
    }

    return {
      tokenConfigured: Boolean(credential.token),
      credentialSource: credential.source,
      credentialLabel: credential.label,
      activeTokenId: activeRecord?.id || null,
      envTokenConfigured: Boolean(this.envToken),
      poolSize: credentials.length,
      credentials,
      tokens: this.state.tokens.map((token) => ({
        id: token.id,
        label: token.label,
        masked: token.masked,
        accountLabel: token.accountLabel || "",
        createdAt: token.createdAt || null,
        lastVerifiedAt: token.lastVerifiedAt || null,
        active: token.id === this.state.activeTokenId,
      })),
      proxy: {
        enabled: this.state.proxy.enabled === true,
        url: publicProxyUrl(this.state.proxy.url || DEFAULT_PROXY.url),
        username: this.state.proxy.username || "",
        hasPassword: Boolean(this.state.proxy.password),
        updatedAt: this.state.proxy.updatedAt || null,
      },
    };
  }

  getProxyConfig() {
    return {
      enabled: this.state.proxy.enabled === true,
      url: this.state.proxy.url || DEFAULT_PROXY.url,
      username: this.state.proxy.username || "",
      password: this.state.proxy.password
        ? decrypt(this.state.proxy.password, this.key)
        : "",
    };
  }

  getEnvToken() {
    return this.envToken;
  }

  addToken({ label, token, accountLabel = "" }) {
    const value = String(token || "").trim();
    if (!value) {
      throw new SettingsStoreError(
        "TOKEN_REQUIRED",
        "An API token is required.",
        400,
      );
    }
    if (value.length > 512) {
      throw new SettingsStoreError(
        "TOKEN_TOO_LONG",
        "The API token is too long.",
        400,
      );
    }

    const fingerprint = tokenFingerprint(value);
    if (
      this.state.tokens.some((entry) => entry.fingerprint === fingerprint)
    ) {
      throw new SettingsStoreError(
        "DUPLICATE_TOKEN",
        "This API token is already saved.",
        409,
      );
    }

    const record = {
      id: randomUUID(),
      label: normalizeLabel(label, accountLabel),
      accountLabel: String(accountLabel || "").slice(0, 128),
      masked: maskToken(value),
      fingerprint,
      encrypted: encrypt(value, this.key),
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };
    this.state.tokens.unshift(record);
    if (!this.state.activeTokenId) {
      this.state.activeTokenId = record.id;
    }
    this.save();
    return record.id;
  }

  activateToken(id) {
    if (!this.state.tokens.some((token) => token.id === id)) {
      throw new SettingsStoreError(
        "TOKEN_NOT_FOUND",
        "The selected API token does not exist.",
        404,
      );
    }
    this.state.activeTokenId = id;
    this.save();
  }

  removeToken(id) {
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((token) => token.id !== id);
    if (this.state.tokens.length === before) {
      throw new SettingsStoreError(
        "TOKEN_NOT_FOUND",
        "The selected API token does not exist.",
        404,
      );
    }
    if (this.state.activeTokenId === id) {
      this.state.activeTokenId = this.state.tokens[0]?.id || null;
    }
    this.save();
  }

  recordVerification(id, { accountLabel = "" } = {}) {
    const record = this.state.tokens.find((token) => token.id === id);
    if (!record) {
      return;
    }
    if (accountLabel) {
      record.accountLabel = String(accountLabel).slice(0, 128);
    }
    record.lastVerifiedAt = new Date().toISOString();
    this.save();
  }

  updateProxy({ enabled, url, username, password }) {
    this.state.proxy = {
      ...this.state.proxy,
      enabled: enabled === true,
      url: normalizeProxyUrl(url) || DEFAULT_PROXY.url,
      username: String(username || "").trim().slice(0, 128),
      updatedAt: new Date().toISOString(),
    };

    if (typeof password === "string" && password.length > 0) {
      this.state.proxy.password = encrypt(password, this.key);
    }
    this.save();
  }
}

export function openSettingsStore({ dataDir, envToken = "" }) {
  return new SettingsStore({ dataDir, envToken });
}

export { DEFAULT_PROXY, maskToken };
