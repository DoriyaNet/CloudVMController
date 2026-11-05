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
  async function request(
    path,
    { method = "GET", body, signal, skipUnauthorized = false } = {},
  ) {
    const headers = {
      Accept: "application/json",
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

      if (response.status === 401 && !skipUnauthorized) {
        onUnauthorized?.(apiError);
      }

      throw apiError;
    }

    return payload;
  }

  return {
    request,
    session: () => request("/session"),
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
    saveProxy: (payload) =>
      request("/settings/proxy", { method: "PUT", body: payload }),
    testProxy: (payload) =>
      request("/settings/proxy/test", { method: "POST", body: payload }),
    testConnection: () =>
      request("/settings/test-connection", { method: "POST" }),
    overview: (options) => request("/overview", options),
    catalog: (options) => request("/catalog", options),
    detail: (id, options) => request(`/instances/${id}/detail`, options),
    availability: (region, options) =>
      request(`/availability/${encodeURIComponent(region)}`, options),
    createInstance: (payload) =>
      request("/instances", { method: "POST", body: payload }),
    action: (id, action) =>
      request(`/instances/${id}/actions/${action}`, { method: "POST" }),
    remove: (id) => request(`/instances/${id}`, { method: "DELETE" }),
  };
}
