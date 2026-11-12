import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SettingsStoreCore,
  createDefaultState,
} from "../server/settings-core.js";
import {
  openSettingsStore,
} from "../server/settings-store.js";
import {
  VaultConflictError,
  VaultFormatError,
  VaultNotFoundError,
  VaultPasswordError,
  VaultTooLargeError,
  openVaultSettingsStore,
} from "../server/vault-store.js";
import {
  VaultPasswordPolicyError,
} from "../server/vault-crypto.js";

const TEST_PASSWORD = "correct horse battery staple";
const TEST_ITERATIONS = 100_000;
const TOKEN_ONE = "linode-token-alpha-1234";
const TOKEN_TWO = "linode-token-beta-5678";
const OCI_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nTESTKEYMATERIAL\n-----END PRIVATE KEY-----";
const PROXY_PASSWORD = "proxy-secret-9999";

function createMemoryVault() {
  let file = null;
  let counter = 0;

  return {
    get file() {
      return file;
    },
    set file(value) {
      file = value;
    },
    externalUpdate() {
      assert.ok(file, "a vault file must exist before externalUpdate");
      counter += 1;
      file = {
        ...file,
        sha: `external-sha-${counter}`,
      };
    },
    async readVaultFile() {
      return file
        ? {
            exists: true,
            sha: file.sha,
            content: file.content,
            htmlUrl: file.htmlUrl,
          }
        : {
            exists: false,
            sha: null,
            content: null,
            htmlUrl: null,
          };
    },
    async writeVaultFile({ content, sha }) {
      if (file) {
        if (sha !== file.sha) {
          throw Object.assign(new Error("conflict"), { status: 409 });
        }
      } else if (sha) {
        throw Object.assign(new Error("missing"), { status: 409 });
      }

      counter += 1;
      file = {
        content,
        sha: `sha-${counter}`,
        htmlUrl: `https://example.test/vault/${counter}`,
      };
      return {
        exists: true,
        sha: file.sha,
        content,
        htmlUrl: file.htmlUrl,
      };
    },
  };
}

function parseEnvelope(content) {
  const envelope = JSON.parse(content);
  assert.equal(envelope.format, "cloudvm-vault");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.kdf.name, "PBKDF2-SHA256");
  assert.equal(envelope.cipher.name, "AES-256-GCM");
  return envelope;
}

test("local settings store encrypts secrets at rest and reopens", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cloudvm-store-"));
  try {
    const store = openSettingsStore({ dataDir });
    await store.addToken({
      label: "Primary",
      token: TOKEN_ONE,
      accountLabel: "Test Account",
    });
    await store.addOracleAccount({
      label: "OCI Test",
      tenancyId: "ocid1.tenancy.oc1..test",
      userId: "ocid1.user.oc1..test",
      fingerprint: "aa:bb:cc",
      region: "us-ashburn-1",
      privateKey: OCI_PRIVATE_KEY,
    });
    await store.updateProxy({
      enabled: true,
      url: "socks5h://127.0.0.1:1080",
      username: "proxy-user",
      password: PROXY_PASSWORD,
    });

    const raw = readFileSync(path.join(dataDir, "settings.json"), "utf8");
    assert.equal(raw.includes(TOKEN_ONE), false);
    assert.equal(raw.includes(OCI_PRIVATE_KEY), false);
    assert.equal(raw.includes(PROXY_PASSWORD), false);
    assert.match(raw, /"encrypted"/);
    assert.match(raw, /"encryptedPrivateKey"/);

    const reopened = openSettingsStore({ dataDir });
    assert.equal(reopened.getCredential().token, TOKEN_ONE);
    assert.equal(
      reopened.getPublicSettings().tokens[0].label,
      "Primary",
    );
    assert.equal(
      reopened.getOracleAccounts()[0].privateKey,
      OCI_PRIVATE_KEY,
    );
    assert.equal(reopened.getProxyConfig().password, PROXY_PASSWORD);

    const exported = store.exportPlainState();
    assert.equal(exported.tokens[0].token, TOKEN_ONE);
    assert.equal("encrypted" in exported.tokens[0], false);
    assert.equal(
      exported.oracleAccounts[0].privateKey,
      OCI_PRIVATE_KEY,
    );
    assert.equal("encryptedPrivateKey" in exported.oracleAccounts[0], false);
    assert.equal(exported.proxy.password, PROXY_PASSWORD);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("settings core rolls back memory when persistence fails", async () => {
  const core = new SettingsStoreCore({
    state: createDefaultState(),
    persist: async () => {
      throw new Error("persist failed");
    },
  });

  await assert.rejects(
    core.addToken({ label: "Failing", token: TOKEN_ONE }),
    /persist failed/,
  );
  assert.equal(core.getPublicSettings().tokens.length, 0);
  assert.equal(core.getCredential().token, "");
  assert.equal(core.state.updatedAt, null);
});

test("creates an encrypted vault, updates IV, and reopens it", async () => {
  const memory = createMemoryVault();
  const opened = await openVaultSettingsStore({
    installationToken: "installation-token",
    installationId: 42,
    repository: "octocat/cloudvm-vault",
    password: TEST_PASSWORD,
    readVaultFile: memory.readVaultFile,
    writeVaultFile: memory.writeVaultFile,
    iterations: TEST_ITERATIONS,
  });

  assert.equal(opened.created, true);
  assert.equal(opened.repository, "octocat/cloudvm-vault");
  assert.equal(opened.installationId, 42);
  assert.ok(memory.file);
  assert.equal(memory.file.content.includes(TOKEN_ONE), false);
  assert.equal(
    opened.store.getVaultMeta().sha,
    memory.file.sha,
  );
  assert.equal(memory.file.content.includes(TEST_PASSWORD), false);
  assert.equal(Object.keys(opened).includes("store"), false);
  const serializedResult = JSON.stringify(opened);
  assert.equal(serializedResult.includes(TOKEN_ONE), false);
  assert.equal(serializedResult.includes(TEST_PASSWORD), false);
  assert.equal("store" in JSON.parse(serializedResult), false);

  const firstEnvelope = parseEnvelope(memory.file.content);
  assert.equal(firstEnvelope.kdf.iterations, TEST_ITERATIONS);
  assert.equal(Buffer.from(firstEnvelope.kdf.salt, "base64").length, 16);
  assert.equal(Buffer.from(firstEnvelope.cipher.iv, "base64").length, 12);

  await opened.store.addToken({
    label: "Primary",
    token: TOKEN_ONE,
    accountLabel: "Test Account",
  });
  const secondEnvelope = parseEnvelope(memory.file.content);
  assert.notEqual(
    secondEnvelope.cipher.iv,
    firstEnvelope.cipher.iv,
  );
  assert.equal(memory.file.content.includes(TOKEN_ONE), false);
  assert.equal(
    opened.store.getPublicSettings().tokens[0].masked,
    `••••••••${TOKEN_ONE.slice(-4)}`,
  );

  const reopened = await openVaultSettingsStore({
    installationToken: "installation-token",
    installationId: 42,
    repository: "octocat/cloudvm-vault",
    password: TEST_PASSWORD,
    readVaultFile: memory.readVaultFile,
    writeVaultFile: memory.writeVaultFile,
  });
  assert.equal(reopened.created, false);
  assert.equal(reopened.store.getCredential().token, TOKEN_ONE);
  assert.equal(reopened.sha, memory.file.sha);
  assert.equal(
    reopened.store.getVaultMeta().htmlUrl,
    memory.file.htmlUrl,
  );
  reopened.store.dispose();
  assert.equal(reopened.store.getPublicSettings().tokens.length, 0);
  assert.equal(reopened.store.persist, null);

  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: "wrong password",
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
    }),
    VaultPasswordError,
  );
});

test("imports local state into a new vault with OCI and proxy secrets", async () => {
  const localDir = mkdtempSync(path.join(os.tmpdir(), "cloudvm-import-"));
  try {
    const local = openSettingsStore({ dataDir: localDir });
    await local.addToken({
      label: "Imported",
      token: TOKEN_TWO,
    });
    await local.addOracleAccount({
      label: "Imported OCI",
      tenancyId: "ocid1.tenancy.oc1..import",
      userId: "ocid1.user.oc1..import",
      fingerprint: "11:22:33",
      region: "ap-tokyo-1",
      privateKey: OCI_PRIVATE_KEY,
    });
    await local.updateProxy({
      enabled: true,
      url: "socks5h://127.0.0.1:7890",
      username: "imported-user",
      password: PROXY_PASSWORD,
    });

    const memory = createMemoryVault();
    const opened = await openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      importState: local.exportPlainState(),
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
      iterations: TEST_ITERATIONS,
    });

    assert.equal(opened.created, true);
    assert.equal(opened.store.getCredential().token, TOKEN_TWO);
    assert.equal(
      opened.store.getOracleAccounts()[0].privateKey,
      OCI_PRIVATE_KEY,
    );
    assert.equal(
      opened.store.getProxyConfig().password,
      PROXY_PASSWORD,
    );
    assert.equal(memory.file.content.includes(TOKEN_TWO), false);
    assert.equal(memory.file.content.includes(OCI_PRIVATE_KEY), false);
    assert.equal(memory.file.content.includes(PROXY_PASSWORD), false);

    const reopened = await openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
    });
    assert.equal(reopened.store.getCredential().token, TOKEN_TWO);
    assert.equal(
      reopened.store.getOracleAccounts()[0].privateKey,
      OCI_PRIVATE_KEY,
    );
    assert.equal(
      reopened.store.getProxyConfig().password,
      PROXY_PASSWORD,
    );
  } finally {
    rmSync(localDir, { recursive: true, force: true });
  }
});

test("reports a conflict and rolls back when GitHub has a newer sha", async () => {
  const memory = createMemoryVault();
  const opened = await openVaultSettingsStore({
    installationToken: "installation-token",
    repository: "octocat/cloudvm-vault",
    password: TEST_PASSWORD,
    readVaultFile: memory.readVaultFile,
    writeVaultFile: memory.writeVaultFile,
    iterations: TEST_ITERATIONS,
  });

  memory.externalUpdate();
  await assert.rejects(
    opened.store.addToken({
      label: "Conflicting",
      token: TOKEN_ONE,
    }),
    VaultConflictError,
  );
  assert.equal(opened.store.getPublicSettings().tokens.length, 0);
});

test("serializes concurrent vault mutations without losing tokens", async () => {
  const memory = createMemoryVault();
  const opened = await openVaultSettingsStore({
    installationToken: "installation-token",
    repository: "octocat/cloudvm-vault",
    password: TEST_PASSWORD,
    readVaultFile: memory.readVaultFile,
    writeVaultFile: memory.writeVaultFile,
    iterations: TEST_ITERATIONS,
  });

  await Promise.all([
    opened.store.addToken({ label: "One", token: TOKEN_ONE }),
    opened.store.addToken({ label: "Two", token: TOKEN_TWO }),
  ]);

  assert.equal(opened.store.getPublicSettings().tokens.length, 2);
  const reopened = await openVaultSettingsStore({
    installationToken: "installation-token",
    repository: "octocat/cloudvm-vault",
    password: TEST_PASSWORD,
    readVaultFile: memory.readVaultFile,
    writeVaultFile: memory.writeVaultFile,
  });
  assert.equal(reopened.store.getPublicSettings().tokens.length, 2);
  assert.deepEqual(
    new Set(
      reopened.store
        .getCredentials()
        .map((credential) => credential.token),
    ),
    new Set([TOKEN_ONE, TOKEN_TWO]),
  );
});

test("enforces password policy and vault size limits", async () => {
  const memory = createMemoryVault();
  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: "short",
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
      iterations: TEST_ITERATIONS,
    }),
    VaultPasswordPolicyError,
  );

  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
      maxBytes: 256,
      iterations: TEST_ITERATIONS,
    }),
    VaultTooLargeError,
  );
});

test("rejects missing, malformed, and unreadable vault files", async () => {
  const memory = createMemoryVault();
  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      createIfMissing: false,
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
    }),
    VaultNotFoundError,
  );

  memory.file = {
    content: JSON.stringify({ format: "wrong" }),
    sha: "bad-sha",
    htmlUrl: null,
  };
  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      readVaultFile: memory.readVaultFile,
      writeVaultFile: memory.writeVaultFile,
    }),
    VaultFormatError,
  );
});

test("maps remote permission and size failures to vault errors", async () => {
  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      readVaultFile: async () => {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      writeVaultFile: async () => {
        throw new Error("unexpected write");
      },
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "vault_forbidden");
      return true;
    },
  );

  await assert.rejects(
    openVaultSettingsStore({
      installationToken: "installation-token",
      repository: "octocat/cloudvm-vault",
      password: TEST_PASSWORD,
      readVaultFile: async () => ({
        exists: false,
        sha: null,
        content: null,
        htmlUrl: null,
      }),
      writeVaultFile: async () => {
        throw Object.assign(new Error("too large"), {
          status: 413,
          code: "vault_too_large",
        });
      },
      iterations: TEST_ITERATIONS,
    }),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.code, "vault_too_large");
      return true;
    },
  );
});
