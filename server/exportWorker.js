// Runs exports off the main thread so packaging never blocks the API. Each worker keeps the few
// releases it used last parsed (prepareRelease), like the store does.
//
// Tasks (message { id, type, ... }):
//   export    { releaseFile, release, variant, uploads, networks, langs, createdAt } → { data, fileName, mime, report }
//   bulk      { releaseFile, release, items: [{ variant, uploads }], networks, langs, createdAt, zipFile, zipName }
//             → writes one ZIP with a folder per variant; per item: { fileName, size, sha256, warnings }
//   estimate  { releaseFile, overrides, uploads } → sizes per network
// Replies { id, progress } while working and { id, result } or { id, error } at the end.
import fs from "node:fs";
import crypto from "node:crypto";
import { parentPort } from "node:worker_threads";
import { zipSync, strToU8 } from "fflate";
import { prepareRelease } from "../shared/playable/export/patch.js";
import { estimateSizes, exportBatch, slug } from "./exporter.js";

const cache = new Map();
function prepared(file) {
  if (cache.has(file)) return cache.get(file);
  const entry = prepareRelease(fs.readFileSync(file, "utf8"));
  cache.set(file, entry);
  if (cache.size > 2) cache.delete(cache.keys().next().value);
  return entry;
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const warningsOf = (report) => [...new Set(report.exports.flatMap((e) => e.warnings))];

const tasks = {
  export({ releaseFile, release, variant, uploads, networks, langs, createdAt }) {
    const rel = prepared(releaseFile);
    const out = exportBatch({
      prepared: rel,
      manifest: rel.manifest,
      release,
      variant,
      uploads,
      networks,
      langs,
      createdAt
    });
    return {
      data: out.data,
      fileName: out.fileName,
      mime: out.mime,
      sha256: sha256(out.data),
      warnings: warningsOf(out.report)
    };
  },

  bulk({ releaseFile, release, items, networks, langs, createdAt, zipFile }, progress) {
    const rel = prepared(releaseFile);
    const entries = Object.create(null);
    const mtime = new Date(1980, 0, 1);
    const results = [];
    const folders = new Set();
    items.forEach(({ variant, uploads }, i) => {
      try {
        const out = exportBatch({
          prepared: rel,
          manifest: rel.manifest,
          release,
          variant,
          uploads,
          networks,
          langs,
          createdAt
        });
        let folder = slug(variant.name);
        while (folders.has(folder)) folder += "_";
        folders.add(folder);
        for (const o of out.outputs)
          entries[`${folder}/${o.name}`] = [typeof o.data === "string" ? strToU8(o.data) : o.data, { mtime, level: 0 }];
        results.push({
          variantId: variant.id,
          fileName: out.fileName,
          size: out.data.length,
          sha256: sha256(out.data),
          warnings: warningsOf(out.report)
        });
      } catch (e) {
        results.push({ variantId: variant.id, error: e.message });
      }
      progress({ done: i + 1, total: items.length });
    });
    const ok = results.filter((r) => !r.error);
    if (!ok.length) throw new Error(results.map((r) => r.error).join("\n"));
    const summary = results.map((r) => ({
      variantId: r.variantId,
      file: r.fileName,
      error: r.error,
      warnings: r.warnings
    }));
    entries["export-summary.json"] = [
      strToU8(
        JSON.stringify({ createdAt, release: release.number, networks, langs, variants: summary }, null, 2) + "\n"
      ),
      { mtime }
    ];
    const zip = zipSync(entries, { level: 6 });
    fs.writeFileSync(zipFile, zip);
    return { size: zip.length, results };
  },

  estimate({ releaseFile, overrides, uploads }) {
    return estimateSizes(prepared(releaseFile), { overrides, uploads });
  }
};

parentPort.on("message", ({ id, type, ...task }) => {
  try {
    const result = tasks[type](task, (progress) => parentPort.postMessage({ id, progress }));
    const transfer = result?.data?.buffer ? [result.data.buffer] : [];
    parentPort.postMessage({ id, result }, transfer);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
