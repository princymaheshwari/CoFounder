import { env } from "./_generated/server";
import { NESSIE_BASE_URL, type NessieObject } from "./lib/nessie";

// Fetch wrapper for the Capital One Nessie sandbox (spec 08). Use only from Convex actions.
// The key goes in `?key=`; errors never include the URL, so the key cannot reach a log.

const DEFAULT_TIMEOUT_MS = 15_000;

export class NessieError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Nessie ${status}: ${detail}`);
    this.name = "NessieError";
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function nessieFetch(method: Method, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const key = env.NESSIE_API_KEY;
  if (!key) throw new NessieError(0, "NESSIE_API_KEY is not set");
  const url = `${NESSIE_BASE_URL}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
  // GETs retry on network errors and 5xx; writes are not idempotent, so they never retry (callers resume by tag).
  const attempts = method === "GET" ? 3 : 1;
  let lastError: NessieError = new NessieError(0, "NETWORK_ERROR");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      lastError = new NessieError(0, timedOut ? "TIMEOUT" : "NETWORK_ERROR");
      continue;
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = text;
    }
    if (res.ok) return { status: res.status, json };
    // Nessie error bodies are a JSON string (validation errors) or {message}.
    const detail = typeof json === "string" ? json : json && typeof json === "object" && "message" in json ? String(json.message) : `HTTP_${res.status}`;
    lastError = new NessieError(res.status, detail.slice(0, 300));
    if (res.status < 500 && res.status !== 429) break;
  }
  throw lastError;
}

// List endpoints answer 404 with a string ("No transfers found for this account") when empty.
export async function nessieList(path: string): Promise<NessieObject[]> {
  try {
    const { json } = await nessieFetch("GET", path);
    return Array.isArray(json) ? (json.filter((x) => x && typeof x === "object") as NessieObject[]) : [];
  } catch (err) {
    if (err instanceof NessieError && err.status === 404) return [];
    throw err;
  }
}

export async function nessieGet(path: string): Promise<NessieObject> {
  const { json } = await nessieFetch("GET", path);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new NessieError(0, "unexpected response shape");
  return json as NessieObject;
}

// POST → 201 {code, message, objectCreated: {_id, …}}.
export async function nessieCreate(path: string, body: Record<string, unknown>): Promise<NessieObject> {
  const { json } = await nessieFetch("POST", path, body);
  const created = json && typeof json === "object" && "objectCreated" in json ? (json.objectCreated as unknown) : null;
  if (!created || typeof created !== "object") throw new NessieError(0, `create returned no object: ${String(json).slice(0, 200)}`);
  return created as NessieObject;
}

// DELETE /transfers/{id} → 200, then GET answers 404 "Transfer not found" (verified 2026-10-25).
// A 404 means it is already gone, so a repeated delete is not an error.
export async function nessieDelete(path: string): Promise<void> {
  try {
    await nessieFetch("DELETE", path);
  } catch (err) {
    if (err instanceof NessieError && err.status === 404) return;
    throw err;
  }
}

// PUT → 202 {code, message, objectUpdated: {…}}.
export async function nessieUpdate(path: string, body: Record<string, unknown>): Promise<NessieObject> {
  const { json } = await nessieFetch("PUT", path, body);
  const updated = json && typeof json === "object" && "objectUpdated" in json ? (json.objectUpdated as unknown) : null;
  if (!updated || typeof updated !== "object") throw new NessieError(0, `update returned no object: ${String(json).slice(0, 200)}`);
  return updated as NessieObject;
}
