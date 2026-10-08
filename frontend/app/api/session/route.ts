export async function GET(request: Request) {
  const requestId = request.headers.get("X-Request-Id")?.trim() || crypto.randomUUID();
  const authenticated = Boolean(request.headers.get("oai-authenticated-user-id")?.trim());
  const required = process.env.METRICGROUND_REQUIRE_AUTH === "true";
  console.log(JSON.stringify({
    level: "info",
    event: "session_check",
    requestId,
    authenticated,
    required,
  }));
  return Response.json({ authenticated, required }, {
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}
