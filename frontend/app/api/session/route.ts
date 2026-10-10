import {
  anonymousSessionCookie,
  anonymousSessionsEnabled,
  createAnonymousSessionToken,
  readAnonymousSessionToken,
} from "../../lib/anonymous-session.server.ts";

export async function GET(request: Request) {
  const requestId = request.headers.get("X-Request-Id")?.trim() || crypto.randomUUID();
  const authenticated = Boolean(request.headers.get("oai-authenticated-user-id")?.trim());
  const required = process.env.METRICGROUND_REQUIRE_AUTH === "true";
  const anonymousMode = anonymousSessionsEnabled();
  const existingToken = readAnonymousSessionToken(request);
  const shouldCreateAnonymousSession = !required && !authenticated && anonymousMode && !existingToken;
  const anonymousToken = shouldCreateAnonymousSession ? createAnonymousSessionToken() : existingToken;
  const anonymous = !authenticated && anonymousMode && Boolean(anonymousToken);
  console.log(JSON.stringify({
    level: "info",
    event: "session_check",
    requestId,
    authenticated,
    required,
    anonymous,
  }));
  const headers = new Headers({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
  });
  if (shouldCreateAnonymousSession && anonymousToken) {
    headers.set("Set-Cookie", anonymousSessionCookie(anonymousToken, new URL(request.url).protocol === "https:"));
  }
  return Response.json({ authenticated, required, anonymous }, {
    headers,
  });
}
