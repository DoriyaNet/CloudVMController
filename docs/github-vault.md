# GitHub Vault 设计与接口约定

本文档描述 CloudVMController 的 GitHub App 登录与私有仓库保险库方案。实现参考
`DoriyaNet/2FA`：GitHub App OAuth 负责身份认证，GitHub App installation token
负责访问用户选择的私有仓库，保险库密文保存在
`.cloudvm/vault.json`。

创建 GitHub App 的逐项操作说明见 wiki：
[创建 GitHub App](https://github.com/DoriyaNet/CloudVMController/wiki/GitHub-App)。

## 目标

- 服务端不把 Linode Token、OCI 私钥或代理密码写入本地磁盘。
- 保险库以 AES-256-GCM 密文保存在 GitHub 私有仓库。
- 只有通过 GitHub 登录且已解锁保险库的请求才能访问云资源 API。
- 保持原有 local 模式可用，便于本地开发和从旧版本迁移。

## 模式

`CLOUDVM_AUTH_MODE`：

- `github`：GitHub App 登录 + 私有仓库保险库。
- `local`：旧行为，使用 `data/settings.json` 和 `data/.key`。
- 未设置时：检测到完整 GitHub App 配置则使用 `github`，否则使用 `local`。

当 `HOST` 不是回环地址且模式为 `local` 时，服务默认拒绝启动；显式设置
`CLOUDVM_ALLOW_INSECURE_REMOTE=1` 才能继续。该逃生开关只用于已经在反向代理
层完成鉴权的情况。

## 环境变量

GitHub 模式必需：

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_SLUG`
- `SESSION_SECRET`（至少 32 字节）

可选：

- `APP_ORIGIN`：规范 origin，例如 `https://cloudvm.example.com`。
- `CLOUDVM_ALLOWED_GITHUB_USERS`：逗号分隔的 GitHub login 白名单。
- `CLOUDVM_ALLOWED_GITHUB_IDS`：逗号分隔的 GitHub user ID 白名单。
- `CLOUDVM_ALLOW_ANY_GITHUB_USER=1`：显式允许多用户使用；默认关闭。
- `CLOUDVM_TRUST_PROXY=1`：信任 `X-Forwarded-Host` / `X-Forwarded-Proto`。
- `CLOUDVM_ALLOW_INSECURE_REMOTE=1`：允许 local 模式监听非回环地址。

GitHub 模式默认要求至少配置一个 login 或 user ID 白名单；白名单为空且未设置
`CLOUDVM_ALLOW_ANY_GITHUB_USER=1` 时，服务拒绝启动，避免公开实例被任意
GitHub 用户使用。

## 服务端模块

### `server/auth/config.js`

```js
readAuthConfig(env) -> {
  mode: "github" | "local",
  githubConfigured: boolean,
  missing: string[],
  configErrors: string[],
  appId, clientId, clientSecret, privateKey, slug,
  sessionSecret, appOrigin,
  isProduction: boolean,
  trustProxy: boolean,
  allowedUsers: string[],
  allowedUserIds: number[],
}
```

### `server/auth/errors.js`

`AuthError(status, code, message)`，用于把鉴权错误映射为 JSON：

```json
{ "error": "message", "code": "machine_code", "details": [] }
```

### `server/auth/cookies.js`

```js
COOKIE_NAMES = {
  session: "cloudvm_session",
  oauthState: "cloudvm_oauth_state",
  installState: "cloudvm_install_state",
  vault: "cloudvm_vault",
}
parseCookies(header)
serializeCookie(name, value, { maxAge, secure, sameSite, httpOnly })
clearCookie(name, options)
```

### `server/auth/crypto.js`

```js
encryptJson(value, secret, purpose)
decryptJson(value, secret, purpose)
randomToken(byteLength)
safeStringEqual(left, right)
base64urlEncode(value)
```

会话 Cookie 使用 AES-256-GCM，密钥由 `SESSION_SECRET` 经 HKDF-SHA256 派生。

### `server/auth/github.js`

GitHub REST 客户端与 App JWT。`fetchImpl` 可注入以便测试。

```js
createAppJwt({ appId, privateKey, now })
class InstallationTokenService { get(installationId) }
exchangeOAuthCode({ clientId, clientSecret, code, redirectUri, codeVerifier, fetchImpl, now })
refreshOAuthToken({ clientId, clientSecret, refreshToken, fetchImpl, now })
fetchGitHubUser(accessToken, { fetchImpl })
listUserInstallations(accessToken, { fetchImpl })
listInstallationRepositories(accessToken, installationId, { fetchImpl })
assertUserCanAccessInstallation(accessToken, installationId, { fetchImpl })
assertUserCanAccessRepository(accessToken, installationId, repository, { fetchImpl })
readVaultFile({ installationToken, repository, fetchImpl })
writeVaultFile({ installationToken, repository, content, sha, fetchImpl })
normalizeInstallationId(value)
normalizeRepositoryFullName(value)
simplifyInstallation(value)
simplifyRepository(value)
```

保险库路径固定为 `.cloudvm/vault.json`。只允许私有仓库。

### `server/auth/oauth.js`

```js
sanitizeReturnTo(value, fallback)
createOAuthAttempt({ returnTo, redirectUri, now })
validateOAuthAttempt(attempt, state, now)
buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge })
createInstallAttempt({ userId, now })
validateInstallAttempt(attempt, state, userId, now)
buildInstallUrl(slug, state)
```

OAuth 使用 state + PKCE S256，state 有效期 10 分钟。

登录、安装和回调入口不会直接返回 HTTP 302。服务端改为返回一个带
`meta refresh` 的站内跳转页，再由浏览器跳转到 GitHub 或返回控制台。这是为了兼容
会在服务端自动跟随 302 的 CDN/反向代理：这类代理会把 GitHub 登录页渲染在控制台
域名下，导致 GitHub 登录表单的 `POST /session` 被提交到控制台并返回
`METHOD_NOT_ALLOWED`。如果 CDN 仍出现该现象，应同时关闭 CDN 的“回源跟随跳转”
或“回源跟随 301/302”选项。

### `server/auth/session.js`

```js
createSession({ user, token, now })
encryptSession(session, secret)
isSessionValid(session, now)
shouldRefreshSession(session, now)
mergeRefreshedToken(session, token, now)
sessionCookieMaxAge(session, now)
```

### `server/auth/controller.js`

```js
createAuthController({
  config,              // readAuthConfig 结果
  vaultStoreFactory,   // 由 vault-store 模块注入
  localSettingsStore,  // 可选，用于创建保险库时导入旧设置
  fetchImpl,
  now,
  logger,
}) -> {
  enabled,
  mode,
  config,
  async handle(request, response, url) -> boolean,
  async resolve(request, response) -> { settingsStore, session, vault },
  async getSessionPayload(request, response?) -> object,
}
```

`handle()` 负责以下路由：

- `GET /api/auth/login`
- `GET /api/auth/callback`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET|POST /api/github/install`
- `GET /api/github/setup`
- `GET /api/github/installations`
- `GET /api/github/repositories`
- `GET /api/vault/status`
- `POST /api/vault/unlock`
- `POST /api/vault/lock`

`resolve()` 对其它 `/api/*` 路由执行：

1. 校验加密会话 Cookie；必要时刷新 GitHub access token。
2. 校验 GitHub 用户白名单。
3. 读取保险库会话 Cookie；无效则抛出 `401 vault_locked`。
4. 返回当前保险库的 `settingsStore`。

保险库会话只存在于 Node 进程内存中，重启后必须重新解锁。

`GET /api/auth/session` 返回：

```json
{
  "mode": "github",
  "configured": true,
  "authenticated": true,
  "user": { "id": 1, "login": "octocat", "name": "Octo Cat", "avatarUrl": "..." },
  "vault": {
    "unlocked": true,
    "installationId": 123,
    "repository": "octocat/cloudvm-vault",
    "htmlUrl": "https://github.com/octocat/cloudvm-vault/blob/main/.cloudvm/vault.json",
    "sha": "..."
  },
  "settings": { "...": "getPublicSettings()，仅在已解锁时返回" }
}
```

未登录时只返回 `mode/configured/authenticated`，不返回错误以外的敏感信息。

`POST /api/vault/unlock`：

```json
{
  "installationId": 123,
  "repository": "octocat/cloudvm-vault",
  "password": "vault password"
}
```

成功返回：

```json
{
  "ok": true,
  "created": false,
  "settings": { "...": "getPublicSettings()" },
  "vault": {
    "installationId": 123,
    "repository": "octocat/cloudvm-vault",
    "htmlUrl": "...",
    "sha": "..."
  }
}
```

错误码：`vault_password_invalid`、`vault_format_invalid`、`vault_too_large`、
`vault_conflict`、`repository_forbidden`。

## 保险库存储模块

### `server/settings-core.js`

从现有 `server/settings-store.js` 抽出的纯内存设置状态。所有写操作异步，
通过注入的 `persist(state)` 持久化；持久化失败时回滚内存状态。

```js
createDefaultState()
class SettingsStoreCore {
  constructor({ state, envToken, persist })
  getPublicSettings()
  getCredentials()
  getCredential()
  getTokenById(id)
  getEnvToken()
  getProxyConfig()
  getOracleAccounts()
  getOracleAccountById(id)
  async addToken({ label, token, accountLabel })
  async activateToken(id)
  async removeToken(id)
  async recordVerification(id, { accountLabel })
  async addOracleAccount({ ... })
  async removeOracleAccount(id)
  async recordOracleVerification(id)
  async updateProxy({ ... })
  exportPlainState()
}
```

### `server/settings-store.js`

保持 `openSettingsStore({ dataDir, envToken })` 兼容。内部使用
`SettingsStoreCore`，加载时解密，持久化时加密写入
`data/settings.json`；密钥仍在 `data/.key`。

### `server/vault-crypto.js`

```js
VAULT_FORMAT = "cloudvm-vault"
VAULT_VERSION = 1
VAULT_AAD = "cloudvm-vault:v1"
DEFAULT_ITERATIONS = 600000
deriveVaultKey(password, salt, iterations)
createVaultKey(password)
encryptVaultPayload(state, key, salt, iterations)
decryptVaultPayload(envelopeText, password)
class VaultPasswordError
class VaultFormatError
```

密文 envelope：

```json
{
  "format": "cloudvm-vault",
  "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "base64" },
  "cipher": { "name": "AES-256-GCM", "iv": "base64", "data": "base64" }
}
```

### `server/vault-store.js`

```js
openVaultSettingsStore({
  installationToken,
  installationId,
  repository,
  password,
  createIfMissing,
  importState,
  readVaultFile,
  writeVaultFile,
  fetchImpl,
  maxBytes,
}) -> {
  store,       // SettingsStoreCore 实例
  created,
  sha,
  htmlUrl,
  repository,
  installationId,
  meta,
}
```

首次创建保险库时，如果提供了 `importState`，用它初始化；否则使用空状态。
每次写操作重新生成 IV，使用当前保险库 key 加密并调用 GitHub Contents API。
写入带 `sha` 做乐观并发控制；冲突抛出 `409 vault_conflict`。
保险库密码最少 8 个字符；密码只保存在进程内存中，锁定或退出时销毁会话。

## 服务端集成

`server/app.js`：

- 保持 `createRequestHandler({ settingsStore, auth, ... })` 兼容。
- 若 `auth.enabled`：
  - 先调用 `auth.handle()`；已处理则返回。
  - 对除 `/api/health`、`/api/session`、auth/vault 路由外的 `/api/*` 调用
    `auth.resolve()`，并把返回的 `settingsStore` 传给 router。
- 原有 `settingsStore` 方法调用改为 `await`。
- `formatError` 映射 `AuthError`、`VaultPasswordError`、`VaultFormatError`、
  `VaultConflictError`。

`server/index.js`：

- 读取 auth 配置。
- 非回环地址 + local 模式时默认拒绝启动。
- GitHub 模式缺少配置时打印缺失项并退出。
- 创建 auth controller，注入 vault store factory。
- 保持 local 模式行为。

## 前端

新增 `public/js/auth.js`：

- `renderAuthGate(state)`：未登录时显示 GitHub 登录。
- 已登录但保险库未解锁时显示 installation / 私有仓库选择、密码输入、
  创建/解锁按钮、安装 GitHub App 入口、退出登录。
- 设置页新增“GitHub 保险库”面板：仓库链接、锁定保险库、退出登录。

`public/js/api.js` 新增：

- `authSession()`
- `logout()`
- `installations()`
- `repositories(installationId)`
- `vaultStatus({ installationId, repository })`
- `unlockVault(payload)`
- `lockVault()`

`public/js/app.js`：

- init 先调用 `/api/session`。
- `mode === "github"` 且未登录：显示登录 gate。
- 已登录但 `vault.unlocked === false`：加载 installations / repositories /
  vault status，显示解锁 gate。
- 解锁成功后 `applySettings(result.settings)`，进入原有界面。
- API 返回 `401 not_authenticated` / `vault_locked` 时回到对应 gate，不要弹出
  Linode token 模态框。

## 测试要求

- 使用 `node:test`；GitHub 请求全部通过注入的 `fetchImpl` 模拟。
- 覆盖：配置校验、OAuth state/PKCE、会话 Cookie、installation/repo 权限、
  私有仓库限制、保险库加密/解密/错误密码、冲突、创建时导入、解锁后设置读写、
  未登录/未解锁访问被拒绝、退出登录清理会话。
- 原有 36 个测试保持通过。

## 安全边界

- 保险库密码会通过 HTTPS 提交给自托管 Node 服务，仅保存在进程内存中；
  服务端必须解密保险库才能调用 Linode/OCI API。密码不会写入磁盘或 GitHub。
- GitHub 只看到密文和提交时间等元数据。
- GitHub 的提交历史会保留旧版本密文；删除某个 Token 后，历史密文仍可能被保险库密码解密。需要彻底清除时请重写仓库历史或轮换该 Token。
- 服务端被攻破时，攻击者仍可从内存获得已解锁凭据；这不是零知识证明。
- 生产环境必须使用 HTTPS，并为 GitHub App 配置最小权限：
  Contents read/write、Metadata read-only。
