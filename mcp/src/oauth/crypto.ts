import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 32 bytes of entropy, prefixed so a leaked string can be recognised on sight
 * and traced to the thing that issued it.
 */
export function newSecret(prefix: string): string {
  return `${prefix}${base64url(randomBytes(32))}`;
}

/** Stored instead of the secret itself, so a database dump is not a keyring. */
export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Constant time. Unequal lengths return early because timingSafeEqual throws
 * on them, and a length is not the secret being protected.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * S256 only. `plain` is accepted by the OAuth spec and rejected here: it
 * proves nothing an interceptor of the authorization request cannot forge.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const derived = base64url(createHash("sha256").update(verifier, "utf8").digest());
  return constantTimeEquals(derived, challenge);
}
