// Files on disk: data/releases/<id>.html and data/assets/<sha256> (content-addressed).
import fs from "node:fs";
import path from "node:path";
import { inspectRelease } from "../shared/playable/export/patch.js";

export function openStore(dataDir) {
  const releasesDir = path.join(dataDir, "releases");
  const assetsDir = path.join(dataDir, "assets");
  // Also creates dataDir itself, where the database lives.
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // Parsed releases are large (all assets as base64); keep only the few being edited.
  const cache = new Map();
  const CACHE_SIZE = 4;

  const releaseFile = (id) => path.join(releasesDir, `${Number(id)}.html`);

  return {
    writeRelease(id, html) {
      fs.writeFileSync(releaseFile(id), html);
    },

    readReleaseHtml(id) {
      return fs.readFileSync(releaseFile(id), "utf8");
    },

    /** { html, manifest, assets: Map<id, { mime, base64 }> } */
    release(id) {
      if (cache.has(id)) {
        const hit = cache.get(id);
        cache.delete(id);
        cache.set(id, hit);
        return hit;
      }
      const html = this.readReleaseHtml(id);
      const entry = { html, ...inspectRelease(html) };
      cache.set(id, entry);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      return entry;
    },

    writeAsset(sha256, bytes) {
      const file = path.join(assetsDir, sha256);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    },

    readAsset(sha256) {
      return fs.readFileSync(path.join(assetsDir, sha256));
    }
  };
}
