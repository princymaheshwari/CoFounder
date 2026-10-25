import { env } from "../_generated/server";

// Fetch wrapper for the Creao API Trigger (spec 02). Use only from Convex actions.

export const CREAO_BASE_URL = "https://agent.creao.ai";
const DEFAULT_TIMEOUT_MS = 15_000;
// Creao sits behind Cloudflare, which rejects some default client signatures (403 "error code: 1010").
const USER_AGENT = "cofounder/1.0";

export class CreaoError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Creao ${status} ${code}`);
    this.name = "CreaoError";
  }
}

export class RateLimitedError extends CreaoError {
  constructor(readonly retryAfterMs: number) {
    super("RATE_LIMITED", 429);
    this.name = "RateLimitedError";
  }
}

export type CreaoResponse = { status: number; json: unknown };

// Retry-After is either seconds or an HTTP date; default 60 s when absent or unparseable.
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  if (!header) return 60_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 60_000 : Math.max(0, date - now);
}

function errorCode(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // non-JSON body, e.g. a Cloudflare error page
  }
  return `HTTP_${status}`;
}

export async function creaoFetch(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<CreaoResponse> {
  const key = env.CREAO_API_KEY;
  if (!key) throw new CreaoError("MISSING_API_KEY", 0);
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  // GETs retry once on a network error; POSTs rely on idempotencyKey instead.
  const attempts = method === "GET" ? 2 : 1;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      res = await fetch(CREAO_BASE_URL + path, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      break;
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (attempt === attempts) throw new CreaoError(timedOut ? "TIMEOUT" : "NETWORK_ERROR", 0);
    }
  }
  if (!res) throw new CreaoError("NETWORK_ERROR", 0);

  if (res.status === 429) throw new RateLimitedError(parseRetryAfter(res.headers.get("Retry-After")));
  const body = await res.text();
  if (!res.ok) throw new CreaoError(errorCode(res.status, body), res.status);
  return { status: res.status, json: body ? (JSON.parse(body) as unknown) : null };
}
