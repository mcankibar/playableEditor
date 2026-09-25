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
  networkBlock,
  readJson,
  readAssets
} from "../shared/playable/build/blocks.js";

const PNG = PLACEHOLDERS.image.base64;
// A different valid PNG (2x1) so uploads are distinguishable from the release asset.
const PNG2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGBkAAAwGAQFP8b0KAAAAAElFTkSuQmCC";

function releaseHtml({ releaseId = "r1", extraField = true } = {}) {
  const fields = [
    { path: "options.language", type: "language", default: "auto", label: "Language", group: "Options" },
    {
      path: "options.link.ios",
      type: "text",
      default: "https://apps.apple.com/app/id0",
      label: "iOS",
      group: "Options"
    },
    { path: "components.cta.color", type: "color", default: "#ff0000", format: "string", label: "Color", group: "CTA" },
    {
      path: "components.cta.caption",
      type: "text",
      default: { en: "PLAY", tr: "OYNA" },
      localized: true,
      label: "Caption",
      group: "CTA"
    },
    { path: "components.logo.assets.logo", type: "image", default: "logo.png", label: "Logo", group: "Logo" }
  ];
  if (extraField)
    fields.push({
      path: "components.cta.scale",
      type: "number",
      default: 1,
      min: 0,
      max: 2,
      label: "Scale",
      group: "CTA"
    });
  const manifest = {
    format: 2,
    schemaVersion: 1,
    game: { id: "test-game", title: "Test Game", version: "1.0.0" },
    releaseId,
    languages: ["en", "tr"],
    fields,
    assets: { "logo.png": { type: "image", mime: "image/png", bytes: 70 } }
  };
  return `<!doctype html><html><head><title>t</title>${networkBlock("default")}</head><body>${manifestBlock(
    manifest
  )}${configBlock({})}${assetsBlock([{ id: "logo.png", mime: "image/png", base64: PNG }])}${gameBlock(
    "window.started=true;"
  )}</body></html>`;
}

async function withApp(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
  const app = await buildApp({ dataDir });
  try {
    await fn(app);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const json = (res) => JSON.parse(res.body);
const upload = (app, html, notes = "") =>
  app.inject({
    method: "POST",
    url: `/api/releases?notes=${encodeURIComponent(notes)}`,
    headers: { "content-type": "text/html" },
    payload: html
  });

test("uploading a release creates the game with a Default variant; the same build is not stored twice", () =>
  withApp(async (app) => {
    const first = await upload(app, releaseHtml(), "first");
    assert.equal(first.statusCode, 201);
    assert.equal(json(first).release.number, 1);
    const again = await upload(app, releaseHtml());
    assert.equal(again.statusCode, 200);
    assert.equal(json(again).created, false);
    const second = await upload(app, releaseHtml({ releaseId: "r2" }));
    assert.equal(json(second).release.number, 2);

    const games = json(await app.inject("/api/games"));
    assert.equal(games.length, 1);
    assert.equal(games[0].title, "Test Game");
    assert.equal(games[0].latestRelease.number, 2);
    const detail = json(await app.inject("/api/games/test-game"));
    assert.deepEqual(
      detail.variants.map((v) => [v.name, v.overrides]),
      [["Default", {}]]
    );
    assert.equal(detail.releases[1].notes, "first");

    const manifest = json(await app.inject(`/api/releases/${detail.releases[0].id}/manifest`));
    assert.equal(manifest.fields.length, 6);
    const play = await app.inject(`/api/releases/${detail.releases[0].id}/play`);
    assert.match(play.headers["content-type"], /text\/html/);
    assert.match(play.body, /__PL_MODE__="preview"/);
    const logo = await app.inject(`/api/releases/${detail.releases[0].id}/assets/logo.png`);
    assert.equal(logo.headers["content-type"], "image/png");
    assert.equal(logo.rawPayload.toString("base64"), PNG);
  }));

test("non-release uploads are rejected", () =>
  withApp(async (app) => {
    assert.equal((await upload(app, "<html>nope</html>")).statusCode, 400);
    const exported = releaseHtml().replace(/<!--pl:manifest-->[\s\S]*<!--\/pl:manifest-->/, "");
    assert.match(json(await upload(app, exported)).error, /manifest/);
  }));

test("variants: create, copy, rename, edit overrides, delete", () =>
  withApp(async (app) => {
    await upload(app, releaseHtml());
    const [def] = json(await app.inject("/api/games/test-game")).variants;
    const red = json(
      await app.inject({
        method: "PUT",
        url: `/api/variants/${def.id}`,
        payload: { overrides: { "components.cta.color": "#00ff00" } }
      })
    );
    assert.deepEqual(red.overrides, { "components.cta.color": "#00ff00" });
    const copy = await app.inject({
      method: "POST",
      url: "/api/games/test-game/variants",
      payload: { name: "Green copy", copyFrom: def.id }
    });
    assert.equal(copy.statusCode, 201);
    assert.deepEqual(json(copy).overrides, red.overrides);
    const renamed = json(
      await app.inject({ method: "PUT", url: `/api/variants/${json(copy).id}`, payload: { name: "B" } })
    );
    assert.equal(renamed.name, "B");
    assert.deepEqual(renamed.overrides, red.overrides);
    assert.equal(
      (await app.inject({ method: "PUT", url: `/api/variants/${def.id}`, payload: { overrides: [] } })).statusCode,
      400
    );
    assert.equal((await app.inject({ method: "DELETE", url: `/api/variants/${def.id}` })).statusCode, 204);
    // The last variant of a game stays.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/variants/${json(copy).id}` })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: "/api/variants/999", payload: {} })).statusCode, 404);
  }));

test("uploads are content-addressed, typed from their bytes and served back", () =>
  withApp(async (app) => {
    const res = await app.inject({ method: "POST", url: "/api/assets", payload: { name: "logo.jpg", base64: PNG2 } });
    const asset = json(res);
    assert.match(asset.id, /^u\/[0-9a-f]{12}\.png$/);
    assert.equal(asset.mime, "image/png");
    const same = json(
      await app.inject({ method: "POST", url: "/api/assets", payload: { name: "x.png", base64: PNG2 } })
    );
    assert.equal(same.id, asset.id);
    const back = await app.inject(`/api/assets/${asset.id}`);
    assert.equal(back.rawPayload.toString("base64"), PNG2);
    const bad = await app.inject({
      method: "POST",
      url: "/api/assets",
      payload: { name: "a.png", base64: btoa("hello\u0000\u0001") }
    });
    assert.equal(bad.statusCode, 400);
  }));

test("export: one file directly, several as a ZIP with report; uploads and languages applied", () =>
  withApp(async (app) => {
    await upload(app, releaseHtml());
    const [def] = json(await app.inject("/api/games/test-game")).variants;
    const logo = json(
      await app.inject({ method: "POST", url: "/api/assets", payload: { name: "l.png", base64: PNG2 } })
    );
    await app.inject({
      method: "PUT",
      url: `/api/variants/${def.id}`,
      payload: { overrides: { "components.cta.color": "#00ff00", "components.logo.assets.logo": logo.id } }
    });

    const uploads = json(await app.inject(`/api/variants/${def.id}/uploads`));
    assert.deepEqual(Object.keys(uploads), [logo.id]);
    assert.match(uploads[logo.id], /^data:image\/png;base64,/);

    const single = await app.inject({
      method: "POST",
      url: `/api/variants/${def.id}/export`,
      payload: { networks: ["applovin"], langs: ["tr"] }
    });
    assert.equal(single.statusCode, 200, single.body);
    assert.match(single.headers["content-disposition"], /test-game_Default_applovin_tr\.html/);
    const config = readJson(single.body, "config");
    assert.equal(config["components.cta.color"], "#00ff00");
    assert.equal(config["options.language"], "tr");
    assert.equal(readAssets(single.body).get(logo.id).base64, PNG2);
    assert.doesNotMatch(single.body, /pl-manifest/);

    const batch = await app.inject({
      method: "POST",
      url: `/api/variants/${def.id}/export`,
      payload: { networks: ["unity", "tiktok", "mintegral"], langs: ["auto", "en"] }
    });
    assert.equal(batch.headers["content-type"], "application/zip");
    const files = unzipSync(new Uint8Array(batch.rawPayload));
    assert.deepEqual(Object.keys(files).sort(), [
      "report.json",
      "test-game_Default_mintegral_auto/mintegral.html",
      "test-game_Default_mintegral_en/mintegral.html",
      "test-game_Default_tiktok_auto.zip",
      "test-game_Default_tiktok_en.zip",
      "test-game_Default_unity_auto.html",
      "test-game_Default_unity_en.html"
    ]);
    const report = JSON.parse(strFromU8(files["report.json"]));
    assert.equal(report.release, 1);
    assert.equal(report.exports.length, 6);
    // TikTok ignores options.link, but the variant did not change it: no warning.
    assert.deepEqual(
      report.exports.flatMap((e) => e.warnings),
      []
    );
  }));

test("export errors are reported, and fields removed in a newer release become orphans", () =>
  withApp(async (app) => {
    await upload(app, releaseHtml());
    const [def] = json(await app.inject("/api/games/test-game")).variants;
    const put = (overrides) => app.inject({ method: "PUT", url: `/api/variants/${def.id}`, payload: { overrides } });
    const exp = (body) => app.inject({ method: "POST", url: `/api/variants/${def.id}/export`, payload: body });

    await put({ "components.logo.assets.logo": "u/000000000000.png" });
    const missing = await exp({ networks: ["default"], langs: ["auto"] });
    assert.equal(missing.statusCode, 400);
    assert.match(json(missing).error, /neither in the release nor uploaded/);
    assert.match(json(await exp({ networks: ["nope"], langs: ["auto"] })).error, /Unknown network/);
    assert.match(json(await exp({ networks: [], langs: ["auto"] })).error, /at least one/);

    await put({ "components.cta.scale": 1.5 });
    await upload(app, releaseHtml({ releaseId: "r2", extraField: false }));
    const res = await exp({ networks: ["default"], langs: ["auto"] });
    assert.equal(res.statusCode, 200);
    assert.equal(readJson(res.body, "config")["components.cta.scale"], undefined);
    const old = await exp({ releaseId: 1, networks: ["default"], langs: ["auto"] });
    assert.equal(readJson(old.body, "config")["components.cta.scale"], 1.5);
  }));

test("variant files from the template's dev panel can be imported", () =>
  withApp(async (app) => {
    await upload(app, releaseHtml());
    const res = await app.inject({
      method: "POST",
      url: "/api/games/test-game/variants/import",
      payload: {
        name: "dev-panel",
        overrides: { "components.logo.assets.logo": "u/e2d4e0858b8a.png", "components.cta.color": "#191ea9" },
        uploads: { "u/e2d4e0858b8a.png": `data:image/png;base64,${PNG2}` }
      }
    });
    assert.equal(res.statusCode, 201, res.body);
    const variant = json(res);
    const id = variant.overrides["components.logo.assets.logo"];
    assert.match(id, /^u\/[0-9a-f]{12}\.png$/);
    assert.equal((await app.inject(`/api/assets/${id}`)).rawPayload.toString("base64"), PNG2);
    const fileRef = await app.inject({
      method: "POST",
      url: "/api/games/test-game/variants/import",
      payload: { overrides: { "components.logo.assets.logo": "file:x.png" } }
    });
    assert.equal(fileRef.statusCode, 400);
  }));
