// Passwords (scrypt), opaque random tokens and the session cookie. Only token hashes are stored,
// so a leaked database does not hand out working sessions or publish tokens.
import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_COOKIE = "studio_session";
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 8;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p)
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when the user does not exist, so a login takes as long either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));
export const burnPasswordCheck = (password) => verifyPassword(password, DUMMY_HASH);

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD)
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (password.length > 200) throw new Error("Password is too long");
  return password;
}

export function validateUsername(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9._-]{2,40}$/.test(name))
    throw new Error("Username: 2-40 characters, letters, digits . _ -");
  return name;
}

export const newToken = (prefix = "") => prefix + crypto.randomBytes(32).toString("base64url");
export const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(value, { secure, maxAge = SESSION_DAYS * 86400 }) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure && "Secure"
  ]
    .filter(Boolean)
    .join("; ");
}

/** Failed logins per client address: after `max` failures, locked for `windowMs`. */
export function loginLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  const entry = (key) => {
    const e = failures.get(key);
    if (e && Date.now() - e.first > windowMs) {
      failures.delete(key);
      return null;
    }
    return e;
  };
  return {
    blocked: (key) => (entry(key)?.count ?? 0) >= max,
    fail(key) {
      const e = entry(key) ?? { count: 0, first: Date.now() };
      e.count++;
      failures.set(key, e);
      if (failures.size > 10000) failures.delete(failures.keys().next().value);
    },
    reset: (key) => failures.delete(key)
  };
}
