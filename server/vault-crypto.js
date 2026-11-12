import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
} from "node:crypto";
import { promisify } from "node:util";

export const VAULT_FORMAT = "cloudvm-vault";
export const VAULT_VERSION = 1;
export const VAULT_AAD = "cloudvm-vault:v1";
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 10_000_000;
export const MIN_PASSWORD_LENGTH = 8;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KDF_NAME = "PBKDF2-SHA256";
const CIPHER_NAME = "AES-256-GCM";
const pbkdf2Async = promisify(pbkdf2);

export class VaultError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    this.status = status;
  }
}

export class VaultPasswordError extends VaultError {
  constructor(message = "保险库密码不正确。") {
    super("vault_password_invalid", message, 401);
    this.name = "VaultPasswordError";
  }
}

export class VaultPasswordPolicyError extends VaultError {
  constructor(message = `保险库密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`) {
    super("vault_password_too_short", message, 400);
    this.name = "VaultPasswordPolicyError";
  }
}

export class VaultFormatError extends VaultError {
  constructor(message = "保险库文件格式无效。") {
    super("vault_format_invalid", message, 422);
    this.name = "VaultFormatError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new VaultFormatError(`${label} 必须是对象。`);
  }
}

function assertAllowedKeys(object, allowedKeys, label) {
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new VaultFormatError(`${label} 包含未知字段。`);
    }
  }
}

function decodeBase64(value, { expectedLength = null, label }) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new VaultFormatError(`${label} 不是有效的 Base64 值。`);
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new VaultFormatError(`${label} 不是有效的 Base64 值。`);
  }
  if (expectedLength !== null && decoded.length !== expectedLength) {
    throw new VaultFormatError(`${label} 长度无效。`);
  }
  return decoded;
}

function assertPassword(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new VaultPasswordError("请输入保险库密码。");
  }
}

function assertPasswordPolicy(value) {
  assertPassword(value);
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new VaultPasswordPolicyError();
  }
  if (value.length > 1024) {
    throw new VaultPasswordPolicyError("保险库密码过长。");
  }
}

function assertIterations(value) {
  if (
    !Number.isInteger(value) ||
    value < MIN_ITERATIONS ||
    value > MAX_ITERATIONS
  ) {
    throw new VaultFormatError(
      `PBKDF2 迭代次数必须在 ${MIN_ITERATIONS} 到 ${MAX_ITERATIONS} 之间。`,
    );
  }
}

function assertSalt(value) {
  if (!Buffer.isBuffer(value) || value.length !== SALT_BYTES) {
    throw new VaultFormatError("保险库 salt 长度无效。");
  }
}

function assertKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== KEY_BYTES) {
    throw new VaultFormatError("保险库密钥长度无效。");
  }
}

export async function deriveVaultKey(password, salt, iterations) {
  assertPassword(password);
  assertSalt(salt);
  assertIterations(iterations);
  return pbkdf2Async(password, salt, iterations, KEY_BYTES, "sha256");
}

export async function createVaultKey(
  password,
  { iterations = DEFAULT_ITERATIONS, salt = randomBytes(SALT_BYTES) } = {},
) {
  assertPasswordPolicy(password);
  assertIterations(iterations);
  assertSalt(salt);
  const key = await deriveVaultKey(password, salt, iterations);
  return { key, salt, iterations };
}

export async function encryptVaultPayload(
  state,
  key,
  salt,
  iterations = DEFAULT_ITERATIONS,
) {
  assertKey(key);
  assertSalt(salt);
  assertIterations(iterations);

  let plaintext;
  try {
    plaintext = JSON.stringify(state);
  } catch {
    throw new VaultFormatError("保险库内容无法序列化。");
  }
  if (typeof plaintext !== "string") {
    throw new VaultFormatError("保险库内容无法序列化。");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(VAULT_AAD, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const envelope = {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: {
      name: KDF_NAME,
      iterations,
      salt: salt.toString("base64"),
    },
    cipher: {
      name: CIPHER_NAME,
      iv: iv.toString("base64"),
      data: Buffer.concat([ciphertext, tag]).toString("base64"),
    },
  };

  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export async function decryptVaultPayload(envelopeText, password) {
  assertPassword(password);

  let envelope;
  if (typeof envelopeText === "string") {
    try {
      envelope = JSON.parse(envelopeText);
    } catch {
      throw new VaultFormatError("保险库文件不是有效的 JSON。");
    }
  } else {
    envelope = envelopeText;
  }

  assertPlainObject(envelope, "保险库文件");
  assertAllowedKeys(
    envelope,
    ["format", "version", "kdf", "cipher"],
    "保险库文件",
  );
  if (envelope.format !== VAULT_FORMAT) {
    throw new VaultFormatError("保险库格式标识不匹配。");
  }
  if (envelope.version !== VAULT_VERSION) {
    throw new VaultFormatError("保险库版本不受支持。");
  }

  assertPlainObject(envelope.kdf, "kdf");
  assertAllowedKeys(envelope.kdf, ["name", "iterations", "salt"], "kdf");
  if (envelope.kdf.name !== KDF_NAME) {
    throw new VaultFormatError("保险库 KDF 不受支持。");
  }
  assertIterations(envelope.kdf.iterations);
  const salt = decodeBase64(envelope.kdf.salt, {
    expectedLength: SALT_BYTES,
    label: "salt",
  });

  assertPlainObject(envelope.cipher, "cipher");
  assertAllowedKeys(
    envelope.cipher,
    ["name", "iv", "data"],
    "cipher",
  );
  if (envelope.cipher.name !== CIPHER_NAME) {
    throw new VaultFormatError("保险库加密算法不受支持。");
  }
  const iv = decodeBase64(envelope.cipher.iv, {
    expectedLength: IV_BYTES,
    label: "iv",
  });
  const sealed = decodeBase64(envelope.cipher.data, { label: "data" });
  if (sealed.length <= TAG_BYTES) {
    throw new VaultFormatError("保险库密文长度无效。");
  }
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const key = await deriveVaultKey(
    password,
    salt,
    envelope.kdf.iterations,
  );

  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(VAULT_AAD, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VaultPasswordError();
  }

  let state;
  try {
    state = JSON.parse(plaintext);
  } catch {
    throw new VaultFormatError("保险库明文不是有效的 JSON。");
  }
  assertPlainObject(state, "保险库明文");

  return {
    state,
    key,
    salt,
    iterations: envelope.kdf.iterations,
    envelope,
  };
}
