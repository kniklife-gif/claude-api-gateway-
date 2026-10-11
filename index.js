const ANTHROPIC_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function configuredKeys(env) {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const value = env[`ANTHROPIC_API_KEY_${i}`];
    if (typeof value === "string" && value.trim()) keys.push({ slot: i, value: value.trim() });
  }
  return keys;
}

function jsonError(status, type, message) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeUpstreamError(response, env) {
  // Return a bounded provider error body when it is JSON; never forward headers or credentials.
  return response.text().then((text) => {
    let message = `Anthropic upstream returned HTTP ${response.status}`;
    let type = "api_error";
    try {
      const parsed = JSON.parse(text.slice(0, 64 * 1024));
      if (parsed?.error?.message && typeof parsed.error.message === "string") {
        message = parsed.error.message.slice(0, 2000);
      }
      if (parsed?.error?.type && typeof parsed.error.type === "string") {
        type = parsed.error.type.slice(0, 100);
      }
    } catch {
      // Do not reflect arbitrary non-JSON upstream content.
    }
    // Never reflect any configured credential, even if an upstream error unexpectedly contains one.
    for (const { value } of configuredKeys(env)) {
      if (value) message = message.split(value).join("[redacted]");
    }
    if (typeof env.GATEWAY_TOKEN === "string" && env.GATEWAY_TOKEN) {
      message = message.split(env.GATEWAY_TOKEN).join("[redacted]");
    }
    return jsonError(response.status, type, message);
  });
}

function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] || "";
}

function constantTimeEqual(a, b) {
  // Fixed-size digest comparison avoids a direct early-exit string comparison.
  const encoder = new TextEncoder();
  const digest = async (s) => crypto.subtle.digest("SHA-256", encoder.encode(s));
  return Promise.all([digest(a), digest(b)]).then(([x, y]) => {
    const aa = new Uint8Array(x);
    const bb = new Uint8Array(y);
    let diff = 0;
    for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
    return diff === 0;
  });
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  try {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.has(url.pathname)) return jsonError(404, "not_found_error", "Not found");
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Method not allowed" } }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", allow: "POST", "cache-control": "no-store" },
      });
    }

    if (typeof env.GATEWAY_TOKEN !== "string" || env.GATEWAY_TOKEN.length < 32) {
      return jsonError(503, "api_error", "Gateway authentication is not configured");
    }
    const supplied = bearerToken(request);
    if (!supplied || !(await constantTimeEqual(supplied, env.GATEWAY_TOKEN))) {
      return jsonError(401, "authentication_error", "Unauthorized");
    }

    const keys = configuredKeys(env);
    if (keys.length === 0) return jsonError(503, "api_error", "No upstream API credentials are configured");

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return jsonError(413, "request_too_large", "Request body exceeds 10 MiB");
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonError(413, "request_too_large", "Request body exceeds 10 MiB");
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonError(400, "invalid_request_error", "Request body must be valid JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonError(400, "invalid_request_error", "Request body must be a JSON object");
    }
    if (url.pathname === "/v1/messages" && (typeof payload.model !== "string" || !Array.isArray(payload.messages))) {
      return jsonError(400, "invalid_request_error", "Messages requests require a model string and messages array");
    }

    const streaming = payload.stream === true;
    const maxAttempts = streaming ? 1 : Math.min(keys.length, 3);
    let lastNetworkError;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = keys[attempt];
      let upstream;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort("upstream timeout"), 115_000);
        try {
          upstream = await fetchImpl(`${ANTHROPIC_URL}${url.pathname}${url.search}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": key.value,
              "anthropic-version": request.headers.get("anthropic-version") || API_VERSION,
              ...(request.headers.get("anthropic-beta") ? { "anthropic-beta": request.headers.get("anthropic-beta") } : {}),
            },
            body: rawBody,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastNetworkError = error;
        // Non-streaming requests can retry a bounded number of times only on transport failure.
        // Streaming requests are never retried to avoid replay after stream establishment.
        if (!streaming && attempt + 1 < maxAttempts) continue;
        return jsonError(502, "api_error", "Unable to reach the Anthropic API");
      }

      // Never rotate credentials on 429 or other policy/quota/authentication errors.
      if (!streaming && TRANSIENT_STATUSES.has(upstream.status) && attempt + 1 < maxAttempts) {
        try { await upstream.body?.cancel(); } catch {}
        continue;
      }

      const headers = new Headers();
      const contentType = upstream.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      // Do not forward upstream cookies, auth headers, or arbitrary headers.
      if (upstream.headers.get("retry-after")) headers.set("retry-after", upstream.headers.get("retry-after"));
      if (!upstream.ok) return await safeUpstreamError(upstream, env);
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    return jsonError(502, "api_error", lastNetworkError ? "Unable to reach the Anthropic API" : "Anthropic API temporarily unavailable");
  } catch {
    // No exception details, prompts, or environment values are logged or returned.
    return jsonError(500, "api_error", "Internal gateway error");
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
