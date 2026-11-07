import http from "node:http";
import https from "node:https";

import { SocksProxyAgent } from "socks-proxy-agent";

const DEFAULT_API_BASE = "https://api.linode.com/v4";
const PROXY_PROTOCOLS = new Set(["socks4:", "socks4a:", "socks5:", "socks5h:"]);

export class LinodeError extends Error {
  constructor(status, message, details = [], path = "") {
    super(message);
    this.name = "LinodeError";
    this.status = status;
    this.details = details;
    this.path = path;
  }
}

function normalizeDetails(payload) {
  if (!payload || !Array.isArray(payload.errors)) {
    return [];
  }

  return payload.errors.map((entry) => ({
    field: typeof entry?.field === "string" ? entry.field : "",
    reason: typeof entry?.reason === "string" ? entry.reason : "Unknown API error",
  }));
}

function errorMessage(status, details) {
  if (details.length > 0) {
    return details.map((entry) => entry.reason).join("；");
  }

  if (status === 401) {
    return "Linode API token is invalid or expired.";
  }
  if (status === 403) {
    return "The Linode API token does not have the required scopes.";
  }
  if (status === 429) {
    return "Linode API rate limit reached. Try again shortly.";
  }

  return `Linode API request failed with status ${status}.`;
}

function normalizeProxyUrl(value) {
  let input = String(value || "").trim();
  if (!input) {
    throw new LinodeError(400, "A SOCKS proxy address is required.", [], "");
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = `socks5h://${input}`;
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new LinodeError(400, "The SOCKS proxy address is invalid.", [], "");
  }

  if (!PROXY_PROTOCOLS.has(url.protocol)) {
    throw new LinodeError(
      400,
      "Only SOCKS4, SOCKS4A, SOCKS5 and SOCKS5H proxies are supported.",
      [],
      "",
    );
  }
  if (!url.hostname) {
    throw new LinodeError(400, "The SOCKS proxy hostname is missing.", [], "");
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new LinodeError(400, "The SOCKS proxy port is invalid.", [], "");
  }

  return url;
}

export function createProxyAgent(proxyConfig = {}) {
  if (!proxyConfig.enabled) {
    return null;
  }

  const url = normalizeProxyUrl(proxyConfig.url);
  if (proxyConfig.username) {
    url.username = String(proxyConfig.username);
  }
  if (proxyConfig.password) {
    url.password = String(proxyConfig.password);
  }
  return new SocksProxyAgent(url.toString());
}

async function performRequest(
  url,
  {
    method = "GET",
    headers = {},
    body,
    agent = null,
    timeoutMs = 30_000,
    maxResponseBytes = 12 * 1024 * 1024,
  } = {},
) {
  const transport = url.protocol === "http:" ? http : https;
  const requestHeaders = { ...headers };
  if (body !== undefined && requestHeaders["Content-Length"] === undefined) {
    requestHeaders["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    const request = transport.request(
      url,
      {
        method,
        headers: requestHeaders,
        agent: agent || undefined,
      },
      (response) => {
        const chunks = [];
        let size = 0;

        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            request.destroy(
              new Error("Linode API response exceeded the size limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(resolve, {
            status: response.statusCode || 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => {
          finish(reject, error);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy(new Error("Request timed out"));
    });
    request.on("error", (error) => {
      if (timedOut) {
        finish(
          reject,
          new LinodeError(504, "Linode API request timed out.", [], ""),
        );
        return;
      }
      finish(
        reject,
        new LinodeError(
          502,
          "Could not reach the Linode API. Check the direct connection or SOCKS proxy settings.",
          [{ field: "", reason: error?.message || "Network error" }],
          "",
        ),
      );
    });

    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export async function probeUrl(
  targetUrl,
  { proxy = null, timeoutMs = 20_000 } = {},
) {
  const url = new URL(targetUrl);
  const agent = createProxyAgent(proxy);
  const startedAt = performance.now();
  const response = await performRequest(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "CloudVMController/1.1",
    },
    agent,
    timeoutMs,
  });
  return {
    statusCode: response.status,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

export class LinodeClient {
  constructor({
    token,
    apiBase = DEFAULT_API_BASE,
    timeoutMs = 30_000,
    proxy = null,
  }) {
    if (!token) {
      throw new LinodeError(401, "No Linode API token was provided.", [], "");
    }

    this.token = token;
    this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.agent = createProxyAgent(proxy || {});
  }

  buildUrl(path, extraQuery) {
    const normalizedPath = String(path || "").replace(/^\/+/, "");
    const url = new URL(`${this.apiBase}/${normalizedPath}`);

    if (extraQuery) {
      for (const [key, value] of Object.entries(extraQuery)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url;
  }

  async request(path, { method = "GET", body, query, headers = {} } = {}) {
    const url = this.buildUrl(path, query);
    const requestHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "CloudVMController/1.1",
      ...headers,
    };

    if (body !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
    }

    let response;
    try {
      response = await performRequest(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        agent: this.agent,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof LinodeError) {
        error.path = path;
        throw error;
      }
      throw new LinodeError(
        502,
        "Could not reach the Linode API. Check the direct connection or SOCKS proxy settings.",
        [{ field: "", reason: error?.message || "Network error" }],
        path,
      );
    }

    const text = response.text;
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.status >= 200 && response.status < 300) {
          throw new LinodeError(
            502,
            "Linode API returned an invalid JSON response.",
            [],
            path,
          );
        }
      }
    }

    if (response.status < 200 || response.status >= 300) {
      const details = normalizeDetails(payload);
      throw new LinodeError(
        response.status,
        errorMessage(response.status, details),
        details,
        path,
      );
    }

    return payload;
  }

  async listAll(path) {
    const firstPage = await this.request(path, { query: { page_size: 500, page: 1 } });
    if (!firstPage || !Array.isArray(firstPage.data)) {
      return [];
    }

    const data = [...firstPage.data];
    const pages = Math.min(Number(firstPage.pages) || 1, 20);

    for (let page = 2; page <= pages; page += 1) {
      const result = await this.request(path, { query: { page_size: 500, page } });
      if (Array.isArray(result?.data)) {
        data.push(...result.data);
      }
    }

    return data;
  }
}

export { DEFAULT_API_BASE };
