import { createHash, randomUUID } from "node:crypto";

const CONFIG_VERSION = 2;

export const DEFAULT_PROXY = {
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

export function createDefaultState() {
  return {
    version: CONFIG_VERSION,
    activeTokenId: null,
    tokens: [],
    oracleAccounts: [],
    proxy: { ...DEFAULT_PROXY },
    updatedAt: null,
  };
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function maskToken(token) {
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

function normalizeTimestamp(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeTokenRecord(record) {
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.token !== "string" ||
    !record.token ||
    record.token.length > 512
  ) {
    return null;
  }

  return {
    id: record.id,
    label: normalizeLabel(record.label, record.accountLabel),
    accountLabel: String(record.accountLabel || "").slice(0, 128),
    masked:
      typeof record.masked === "string" && record.masked
        ? record.masked
        : maskToken(record.token),
    fingerprint:
      typeof record.fingerprint === "string" && record.fingerprint
        ? record.fingerprint
        : tokenFingerprint(record.token),
    token: record.token,
    createdAt: normalizeTimestamp(record.createdAt),
    lastVerifiedAt: normalizeTimestamp(record.lastVerifiedAt),
  };
}

function normalizeOracleAccount(record) {
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.privateKey !== "string" ||
    !record.privateKey ||
    record.privateKey.length > 32_768 ||
    typeof record.tenancyId !== "string" ||
    typeof record.userId !== "string" ||
    typeof record.fingerprint !== "string" ||
    typeof record.region !== "string"
  ) {
    return null;
  }

  const identity = `${record.tenancyId}\n${record.userId}\n${record.fingerprint}`;

  return {
    id: record.id,
    label: normalizeLabel(
      record.label,
      record.accountLabel || `Oracle · ${record.region || "OCI"}`,
    ),
    tenancyId: String(record.tenancyId).slice(0, 512),
    userId: String(record.userId).slice(0, 512),
    fingerprint: String(record.fingerprint).slice(0, 64),
    region: String(record.region).slice(0, 64),
    compartmentId: String(record.compartmentId || "").slice(0, 512),
    maskedPrivateKey: record.maskedPrivateKey || "•••••••• RSA KEY",
    identityFingerprint:
      typeof record.identityFingerprint === "string" &&
      record.identityFingerprint
        ? record.identityFingerprint
        : tokenFingerprint(identity),
    privateKey: record.privateKey,
    createdAt: normalizeTimestamp(record.createdAt),
    lastVerifiedAt: normalizeTimestamp(record.lastVerifiedAt),
  };
}

export function normalizePlainState(input, { strict = false } = {}) {
  const state = createDefaultState();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (strict) {
      throw new SettingsStoreError(
        "INVALID_SETTINGS_STATE",
        "The settings state must be an object.",
        500,
      );
    }
    return state;
  }

  state.activeTokenId =
    typeof input.activeTokenId === "string" ? input.activeTokenId : null;
  const tokenInputs = Array.isArray(input.tokens) ? input.tokens : [];
  const oracleInputs = Array.isArray(input.oracleAccounts)
    ? input.oracleAccounts
    : [];
  if (strict && input.tokens !== undefined && !Array.isArray(input.tokens)) {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_STATE",
      "The settings state tokens field must be an array.",
      500,
    );
  }
  if (
    strict &&
    input.oracleAccounts !== undefined &&
    !Array.isArray(input.oracleAccounts)
  ) {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_STATE",
      "The settings state oracleAccounts field must be an array.",
      500,
    );
  }
  if (
    strict &&
    input.proxy !== undefined &&
    (input.proxy === null ||
      typeof input.proxy !== "object" ||
      Array.isArray(input.proxy))
  ) {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_STATE",
      "The settings state proxy field must be an object.",
      500,
    );
  }
  state.tokens = tokenInputs.map(normalizeTokenRecord).filter(Boolean);
  state.oracleAccounts = oracleInputs
    .map(normalizeOracleAccount)
    .filter(Boolean);
  if (strict && state.tokens.length !== tokenInputs.length) {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_STATE",
      "The settings state contains an invalid Linode token record.",
      500,
    );
  }
  if (strict && state.oracleAccounts.length !== oracleInputs.length) {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_STATE",
      "The settings state contains an invalid Oracle account record.",
      500,
    );
  }
  state.proxy = {
    ...DEFAULT_PROXY,
    ...(input.proxy && typeof input.proxy === "object"
      ? {
          enabled: input.proxy.enabled === true,
          url:
            normalizeProxyUrl(input.proxy.url) || DEFAULT_PROXY.url,
          username: String(input.proxy.username || "")
            .trim()
            .slice(0, 128),
          password:
            typeof input.proxy.password === "string" &&
            input.proxy.password.length > 0
              ? input.proxy.password
              : null,
          updatedAt: normalizeTimestamp(input.proxy.updatedAt),
        }
      : {}),
  };
  state.updatedAt = normalizeTimestamp(input.updatedAt);

  if (
    state.activeTokenId &&
    !state.tokens.some((token) => token.id === state.activeTokenId)
  ) {
    state.activeTokenId = state.tokens[0]?.id || null;
  }

  return state;
}

export class SettingsStoreCore {
  constructor({ state, envToken = "", persist = null } = {}) {
    this.state = normalizePlainState(state);
    this.envToken = String(envToken || "").trim();
    this.persist = typeof persist === "function" ? persist : null;
    this._writeChain = Promise.resolve();
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
        token: record.token,
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
      token: record.token,
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
    return { ...record };
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
    const oracleAccounts = this.state.oracleAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      tenancyId: account.tenancyId,
      userId: account.userId,
      fingerprint: account.fingerprint,
      region: account.region,
      compartmentId: account.compartmentId || "",
      maskedPrivateKey: account.maskedPrivateKey || "••••••••",
      createdAt: account.createdAt || null,
      lastVerifiedAt: account.lastVerifiedAt || null,
    }));

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
      oracleConfigured: oracleAccounts.length > 0,
      oracleAccounts,
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
      password: this.state.proxy.password || "",
    };
  }

  getEnvToken() {
    return this.envToken;
  }

  getOracleAccounts() {
    return this.state.oracleAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      tenancyId: account.tenancyId,
      userId: account.userId,
      fingerprint: account.fingerprint,
      region: account.region,
      compartmentId: account.compartmentId || "",
      privateKey: account.privateKey,
      createdAt: account.createdAt || null,
      lastVerifiedAt: account.lastVerifiedAt || null,
    }));
  }

  getOracleAccountById(id) {
    const account = this.state.oracleAccounts.find((entry) => entry.id === id);
    if (!account) {
      throw new SettingsStoreError(
        "ORACLE_ACCOUNT_NOT_FOUND",
        "The selected Oracle Cloud account does not exist.",
        404,
      );
    }
    return {
      id: account.id,
      label: account.label,
      tenancyId: account.tenancyId,
      userId: account.userId,
      fingerprint: account.fingerprint,
      region: account.region,
      compartmentId: account.compartmentId || "",
      privateKey: account.privateKey,
      createdAt: account.createdAt || null,
      lastVerifiedAt: account.lastVerifiedAt || null,
    };
  }

  exportPlainState() {
    return structuredClone(this.state);
  }

  async _commit(mutator) {
    const run = async () => {
      const previous = structuredClone(this.state);
      try {
        const result = mutator();
        this.state.updatedAt = new Date().toISOString();
        if (this.persist) {
          await this.persist(this.state);
        }
        return result;
      } catch (error) {
        this.state = previous;
        throw error;
      }
    };
    const task = this._writeChain.then(run, run);
    this._writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async addOracleAccount({
    label,
    tenancyId,
    userId,
    fingerprint,
    region,
    compartmentId = "",
    privateKey,
    accountLabel = "",
  }) {
    const value = String(privateKey || "").trim();
    if (!value) {
      throw new SettingsStoreError(
        "ORACLE_PRIVATE_KEY_REQUIRED",
        "An Oracle API private key is required.",
        400,
      );
    }
    if (value.length > 32_768) {
      throw new SettingsStoreError(
        "ORACLE_PRIVATE_KEY_TOO_LONG",
        "The Oracle API private key is too long.",
        400,
      );
    }

    const identity = `${tenancyId}\n${userId}\n${fingerprint}`;
    const fingerprintHash = tokenFingerprint(identity);

    const record = {
      id: randomUUID(),
      label: normalizeLabel(
        label,
        accountLabel || `Oracle · ${region || "OCI"}`,
      ),
      tenancyId: String(tenancyId || "").slice(0, 512),
      userId: String(userId || "").slice(0, 512),
      fingerprint: String(fingerprint || "").slice(0, 64),
      region: String(region || "").slice(0, 64),
      compartmentId: String(compartmentId || "").slice(0, 512),
      maskedPrivateKey: "•••••••• RSA KEY",
      identityFingerprint: fingerprintHash,
      privateKey: value,
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };

    return this._commit(() => {
      if (
        this.state.oracleAccounts.some(
          (entry) => entry.identityFingerprint === fingerprintHash,
        )
      ) {
        throw new SettingsStoreError(
          "DUPLICATE_ORACLE_ACCOUNT",
          "This Oracle Cloud account is already saved.",
          409,
        );
      }
      this.state.oracleAccounts.unshift(record);
      return record.id;
    });
  }

  async removeOracleAccount(id) {
    return this._commit(() => {
      if (!this.state.oracleAccounts.some((account) => account.id === id)) {
        throw new SettingsStoreError(
          "ORACLE_ACCOUNT_NOT_FOUND",
          "The selected Oracle Cloud account does not exist.",
          404,
        );
      }
      this.state.oracleAccounts = this.state.oracleAccounts.filter(
        (account) => account.id !== id,
      );
    });
  }

  async recordOracleVerification(id) {
    return this._commit(() => {
      const account = this.state.oracleAccounts.find(
        (entry) => entry.id === id,
      );
      if (!account) {
        return;
      }
      account.lastVerifiedAt = new Date().toISOString();
    });
  }

  async addToken({ label, token, accountLabel = "" }) {
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

    const record = {
      id: randomUUID(),
      label: normalizeLabel(label, accountLabel),
      accountLabel: String(accountLabel || "").slice(0, 128),
      masked: maskToken(value),
      fingerprint,
      token: value,
      createdAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };

    return this._commit(() => {
      if (
        this.state.tokens.some(
          (entry) => entry.fingerprint === fingerprint,
        )
      ) {
        throw new SettingsStoreError(
          "DUPLICATE_TOKEN",
          "This API token is already saved.",
          409,
        );
      }
      this.state.tokens.unshift(record);
      if (!this.state.activeTokenId) {
        this.state.activeTokenId = record.id;
      }
      return record.id;
    });
  }

  async activateToken(id) {
    return this._commit(() => {
      if (!this.state.tokens.some((token) => token.id === id)) {
        throw new SettingsStoreError(
          "TOKEN_NOT_FOUND",
          "The selected API token does not exist.",
          404,
        );
      }
      this.state.activeTokenId = id;
    });
  }

  async removeToken(id) {
    return this._commit(() => {
      if (!this.state.tokens.some((token) => token.id === id)) {
        throw new SettingsStoreError(
          "TOKEN_NOT_FOUND",
          "The selected API token does not exist.",
          404,
        );
      }
      this.state.tokens = this.state.tokens.filter(
        (token) => token.id !== id,
      );
      if (this.state.activeTokenId === id) {
        this.state.activeTokenId = this.state.tokens[0]?.id || null;
      }
    });
  }

  async recordVerification(id, { accountLabel = "" } = {}) {
    return this._commit(() => {
      const record = this.state.tokens.find((token) => token.id === id);
      if (!record) {
        return;
      }
      if (accountLabel) {
        record.accountLabel = String(accountLabel).slice(0, 128);
      }
      record.lastVerifiedAt = new Date().toISOString();
    });
  }

  async updateProxy({ enabled, url, username, password }) {
    return this._commit(() => {
      this.state.proxy = {
        ...this.state.proxy,
        enabled: enabled === true,
        url: normalizeProxyUrl(url) || DEFAULT_PROXY.url,
        username: String(username || "").trim().slice(0, 128),
        updatedAt: new Date().toISOString(),
      };

      if (typeof password === "string" && password.length > 0) {
        this.state.proxy.password = password;
      }
    });
  }
}
