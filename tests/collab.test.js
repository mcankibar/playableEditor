import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { buildApp } from "../server/app.js";
import {
  PLACEHOLDERS,
  assetsBlock,
  configBlock,
  gameBlock,
  manifestBlock,
  networkBlock
} from "../shared/playable/build/blocks.js";

const PNG = PLACEHOLDERS.image.base64;
const PNG2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGBkAAAwGAQFP8b0KAAAAAElFTkSuQmCC";

function releaseHtml(releaseId = "r1") {
  const fields = [
    { path: "options.language", type: "language", default: "auto", label: "Language", group: "Options" },
    { path: "components.cta.color", type: "color", default: "#ff0000", format: "string", label: "Color", group: "CTA" },
    { path: "components.cta.scale", type: "number", default: 1, min: 0, max: 2, label: "Scale", group: "CTA" },
    { path: "components.logo.assets.logo", type: "image", default: "logo.png", label: "Logo", group: "Logo" }
  ];
  const manifest = {
    format: 2,
    schemaVersion: 1,
    game: { id: "test-game", title: "Test Game", version: "1.0.0" },
    releaseId,
    languages: ["en"],
    fields,
    assets: { "logo.png": { type: "image", mime: "image/png", bytes: 70 } }
  };
  return `<!doctype html><html><head><title>t</title>${networkBlock("default")}</head><body>${manifestBlock(
    manifest
  )}${configBlock({})}${assetsBlock([{ id: "logo.png", mime: "image/png", base64: PNG }])}${gameBlock(
    "window.started=true;"
  )}</body></html>`;
}

async function withApp(fn, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
  const app = await buildApp({ dataDir, auth: false, ...opts(dataDir) });
  try {
    await fn(app, dataDir);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (opts(dataDir).backup) fs.rmSync(opts(dataDir).backup.dir, { recursive: true, force: true });
  }
}
const run = (fn, opts = () => ({})) => withApp(fn, opts);

const json = (res) => JSON.parse(res.body);
const upload = (app, html) =>
  app.inject({ method: "POST", url: "/api/releases", headers: { "content-type": "text/html" }, payload: html });
const patch = (app, id, payload) => app.inject({ method: "PATCH", url: `/api/variants/${id}`, payload });
const setup = async (app) => {
  await upload(app, releaseHtml());
  return json(await app.inject("/api/games/test-game")).variants[0];
};

test("PATCH saves only changed keys; different fields merge, the same field conflicts", () =>
  run(async (app) => {
    const v = await setup(app);
    assert.equal(v.revision, 1);
    // Two editors start from revision 1.
    const a = json(await patch(app, v.id, { baseRevision: 1, set: { "components.cta.color": "#00ff00" } }));
    assert.equal(a.revision, 2);
    const b = await patch(app, v.id, { baseRevision: 1, set: { "components.cta.scale": 1.5 } });
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(json(b).overrides, { "components.cta.color": "#00ff00", "components.cta.scale": 1.5 });

    const clash = await patch(app, v.id, { baseRevision: 1, set: { "components.cta.color": "#0000ff" } });
    assert.equal(clash.statusCode, 409);
    const body = json(clash);
    assert.deepEqual(body.conflicts, [{ path: "components.cta.color", theirs: "#00ff00", yours: "#0000ff" }]);
    assert.equal(body.variant.revision, 3);

    const forced = json(
      await patch(app, v.id, { baseRevision: 1, set: { "components.cta.color": "#0000ff" }, force: true })
    );
    assert.equal(forced.overrides["components.cta.color"], "#0000ff");
    // Unset removes; a no-op keeps the revision.
    const unset = json(await patch(app, v.id, { baseRevision: forced.revision, unset: ["components.cta.scale"] }));
    assert.deepEqual(Object.keys(unset.overrides), ["components.cta.color"]);
    const same = json(await patch(app, v.id, { baseRevision: 1, set: { "components.cta.color": "#0000ff" } }));
    assert.equal(same.revision, unset.revision);
    // Name, tags, status are keys too.
    const meta = json(
      await patch(app, v.id, { baseRevision: same.revision, name: "Blue", tags: ["q4", "q4", "ua"], status: "review" })
    );
    assert.deepEqual([meta.name, meta.tags, meta.status], ["Blue", ["q4", "ua"], "review"]);
    assert.equal((await patch(app, v.id, { baseRevision: 1, name: "Red" })).statusCode, 409);
    assert.equal((await patch(app, v.id, { status: "done" })).statusCode, 400);
    assert.equal(meta.updatedBy, "local");
  }));

test("history: autosaves merge into one entry; restore brings an entry back", () =>
  run(async (app) => {
    const v = await setup(app);
    await patch(app, v.id, { set: { "components.cta.color": "#00ff00" } });
    await patch(app, v.id, { set: { "components.cta.scale": 2 } });
    let revs = json(await app.inject(`/api/variants/${v.id}/revisions`));
    assert.deepEqual(
      revs.map((r) => r.kind),
      ["edit", "create"]
    );
    assert.deepEqual(revs[0].changed.sort(), ["components.cta.color", "components.cta.scale"]);
    const snapshot = json(await app.inject(`/api/variants/${v.id}/revisions/${revs[0].revision}`));
    assert.equal(snapshot.overrides["components.cta.scale"], 2);

    const restored = json(
      await app.inject({
        method: "POST",
        url: `/api/variants/${v.id}/restore`,
        payload: { revision: revs[1].revision }
      })
    );
    assert.deepEqual(restored.overrides, {});
    revs = json(await app.inject(`/api/variants/${v.id}/revisions`));
    assert.deepEqual(
      revs.map((r) => r.kind),
      ["restore", "edit", "create"]
    );
    // The edit session before the restore is still there to go back to.
    const back = json(
      await app.inject({
        method: "POST",
        url: `/api/variants/${v.id}/restore`,
        payload: { revision: revs[1].revision }
      })
    );
    assert.deepEqual(back.overrides, { "components.cta.color": "#00ff00", "components.cta.scale": 2 });
  }));

test("export: tied to the revision on screen, recorded, and the same file can be made again", () =>
  run(async (app) => {
    const v = await setup(app);
    const saved = json(await patch(app, v.id, { set: { "components.cta.color": "#00ff00" } }));
    const stale = await app.inject({
      method: "POST",
      url: `/api/variants/${v.id}/export`,
      payload: { networks: ["default", "applovin"], langs: ["auto"], revision: saved.revision - 1 }
    });
    assert.equal(stale.statusCode, 409);
    const res = await app.inject({
      method: "POST",
      url: `/api/variants/${v.id}/export`,
      payload: { networks: ["default", "applovin"], langs: ["auto"], revision: saved.revision }
    });
    assert.equal(res.statusCode, 200, res.body);
    const exportId = Number(res.headers["x-export-id"]);
    const { exports } = json(await app.inject("/api/games/test-game/exports"));
    assert.equal(exports.length, 1);
    assert.equal(exports[0].id, exportId);
    assert.equal(exports[0].revision, saved.revision);
    assert.deepEqual(exports[0].networks, ["default", "applovin"]);

    // Later edits don't change what the recorded export makes.
    await patch(app, v.id, { set: { "components.cta.color": "#123456" } });
    const again = await app.inject(`/api/exports/${exportId}/download`);
    assert.equal(again.headers["x-export-identical"], "1");
    assert.deepEqual(again.rawPayload, res.rawPayload);
    const files = unzipSync(new Uint8Array(again.rawPayload));
    const html = strFromU8(Object.entries(files).find(([n]) => n.endsWith(".html"))[1]);
    assert.match(html, /#00ff00/);
  }));

test("bulk export runs as a job and records each variant; size estimate per network", () =>
  run(async (app) => {
    const v = await setup(app);
    const copy = json(
      await app.inject({
        method: "POST",
        url: "/api/games/test-game/variants",
        payload: { name: "Copy", copyFrom: v.id }
      })
    );
    const start = await app.inject({
      method: "POST",
      url: "/api/games/test-game/export-jobs",
      payload: { variantIds: [v.id, copy.id], networks: ["default", "facebook"], langs: ["auto"] }
    });
    assert.equal(start.statusCode, 202, start.body);
    let job = json(start);
    for (let i = 0; i < 100 && job.state !== "done" && job.state !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 30));
      job = json(await app.inject(`/api/jobs/${job.id}`));
    }
    assert.equal(job.state, "done", job.error);
    assert.equal(job.done, 2);
    const zip = unzipSync(new Uint8Array((await app.inject(`/api/jobs/${job.id}/download`)).rawPayload));
    assert.ok(Object.keys(zip).some((n) => n.startsWith("Default/")));
    assert.ok(Object.keys(zip).some((n) => n.startsWith("Copy/")));
    assert.ok(zip["export-summary.json"]);
    assert.equal(json(await app.inject("/api/games/test-game/exports")).exports.length, 2);

    const rel = json(await app.inject("/api/games/test-game")).releases[0];
    const sizes = json(
      await app.inject({ method: "POST", url: `/api/releases/${rel.id}/estimate`, payload: { overrides: {} } })
    );
    assert.ok(sizes.default.bytes > 0 && sizes.default.approx === false);
    assert.equal(sizes.facebook.maxBytes, 2 * 1024 * 1024);
    assert.equal(sizes.facebook.approx, true);
  }));

test("asset library, deleting releases and games, and cleaning up unused files", () =>
  run(async (app, dataDir) => {
    const v = await setup(app);
    const asset = json(
      await app.inject({
        method: "POST",
        url: "/api/assets",
        payload: { name: "logo2.png", base64: PNG2, gameId: "test-game" }
      })
    );
    let lib = json(await app.inject("/api/games/test-game/assets"));
    assert.deepEqual(
      lib.map((a) => [a.id, a.name, a.usedBy]),
      [[asset.id, "logo2.png", []]]
    );
    await patch(app, v.id, { set: { "components.logo.assets.logo": asset.id } });
    lib = json(await app.inject("/api/games/test-game/assets"));
    assert.deepEqual(lib[0].usedBy, ["Default"]);
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/games/test-game/assets/${asset.id}` })).statusCode,
      400
    );

    // Releases: not the last one, not a pinned one.
    await upload(app, releaseHtml("r2"));
    const [r2, r1] = json(await app.inject("/api/games/test-game")).releases;
    await patch(app, v.id, { pinnedReleaseId: r1.id });
    assert.equal((await app.inject({ method: "DELETE", url: `/api/releases/${r1.id}` })).statusCode, 400);
    await patch(app, v.id, { pinnedReleaseId: null });
    assert.equal((await app.inject({ method: "DELETE", url: `/api/releases/${r1.id}` })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/releases/${r2.id}` })).statusCode, 400);
    assert.ok(!fs.existsSync(path.join(dataDir, "releases", `${r1.id}.html`)));

    // A stray upload is only collected when old enough; used ones stay.
    fs.writeFileSync(path.join(dataDir, "assets", "stray"), "x");
    const gc = json(await app.inject({ method: "POST", url: "/api/maintenance/gc" }));
    assert.equal(gc.assets, 0);
    assert.equal(gc.files, 1);
    assert.equal((await app.inject(`/api/assets/${asset.id}`)).statusCode, 200);

    assert.equal((await app.inject({ method: "DELETE", url: "/api/games/test-game" })).statusCode, 400);
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/api/games/test-game?confirm=test-game" })).statusCode,
      204
    );
    assert.deepEqual(json(await app.inject("/api/games")), []);
    assert.equal(fs.readdirSync(path.join(dataDir, "releases")).length, 0);
  }));

test("backups: a database copy per day plus release and asset files", () =>
  run(
    async (app, dataDir) => {
      await setup(app);
      const out = json(await app.inject({ method: "POST", url: "/api/maintenance/backup" }));
      const dir = `${dataDir}-backup`;
      assert.equal(out.backups.length, 1);
      assert.ok(fs.existsSync(path.join(dir, "db", out.backups[0].file)));
      assert.equal(fs.readdirSync(path.join(dir, "releases")).length, 1);
      const info = json(await app.inject("/api/maintenance"));
      assert.equal(info.backupDir, dir);
    },
    (dataDir) => ({ backup: { dir: `${dataDir}-backup`, keep: 3 } })
  ));
