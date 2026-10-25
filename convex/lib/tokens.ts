// Task-scoped tokens (spec 05): HMAC-SHA256 over {task, role, exp} with CO_TOKEN_SECRET.
// Format: base64url(JSON claims) + "." + base64url(signature). Only the token's hash is stored on the task.
// Signing is deterministic, so a retried run start sends the identical ASSIGN.

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type TaskTokenClaims = { task: string; role: string; exp: number };
export type VerifyResult =
  | { ok: true; claims: TaskTokenClaims }
  | { ok: false; error: "malformed" | "bad_signature" | "expired" };

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signTaskToken(secret: string, claims: TaskTokenClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ task: claims.task, role: claims.role, exp: claims.exp })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

// Checks signature and expiry only; the caller also checks the task is still open (spec 06).
export async function verifyTaskToken(secret: string, token: string, now: number): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed" };
  const [payload, sig] = parts;
  const signature = fromBase64Url(sig);
  const claimsBytes = fromBase64Url(payload);
  if (!signature || !claimsBytes) return { ok: false, error: "malformed" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, encoder.encode(payload));
  if (!valid) return { ok: false, error: "bad_signature" };
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(claimsBytes));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    !claims ||
    typeof claims !== "object" ||
    !("task" in claims) ||
    !("role" in claims) ||
    !("exp" in claims) ||
    typeof claims.task !== "string" ||
    typeof claims.role !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, error: "malformed" };
  }
  if (claims.exp <= now) return { ok: false, error: "expired" };
  return { ok: true, claims: { task: claims.task, role: claims.role, exp: claims.exp } };
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
