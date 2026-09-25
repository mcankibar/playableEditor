// Batch export: one variant × networks × languages → a single file, or a ZIP with a report.json.
// Output names match the template's `npm run export` CLI.
import { zipSync, strToU8 } from "fflate";
import { packageVariant } from "../shared/playable/export/patch.js";
import { EXPORT_NETWORKS } from "../shared/playable/export/networks.js";

// ASCII only (file names, Content-Disposition); "Kırmızı CTA" → "Kirmizi-CTA".
export const slug = (s) =>
  String(s)
    .replace(/^@[^/]+\//, "")
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-");

/**
 * @param release  prepareRelease(html), cached per release so its assets are parsed and checked once
 * @param uploads  { assetId: { mime, base64 } } for the uploaded files the variant uses
 * @returns {{ fileName, mime, data: Uint8Array, report }}
 */
export function exportBatch({ prepared, manifest, release, variant, uploads, networks, langs }) {
  if (!networks.length || !langs.length) throw new Error("Pick at least one network and one language");
  for (const n of networks) if (!Object.hasOwn(EXPORT_NETWORKS, n)) throw new Error(`Unknown network: ${n}`);

  // Everything is validated and packaged before anything is returned.
  const outputs = [];
  for (const network of networks) {
    for (const lang of langs) {
      const packed = packageVariant(prepared, {
        overrides: variant.overrides,
        uploads,
        network,
        language: lang
      });
      const base = [slug(manifest.game.id), slug(variant.name), slug(network), slug(lang)].join("_");
      // Keep a network-mandated entry file name (Mintegral) inside a folder of its own.
      const name =
        packed.extension === "html" && packed.entryName !== "index.html"
          ? `${base}/${packed.entryName}`
          : `${base}.${packed.extension}`;
      outputs.push({ name, packed });
    }
  }

  const report = {
    game: manifest.game.id,
    release: release.number,
    releaseId: manifest.releaseId ?? null,
    variant: variant.name,
    createdAt: new Date().toISOString(),
    exports: outputs.map(({ name, packed: { report: r } }) => ({
      path: name,
      network: r.network,
      language: r.language,
      packageBytes: r.packageBytes,
      storeUrl: r.storeUrl,
      warnings: r.warnings,
      orphans: r.orphans,
      pruned: r.pruned
    }))
  };

  if (outputs.length === 1 && !outputs[0].name.includes("/")) {
    const [{ name, packed }] = outputs;
    return {
      fileName: name,
      mime: packed.extension === "zip" ? "application/zip" : "text/html; charset=utf-8",
      data: packed.data,
      report
    };
  }

  const entries = Object.create(null);
  const mtime = new Date(1980, 0, 1);
  for (const { name, packed } of outputs) entries[name] = [packed.data, { mtime, level: 0 }];
  entries["report.json"] = [strToU8(JSON.stringify(report, null, 2) + "\n"), { mtime }];
  return {
    fileName: `${slug(manifest.game.id)}_${slug(variant.name)}_r${release.number}.zip`,
    mime: "application/zip",
    data: zipSync(entries, { level: 6 }),
    report
  };
}
