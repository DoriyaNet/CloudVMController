import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
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

import {
  DEFAULT_PROXY,
  SettingsStoreCore,
  SettingsStoreError,
  createDefaultState,
  maskToken,
  normalizePlainState,
} from "./settings-core.js";

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

function deserializeLocalState(parsed, key) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_FILE",
      "data/settings.json must contain a JSON object.",
      500,
    );
  }
  const state = createDefaultState();
  state.activeTokenId =
    typeof parsed.activeTokenId === "string" ? parsed.activeTokenId : null;
  state.tokens = Array.isArray(parsed.tokens)
    ? parsed.tokens
        .filter(
          (token) =>
            token &&
            typeof token.id === "string" &&
            typeof token.encrypted === "string",
        )
        .map((token) => ({
          ...token,
          token: decrypt(token.encrypted, key),
        }))
    : [];
  state.oracleAccounts = Array.isArray(parsed.oracleAccounts)
    ? parsed.oracleAccounts
        .filter(
          (account) =>
            account &&
            typeof account.id === "string" &&
            typeof account.encryptedPrivateKey === "string" &&
            typeof account.tenancyId === "string" &&
            typeof account.userId === "string" &&
            typeof account.fingerprint === "string" &&
            typeof account.region === "string",
        )
        .map((account) => ({
          ...account,
          privateKey: decrypt(account.encryptedPrivateKey, key),
        }))
    : [];
  state.proxy = {
    ...DEFAULT_PROXY,
    ...(parsed.proxy && typeof parsed.proxy === "object" ? parsed.proxy : {}),
  };
  state.proxy.password =
    typeof parsed.proxy?.password === "string" &&
    parsed.proxy.password.length > 0
      ? decrypt(parsed.proxy.password, key)
      : null;
  state.updatedAt = parsed.updatedAt || null;

  return normalizePlainState(state);
}

function serializeLocalState(state, key) {
  return {
    version: state.version,
    activeTokenId: state.activeTokenId,
    tokens: state.tokens.map(({ token, ...record }) => ({
      ...record,
      encrypted: encrypt(token, key),
    })),
    oracleAccounts: state.oracleAccounts.map(
      ({ privateKey, ...record }) => ({
        ...record,
        encryptedPrivateKey: encrypt(privateKey, key),
      }),
    ),
    proxy: {
      ...state.proxy,
      password: state.proxy.password
        ? encrypt(state.proxy.password, key)
        : null,
    },
    updatedAt: state.updatedAt,
  };
}

function writeLocalState(settingsPath, key, state) {
  const tempPath = `${settingsPath}.tmp`;
  const serialized = serializeLocalState(state, key);
  writeFileSync(tempPath, `${JSON.stringify(serialized, null, 2)}\n`, {
    mode: 0o600,
  });
  ensurePrivateMode(tempPath);
  renameSync(tempPath, settingsPath);
  ensurePrivateMode(settingsPath);
}

function loadLocalState(dataDir) {
  const resolvedDataDir = path.resolve(dataDir);
  const settingsPath = path.join(resolvedDataDir, "settings.json");
  const keyPath = path.join(resolvedDataDir, ".key");

  mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });
  const key = readOrCreateKey(keyPath);

  if (!existsSync(settingsPath)) {
    const state = createDefaultState();
    state.updatedAt = new Date().toISOString();
    writeLocalState(settingsPath, key, state);
    return { resolvedDataDir, settingsPath, keyPath, key, state };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    throw new SettingsStoreError(
      "INVALID_SETTINGS_FILE",
      "data/settings.json is not valid JSON. Fix or remove it before starting CloudVMController.",
      500,
    );
  }

  const state = deserializeLocalState(parsed, key);
  return { resolvedDataDir, settingsPath, keyPath, key, state };
}

export class SettingsStore extends SettingsStoreCore {
  constructor({ dataDir, envToken = "" }) {
    const loaded = loadLocalState(dataDir);
    const persist = async (state) => {
      writeLocalState(loaded.settingsPath, loaded.key, state);
    };

    super({
      state: loaded.state,
      envToken,
      persist,
    });

    this.dataDir = loaded.resolvedDataDir;
    this.settingsPath = loaded.settingsPath;
    this.keyPath = loaded.keyPath;
    this.key = loaded.key;
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    await this.persist(this.state);
  }
}

export function openSettingsStore({ dataDir, envToken = "" }) {
  return new SettingsStore({ dataDir, envToken });
}

export { DEFAULT_PROXY, SettingsStoreError, maskToken };
