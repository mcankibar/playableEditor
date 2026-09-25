// HTTP API. Every /api route needs a signed-in user (session cookie), except POST /api/login.
// Publish tokens (Authorization: Bearer) can only upload releases — for `npm run release` / CI.
import crypto from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import { openDb } from "./db.js";
import { openStore } from "./store.js";
import { exportBatch } from "./exporter.js";
import { inspectRelease } from "../shared/playable/export/patch.js";
import { EXPORT_NETWORKS } from "../shared/playable/export/networks.js";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  burnPasswordCheck,
  hashPassword,
  loginLimiter,
  newToken,
  readCookie,
  sessionCookie,
  tokenHash,
  validatePassword,
  validateUsername,
  verifyPassword
} from "./auth.js";
import { decodeBase64, detectMime, validateAssetId } from "../shared/playable/kit/assets.js";

const BODY_LIMIT = 64 * 1024 * 1024;

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "model/gltf-binary": "glb",
  "application/zip": "zip",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/json": "json",
  "text/plain": "txt"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}
const badRequest = (message) => new HttpError(400, message);
const notFound = (what) => new HttpError(404, `${what} not found`);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function variantName(name) {
  if (typeof name !== "string" || !name.trim()) throw badRequest("Variant name is required");
  if (name.length > 80) throw badRequest("Variant name is too long");
  return name.trim();
}

function overridesBody(overrides) {
  if (!isPlainObject(overrides)) throw badRequest("overrides must be an object");
  return overrides;
}

function parseDataUri(uri) {
  const m = typeof uri === "string" && /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(uri);
  if (!m) throw badRequest("uploads must be base64 data URIs");
  return m[2];
}

/**
 * @param secureCookies  mark the session cookie Secure (the Studio is served over HTTPS)
 * @param trustProxy     behind a reverse proxy: take the client address from X-Forwarded-For
 * @param admin          { username, password } created when the database has no users yet
 * @param auth           false: no sign-in at all, every request acts as a local user (local testing only)
 */
export async function buildApp({
  dataDir,
  logger = false,
  secureCookies = false,
  trustProxy = false,
  admin = null,
  auth = true
}) {
  const store = openStore(dataDir);
  const db = openDb(path.join(dataDir, "studio.db"));
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT, trustProxy });

  if (admin?.password && db.countUsers() === 0) {
    db.createUser(validateUsername(admin.username || "admin"), hashPassword(validatePassword(admin.password)));
  }
  if (!auth) app.log.warn("Sign-in is disabled (STUDIO_AUTH=0): anyone who can reach this port can use the Studio");
  else if (db.countUsers() === 0)
    app.log.warn("No users yet — add one with: npm run users -- add <name>  (or set STUDIO_ADMIN_PASSWORD)");

  app.addContentTypeParser("text/html", { parseAs: "string", bodyLimit: BODY_LIMIT }, (req, body, done) =>
    done(null, body)
  );
  app.addHook("onClose", async () => db.close());
  app.setErrorHandler((error, req, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) req.log.error(error);
    reply.status(status).send({ error: status >= 500 && !error.statusCode ? "Internal error" : error.message });
  });

  // ── auth ─────────────────────────────────────────────────────────────────
  const limiter = loginLimiter();
  const PUBLIC = new Set(["POST /api/login"]);
  const TOKEN_ROUTES = new Set(["POST /api/releases"]);

  const LOCAL_USER = Object.freeze({ id: 0, username: "local", authDisabled: true });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) return; // the web UI itself is public; it shows the login page
    if (!auth) {
      req.user = LOCAL_USER;
      return;
    }
    const route = `${req.method} ${url}`;
    if (PUBLIC.has(route)) return;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    if (bearer) {
      req.user = TOKEN_ROUTES.has(route) ? db.apiTokenUser(tokenHash(bearer)) : null;
      if (!req.user) throw new HttpError(401, "Invalid token, or the token can't be used here");
      return;
    }
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    req.user = session ? db.sessionUser(tokenHash(session)) : null;
    if (!req.user) throw new HttpError(401, "Sign in required");
  });

  app.post("/api/login", async (req, reply) => {
    const { username, password } = req.body ?? {};
    const key = req.ip;
    if (limiter.blocked(key)) throw new HttpError(429, "Too many failed sign-ins, try again in 15 minutes");
    if (typeof username !== "string" || typeof password !== "string" || password.length > 200)
      throw badRequest("username and password are required");
    const login = db.findLogin(username.trim());
    const ok = login ? verifyPassword(password, login.passwordHash) : burnPasswordCheck(password) && false;
    if (!ok) {
      limiter.fail(key);
      throw new HttpError(401, "Wrong username or password");
    }
    limiter.reset(key);
    const token = newToken();
    db.createSession(tokenHash(token), login.user.id, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
    reply.header("Set-Cookie", sessionCookie(token, { secure: secureCookies }));
    return login.user;
  });

  app.post("/api/logout", async (req, reply) => {
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (session) db.deleteSession(tokenHash(session));
    reply.header("Set-Cookie", sessionCookie("", { secure: secureCookies, maxAge: 0 }));
    reply.status(204);
  });

  app.get("/api/me", async (req) => req.user);

  const game = (id) =>
    db.getGame(id) ??
    (() => {
      throw notFound("Game");
    })();
  const release = (id) =>
    db.getRelease(Number(id)) ??
    (() => {
      throw notFound("Release");
    })();
  const variant = (id) =>
    db.getVariant(Number(id)) ??
    (() => {
      throw notFound("Variant");
    })();

  /** Stores bytes content-addressed and returns the asset id used in overrides ("u/<hash>.<ext>"). */
  function saveAsset(bytes, name = "") {
    let mime;
    try {
      mime = detectMime(bytes);
    } catch (e) {
      throw badRequest(`${name || "file"}: ${e.message}`);
    }
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const id = `u/${sha256.slice(0, 12)}.${EXT_BY_MIME[mime] ?? "bin"}`;
    validateAssetId(id);
    store.writeAsset(sha256, bytes);
    return db.addAsset({ id, sha256, mime, size: bytes.length, name: String(name).slice(0, 200) });
  }

  /** The uploaded files a variant points at, in the shape the exporter / preview expects. */
  function variantUploads(overrides) {
    const uploads = Object.create(null);
    for (const value of Object.values(overrides)) {
      if (typeof value !== "string" || uploads[value]) continue;
      const asset = db.getAsset(value);
      if (asset) uploads[value] = { mime: asset.mime, base64: store.readAsset(asset.sha256).toString("base64") };
    }
    return uploads;
  }

  // ── games & releases ─────────────────────────────────────────────────────
  app.get("/api/networks", async () =>
    Object.entries(EXPORT_NETWORKS).map(([id, n]) => ({
      id,
      label: n.label,
      container: n.container,
      maxMb: n.maxMb,
      storeUrl: n.storeUrl
    }))
  );

  app.get("/api/games", async () => db.listGames());

  app.get("/api/games/:gameId", async (req) => ({
    game: game(req.params.gameId),
    releases: db.listReleases(req.params.gameId),
    variants: db.listVariants(req.params.gameId)
  }));

  // Body: the release HTML (dist/index.html) as text/html. ?notes=...
  app.post("/api/releases", async (req, reply) => {
    const html = req.body;
    if (typeof html !== "string" || !html) throw badRequest("Send the release HTML with Content-Type: text/html");
    let manifest;
    try {
      ({ manifest } = inspectRelease(html));
    } catch (e) {
      throw badRequest(e.message);
    }
    const { id, title, version } = manifest.game;
    if (typeof id !== "string" || !id || id.length > 200) throw badRequest("Invalid game id in manifest");
    const notes = typeof req.query.notes === "string" ? req.query.notes.slice(0, 2000) : "";
    const { release: rel, created } = db.addRelease(
      {
        game: { id, title: typeof title === "string" && title ? title : id },
        releaseHash: manifest.releaseId,
        gameVersion: version,
        notes,
        size: Buffer.byteLength(html),
        fieldCount: manifest.fields.length
      },
      (releaseId) => store.writeRelease(releaseId, html)
    );
    reply.status(created ? 201 : 200);
    return { game: db.getGame(id), release: rel, created };
  });

  app.get("/api/releases/:id/manifest", async (req) => store.release(release(req.params.id).id).manifest);

  // The release itself, for the preview iframe (its network block is in preview mode).
  app.get("/api/releases/:id/play", async (req, reply) => {
    const { id } = release(req.params.id);
    reply.header("Cache-Control", "private, max-age=3600").type("text/html; charset=utf-8");
    return store.readReleaseHtml(id);
  });

  app.get("/api/releases/:id/assets/*", async (req, reply) => {
    const { id } = release(req.params.id);
    const asset = store.release(id).assets.get(req.params["*"]);
    if (!asset || !asset.base64) throw notFound("Asset");
    reply.header("Cache-Control", "private, max-age=3600").type(asset.mime);
    return Buffer.from(asset.base64, "base64");
  });

  // ── uploaded assets ──────────────────────────────────────────────────────
  // Body: { name, base64 }. The MIME type is detected from the bytes, never trusted.
  app.post("/api/assets", async (req) => {
    const { name = "", base64 } = req.body ?? {};
    if (typeof base64 !== "string") throw badRequest("base64 is required");
    let bytes;
    try {
      bytes = Buffer.from(decodeBase64(base64));
    } catch (e) {
      throw badRequest(e.message);
    }
    return saveAsset(bytes, name);
  });

  app.get("/api/assets/*", async (req, reply) => {
    const asset = db.getAsset(req.params["*"]);
    if (!asset) throw notFound("Asset");
    reply.header("Cache-Control", "private, max-age=31536000, immutable").type(asset.mime);
    return store.readAsset(asset.sha256);
  });

  // ── variants ─────────────────────────────────────────────────────────────
  app.post("/api/games/:gameId/variants", async (req, reply) => {
    const { gameId } = req.params;
    game(gameId);
    const { name, copyFrom } = req.body ?? {};
    let overrides = {};
    if (copyFrom !== undefined) {
      const source = variant(copyFrom);
      if (source.gameId !== gameId) throw badRequest("copyFrom belongs to another game");
      overrides = source.overrides;
    }
    reply.status(201);
    return db.createVariant(gameId, variantName(name), overrides);
  });

  // Body: a variant file as written by the template's dev panel / used by `npm run export`.
  app.post("/api/games/:gameId/variants/import", async (req, reply) => {
    const { gameId } = req.params;
    game(gameId);
    const file = req.body ?? {};
    const overrides = { ...overridesBody(file.overrides ?? {}) };
    const ids = new Map();
    for (const [oldId, uri] of Object.entries(file.uploads ?? {})) {
      ids.set(oldId, saveAsset(Buffer.from(decodeBase64(parseDataUri(uri))), oldId).id);
    }
    for (const [p, value] of Object.entries(overrides)) {
      if (typeof value === "string" && value.startsWith("file:"))
        throw badRequest(`${p}: "file:" references can't be imported; use the dev panel's download instead`);
      if (ids.has(value)) overrides[p] = ids.get(value);
    }
    reply.status(201);
    return db.createVariant(gameId, variantName(file.name || "Imported"), overrides);
  });

  app.put("/api/variants/:id", async (req) => {
    const { id } = variant(req.params.id);
    const { name, overrides } = req.body ?? {};
    return db.updateVariant(id, {
      name: name === undefined ? undefined : variantName(name),
      overrides: overrides === undefined ? undefined : overridesBody(overrides)
    });
  });

  app.delete("/api/variants/:id", async (req, reply) => {
    const v = variant(req.params.id);
    if (db.listVariants(v.gameId).length === 1) throw badRequest("A game needs at least one variant");
    db.deleteVariant(v.id);
    reply.status(204);
  });

  // Uploaded files of a variant as data URIs, for the preview iframe.
  app.get("/api/variants/:id/uploads", async (req) => {
    const out = {};
    for (const [id, { mime, base64 }] of Object.entries(variantUploads(variant(req.params.id).overrides)))
      out[id] = `data:${mime};base64,${base64}`;
    return out;
  });

  // Body: { releaseId, networks: [...], langs: [...] } → the file (or a ZIP of files + report.json).
  app.post("/api/variants/:id/export", async (req, reply) => {
    const v = variant(req.params.id);
    const { releaseId, networks, langs } = req.body ?? {};
    if (!Array.isArray(networks) || !Array.isArray(langs)) throw badRequest("networks and langs must be arrays");
    const rel = releaseId === undefined ? db.listReleases(v.gameId)[0] : release(releaseId);
    if (!rel || rel.gameId !== v.gameId) throw badRequest("No release of this game to export");
    const prepared = store.release(rel.id);
    let out;
    try {
      out = exportBatch({
        prepared,
        manifest: prepared.manifest,
        release: rel,
        variant: v,
        uploads: variantUploads(v.overrides),
        networks: networks.map(String),
        langs: langs.map(String)
      });
    } catch (e) {
      throw badRequest(e.message);
    }
    reply
      .header("Content-Disposition", `attachment; filename="${out.fileName}"`)
      .header("X-Export-Report", encodeURIComponent(JSON.stringify(out.report.exports.map((e) => e.warnings).flat())))
      .type(out.mime);
    return Buffer.from(out.data);
  });

  return app;
}
