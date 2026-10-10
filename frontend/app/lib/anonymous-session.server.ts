export const ANONYMOUS_SESSION_COOKIE = "metricground_anon_session";
const ANONYMOUS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function anonymousSessionsEnabled() {
  return process.env.METRICGROUND_ANONYMOUS_SESSIONS === "true";
}

function parseCookies(request: Request) {
  const values = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) values.set(name, value);
  }
  return values;
}

export function readAnonymousSessionToken(request: Request) {
  const token = parseCookies(request).get(ANONYMOUS_SESSION_COOKIE) ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
    ? token.toLowerCase()
    : null;
}

export function anonymousSessionRequired(request: Request, authenticated: boolean) {
  return anonymousSessionsEnabled() && !authenticated && !readAnonymousSessionToken(request);
}

export function createAnonymousSessionToken() {
  return crypto.randomUUID();
}

export function anonymousSessionCookie(token: string, secure: boolean) {
  return [
    `${ANONYMOUS_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ANONYMOUS_SESSION_MAX_AGE_SECONDS}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}
