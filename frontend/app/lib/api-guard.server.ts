import { ensureTaskRunSchema, taskRunDb } from "./task-run-persistence.server";

export type ApiContext = {
  requestId: string;
  route: string;
  ownerHash: string;
  authenticated: boolean;
  traceRef: string | null;
  startedAt: number;
  rateLimit: { limit: number; remaining: number; resetAt: number };
};

type GuardOptions = {
  route: string;
  limit: number;
  windowMs?: number;
  mutation?: boolean;
};

function validRequestId(value: string | null) {
  return value && /^[A-Za-z0-9_.:-]{8,100}$/.test(value) ? value : crypto.randomUUID();
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function securityHeaders(context: ApiContext) {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": context.requestId,
    "X-RateLimit-Limit": String(context.rateLimit.limit),
    "X-RateLimit-Remaining": String(context.rateLimit.remaining),
    "X-RateLimit-Reset": String(Math.ceil(context.rateLimit.resetAt / 1000)),
  };
}

export function apiJson(context: ApiContext, body: unknown, init: ResponseInit = {}) {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(securityHeaders(context))) headers.set(name, value);
  console.log(JSON.stringify({
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    event: "api_request",
    requestId: context.requestId,
    traceRef: context.traceRef,
    route: context.route,
    status,
    durationMs: Date.now() - context.startedAt,
    authenticated: context.authenticated,
  }));
  return Response.json(body, { ...init, status, headers });
}

export async function guardApiRequest(request: Request, options: GuardOptions) {
  const startedAt = Date.now();
  const requestId = validRequestId(request.headers.get("X-Request-Id"));
  const traceId = request.headers.get("X-Trace-Id")?.trim() ?? "";
  const userId = request.headers.get("oai-authenticated-user-id")?.trim() ?? "";
  const authenticated = Boolean(userId);
  const ownerHash = await sha256(`metricground-owner:${userId || "anonymous-local"}`);
  const provisional: ApiContext = {
    requestId,
    route: options.route,
    ownerHash,
    authenticated,
    traceRef: traceId ? traceId.slice(-12) : null,
    startedAt,
    rateLimit: { limit: options.limit, remaining: options.limit, resetAt: startedAt + (options.windowMs ?? 60_000) },
  };

  if (process.env.METRICGROUND_REQUIRE_AUTH === "true" && !authenticated) {
    return { response: apiJson(provisional, { error: "此部署要求登录后访问。" }, { status: 401 }) } as const;
  }
  if (options.mutation) {
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
    if ((origin && origin !== new URL(request.url).origin) || fetchSite === "cross-site") {
      return { response: apiJson(provisional, { error: "跨站写入请求已被拒绝。" }, { status: 403 }) } as const;
    }
  }

  const clientAddress = request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "local";
  const rateSubject = await sha256(`metricground-rate:${userId || clientAddress}`);
  const windowMs = options.windowMs ?? 60_000;
  const windowStart = Math.floor(startedAt / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const bucketKey = `${options.route}:${rateSubject}:${windowStart}`;
  let row: { request_count: number } | null;
  try {
    const db = taskRunDb();
    await ensureTaskRunSchema(db);
    row = await db.prepare(`INSERT INTO api_rate_limits (bucket_key, request_count, expires_at, updated_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          request_count = api_rate_limits.request_count + 1,
          updated_at = excluded.updated_at
        RETURNING request_count`)
      .bind(bucketKey, resetAt, new Date(startedAt).toISOString())
      .first<{ request_count: number }>();
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "rate_limit_store_failed",
      requestId,
      route: options.route,
      error: error instanceof Error ? error.message : "Unknown rate limit store error",
    }));
    return {
      response: apiJson(provisional, { error: "服务暂时不可用，请稍后重试。" }, { status: 503 }),
    } as const;
  }
  const count = Number(row?.request_count ?? options.limit + 1);
  const context: ApiContext = {
    ...provisional,
    rateLimit: { limit: options.limit, remaining: Math.max(0, options.limit - count), resetAt },
  };
  if (count > options.limit) {
    return {
      response: apiJson(context, { error: "请求过于频繁，请稍后重试。" }, {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil((resetAt - startedAt) / 1000))) },
      }),
    } as const;
  }
  return { context } as const;
}

export async function readJsonBody(request: Request, maximumBytes: number) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return { error: `请求载荷不能超过 ${maximumBytes} 字节。`, status: 413 } as const;
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("payload too large");
        return { error: `请求载荷不能超过 ${maximumBytes} 字节。`, status: 413 } as const;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  try {
    return { value: JSON.parse(raw) as unknown } as const;
  } catch {
    return { error: "请求内容不是有效 JSON。", status: 400 } as const;
  }
}
