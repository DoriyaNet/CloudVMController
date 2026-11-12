import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import { createAuthController, isUserAllowed } from "../server/auth/controller.js";
import { readAuthConfig } from "../server/auth/config.js";
import {
  decryptJson,
  encryptJson,
  safeStringEqual,
} from "../server/auth/crypto.js";
import { createAppJwt } from "../server/auth/github.js";
import {
  buildAuthorizeUrl,
  createOAuthAttempt,
  sanitizeReturnTo,
  validateOAuthAttempt,
} from "../server/auth/oauth.js";
import {
  createSession,
  encryptSession,
} from "../server/auth/session.js";
import {
  normalizeInstallationId,
  normalizeRepositoryFullName,
  repositoryIsAccessible,
} from "../server/auth/github.js";

const NOW = 1_700_000_000_000;
const SESSION_SECRET = "test-session-secret-with-plenty-of-entropy";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const USER = {
  id: 101,
  login: "octocat",
  name: "Octo Cat",
  avatarUrl: "https://example.test/avatar.png",
};

const BASE_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_SLUG: "cloudvm",
  SESSION_SECRET,
  CLOUDVM_ALLOWED_GITHUB_USERS: "octocat",
};

const INSTALLATION = {
  id: 123,
  repository_selection: "selected",
  account: {
    id: 101,
    login: "octocat",
    type: "User",
    avatar_url: USER.avatarUrl,
  },
};

const PRIVATE_REPO = {
  id: 55,
  name: "vault",
  full_name: "octocat/vault",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/octocat/vault",
  owner: { id: 101, login: "octocat", type: "User" },
};

const PUBLIC_REPO = {
  ...PRIVATE_REPO,
  id: 56,
  name: "public",
  full_name: "octocat/public",
  private: false,
  html_url: "https://github.com/octocat/public",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cookieValues(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const header = response.headers.get("set-cookie");
  return header ? header.split(/,(?=\s*[^;,]+=)/) : [];
}

function cookieHeader(response) {
  const pairs = new Map();
  for (const value of cookieValues(response)) {
    const pair = value.split(";")[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      pairs.set(pair.slice(0, separator), pair);
    }
  }
  return [...pairs.values()].join("; ");
}

function mergeCookieStrings(...values) {
  const pairs = new Map();
  for (const value of values) {
    for (const part of String(value || "").split(";")) {
      const pair = part.trim();
      const separator = pair.indexOf("=");
      if (separator > 0) {
        pairs.set(pair.slice(0, separator), pair);
      }
    }
  }
  return [...pairs.values()].join("; ");
}

function sessionCookieFor(user = USER, overrides = {}) {
  const session = createSession({
    user,
    token: {
      accessToken: "ghu_test_access_token",
      refreshToken: null,
      expiresAt: NOW + 60 * 60 * 1000,
      ...overrides,
    },
    now: NOW,
  });
  return `cloudvm_session=${encryptSession(session, SESSION_SECRET)}`;
}

function createFakeGitHub({ user = USER, vaultContent = null } = {}) {
  const state = {
    vaultContent,
    vaultSha: vaultContent ? "a".repeat(40) : null,
    calls: [],
    user,
  };

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    state.calls.push({ method, url: url.toString() });

    if (
      url.origin === "https://github.com" &&
      url.pathname === "/login/oauth/access_token"
    ) {
      return jsonResponse({
        access_token: "ghu_test_access_token",
        token_type: "bearer",
        scope: "",
      });
    }

    if (url.hostname !== "api.github.com") {
      throw new Error(`Unexpected host: ${method} ${url}`);
    }

    if (url.pathname === "/user") {
      return jsonResponse({
        id: state.user.id,
        login: state.user.login,
        name: state.user.name,
        avatar_url: state.user.avatarUrl,
      });
    }
    if (url.pathname === "/user/installations") {
      return jsonResponse({
        total_count: 1,
        installations: [INSTALLATION],
      });
    }
    if (url.pathname === "/user/installations/123/repositories") {
      return jsonResponse({
        total_count: 2,
        repositories: [PRIVATE_REPO, PUBLIC_REPO],
      });
    }
    if (
      url.pathname === "/app/installations/123/access_tokens" &&
      method === "POST"
    ) {
      return jsonResponse({
        token: "ghs_test_installation_token",
        expires_at: new Date(NOW + 55 * 60 * 1000).toISOString(),
      });
    }
    if (
      url.pathname === "/repos/octocat/vault/contents/.cloudvm/vault.json"
    ) {
      if (method === "GET") {
        if (state.vaultContent === null) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        return jsonResponse({
          type: "file",
          encoding: "base64",
          content: Buffer.from(state.vaultContent, "utf8").toString("base64"),
          sha: state.vaultSha,
          html_url:
            "https://github.com/octocat/vault/blob/main/.cloudvm/vault.json",
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(init.body);
        state.vaultContent = Buffer.from(body.content, "base64").toString(
          "utf8",
        );
        state.vaultSha = "b".repeat(40);
        return jsonResponse({
          content: {
            sha: state.vaultSha,
            html_url:
              "https://github.com/octocat/vault/blob/main/.cloudvm/vault.json",
          },
        });
      }
    }

    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  }

  return { fetchImpl, state };
}

function fakePublicSettings() {
  return {
    tokenConfigured: true,
    credentialSource: "web",
    credentialLabel: "Vault",
    activeTokenId: "token-1",
    envTokenConfigured: false,
    poolSize: 1,
    credentials: [
      { id: "token-1", label: "Vault", active: true, source: "web" },
    ],
    tokens: [
      {
        id: "token-1",
        label: "Vault",
        masked: "••••••••test",
        active: true,
      },
    ],
    oracleConfigured: false,
    oracleAccounts: [],
    proxy: {
      enabled: false,
      url: "socks5h://127.0.0.1:7890",
      username: "",
      hasPassword: false,
    },
  };
}

function createFakeVaultFactory({ created = false, passwordError = false } = {}) {
  const calls = [];
  async function vaultStoreFactory(options) {
    calls.push(options);
    if (passwordError) {
      const error = new Error("The vault password is incorrect.");
      error.name = "VaultPasswordError";
      error.code = "vault_password_invalid";
      throw error;
    }
    return {
      store: {
        getPublicSettings: fakePublicSettings,
        exportPlainState: () => ({ tokens: [], oracleAccounts: [] }),
      },
      created,
      sha: "a".repeat(40),
      htmlUrl:
        "https://github.com/octocat/vault/blob/main/.cloudvm/vault.json",
      repository: options.repository,
      installationId: options.installationId,
      meta: {},
    };
  }
  return { vaultStoreFactory, calls };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address();
}

async function startAuthStack({
  env = BASE_ENV,
  fake = createFakeGitHub(),
  vault = createFakeVaultFactory(),
} = {}) {
  const config = readAuthConfig(env);
  const auth = createAuthController({
    config,
    vaultStoreFactory: vault.vaultStoreFactory,
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    logger: { warn() {}, error() {} },
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (await auth.handle(request, response, url)) {
      return;
    }
    if (url.pathname === "/api/protected") {
      try {
        const resolved = await auth.resolve(request, response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            repository: resolved.vault.repository,
            tokenConfigured:
              resolved.settingsStore.getPublicSettings().tokenConfigured,
          }),
        );
      } catch (error) {
        response.statusCode = error.status || 500;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ code: error.code, error: error.message }),
        );
      }
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  const address = await listen(server);
  return {
    auth,
    config,
    fake,
    vault,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function request(
  baseUrl,
  path,
  {
    method = "GET",
    cookie,
    body,
    csrf = true,
    redirect = "manual",
  } = {},
) {
  const headers = {};
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (csrf && !["GET", "HEAD"].includes(method)) {
    headers["X-CloudVMController"] = "1";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

test("reads GitHub auth configuration and enforces safe defaults", () => {
  const disabled = readAuthConfig({});
  assert.equal(disabled.mode, "local");
  assert.equal(disabled.githubConfigured, false);
  assert.equal(disabled.allowAnyUser, false);

  const missing = readAuthConfig({ CLOUDVM_AUTH_MODE: "github" });
  assert.equal(missing.mode, "github");
  assert.equal(missing.githubConfigured, false);
  assert.ok(missing.missing.includes("GITHUB_APP_ID"));
  assert.ok(missing.missing.includes("SESSION_SECRET"));

  const configured = readAuthConfig(BASE_ENV);
  assert.equal(configured.mode, "github");
  assert.equal(configured.githubConfigured, true);
  assert.equal(configured.allowAnyUser, false);
  assert.deepEqual(configured.allowedUsers, ["octocat"]);
  assert.equal(isUserAllowed(configured, USER), true);
  assert.equal(
    isUserAllowed(configured, { ...USER, id: 999, login: "intruder" }),
    false,
  );

  const anyUser = readAuthConfig({
    ...BASE_ENV,
    CLOUDVM_ALLOWED_GITHUB_USERS: "",
    CLOUDVM_ALLOW_ANY_GITHUB_USER: "1",
  });
  assert.equal(anyUser.allowAnyUser, true);
  assert.equal(
    isUserAllowed(anyUser, { ...USER, id: 999, login: "intruder" }),
    true,
  );
});

test("encrypts cookies and validates OAuth state and PKCE", () => {
  const encrypted = encryptJson({ answer: 42 }, SESSION_SECRET, "test");
  assert.deepEqual(
    decryptJson(encrypted, SESSION_SECRET, "test"),
    { answer: 42 },
  );
  assert.throws(() =>
    decryptJson(`${encrypted.slice(0, -1)}x`, SESSION_SECRET, "test"),
  );
  assert.equal(safeStringEqual("same", "same"), true);
  assert.equal(safeStringEqual("same", "different"), false);

  const attempt = createOAuthAttempt({
    returnTo: "/settings?tab=vault",
    redirectUri: "https://cloudvm.example.com/api/auth/callback",
    now: NOW,
  });
  assert.match(attempt.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    validateOAuthAttempt(attempt.cookie, attempt.cookie.state, NOW).returnTo,
    "/settings?tab=vault",
  );
  assert.throws(
    () => validateOAuthAttempt(attempt.cookie, "wrong", NOW),
    /does not match/,
  );
  assert.equal(sanitizeReturnTo("https://evil.example", null), null);
  assert.equal(sanitizeReturnTo("//evil.example", null), null);
  assert.equal(sanitizeReturnTo("/ok?x=1", null), "/ok?x=1");

  const authorize = new URL(
    buildAuthorizeUrl({
      clientId: "client-id",
      redirectUri: "https://cloudvm.example.com/api/auth/callback",
      state: "state-value",
      codeChallenge: attempt.challenge,
    }),
  );
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("state"), "state-value");
});

test("creates a verifiable GitHub App JWT and validates repository access", () => {
  const token = createAppJwt({
    appId: "12345",
    privateKey,
    now: NOW,
  });
  const [header, payload, signature] = token.split(".");
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  assert.equal(valid, true);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(claims.iss, "12345");

  assert.equal(normalizeInstallationId("123"), 123);
  assert.equal(normalizeInstallationId("0"), null);
  assert.equal(normalizeRepositoryFullName("octocat/vault"), "octocat/vault");
  assert.equal(normalizeRepositoryFullName("../vault"), null);
  assert.equal(
    repositoryIsAccessible([PRIVATE_REPO], "octocat/vault"),
    true,
  );
  assert.equal(
    repositoryIsAccessible([PUBLIC_REPO], "octocat/public"),
    false,
  );
});

test("runs the GitHub login, installation, and vault unlock flow", async (t) => {
  const stack = await startAuthStack();
  t.after(() => stack.close());

  const login = await request(stack.baseUrl, "/api/auth/login");
  assert.equal(login.response.status, 302);
  assert.match(
    login.response.headers.get("location"),
    /^https:\/\/github\.com\/login\/oauth\/authorize/,
  );
  const oauthCookie = cookieHeader(login.response);
  const state = new URL(
    login.response.headers.get("location"),
  ).searchParams.get("state");

  const callback = await request(
    stack.baseUrl,
    `/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { cookie: oauthCookie },
  );
  assert.equal(callback.response.status, 302);
  assert.equal(callback.response.headers.get("location"), "/");
  const sessionCookie = cookieHeader(callback.response);
  assert.match(sessionCookie, /cloudvm_session=/);

  const sessionBefore = await request(
    stack.baseUrl,
    "/api/auth/session",
    { cookie: sessionCookie },
  );
  assert.equal(sessionBefore.response.status, 200);
  assert.equal(sessionBefore.json.authenticated, true);
  assert.equal(sessionBefore.json.vault.unlocked, false);

  const install = await request(stack.baseUrl, "/api/github/install", {
    cookie: sessionCookie,
  });
  assert.equal(install.response.status, 302);
  const installLocation = install.response.headers.get("location");
  assert.match(
    installLocation,
    /^https:\/\/github\.com\/apps\/cloudvm\/installations\/new\?state=/,
  );
  const installState = new URL(installLocation).searchParams.get("state");
  const setup = await request(
    stack.baseUrl,
    `/api/github/setup?installation_id=123&state=${encodeURIComponent(installState)}`,
    {
      cookie: mergeCookieStrings(
        sessionCookie,
        cookieHeader(install.response),
      ),
    },
  );
  assert.equal(setup.response.status, 302);
  assert.equal(setup.response.headers.get("location"), "/?github=installed");

  const installations = await request(
    stack.baseUrl,
    "/api/github/installations",
    { cookie: sessionCookie },
  );
  assert.equal(installations.response.status, 200);
  assert.equal(installations.json.installations.length, 1);
  assert.equal(installations.json.installations[0].id, 123);

  const repositories = await request(
    stack.baseUrl,
    "/api/github/repositories?installationId=123",
    { cookie: sessionCookie },
  );
  assert.equal(repositories.response.status, 200);
  assert.deepEqual(
    repositories.json.repositories.map((repo) => repo.fullName),
    ["octocat/vault"],
  );
  assert.equal(repositories.json.repositories[0].private, true);

  const statusBefore = await request(
    stack.baseUrl,
    "/api/vault/status?installationId=123&repository=octocat%2Fvault",
    { cookie: sessionCookie },
  );
  assert.equal(statusBefore.response.status, 200);
  assert.equal(statusBefore.json.exists, false);
  assert.equal(statusBefore.json.locked, true);

  const unlock = await request(stack.baseUrl, "/api/vault/unlock", {
    method: "POST",
    cookie: sessionCookie,
    body: {
      installationId: 123,
      repository: "octocat/vault",
      password: "correct horse battery staple",
    },
  });
  assert.equal(unlock.response.status, 200);
  assert.equal(unlock.json.ok, true);
  assert.equal(unlock.json.settings.tokenConfigured, true);
  const vaultCookie = cookieHeader(unlock.response);
  assert.match(vaultCookie, /cloudvm_vault=/);
  assert.equal(stack.vault.calls.length, 1);
  assert.equal(
    stack.vault.calls[0].installationToken,
    "ghs_test_installation_token",
  );

  const unlockedCookie = mergeCookieStrings(sessionCookie, vaultCookie);
  const sessionAfter = await request(
    stack.baseUrl,
    "/api/auth/session",
    { cookie: unlockedCookie },
  );
  assert.equal(sessionAfter.json.authenticated, true);
  assert.equal(sessionAfter.json.vault.unlocked, true);
  assert.equal(sessionAfter.json.vault.repository, "octocat/vault");
  assert.equal(sessionAfter.json.settings.tokenConfigured, true);

  const protectedRequest = await request(
    stack.baseUrl,
    "/api/protected",
    { cookie: unlockedCookie },
  );
  assert.equal(protectedRequest.response.status, 200);
  assert.equal(protectedRequest.json.tokenConfigured, true);

  const lock = await request(stack.baseUrl, "/api/vault/lock", {
    method: "POST",
    cookie: unlockedCookie,
  });
  assert.equal(lock.response.status, 200);
  const lockedRequest = await request(stack.baseUrl, "/api/protected", {
    cookie: unlockedCookie,
  });
  assert.equal(lockedRequest.response.status, 401);
  assert.equal(lockedRequest.json.code, "vault_locked");

  const logout = await request(stack.baseUrl, "/api/auth/logout", {
    method: "POST",
    cookie: unlockedCookie,
  });
  assert.equal(logout.response.status, 200);
  const sessionAfterLogout = await request(
    stack.baseUrl,
    "/api/auth/session",
    { cookie: cookieHeader(logout.response) },
  );
  assert.equal(sessionAfterLogout.json.authenticated, false);
});

test("redirects a non-allowlisted GitHub user instead of creating a session", async (t) => {
  const fake = createFakeGitHub({
    user: { ...USER, id: 999, login: "intruder" },
  });
  const stack = await startAuthStack({ fake });
  t.after(() => stack.close());

  const login = await request(stack.baseUrl, "/api/auth/login");
  const state = new URL(
    login.response.headers.get("location"),
  ).searchParams.get("state");
  const callback = await request(
    stack.baseUrl,
    `/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { cookie: cookieHeader(login.response) },
  );

  assert.equal(callback.response.status, 302);
  assert.equal(
    callback.response.headers.get("location"),
    "/?auth_error=github_user_not_allowed",
  );
  assert.doesNotMatch(cookieHeader(callback.response), /cloudvm_session=[^;]+/);
});

test("denies users when the allowlist is empty and allowAnyUser is false", async (t) => {
  const stack = await startAuthStack({
    env: {
      ...BASE_ENV,
      CLOUDVM_ALLOWED_GITHUB_USERS: "",
      CLOUDVM_ALLOWED_GITHUB_IDS: "",
    },
  });
  t.after(() => stack.close());

  const response = await request(
    stack.baseUrl,
    "/api/github/installations",
    { cookie: sessionCookieFor() },
  );
  assert.equal(response.response.status, 403);
  assert.equal(response.json.code, "github_user_not_allowed");
});

test("allows any GitHub user only with the explicit switch", async (t) => {
  const stack = await startAuthStack({
    env: {
      ...BASE_ENV,
      CLOUDVM_ALLOWED_GITHUB_USERS: "",
      CLOUDVM_ALLOW_ANY_GITHUB_USER: "1",
    },
  });
  t.after(() => stack.close());

  const response = await request(
    stack.baseUrl,
    "/api/github/installations",
    { cookie: sessionCookieFor() },
  );
  assert.equal(response.response.status, 200);
});

test("refreshes an expired access token when reading the session", async (t) => {
  const stack = await startAuthStack();
  t.after(() => stack.close());
  const cookie = sessionCookieFor(USER, {
    expiresAt: NOW - 1000,
    refreshToken: "ghr_test_refresh_token",
    refreshTokenExpiresAt: NOW + 60 * 60 * 1000,
  });

  const response = await request(stack.baseUrl, "/api/auth/session", {
    cookie,
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.json.authenticated, true);
  assert.match(cookieHeader(response.response), /^cloudvm_session=/);
  assert.ok(
    stack.fake.state.calls.some(
      (call) =>
        call.url === "https://github.com/login/oauth/access_token",
    ),
  );
});

test("requires the CSRF header for state-changing auth requests", async (t) => {
  const stack = await startAuthStack();
  t.after(() => stack.close());
  const cookie = sessionCookieFor();

  const unlock = await request(stack.baseUrl, "/api/vault/unlock", {
    method: "POST",
    cookie,
    csrf: false,
    body: {
      installationId: 123,
      repository: "octocat/vault",
      password: "password",
    },
  });
  assert.equal(unlock.response.status, 403);
  assert.equal(unlock.json.code, "CSRF_CHECK_FAILED");

  const logout = await request(stack.baseUrl, "/api/auth/logout", {
    method: "POST",
    cookie,
    csrf: false,
  });
  assert.equal(logout.response.status, 403);
  assert.equal(logout.json.code, "CSRF_CHECK_FAILED");
});

test("rate-limits repeated failed vault unlock attempts", async (t) => {
  const vault = createFakeVaultFactory({ passwordError: true });
  const stack = await startAuthStack({ vault });
  t.after(() => stack.close());
  const cookie = sessionCookieFor();

  for (let index = 0; index < 4; index += 1) {
    const response = await request(stack.baseUrl, "/api/vault/unlock", {
      method: "POST",
      cookie,
      body: {
        installationId: 123,
        repository: "octocat/vault",
        password: "wrong",
      },
    });
    assert.equal(response.response.status, 401);
    assert.equal(response.json.code, "vault_password_invalid");
  }

  const fifth = await request(stack.baseUrl, "/api/vault/unlock", {
    method: "POST",
    cookie,
    body: {
      installationId: 123,
      repository: "octocat/vault",
      password: "wrong",
    },
  });
  assert.equal(fifth.response.status, 429);
  assert.equal(fifth.json.code, "vault_rate_limited");

  const blocked = await request(stack.baseUrl, "/api/vault/unlock", {
    method: "POST",
    cookie,
    body: {
      installationId: 123,
      repository: "octocat/vault",
      password: "wrong",
    },
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.json.code, "vault_rate_limited");
});
