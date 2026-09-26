// Files on disk: data/releases/<id>.html, data/assets/<sha256> (content-addressed),
// data/thumbs/<variantId>.jpg and data/tmp/ (finished export jobs, removed after a day).
import fs from "node:fs";
import path from "node:path";
import { prepareRelease } from "../shared/playable/export/patch.js";

export function openStore(dataDir) {
  const releasesDir = path.join(dataDir, "releases");
  const assetsDir = path.join(dataDir, "assets");
  const tmpDir = path.join(dataDir, "tmp");
  const exportsDir = path.join(dataDir, "exports");
  const jobsDir = path.join(dataDir, "jobs");
  const thumbsDir = path.join(dataDir, "thumbs");
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  // Also creates dataDir itself, where the database lives.
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Parsed releases are large (all assets as base64); keep only the few being edited.
  const cache = new Map();
  const CACHE_SIZE = 4;

  const releaseFile = (id) => path.join(releasesDir, `${Number(id)}.html`);

  return {
    releasesDir,
    assetsDir,
    tmpDir,
    exportsDir,
    jobsDir,
    thumbsDir,
    thumbFile(id) {
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1) throw new Error("Invalid variant id");
      return path.join(thumbsDir, `${n}.jpg`);
    },
    writeThumb(id, bytes) {
      const file = this.thumbFile(id);
      fs.writeFileSync(file + ".part", bytes);
      fs.renameSync(file + ".part", file);
    },
    readThumb(id) {
      const file = this.thumbFile(id);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    /** Copies a variant's picture onto another variant. Returns whether there was one. */
    copyThumb(fromId, toId) {
      const from = this.thumbFile(fromId);
      if (!fs.existsSync(from)) return false;
      fs.copyFileSync(from, this.thumbFile(toId));
      return true;
    },
    releaseFile,
    exportFile(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid export hash");
      return path.join(exportsDir, hash);
    },
    writeExport(hash, data) {
      const file = this.exportFile(hash);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file + ".part", data);
        fs.renameSync(file + ".part", file);
      }
    },

    writeRelease(id, html) {
      fs.writeFileSync(releaseFile(id), html);
    },

    readReleaseHtml(id) {
      return fs.readFileSync(releaseFile(id), "utf8");
    },

    /** prepareRelease(html): { html, manifest, assets: Map<id, { mime, base64 }>, … }; reused by every export. */
    release(id) {
      if (cache.has(id)) {
        const hit = cache.get(id);
        cache.delete(id);
        cache.set(id, hit);
        return hit;
      }
      const html = this.readReleaseHtml(id);
      const entry = prepareRelease(html);
      cache.set(id, entry);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      return entry;
    },

    deleteRelease(id) {
      cache.delete(id);
      fs.rmSync(releaseFile(id), { force: true });
    },

    /** Deletes release files without a database row and asset files not in `keep`; returns the count. */
    removeUnused({ releaseIds, keep }) {
      let removed = 0;
      for (const file of fs.readdirSync(releasesDir)) {
        const id = Number.parseInt(file, 10);
        if (!releaseIds.has(id)) {
          fs.rmSync(path.join(releasesDir, file), { force: true });
          cache.delete(id);
          removed++;
        }
      }
      for (const file of fs.readdirSync(assetsDir)) {
        if (!keep.has(file)) {
          fs.rmSync(path.join(assetsDir, file), { force: true });
          removed++;
        }
      }
      return removed;
    },

    /** Removes temporary files older than maxAgeMs. */
    cleanTmp(maxAgeMs = 24 * 3600 * 1000) {
      for (const file of fs.readdirSync(tmpDir)) {
        const full = path.join(tmpDir, file);
        if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true });
      }
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
