// HTTP API. Every /api route needs a signed-in user (session cookie), except POST /api/login.
// Publish tokens (Authorization: Bearer) can only upload releases — for `npm run release` / CI.
import crypto from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import fs from "node:fs";
import { ConflictError, VARIANT_STATUSES, openDb } from "./db.js";
import { openStore } from "./store.js";
import { createJobs, createWorkerPool, jobView } from "./jobs.js";
import { listBackups, runBackup, scheduleBackups } from "./backup.js";
import { slug } from "./exporter.js";
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

function tagsBody(tags) {
  if (!Array.isArray(tags) || tags.length > 20) throw badRequest("tags must be a list of up to 20 names");
  const out = [];
  for (const t of tags) {
    if (typeof t !== "string" || !t.trim() || t.length > 40) throw badRequest("A tag is 1–40 characters");
    if (!out.includes(t.trim())) out.push(t.trim());
  }
  return out;
}

function statusBody(status) {
  if (!VARIANT_STATUSES.includes(status)) throw badRequest(`status must be one of ${VARIANT_STATUSES.join(", ")}`);
  return status;
}

const stringList = (v, what) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw badRequest(`${what} must be a list of strings`);
  return v;
};

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
 * @param backup         { dir, keep } daily backups (see ./backup.js); null turns them off
 */
export async function buildApp({
  dataDir,
  logger = false,
  secureCookies = false,
  trustProxy = false,
  admin = null,
  auth = true,
  backup = null
}) {
  const store = openStore(dataDir);
  const db = openDb(path.join(dataDir, "studio.db"));
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT, trustProxy });
  const pool = createWorkerPool();
  const jobs = createJobs();
  app.addHook("onClose", () => pool.close());
  if (backup?.dir) {
    const stop = scheduleBackups({ db, store, backupDir: backup.dir, keep: backup.keep, log: app.log });
    app.addHook("onClose", async () => stop());
  }
  const tmpTimer = setInterval(() => store.cleanTmp(), 3600 * 1000);
  tmpTimer.unref();
  app.addHook("onClose", async () => clearInterval(tmpTimer));

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
    if (error instanceof ConflictError)
      return reply.status(409).send({ error: error.message, conflicts: error.conflicts, variant: error.variant });
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

  const who = (req) => req.user?.username ?? null;

  /** The release a variant uses by default: its pin, else the game's latest. */
  const defaultRelease = (v) =>
    (v.pinnedReleaseId && db.getRelease(v.pinnedReleaseId)) || db.listReleases(v.gameId)[0] || null;

  function gameRelease(gameId, id) {
    const rel = release(id);
    if (rel.gameId !== gameId) throw badRequest("That release belongs to another game");
    return rel;
  }

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
    const { name = "", base64, gameId } = req.body ?? {};
    if (typeof base64 !== "string") throw badRequest("base64 is required");
    let bytes;
    try {
      bytes = Buffer.from(decodeBase64(base64));
    } catch (e) {
      throw badRequest(e.message);
    }
    const asset = saveAsset(bytes, name);
    if (gameId !== undefined) db.linkAsset(game(String(gameId)).id, asset.id, asset.name);
    return asset;
  });

  // The game's asset library: files uploaded for it (and used by its variants), to reuse in any variant.
  app.get("/api/games/:gameId/assets", async (req) => db.listGameAssets(game(req.params.gameId).id));

  app.delete("/api/games/:gameId/assets/*", async (req, reply) => {
    const { id } = game(req.params.gameId);
    const assetId = req.params["*"];
    const inUse = db.listGameAssets(id).find((a) => a.id === assetId)?.usedBy ?? [];
    if (inUse.length) throw badRequest(`Still used by: ${inUse.join(", ")}`);
    db.unlinkAsset(id, assetId);
    reply.status(204);
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
    const { name, copyFrom, tags, status } = req.body ?? {};
    let overrides = {};
    let copied = {};
    if (copyFrom !== undefined) {
      const source = variant(copyFrom);
      if (source.gameId !== gameId) throw badRequest("copyFrom belongs to another game");
      overrides = source.overrides;
      copied = { tags: source.tags };
    }
    reply.status(201);
    return db.createVariant(gameId, variantName(name), overrides, {
      user: who(req),
      tags: tags === undefined ? (copied.tags ?? []) : tagsBody(tags),
      status: status === undefined ? "draft" : statusBody(status),
      kind: copyFrom === undefined ? "create" : "copy"
    });
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
    for (const id of ids.values()) db.linkAsset(gameId, id);
    reply.status(201);
    return db.createVariant(gameId, variantName(file.name || "Imported"), overrides, {
      user: who(req),
      tags: Array.isArray(file.tags) ? tagsBody(file.tags) : [],
      kind: "import"
    });
  });

  // Replaces the whole variant. Body: { name?, overrides?, revision? } — with revision, a variant
  // changed since then is a 409. The Studio itself saves with PATCH.
  app.put("/api/variants/:id", async (req) => {
    const { id } = variant(req.params.id);
    const { name, overrides, revision } = req.body ?? {};
    return db.replaceVariant(
      id,
      {
        name: name === undefined ? undefined : variantName(name),
        overrides: overrides === undefined ? undefined : overridesBody(overrides)
      },
      { baseRevision: Number.isInteger(revision) ? revision : null, user: who(req) }
    );
  });

  // Saves only what changed. Body: { baseRevision, set: {path: value}, unset: [path], name, tags,
  // status, pinnedReleaseId, baseReleaseId, force }. A key someone else changed after baseRevision
  // → 409 { conflicts: [{ path, theirs, yours }], variant } (force: true overwrites).
  app.patch("/api/variants/:id", async (req) => {
    const v = variant(req.params.id);
    const body = req.body ?? {};
    const patch = {};
    if (body.set !== undefined) patch.set = overridesBody(body.set);
    if (body.unset !== undefined) patch.unset = stringList(body.unset, "unset");
    if (body.name !== undefined) patch.name = variantName(body.name);
    if (body.tags !== undefined) patch.tags = tagsBody(body.tags);
    if (body.status !== undefined) patch.status = statusBody(body.status);
    if (body.pinnedReleaseId !== undefined)
      patch.pinnedReleaseId = body.pinnedReleaseId === null ? null : gameRelease(v.gameId, body.pinnedReleaseId).id;
    if (body.baseReleaseId !== undefined) patch.baseReleaseId = gameRelease(v.gameId, body.baseReleaseId).id;
    if (body.baseRevision !== undefined && !Number.isInteger(body.baseRevision))
      throw badRequest("baseRevision must be a number");
    return db.patchVariant(v.id, patch, {
      baseRevision: body.baseRevision ?? null,
      force: body.force === true,
      user: who(req)
    });
  });

  // ── history ──────────────────────────────────────────────────────────────
  app.get("/api/variants/:id/revisions", async (req) => db.listRevisions(variant(req.params.id).id));

  app.get("/api/variants/:id/revisions/:revision", async (req) => {
    const rev = db.getRevision(variant(req.params.id).id, Number(req.params.revision));
    if (!rev) throw notFound("Revision");
    return rev;
  });

  // Body: { revision } → the variant gets that entry's name and values back (as a new revision).
  app.post("/api/variants/:id/restore", async (req) => {
    const v = variant(req.params.id);
    const rev = db.getRevision(v.id, Number(req.body?.revision));
    if (!rev) throw notFound("Revision");
    return db.replaceVariant(v.id, { name: rev.name, overrides: rev.overrides }, { user: who(req), kind: "restore" });
  });

  // The last playtest (bot) result: { releaseId, revision, runs, wins, … } from the Studio UI.
  app.post("/api/variants/:id/playtest", async (req) => {
    const v = variant(req.params.id);
    const result = req.body ?? null;
    if (result !== null && (!isPlainObject(result) || JSON.stringify(result).length > 20000))
      throw badRequest("Invalid playtest result");
    return db.setPlaytest(v.id, result && { ...result, by: who(req), at: new Date().toISOString() });
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

  // ── exports ──────────────────────────────────────────────────────────────
  function exportRequest(body) {
    const { networks, langs } = body ?? {};
    if (!Array.isArray(networks) || !Array.isArray(langs)) throw badRequest("networks and langs must be arrays");
    if (!networks.length || !langs.length) throw badRequest("Pick at least one network and one language");
    for (const n of networks) if (!Object.hasOwn(EXPORT_NETWORKS, n)) throw badRequest(`Unknown network: ${n}`);
    return { networks: networks.map(String), langs: langs.map(String) };
  }

  const releaseInfo = (rel) => ({ id: rel.id, number: rel.number, gameId: rel.gameId });

  // Body: { releaseId, networks, langs, revision } → the file (or a ZIP of files + report.json).
  // revision: the variant revision the editor shows; if the saved variant is different → 409, so an
  // export never uses values other than the ones on screen.
  app.post("/api/variants/:id/export", async (req, reply) => {
    const v = variant(req.params.id);
    const { networks, langs } = exportRequest(req.body);
    const { releaseId, revision } = req.body;
    if (revision !== undefined && revision !== v.revision)
      throw new HttpError(409, `The variant changed since (now revision ${v.revision}). Check it and export again.`);
    const rel = releaseId === undefined ? defaultRelease(v) : gameRelease(v.gameId, releaseId);
    if (!rel) throw badRequest("No release of this game to export");
    const createdAt = new Date().toISOString();
    const out = await pool.run("export", {
      releaseFile: store.releaseFile(rel.id),
      release: releaseInfo(rel),
      variant: { id: v.id, name: v.name, overrides: v.overrides },
      uploads: variantUploads(v.overrides),
      networks,
      langs,
      createdAt
    });
    const record = db.addExport({
      gameId: v.gameId,
      variantId: v.id,
      variantName: v.name,
      revision: v.revision,
      releaseId: rel.id,
      releaseNumber: rel.number,
      networks,
      langs,
      overrides: v.overrides,
      fileName: out.fileName,
      size: out.data.length,
      sha256: out.sha256,
      warnings: out.warnings,
      user: who(req),
      createdAt
    });
    reply
      .header("Content-Disposition", `attachment; filename="${out.fileName}"`)
      .header("X-Export-Id", String(record.id))
      .header("X-Export-Report", encodeURIComponent(JSON.stringify(out.warnings)))
      .type(out.mime);
    return Buffer.from(out.data);
  });

  app.get("/api/games/:gameId/exports", async (req) => {
    const { id } = game(req.params.gameId);
    return { exports: db.listExports(id), jobs: jobs.list(id).map(jobView) };
  });

  // The same file again: made from the stored values; X-Export-Identical says whether the bytes match.
  app.get("/api/exports/:id/download", async (req, reply) => {
    const e = db.getExportSource(Number(req.params.id));
    if (!e) throw notFound("Export");
    const rel = db.getRelease(e.releaseId);
    if (!rel) throw badRequest(`Release r${e.releaseNumber} was deleted, so this export can't be made again`);
    const out = await pool.run("export", {
      releaseFile: store.releaseFile(rel.id),
      release: releaseInfo(rel),
      variant: { id: e.variantId, name: e.variantName, overrides: e.overrides },
      uploads: variantUploads(e.overrides),
      networks: e.networks,
      langs: e.langs,
      createdAt: e.createdAt
    });
    reply
      .header("Content-Disposition", `attachment; filename="${out.fileName}"`)
      .header("X-Export-Identical", out.sha256 === e.sha256 ? "1" : "0")
      .type(out.mime);
    return Buffer.from(out.data);
  });

  // Bulk export in the background. Body: { variantIds, releaseId?, networks, langs } → 202 job.
  // Each variant uses the given release, or else its pinned release / the latest.
  app.post("/api/games/:gameId/export-jobs", async (req, reply) => {
    const { id: gameId } = game(req.params.gameId);
    const { networks, langs } = exportRequest(req.body);
    const { variantIds, releaseId } = req.body;
    if (!Array.isArray(variantIds) || !variantIds.length || variantIds.length > 500)
      throw badRequest("variantIds: 1–500 variants");
    const variants = variantIds.map((vid) => {
      const v = variant(vid);
      if (v.gameId !== gameId) throw badRequest("A variant belongs to another game");
      return v;
    });
    const byRelease = new Map();
    for (const v of variants) {
      const rel = releaseId === undefined ? defaultRelease(v) : gameRelease(gameId, releaseId);
      if (!rel) throw badRequest("No release of this game to export");
      if (!byRelease.has(rel.id)) byRelease.set(rel.id, { rel, items: [] });
      byRelease.get(rel.id).items.push(v);
    }
    const createdAt = new Date().toISOString();
    const g = game(gameId);
    const job = jobs.create({
      gameId,
      user: who(req),
      networks,
      langs,
      total: variants.length,
      fileName: `${slug(g.id)}_${variants.length}-variants_${createdAt.slice(0, 16).replace(/[:T]/g, "-")}.zip`
    });
    job.zipFile = path.join(store.tmpDir, `job-${job.id}.zip`);
    (async () => {
      job.state = "running";
      const results = [];
      let offset = 0;
      const parts = [];
      for (const { rel, items } of byRelease.values()) {
        const partFile = byRelease.size === 1 ? job.zipFile : `${job.zipFile}.${rel.id}`;
        const out = await pool.run(
          "bulk",
          {
            releaseFile: store.releaseFile(rel.id),
            release: releaseInfo(rel),
            items: items.map((v) => ({
              variant: { id: v.id, name: v.name, overrides: v.overrides },
              uploads: variantUploads(v.overrides)
            })),
            networks,
            langs,
            createdAt,
            zipFile: partFile
          },
          ({ done }) => {
            job.done = offset + done;
          }
        );
        offset += items.length;
        parts.push({ rel, partFile });
        for (const r of out.results) {
          const v = items.find((x) => x.id === r.variantId);
          results.push({
            variantId: v.id,
            name: v.name,
            release: rel.number,
            error: r.error ?? null,
            warnings: r.warnings ?? []
          });
          if (r.error) continue;
          db.addExport({
            gameId,
            variantId: v.id,
            variantName: v.name,
            revision: v.revision,
            releaseId: rel.id,
            releaseNumber: rel.number,
            networks,
            langs,
            overrides: v.overrides,
            fileName: r.fileName,
            size: r.size,
            sha256: r.sha256,
            warnings: r.warnings,
            jobId: job.id,
            user: job.user,
            createdAt
          });
        }
      }
      if (parts.length > 1) {
        // Variants pinned to different releases: one ZIP holding a ZIP per release.
        const { zipSync } = await import("fflate");
        const entries = {};
        for (const { rel, partFile } of parts) {
          entries[`r${rel.number}.zip`] = [fs.readFileSync(partFile), { level: 0 }];
          fs.rmSync(partFile, { force: true });
        }
        fs.writeFileSync(job.zipFile, zipSync(entries));
      }
      job.results = results;
      job.size = fs.statSync(job.zipFile).size;
      job.state = "done";
    })().catch((e) => {
      job.state = "failed";
      job.error = e.message;
    });
    reply.status(202);
    return jobView(job);
  });

  app.get("/api/jobs/:id", async (req) => {
    const job = jobs.get(req.params.id);
    if (!job) throw notFound("Job");
    return jobView(job);
  });

  app.get("/api/jobs/:id/download", async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) throw notFound("Job");
    if (job.state !== "done" || !fs.existsSync(job.zipFile))
      throw badRequest("The export isn't ready (or has expired)");
    reply.header("Content-Disposition", `attachment; filename="${job.fileName}"`).type("application/zip");
    return fs.createReadStream(job.zipFile);
  });

  // Package sizes per network for the editor's size meter. Body: { overrides }.
  app.post("/api/releases/:id/estimate", async (req) => {
    const rel = release(req.params.id);
    const overrides = overridesBody(req.body?.overrides ?? {});
    try {
      return await pool.run("estimate", {
        releaseFile: store.releaseFile(rel.id),
        overrides,
        uploads: variantUploads(overrides)
      });
    } catch (e) {
      return { error: e.message };
    }
  });

  // ── deleting & maintenance ───────────────────────────────────────────────
  // A release can go when it isn't the game's only one and no variant is pinned to it.
  app.delete("/api/releases/:id", async (req, reply) => {
    const rel = release(req.params.id);
    if (db.listReleases(rel.gameId).length === 1) throw badRequest("A game needs at least one release");
    const pinned = db.listVariants(rel.gameId).filter((v) => v.pinnedReleaseId === rel.id);
    if (pinned.length) throw badRequest(`Pinned by: ${pinned.map((v) => v.name).join(", ")} — unpin them first`);
    db.deleteRelease(rel.id);
    store.deleteRelease(rel.id);
    reply.status(204);
  });

  // ?confirm=<game id> guards against deleting the wrong game.
  app.delete("/api/games/:gameId", async (req, reply) => {
    const { id } = game(req.params.gameId);
    if (req.query.confirm !== id) throw badRequest("Confirm with the game id");
    for (const releaseId of db.deleteGame(id)) store.deleteRelease(releaseId);
    reply.status(204);
  });

  // Removes uploaded files nothing uses any more (older than a day) and stray files.
  app.post("/api/maintenance/gc", async () => {
    const { removed, keep } = db.collectUnusedAssets();
    const files = store.removeUnused({ releaseIds: db.releaseIds(), keep });
    return { assets: removed.length, bytes: removed.reduce((n, a) => n + a.size, 0), files };
  });

  app.get("/api/maintenance", async () => ({
    backupDir: backup?.dir ?? null,
    backups: backup?.dir ? listBackups(backup.dir) : []
  }));

  app.post("/api/maintenance/backup", async () => {
    if (!backup?.dir) throw badRequest("Backups are off (set STUDIO_BACKUP_DIR)");
    const out = runBackup({ db, store, backupDir: backup.dir, keep: backup.keep });
    return { ...out, backups: listBackups(backup.dir) };
  });

  return app;
}
