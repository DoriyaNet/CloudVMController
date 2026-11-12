export class ApiError extends Error {
  constructor(message, { status = 0, code = "NETWORK_ERROR", details = [] } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createApi({ onUnauthorized } = {}) {
  function withTokenQuery(path, tokenId) {
    if (!tokenId) {
      return path;
    }
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}tokenId=${encodeURIComponent(tokenId)}`;
  }

  function withQuery(path, key, value) {
    if (!value) {
      return path;
    }
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}${key}=${encodeURIComponent(value)}`;
  }

  function withQueries(path, values = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
  }

  async function request(
    path,
    { method = "GET", body, signal, skipUnauthorized = false } = {},
  ) {
    const headers = {
      Accept: "application/json",
      "X-CloudVMController": "1",
      "X-Linode-Pilot": "1",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response;
    try {
      response = await fetch(`/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new ApiError(
        "无法连接本地服务，请确认 Node 服务仍在运行。",
        { code: "NETWORK_ERROR" },
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const apiError = new ApiError(
        payload?.error || `请求失败（HTTP ${response.status}）`,
        {
          status: response.status,
          code: payload?.code || "API_ERROR",
          details: payload?.details || [],
        },
      );

      const authError = [
        "not_authenticated",
        "reauth_required",
        "vault_locked",
        "github_user_not_allowed",
      ].includes(apiError.code);
      if (authError || (response.status === 401 && !skipUnauthorized)) {
        onUnauthorized?.(apiError);
      }

      throw apiError;
    }

    return payload;
  }

  return {
    request,
    session: () => request("/session"),
    authSession: () => request("/session"),
    logout: () => request("/auth/logout", { method: "POST" }),
    installations: () => request("/github/installations"),
    repositories: (installationId) =>
      request(
        withQuery("/github/repositories", "installationId", installationId),
      ),
    vaultStatus: ({ installationId, repository } = {}) =>
      request(
        withQueries("/vault/status", { installationId, repository }),
      ),
    unlockVault: (payload) =>
      request("/vault/unlock", { method: "POST", body: payload }),
    lockVault: () => request("/vault/lock", { method: "POST" }),
    settings: () => request("/settings"),
    addToken: (payload) =>
      request("/settings/tokens", {
        method: "POST",
        body: payload,
        skipUnauthorized: true,
      }),
    importEnvToken: () =>
      request("/settings/tokens/import-env", { method: "POST" }),
    activateToken: (id) =>
      request(`/settings/tokens/${encodeURIComponent(id)}/activate`, {
        method: "POST",
        skipUnauthorized: true,
      }),
    testToken: (id) =>
      request(`/settings/tokens/${encodeURIComponent(id)}/test`, {
        method: "POST",
        skipUnauthorized: true,
      }),
    deleteToken: (id) =>
      request(`/settings/tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    addOracleAccount: (payload) =>
      request("/settings/oracle-accounts", {
        method: "POST",
        body: payload,
        skipUnauthorized: true,
      }),
    testOracleAccount: (id) =>
      request(`/settings/oracle-accounts/${encodeURIComponent(id)}/test`, {
        method: "POST",
        skipUnauthorized: true,
      }),
    deleteOracleAccount: (id) =>
      request(`/settings/oracle-accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    saveProxy: (payload) =>
      request("/settings/proxy", { method: "PUT", body: payload }),
    testProxy: (payload) =>
      request("/settings/proxy/test", { method: "POST", body: payload }),
    testConnection: () =>
      request("/settings/test-connection", { method: "POST" }),
    overview: (options) => request("/overview", options),
    catalog: (tokenId, options) =>
      request(withTokenQuery("/catalog", tokenId), {
        ...options,
        skipUnauthorized: true,
      }),
    detail: (id, tokenId, options) =>
      request(withTokenQuery(`/instances/${id}/detail`, tokenId), {
        ...options,
        skipUnauthorized: true,
      }),
    oracleDetail: (id, accountId, options) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/detail`,
          "accountId",
          accountId,
        ),
        {
          ...options,
          skipUnauthorized: true,
        },
      ),
    instanceIps: (id, tokenId, options) =>
      request(withTokenQuery(`/instances/${id}/ips`, tokenId), {
        ...options,
        skipUnauthorized: true,
      }),
    swapIp: (id, tokenId, payload) =>
      request(withTokenQuery(`/instances/${id}/ip-swap`, tokenId), {
        method: "POST",
        body: payload,
        skipUnauthorized: true,
      }),
    renewIp: (id, tokenId, payload) =>
      request(withTokenQuery(`/instances/${id}/ip-renew`, tokenId), {
        method: "POST",
        body: payload,
        skipUnauthorized: true,
      }),
    availability: (region, tokenId, options) =>
      request(
        withTokenQuery(
          `/availability/${encodeURIComponent(region)}`,
          tokenId,
        ),
        { ...options, skipUnauthorized: true },
      ),
    createInstance: (payload) =>
      request("/instances", {
        method: "POST",
        body: payload,
        skipUnauthorized: true,
      }),
    action: (id, action, tokenId) =>
      request(withTokenQuery(`/instances/${id}/actions/${action}`, tokenId), {
        method: "POST",
        skipUnauthorized: true,
      }),
    oracleAction: (id, action, accountId) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/actions/${action}`,
          "accountId",
          accountId,
        ),
        {
          method: "POST",
          skipUnauthorized: true,
        },
      ),
    oracleMetrics: (id, accountId, window = "24h", options) =>
      request(
        withQueries(
          `/oracle/instances/${encodeURIComponent(id)}/metrics`,
          { accountId, window },
        ),
        { ...options, skipUnauthorized: true },
      ),
    oracleBackups: (id, accountId, options) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/backups`,
          "accountId",
          accountId,
        ),
        { ...options, skipUnauthorized: true },
      ),
    createOracleBackup: (id, accountId, payload) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/backups`,
          "accountId",
          accountId,
        ),
        {
          method: "POST",
          body: payload,
          skipUnauthorized: true,
        },
      ),
    deleteOracleBackup: (id, backupId, accountId) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}`,
          "accountId",
          accountId,
        ),
        { method: "DELETE", skipUnauthorized: true },
      ),
    oracleConsole: (id, accountId, options) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/console`,
          "accountId",
          accountId,
        ),
        { ...options, skipUnauthorized: true },
      ),
    createOracleConsoleConnection: (id, accountId, payload) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/console`,
          "accountId",
          accountId,
        ),
        {
          method: "POST",
          body: payload,
          skipUnauthorized: true,
        },
      ),
    deleteOracleConsoleConnection: (id, connectionId, accountId) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/console/connections/${encodeURIComponent(connectionId)}`,
          "accountId",
          accountId,
        ),
        { method: "DELETE", skipUnauthorized: true },
      ),
    createOracleConsoleHistory: (id, accountId, payload = {}) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/console/histories`,
          "accountId",
          accountId,
        ),
        {
          method: "POST",
          body: payload,
          skipUnauthorized: true,
        },
      ),
    oracleConsoleHistoryData: (id, historyId, accountId) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/console/histories/${encodeURIComponent(historyId)}/data`,
          "accountId",
          accountId,
        ),
        { skipUnauthorized: true },
      ),
    deleteOracleConsoleHistory: (id, historyId, accountId) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}/console/histories/${encodeURIComponent(historyId)}`,
          "accountId",
          accountId,
        ),
        { method: "DELETE", skipUnauthorized: true },
      ),
    oracleCreateOptions: (accountId, { compartmentId, availabilityDomain } = {}) =>
      request(
        withQueries("/oracle/create-options", {
          accountId,
          compartmentId,
          availabilityDomain,
        }),
        { skipUnauthorized: true },
      ),
    createOracleInstance: (payload) =>
      request("/oracle/instances", {
        method: "POST",
        body: payload,
        skipUnauthorized: true,
      }),
    terminateOracleInstance: (id, accountId, payload) =>
      request(
        withQuery(
          `/oracle/instances/${encodeURIComponent(id)}`,
          "accountId",
          accountId,
        ),
        {
          method: "DELETE",
          body: payload,
          skipUnauthorized: true,
        },
      ),
    remove: (id, tokenId) =>
      request(withTokenQuery(`/instances/${id}`, tokenId), {
        method: "DELETE",
        skipUnauthorized: true,
      }),
  };
}
