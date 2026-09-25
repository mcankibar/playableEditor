// Batch export: one variant × networks × languages → a single file, or a ZIP with a report.json.
// Output names match the template's `npm run export` CLI.
import { zipSync, strToU8, deflateSync } from "fflate";
import { exportVariant, packageVariant } from "../shared/playable/export/patch.js";
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
 * @param createdAt  written to report.json; the same inputs and createdAt give the same bytes
 * @returns {{ fileName, mime, data: Uint8Array, report, outputs: [{ name, data }] }}
 */
export function exportBatch({ prepared, manifest, release, variant, uploads, networks, langs, createdAt }) {
  if (!networks.length || !langs.length) throw new Error("Pick at least one network and one language");
  for (const n of networks) if (!Object.hasOwn(EXPORT_NETWORKS, n)) throw new Error(`Unknown network: ${n}`);

  // Everything is validated and packaged before anything is returned.
  const outputs = [];
  let outputBytes = 0;
  for (const network of networks) {
    for (const lang of langs) {
      const packed = packageVariant(prepared, {
        overrides: variant.overrides,
        uploads,
        network,
        language: lang === "auto" && !manifest.fields.some((f) => f.type === "language") ? null : lang
      });
      const base = [slug(manifest.game.id), slug(variant.name), slug(network), slug(lang)].join("_");
      // Keep a network-mandated entry file name (Mintegral) inside a folder of its own.
      const name =
        packed.extension === "html" && packed.entryName !== "index.html"
          ? `${base}/${packed.entryName}`
          : `${base}.${packed.extension}`;
      outputBytes += packed.data.length;
      if (outputBytes > 96 * 1024 * 1024)
        throw new Error("Variant output exceeds 96 MiB; choose fewer networks/languages");
      outputs.push({ name, packed });
    }
  }

  const report = {
    game: manifest.game.id,
    release: release.number,
    releaseId: manifest.releaseId ?? null,
    variant: variant.name,
    createdAt: createdAt ?? new Date().toISOString(),
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
      report,
      outputs: [{ name, data: packed.data }]
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
    report,
    outputs: outputs
      .map(({ name, packed }) => ({ name, data: packed.data }))
      .concat({
        name: "report.json",
        data: entries["report.json"][0]
      })
  };
}

/**
 * Package size per network for the editor's size meter. HTML networks are exact; ZIP networks are
 * estimated with fast compression (a little larger than the real, level 9 package).
 * @returns {{ [network]: { bytes, maxBytes, approx } }}
 */
export function estimateSizes(prepared, { overrides, uploads }) {
  const out = {};
  for (const [network, net] of Object.entries(EXPORT_NETWORKS)) {
    const { files } = exportVariant(prepared, { overrides, uploads, network });
    let bytes = 0;
    for (const f of files) {
      const data = typeof f.data === "string" ? strToU8(f.data) : f.data;
      bytes += net.container === "zip" ? deflateSync(data, { level: 1 }).length + 76 + 2 * f.name.length : data.length;
    }
    out[network] = { bytes, maxBytes: net.maxMb * 1024 * 1024, approx: net.container === "zip" };
  }
  return out;
}
