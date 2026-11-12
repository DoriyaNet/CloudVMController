export const COOKIE_NAMES = Object.freeze({
  session: "cloudvm_session",
  oauthState: "cloudvm_oauth_state",
  installState: "cloudvm_install_state",
  vault: "cloudvm_vault",
});

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string" || header.length === 0) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !(name in cookies)) {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function serializeCookie(
  name,
  value,
  { maxAge, secure = false, sameSite = "Lax", httpOnly = true } = {},
) {
  const attributes = [`${name}=${value}`, "Path=/"];
  if (httpOnly) {
    attributes.push("HttpOnly");
  }
  attributes.push(`SameSite=${sameSite}`);
  if (Number.isFinite(maxAge)) {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function clearCookie(name, options = {}) {
  return serializeCookie(name, "", { ...options, maxAge: 0 });
}
