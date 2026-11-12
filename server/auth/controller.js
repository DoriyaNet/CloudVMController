import { Buffer } from "node:buffer";

import {
  COOKIE_NAMES,
  clearCookie,
  parseCookies,
  serializeCookie,
} from "./cookies.js";
import { assertAuthConfigured, getRequestOrigin } from "./config.js";
import { decryptJson, encryptJson, randomToken } from "./crypto.js";
import {
  AuthError,
  GitHubHttpError,
  GitHubNetworkError,
  GitHubOAuthError,
} from "./errors.js";
import {
  InstallationTokenService,
  assertUserCanAccessInstallation,
  assertUserCanAccessRepository,
  exchangeOAuthCode,
  fetchGitHubUser,
  listInstallationRepositories,
  listUserInstallations,
  normalizeInstallationId,
  normalizeRepositoryFullName,
  readVaultFile,
  refreshOAuthToken,
  simplifyInstallation,
  simplifyRepository,
  writeVaultFile,
} from "./github.js";
import {
  buildAuthorizeUrl,
  buildInstallUrl,
  createInstallAttempt,
  createOAuthAttempt,
  sanitizeReturnTo,
  validateInstallAttempt,
  validateOAuthAttempt,
} from "./oauth.js";
import {
  createSession,
  encryptSession,
  isSessionValid,
  mergeRefreshedToken,
  sessionCookieMaxAge,
  shouldRefreshSession,
} from "./session.js";

const MAX_AUTH_BODY_BYTES = 96 * 1024;
const VAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const VAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const VAULT_UNLOCK_FAILURE_LIMIT = 5;
const VAULT_UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const CSRF_HEADERS = ["x-cloudvmcontroller", "x-linode-pilot"];
const CSRF_VALUE = "1";
const GITHUB_INSTALL_REDIRECT = "/?github=installed";
const GITHUB_USER_DENIED_REDIRECT = "/?auth_error=github_user_not_allowed";

export function isUserAllowed(config, user) {
  if (!user || !Number.isSafeInteger(user.id) || !user.login) {
    return false;
  }
  if (config.allowAnyUser) {
    return true;
  }
  if (config.allowedUserIds.includes(user.id)) {
    return true;
  }
  return config.allowedUsers.includes(user.login.toLowerCase());
}

function requireCsrfHeader(request) {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !CSRF_HEADERS.some((header) => request.headers[header] === CSRF_VALUE)
  ) {
    throw new AuthError(
      403,
      "CSRF_CHECK_FAILED",
      "Missing the CloudVMController request header.",
    );
  }
}

function requestUrl(request) {
  try {
    return new URL(request.url || "/", "http://localhost");
  } catch {
    throw new AuthError(400, "invalid_url", "The request URL is invalid.");
  }
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function assertMethod(request, allowed) {
  if (!allowed.includes(request.method)) {
    throw new AuthError(
      405,
      "method_not_allowed",
      `Use ${allowed.join(" or ")} for this endpoint.`,
    );
  }
}

async function readJsonBody(request, maxBytes = MAX_AUTH_BODY_BYTES) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AuthError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AuthError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body is too large.",
    );
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        throw new AuthError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body is too large.",
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(400, "invalid_body", "Could not read the request body.");
  }

  if (chunks.length === 0) {
    return {};
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError(
      400,
      "INVALID_JSON",
      "The request body is not valid JSON.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError(400, "invalid_body", "The JSON body must be an object.");
  }
  return value;
}

function appendSetCookie(response, cookie) {
  const existing = response.getHeader("Set-Cookie");
  if (existing === undefined) {
    response.setHeader("Set-Cookie", cookie);
    return;
  }
  if (Array.isArray(existing)) {
    response.setHeader("Set-Cookie", [...existing, cookie]);
    return;
  }
  response.setHeader("Set-Cookie", [existing, cookie]);
}

function secureCookieOptions(config) {
  return {
    secure: config.isProduction,
    sameSite: "Lax",
    httpOnly: true,
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendRedirect(response, location, status = 302) {
  response.statusCode = status;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end();
}

function hasImportableSettings(state) {
  if (!state || typeof state !== "object") {
    return false;
  }
  return Boolean(
    (Array.isArray(state.tokens) && state.tokens.length > 0) ||
      (Array.isArray(state.oracleAccounts) &&
        state.oracleAccounts.length > 0) ||
      state.proxy?.enabled === true ||
      state.proxy?.updatedAt,
  );
}

function isPasswordFailure(error) {
  return (
    error?.name === "VaultPasswordError" ||
    error?.code === "vault_password_invalid"
  );
}

function mapError(error) {
  if (error instanceof AuthError) {
    return error;
  }
  if (error?.name === "VaultPasswordError" || error?.code === "vault_password_invalid") {
    return new AuthError(
      401,
      "vault_password_invalid",
      "The vault password is incorrect.",
    );
  }
  if (error?.name === "VaultFormatError" || error?.code === "vault_format_invalid") {
    return new AuthError(
      422,
      "vault_format_invalid",
      "The encrypted vault format is invalid.",
    );
  }
  if (error?.name === "VaultConflictError" || error?.code === "vault_conflict") {
    return new AuthError(
      409,
      "vault_conflict",
      "The vault changed on GitHub. Refresh and unlock again.",
    );
  }
  if (error?.name === "VaultTooLargeError" || error?.code === "vault_too_large") {
    return new AuthError(
      413,
      "vault_too_large",
      "The vault file exceeds the 512 KB limit.",
    );
  }
  if (
    Number.isInteger(error?.status) &&
    typeof error?.code === "string" &&
    error?.name?.startsWith("Vault")
  ) {
    return new AuthError(error.status, error.code, error.message);
  }
  if (error instanceof GitHubHttpError) {
    if (error.status === 401) {
      return new AuthError(
        401,
        "reauth_required",
        "GitHub no longer accepts this session. Please sign in again.",
      );
    }
    if (error.status === 403) {
      return new AuthError(
        403,
        "github_forbidden",
        "GitHub denied access to the requested resource.",
      );
    }
    if (error.status === 404) {
      return new AuthError(
        404,
        "github_not_found",
        "The requested GitHub resource was not found.",
      );
    }
    return new AuthError(
      502,
      "github_api_error",
      `GitHub API request failed (HTTP ${error.status}).`,
    );
  }
  if (error instanceof GitHubNetworkError) {
    return new AuthError(
      502,
      "github_unavailable",
      "GitHub could not be reached. Please try again.",
    );
  }
  if (error instanceof GitHubOAuthError) {
    return new AuthError(
      401,
      "oauth_failed",
      `GitHub OAuth failed: ${error.message}`,
    );
  }
  return new AuthError(
    500,
    "internal_error",
    "An unexpected server error occurred.",
  );
}

export function createAuthController({
  config,
  vaultStoreFactory,
  localSettingsStore = null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger = console,
} = {}) {
  if (!config) {
    throw new Error("A readAuthConfig() result is required.");
  }
  if (config.mode !== "github") {
    return {
      enabled: false,
      mode: config.mode,
      config,
      async handle() {
        return false;
      },
      async resolve() {
        throw new AuthError(
          503,
          "not_configured",
          "GitHub authentication mode is not enabled.",
        );
      },
      async getSessionPayload() {
        return { mode: config.mode, configured: false, authenticated: false };
      },
    };
  }
  assertAuthConfigured(config);
  if (typeof vaultStoreFactory !== "function") {
    throw new Error("vaultStoreFactory is required in github mode.");
  }

  const installationTokens = new InstallationTokenService({
    appId: config.appId,
    privateKey: config.privateKey,
    fetchImpl,
    now,
  });
  const vaultSessions = new Map();
  const unlockFailures = new Map();
  const vaultCleanupTimer = setInterval(() => {
    const currentTime = now();
    for (const [token, entry] of vaultSessions.entries()) {
      if (
        currentTime - entry.lastUsedAt > VAULT_SESSION_IDLE_MS ||
        currentTime - entry.createdAt > VAULT_SESSION_MAX_AGE_SECONDS * 1000
      ) {
        entry.store?.dispose?.();
        vaultSessions.delete(token);
      }
    }
    for (const [userId, entry] of unlockFailures.entries()) {
      if (currentTime >= entry.resetAt) {
        unlockFailures.delete(userId);
      }
    }
  }, 5 * 60 * 1000);
  vaultCleanupTimer.unref?.();

  function cookieOptions() {
    return secureCookieOptions(config);
  }

  function setSessionCookie(response, session, currentTime = now()) {
    appendSetCookie(
      response,
      serializeCookie(
        COOKIE_NAMES.session,
        encryptSession(session, config.sessionSecret),
        {
          ...cookieOptions(),
          maxAge: sessionCookieMaxAge(session, currentTime),
        },
      ),
    );
  }

  function clearSessionCookie(response) {
    appendSetCookie(
      response,
      clearCookie(COOKIE_NAMES.session, cookieOptions()),
    );
  }

  function setVaultCookie(response, token) {
    appendSetCookie(
      response,
      serializeCookie(COOKIE_NAMES.vault, token, {
        ...cookieOptions(),
        maxAge: VAULT_SESSION_MAX_AGE_SECONDS,
      }),
    );
  }

  function clearVaultCookie(response) {
    appendSetCookie(
      response,
      clearCookie(COOKIE_NAMES.vault, cookieOptions()),
    );
  }

  function clearAuthCookies(response) {
    clearSessionCookie(response);
    clearVaultCookie(response);
  }

  function readSessionCookie(request) {
    const cookies = parseCookies(request.headers.cookie);
    const encrypted = cookies[COOKIE_NAMES.session];
    if (!encrypted) {
      return { state: "missing", session: null };
    }
    try {
      const session = decryptJson(
        encrypted,
        config.sessionSecret,
        "cloudvm:session:v1",
      );
      return { state: "ok", session };
    } catch {
      return { state: "invalid", session: null };
    }
  }

  function assertUserAllowed(user) {
    if (isUserAllowed(config, user)) {
      return;
    }
    throw new AuthError(
      403,
      "github_user_not_allowed",
      "This GitHub account is not allowed to use this CloudVMController.",
    );
  }

  async function refreshSessionIfNeeded(session, response) {
    const currentTime = now();
    const accessExpired =
      Number.isFinite(session?.expiresAt) && session.expiresAt <= currentTime;
    const refreshAvailable =
      typeof session?.refreshToken === "string" &&
      session.refreshToken.length > 0 &&
      (!Number.isFinite(session.refreshTokenExpiresAt) ||
        session.refreshTokenExpiresAt > currentTime);

    if (shouldRefreshSession(session, currentTime) && refreshAvailable) {
      try {
        const token = await refreshOAuthToken({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: session.refreshToken,
          fetchImpl,
          now: currentTime,
        });
        session = mergeRefreshedToken(session, token, currentTime);
        if (response) {
          setSessionCookie(response, session, currentTime);
        }
      } catch (error) {
        if (accessExpired) {
          if (response) {
            clearSessionCookie(response);
          }
          return null;
        }
        if (
          !(error instanceof GitHubOAuthError) ||
          ![400, 401].includes(error.status)
        ) {
          throw error;
        }
        logger?.warn?.(
          "[auth] GitHub token refresh was rejected before access token expiry.",
          error.code,
        );
      }
    }

    if (!isSessionValid(session, now())) {
      if (response) {
        clearSessionCookie(response);
      }
      return null;
    }
    return session;
  }

  async function optionalSession(request, response = null) {
    const result = readSessionCookie(request);
    if (result.state !== "ok") {
      return null;
    }
    const session = await refreshSessionIfNeeded(result.session, response);
    if (!session || !isUserAllowed(config, session.user)) {
      return null;
    }
    return session;
  }

  async function requireSession(request, response) {
    const result = readSessionCookie(request);
    if (result.state === "missing") {
      throw new AuthError(
        401,
        "not_authenticated",
        "GitHub sign-in is required.",
      );
    }
    if (result.state === "invalid") {
      clearSessionCookie(response);
      throw new AuthError(
        401,
        "reauth_required",
        "The session cookie is invalid. Please sign in again.",
      );
    }

    const session = await refreshSessionIfNeeded(result.session, response);
    if (!session) {
      throw new AuthError(
        401,
        "reauth_required",
        "The GitHub session expired and could not be refreshed. Please sign in again.",
      );
    }
    assertUserAllowed(session.user);
    return session;
  }

  function vaultPublicEntry(entry) {
    let meta = {};
    if (typeof entry.store?.getVaultMeta === "function") {
      try {
        meta = entry.store.getVaultMeta() || {};
      } catch {
        meta = {};
      }
    }
    return {
      unlocked: true,
      installationId: entry.installationId,
      repository: entry.repository,
      htmlUrl: meta.htmlUrl ?? entry.htmlUrl ?? null,
      sha: meta.sha ?? entry.sha ?? null,
      created: entry.created === true,
    };
  }

  function getVaultEntry(request, session) {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAMES.vault];
    if (!token) {
      return null;
    }
    const entry = vaultSessions.get(token);
    if (!entry || entry.userId !== session.user.id) {
      return null;
    }
    const currentTime = now();
    if (
      currentTime - entry.lastUsedAt > VAULT_SESSION_IDLE_MS ||
      currentTime - entry.createdAt > VAULT_SESSION_MAX_AGE_SECONDS * 1000
    ) {
      entry.store?.dispose?.();
      vaultSessions.delete(token);
      return null;
    }
    entry.lastUsedAt = currentTime;
    return { token, entry };
  }

  function destroyCurrentVaultSession(
    request,
    response,
    { clear = true } = {},
  ) {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAMES.vault];
    if (token) {
      vaultSessions.get(token)?.store?.dispose?.();
      vaultSessions.delete(token);
    }
    if (clear) {
      clearVaultCookie(response);
    }
  }

  function destroyVaultSessionsForUser(userId) {
    for (const [token, entry] of vaultSessions.entries()) {
      if (entry.userId === userId) {
        if (typeof entry.store?.dispose === "function") {
          entry.store.dispose();
        }
        vaultSessions.delete(token);
      }
    }
  }

  function sessionPublicPayload(session, request) {
    if (!session) {
      return {
        mode: "github",
        configured: config.githubConfigured,
        authenticated: false,
      };
    }

    const vaultResult = getVaultEntry(request, session);
    const payload = {
      mode: "github",
      configured: config.githubConfigured,
      authenticated: true,
      user: session.user,
      vault: vaultResult
        ? vaultPublicEntry(vaultResult.entry)
        : { unlocked: false },
    };
    if (vaultResult) {
      payload.settings = vaultResult.entry.store.getPublicSettings();
    }
    return payload;
  }

  async function getSessionPayload(request, response = null) {
    const result = readSessionCookie(request);
    if (result.state === "invalid" && response) {
      clearSessionCookie(response);
    }
    if (result.state !== "ok") {
      return {
        mode: "github",
        configured: config.githubConfigured,
        authenticated: false,
      };
    }
    const session = await refreshSessionIfNeeded(result.session, response);
    if (!session) {
      return {
        mode: "github",
        configured: config.githubConfigured,
        authenticated: false,
      };
    }
    if (!isUserAllowed(config, session.user)) {
      if (response) {
        clearSessionCookie(response);
      }
      return {
        mode: "github",
        configured: config.githubConfigured,
        authenticated: false,
        authError: "github_user_not_allowed",
      };
    }
    return sessionPublicPayload(session, request);
  }

  function checkUnlockRateLimit(userId) {
    const entry = unlockFailures.get(userId);
    if (!entry) {
      return;
    }
    if (now() >= entry.resetAt) {
      unlockFailures.delete(userId);
      return;
    }
    if (entry.count >= VAULT_UNLOCK_FAILURE_LIMIT) {
      const retryAfter = Math.max(
        1,
        Math.ceil((entry.resetAt - now()) / 1000),
      );
      throw new AuthError(
        429,
        "vault_rate_limited",
        `Too many failed vault unlock attempts. Try again in ${retryAfter} seconds.`,
      );
    }
  }

  function recordUnlockFailure(userId) {
    const currentTime = now();
    let entry = unlockFailures.get(userId);
    if (!entry || currentTime >= entry.resetAt) {
      entry = {
        count: 0,
        resetAt: currentTime + VAULT_UNLOCK_WINDOW_MS,
      };
      unlockFailures.set(userId, entry);
    }
    entry.count += 1;
    if (entry.count >= VAULT_UNLOCK_FAILURE_LIMIT) {
      entry.resetAt = currentTime + VAULT_UNLOCK_WINDOW_MS;
      const retryAfter = Math.max(
        1,
        Math.ceil((entry.resetAt - currentTime) / 1000),
      );
      throw new AuthError(
        429,
        "vault_rate_limited",
        `Too many failed vault unlock attempts. Try again in ${retryAfter} seconds.`,
      );
    }
  }

  function clearUnlockFailures(userId) {
    unlockFailures.delete(userId);
  }

  function importedState() {
    if (
      !localSettingsStore ||
      typeof localSettingsStore.exportPlainState !== "function"
    ) {
      return null;
    }
    try {
      const state = localSettingsStore.exportPlainState();
      return hasImportableSettings(state) ? state : null;
    } catch (error) {
      logger?.warn?.("[auth] Could not import local settings.", error?.message);
      return null;
    }
  }

  async function handleLogin(request, response, url) {
    assertMethod(request, ["GET"]);
    const returnToParam = url.searchParams.get("returnTo");
    const returnTo =
      returnToParam === null ? "/" : sanitizeReturnTo(returnToParam, null);
    if (!returnTo) {
      throw new AuthError(
        400,
        "invalid_return_to",
        "returnTo must be a site-relative path.",
      );
    }

    const redirectUri = `${getRequestOrigin(request, config)}/api/auth/callback`;
    const attempt = createOAuthAttempt({
      returnTo,
      redirectUri,
      now: now(),
    });
    appendSetCookie(
      response,
      serializeCookie(
        COOKIE_NAMES.oauthState,
        encryptOAuthState(attempt.cookie),
        {
          ...cookieOptions(),
          maxAge: attempt.maxAge,
        },
      ),
    );
    sendRedirect(
      response,
      buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri,
        state: attempt.cookie.state,
        codeChallenge: attempt.challenge,
      }),
    );
  }

  function encryptOAuthState(cookie) {
    return encryptPurpose(cookie, "cloudvm:oauth-state:v1");
  }

  function decryptOAuthState(value) {
    return decryptPurpose(value, "cloudvm:oauth-state:v1");
  }

  function encryptInstallState(cookie) {
    return encryptPurpose(cookie, "cloudvm:install-state:v1");
  }

  function decryptInstallState(value) {
    return decryptPurpose(value, "cloudvm:install-state:v1");
  }

  function encryptPurpose(value, purpose) {
    // Keep the purpose strings in one place while using the shared
    // session-cookie encryptor.
    return encryptJson(value, config.sessionSecret, purpose);
  }

  function decryptPurpose(value, purpose) {
    return decryptJson(value, config.sessionSecret, purpose);
  }

  async function handleCallback(request, response, url) {
    assertMethod(request, ["GET"]);
    const cookies = parseCookies(request.headers.cookie);
    const encryptedAttempt = cookies[COOKIE_NAMES.oauthState];
    if (encryptedAttempt) {
      appendSetCookie(
        response,
        clearCookie(COOKIE_NAMES.oauthState, cookieOptions()),
      );
    }
    if (!encryptedAttempt) {
      throw new AuthError(
        400,
        "invalid_state",
        "The OAuth state cookie is missing. Please sign in again.",
      );
    }

    let cookieAttempt;
    try {
      cookieAttempt = decryptOAuthState(encryptedAttempt);
    } catch {
      throw new AuthError(
        400,
        "invalid_state",
        "The OAuth state cookie is invalid. Please sign in again.",
      );
    }

    const attempt = validateOAuthAttempt(
      cookieAttempt,
      url.searchParams.get("state"),
      now(),
    );

    if (url.searchParams.has("error")) {
      throw new AuthError(
        401,
        "oauth_denied",
        "GitHub authorization was cancelled or denied.",
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      throw new AuthError(
        400,
        "missing_code",
        "GitHub did not return an OAuth code.",
      );
    }

    let token;
    try {
      token = await exchangeOAuthCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri: attempt.redirectUri,
        codeVerifier: attempt.verifier,
        fetchImpl,
        now: now(),
      });
    } catch (error) {
      if (error instanceof GitHubOAuthError) {
        throw new AuthError(
          401,
          "oauth_failed",
          `GitHub sign-in failed: ${error.message}`,
        );
      }
      throw error;
    }

    const user = await fetchGitHubUser(token.accessToken, { fetchImpl });
    if (!isUserAllowed(config, user)) {
      clearAuthCookies(response);
      sendRedirect(response, GITHUB_USER_DENIED_REDIRECT);
      return;
    }

    const session = createSession({ user, token, now: now() });
    setSessionCookie(response, session, now());
    clearVaultCookie(response);
    destroyVaultSessionsForUser(user.id);
    sendRedirect(response, attempt.returnTo);
  }

  async function handleSession(request, response) {
    assertMethod(request, ["GET"]);
    sendJson(response, 200, await getSessionPayload(request, response));
  }

  async function handleLogout(request, response) {
    assertMethod(request, ["POST"]);
    requireCsrfHeader(request);
    const result = readSessionCookie(request);
    if (result.state === "ok" && result.session?.user?.id) {
      destroyVaultSessionsForUser(result.session.user.id);
    }
    const vaultToken = parseCookies(request.headers.cookie)[COOKIE_NAMES.vault];
    if (vaultToken) {
      vaultSessions.get(vaultToken)?.store?.dispose?.();
      vaultSessions.delete(vaultToken);
    }
    clearAuthCookies(response);
    sendJson(response, 200, { ok: true });
  }

  async function handleInstall(request, response) {
    assertMethod(request, ["GET", "POST"]);
    requireCsrfHeader(request);
    const session = await requireSession(request, response);
    const attempt = createInstallAttempt({
      userId: session.user.id,
      now: now(),
    });
    appendSetCookie(
      response,
      serializeCookie(
        COOKIE_NAMES.installState,
        encryptInstallState(attempt.cookie),
        {
          ...cookieOptions(),
          maxAge: attempt.maxAge,
        },
      ),
    );
    sendRedirect(
      response,
      buildInstallUrl(config.slug, attempt.cookie.state),
    );
  }

  async function handleSetup(request, response, url) {
    assertMethod(request, ["GET"]);
    let session = null;
    try {
      session = await optionalSession(request, response);
    } catch (error) {
      if (!(error instanceof AuthError && error.code === "reauth_required")) {
        throw error;
      }
    }

    if (!session) {
      const returnTo = sanitizeReturnTo(
        `${url.pathname}${url.search}`,
        null,
      );
      if (!returnTo) {
        throw new AuthError(
          400,
          "invalid_return_to",
          "Invalid setup return path.",
        );
      }
      sendRedirect(
        response,
        `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      );
      return;
    }

    const state = url.searchParams.get("state");
    const installationId = normalizeInstallationId(
      url.searchParams.get("installation_id"),
    );
    if (installationId === null) {
      throw new AuthError(
        400,
        "invalid_installation_id",
        "installation_id must be a positive integer.",
      );
    }

    const cookies = parseCookies(request.headers.cookie);
    const encryptedAttempt = cookies[COOKIE_NAMES.installState];
    if (encryptedAttempt) {
      appendSetCookie(
        response,
        clearCookie(COOKIE_NAMES.installState, cookieOptions()),
      );
    }
    if (!encryptedAttempt) {
      throw new AuthError(
        400,
        "invalid_install_state",
        "The GitHub App installation state cookie is missing.",
      );
    }

    let cookieAttempt;
    try {
      cookieAttempt = decryptInstallState(encryptedAttempt);
    } catch {
      throw new AuthError(
        400,
        "invalid_install_state",
        "The GitHub App installation state cookie is invalid.",
      );
    }
    validateInstallAttempt(cookieAttempt, state, session.user.id, now());
    await assertUserCanAccessInstallation(
      session.accessToken,
      installationId,
      { fetchImpl },
    );
    sendRedirect(response, GITHUB_INSTALL_REDIRECT);
  }

  async function handleInstallations(request, response) {
    assertMethod(request, ["GET"]);
    const session = await requireSession(request, response);
    const installations = await listUserInstallations(session.accessToken, {
      fetchImpl,
    });
    sendJson(response, 200, {
      installations: installations.map(simplifyInstallation),
    });
  }

  async function handleRepositories(request, response, url) {
    assertMethod(request, ["GET"]);
    const session = await requireSession(request, response);
    const installationId = normalizeInstallationId(
      url.searchParams.get("installationId"),
    );
    if (installationId === null) {
      throw new AuthError(
        400,
        "invalid_installation_id",
        "installationId must be a positive integer.",
      );
    }
    await assertUserCanAccessInstallation(
      session.accessToken,
      installationId,
      { fetchImpl },
    );
    const repositories = await listInstallationRepositories(
      session.accessToken,
      installationId,
      { fetchImpl },
    );
    sendJson(response, 200, {
      repositories: repositories
        .map(simplifyRepository)
        .filter((repository) => repository.private === true),
    });
  }

  async function handleVaultStatus(request, response, url) {
    assertMethod(request, ["GET"]);
    const session = await requireSession(request, response);
    const installationId = normalizeInstallationId(
      url.searchParams.get("installationId"),
    );
    if (installationId === null) {
      throw new AuthError(
        400,
        "invalid_installation_id",
        "installationId must be a positive integer.",
      );
    }
    const repository = normalizeRepositoryFullName(
      url.searchParams.get("repository"),
    );
    if (!repository) {
      throw new AuthError(
        400,
        "invalid_repository",
        "repository must use the owner/name format.",
      );
    }

    await assertUserCanAccessRepository(
      session.accessToken,
      installationId,
      repository,
      { fetchImpl },
    );
    const installationToken = await installationTokens.get(installationId);
    const file = await readVaultFile({
      installationToken,
      repository,
      fetchImpl,
    });
    const vaultResult = getVaultEntry(request, session);
    sendJson(response, 200, {
      exists: file.exists,
      sha: file.sha,
      htmlUrl: file.htmlUrl,
      locked:
        !vaultResult ||
        vaultResult.entry.installationId !== installationId ||
        vaultResult.entry.repository.toLowerCase() !== repository.toLowerCase(),
      repository,
      installationId,
    });
  }

  async function handleVaultUnlock(request, response) {
    assertMethod(request, ["POST"]);
    requireCsrfHeader(request);
    const session = await requireSession(request, response);
    const body = await readJsonBody(request);
    const installationId = normalizeInstallationId(body.installationId);
    if (installationId === null) {
      throw new AuthError(
        400,
        "invalid_installation_id",
        "installationId must be a positive integer.",
      );
    }
    const repository = normalizeRepositoryFullName(body.repository);
    if (!repository) {
      throw new AuthError(
        400,
        "invalid_repository",
        "repository must use the owner/name format.",
      );
    }
    const password =
      typeof body.password === "string" ? body.password : "";
    if (!password) {
      throw new AuthError(
        400,
        "vault_password_required",
        "A vault password is required.",
      );
    }
    if (password.length > 1024) {
      throw new AuthError(
        400,
        "vault_password_too_long",
        "The vault password is too long.",
      );
    }

    checkUnlockRateLimit(session.user.id);
    await assertUserCanAccessRepository(
      session.accessToken,
      installationId,
      repository,
      { fetchImpl },
    );
    const installationToken = await installationTokens.get(installationId);

    let vault;
    try {
      vault = await vaultStoreFactory({
        installationToken,
        installationId,
        repository,
        password,
        createIfMissing: true,
        importState: importedState(),
        readVaultFile,
        writeVaultFile,
        fetchImpl,
      });
    } catch (error) {
      if (isPasswordFailure(error)) {
        recordUnlockFailure(session.user.id);
      }
      throw error;
    }

    if (!vault || !vault.store) {
      throw new AuthError(
        500,
        "vault_open_failed",
        "The vault store could not be opened.",
      );
    }

    clearUnlockFailures(session.user.id);
    destroyCurrentVaultSession(request, response, { clear: false });
    const token = randomToken(32);
    const currentTime = now();
    vaultSessions.set(token, {
      userId: session.user.id,
      installationId,
      repository,
      store: vault.store,
      sha: vault.sha ?? null,
      htmlUrl: vault.htmlUrl ?? null,
      created: vault.created === true,
      createdAt: currentTime,
      lastUsedAt: currentTime,
    });
    setVaultCookie(response, token);

    sendJson(response, 200, {
      ok: true,
      created: vault.created === true,
      settings: vault.store.getPublicSettings(),
      vault: {
        installationId,
        repository,
        htmlUrl: vault.htmlUrl ?? null,
        sha: vault.sha ?? null,
      },
    });
  }

  async function handleVaultLock(request, response) {
    assertMethod(request, ["POST"]);
    requireCsrfHeader(request);
    await requireSession(request, response);
    destroyCurrentVaultSession(request, response);
    sendJson(response, 200, { ok: true });
  }

  async function handle(request, response, parsedUrl = requestUrl(request)) {
    const pathname = normalizePathname(parsedUrl.pathname);
    const routeKnown =
      pathname === "/api/auth/login" ||
      pathname === "/api/auth/callback" ||
      pathname === "/api/auth/session" ||
      pathname === "/api/session" ||
      pathname === "/api/auth/logout" ||
      pathname === "/api/github/install" ||
      pathname === "/api/github/setup" ||
      pathname === "/api/github/installations" ||
      pathname === "/api/github/repositories" ||
      pathname === "/api/vault/status" ||
      pathname === "/api/vault/unlock" ||
      pathname === "/api/vault/lock";
    if (!routeKnown) {
      return false;
    }

    try {
      if (pathname === "/api/auth/login") {
        await handleLogin(request, response, parsedUrl);
      } else if (pathname === "/api/auth/callback") {
        await handleCallback(request, response, parsedUrl);
      } else if (
        pathname === "/api/auth/session" ||
        pathname === "/api/session"
      ) {
        await handleSession(request, response);
      } else if (pathname === "/api/auth/logout") {
        await handleLogout(request, response);
      } else if (pathname === "/api/github/install") {
        await handleInstall(request, response);
      } else if (pathname === "/api/github/setup") {
        await handleSetup(request, response, parsedUrl);
      } else if (pathname === "/api/github/installations") {
        await handleInstallations(request, response);
      } else if (pathname === "/api/github/repositories") {
        await handleRepositories(request, response, parsedUrl);
      } else if (pathname === "/api/vault/status") {
        await handleVaultStatus(request, response, parsedUrl);
      } else if (pathname === "/api/vault/unlock") {
        await handleVaultUnlock(request, response);
      } else if (pathname === "/api/vault/lock") {
        await handleVaultLock(request, response);
      }
    } catch (error) {
      const mapped = mapError(error);
      if (!response.headersSent) {
        sendJson(response, mapped.status, {
          error: mapped.message,
          code: mapped.code,
          details: mapped.details || [],
        });
      } else {
        response.destroy();
      }
      if (mapped.status >= 500) {
        logger?.error?.(
          `[auth] ${request.method} ${pathname} failed`,
          error,
        );
      }
    }
    return true;
  }

  async function resolve(request, response) {
    const session = await requireSession(request, response);
    const vaultResult = getVaultEntry(request, session);
    if (!vaultResult) {
      clearVaultCookie(response);
      throw new AuthError(
        401,
        "vault_locked",
        "Unlock the GitHub vault to continue.",
      );
    }
    return {
      settingsStore: vaultResult.entry.store,
      session,
      vault: vaultPublicEntry(vaultResult.entry),
    };
  }

  return {
    enabled: true,
    mode: "github",
    config,
    handle,
    resolve,
    getSessionPayload,
  };
}
