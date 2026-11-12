import {
  SettingsStoreCore,
  createDefaultState,
  normalizePlainState,
} from "./settings-core.js";
import {
  DEFAULT_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  VaultError,
  VaultFormatError,
  VaultPasswordError,
  VaultPasswordPolicyError,
  createVaultKey,
  decryptVaultPayload,
  encryptVaultPayload,
} from "./vault-crypto.js";

export const DEFAULT_VAULT_MAX_BYTES = 512 * 1024;

export class VaultStoreError extends VaultError {
  constructor(status, code, message) {
    super(code, message, status);
    this.name = "VaultStoreError";
  }
}

export class VaultConflictError extends VaultStoreError {
  constructor(
    message = "保险库已在其他设备上更新，请重新加载后再试。",
  ) {
    super(409, "vault_conflict", message);
    this.name = "VaultConflictError";
  }
}

export class VaultTooLargeError extends VaultStoreError {
  constructor(message = "保险库文件超过 512 KiB 限制。") {
    super(413, "vault_too_large", message);
    this.name = "VaultTooLargeError";
  }
}

export class VaultNotFoundError extends VaultStoreError {
  constructor(message = "保险库文件不存在。") {
    super(404, "vault_not_found", message);
    this.name = "VaultNotFoundError";
  }
}

function mapRemoteError(error) {
  if (
    error instanceof VaultError ||
    error instanceof VaultStoreError
  ) {
    return error;
  }

  const status = Number(error?.status);
  if (status === 409 || status === 422) {
    return new VaultConflictError(
      "保险库已在其他设备上更新，请重新加载后再试。",
    );
  }
  if (status === 403) {
    return new VaultStoreError(
      403,
      "vault_forbidden",
      "GitHub App 无权写入该私有仓库。",
    );
  }
  if (status === 404) {
    return new VaultStoreError(
      404,
      "repository_not_found",
      "找不到目标私有仓库或保险库路径。",
    );
  }
  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 600 &&
    typeof error?.code === "string" &&
    error.code
  ) {
    return new VaultStoreError(
      status,
      error.code,
      error.message || "GitHub 保险库请求失败，请稍后重试。",
    );
  }
  return new VaultStoreError(
    502,
    "github_api_error",
    "GitHub 保险库请求失败，请稍后重试。",
  );
}

function normalizeImportState(importState) {
  if (!importState) {
    return createDefaultState();
  }
  const source =
    typeof importState.exportPlainState === "function"
      ? importState.exportPlainState()
      : importState;
  try {
    return normalizePlainState(source, { strict: true });
  } catch {
    throw new VaultFormatError("导入的本地设置数据结构无效。");
  }
}

function assertVaultBackend(readVaultFile, writeVaultFile) {
  if (
    typeof readVaultFile !== "function" ||
    typeof writeVaultFile !== "function"
  ) {
    throw new VaultStoreError(
      500,
      "vault_backend_missing",
      "保险库 GitHub 存储后端未配置。",
    );
  }
}

function normalizeMaxBytes(value) {
  const maxBytes = Number(value);
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    return DEFAULT_VAULT_MAX_BYTES;
  }
  return Math.floor(maxBytes);
}

function assertContentSize(content, maxBytes) {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new VaultTooLargeError(
      `保险库文件超过 ${Math.floor(maxBytes / 1024)} KiB 限制。`,
    );
  }
}

function createPersist({
  installationToken,
  repository,
  key,
  salt,
  iterations,
  maxBytes,
  writeVaultFile,
  fetchImpl,
  meta,
}) {
  return async (state) => {
    const content = await encryptVaultPayload(
      state,
      key,
      salt,
      iterations,
    );
    assertContentSize(content, maxBytes);

    let result;
    try {
      result = await writeVaultFile({
        installationToken,
        repository,
        content,
        sha: meta.sha,
        fetchImpl,
      });
    } catch (error) {
      throw mapRemoteError(error);
    }

    if (typeof result?.sha === "string") {
      meta.sha = result.sha;
    }
    meta.htmlUrl =
      typeof result?.htmlUrl === "string"
        ? result.htmlUrl
        : meta.htmlUrl;
    meta.updatedAt = state.updatedAt || new Date().toISOString();
  };
}

function decorateVaultStore(store, key, meta) {
  Object.defineProperties(store, {
    getVaultMeta: {
      value: () => ({
        repository: meta.repository,
        installationId: meta.installationId,
        sha: meta.sha,
        htmlUrl: meta.htmlUrl,
        updatedAt: meta.updatedAt,
      }),
      enumerable: false,
    },
    dispose: {
      value: () => {
        store.persist = null;
        store.state = createDefaultState();
        store.envToken = "";
        Promise.resolve(store._writeChain).then(() => {
          if (Buffer.isBuffer(key)) {
            key.fill(0);
          }
        });
      },
      enumerable: false,
    },
  });
  return store;
}

export async function openVaultSettingsStore({
  installationToken,
  installationId = null,
  repository,
  password,
  createIfMissing = true,
  importState = null,
  readVaultFile,
  writeVaultFile,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_VAULT_MAX_BYTES,
  iterations = DEFAULT_ITERATIONS,
} = {}) {
  assertVaultBackend(readVaultFile, writeVaultFile);

  const normalizedRepository = String(repository || "").trim();
  if (!normalizedRepository) {
    throw new VaultStoreError(
      400,
      "invalid_repository",
      "必须选择私有仓库。",
    );
  }
  const limit = normalizeMaxBytes(maxBytes);

  let file;
  try {
    file = await readVaultFile({
      installationToken,
      repository: normalizedRepository,
      fetchImpl,
    });
  } catch (error) {
    if (Number(error?.status) === 404 && createIfMissing) {
      file = { exists: false, sha: null, content: null, htmlUrl: null };
    } else {
      throw mapRemoteError(error);
    }
  }

  if (!file?.exists) {
    if (!createIfMissing) {
      throw new VaultNotFoundError();
    }

    const state = normalizeImportState(importState);
    const keyInfo = await createVaultKey(password, { iterations });
    const content = await encryptVaultPayload(
      state,
      keyInfo.key,
      keyInfo.salt,
      keyInfo.iterations,
    );
    assertContentSize(content, limit);

    let writeResult;
    try {
      writeResult = await writeVaultFile({
        installationToken,
        repository: normalizedRepository,
        content,
        sha: null,
        fetchImpl,
      });
    } catch (error) {
      throw mapRemoteError(error);
    }

    const meta = {
      repository: normalizedRepository,
      installationId,
      sha:
        typeof writeResult?.sha === "string"
          ? writeResult.sha
          : null,
      htmlUrl:
        typeof writeResult?.htmlUrl === "string"
          ? writeResult.htmlUrl
          : null,
      updatedAt: state.updatedAt || new Date().toISOString(),
    };
    const store = new SettingsStoreCore({
      state,
      envToken: "",
      persist: createPersist({
        installationToken,
        repository: normalizedRepository,
        key: keyInfo.key,
        salt: keyInfo.salt,
        iterations: keyInfo.iterations,
        maxBytes: limit,
        writeVaultFile,
        fetchImpl,
        meta,
      }),
    });
    decorateVaultStore(store, keyInfo.key, meta);

    const result = {
      created: true,
      get sha() {
        return meta.sha;
      },
      get htmlUrl() {
        return meta.htmlUrl;
      },
      repository: normalizedRepository,
      installationId,
      meta,
    };
    Object.defineProperties(result, {
      store: {
        value: store,
        enumerable: false,
      },
      toJSON: {
        value: () => ({
          created: true,
          repository: normalizedRepository,
          installationId,
          sha: meta.sha,
          htmlUrl: meta.htmlUrl,
          meta,
        }),
        enumerable: false,
      },
    });
    return result;
  }

  const content =
    typeof file.content === "string" ? file.content : "";
  assertContentSize(content, limit);

  const decrypted = await decryptVaultPayload(content, password);
  let state;
  try {
    state = normalizePlainState(decrypted.state, { strict: true });
  } catch {
    throw new VaultFormatError("保险库设置数据结构无效。");
  }
  const meta = {
    repository: normalizedRepository,
    installationId,
    sha: typeof file.sha === "string" ? file.sha : null,
    htmlUrl:
      typeof file.htmlUrl === "string" ? file.htmlUrl : null,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
  const store = new SettingsStoreCore({
    state,
    envToken: "",
    persist: createPersist({
      installationToken,
      repository: normalizedRepository,
      key: decrypted.key,
      salt: decrypted.salt,
      iterations: decrypted.iterations,
      maxBytes: limit,
      writeVaultFile,
      fetchImpl,
      meta,
    }),
  });
  decorateVaultStore(store, decrypted.key, meta);

  const result = {
    created: false,
    get sha() {
      return meta.sha;
    },
    get htmlUrl() {
      return meta.htmlUrl;
    },
    repository: normalizedRepository,
    installationId,
    meta,
  };
  Object.defineProperties(result, {
    store: {
      value: store,
      enumerable: false,
    },
    toJSON: {
      value: () => ({
        created: false,
        repository: normalizedRepository,
        installationId,
        sha: meta.sha,
        htmlUrl: meta.htmlUrl,
        meta,
      }),
      enumerable: false,
    },
  });
  return result;
}

export {
  DEFAULT_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  VaultError,
  VaultFormatError,
  VaultPasswordError,
  VaultPasswordPolicyError,
};
