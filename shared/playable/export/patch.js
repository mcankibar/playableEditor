// Turns a release (dist/index.html) + a variant into ad-network-ready files — no rebuild.
// Pure JS: runs in Node (playable/export/cli.js) and in the browser (a future Studio).

import { assetUsage, sanitizeOverrides } from "../kit/resolve.js";
import {
  PLACEHOLDERS,
  assetsBlock,
  configBlock,
  networkBlock,
  readAssets,
  readGameCode,
  readJson,
  gameBlock,
  FORMAT_VERSION,
  BLOCKS,
  blockRange,
  hasBlock
} from "../build/blocks.js";
import { ASSET_TYPES } from "../kit/fields.js";
import { validateAsset, validateAssetId } from "../kit/assets.js";
import { zipSync, strToU8 } from "fflate";
import { EXPORT_NETWORKS, NETWORK_PROFILE_VERSION } from "./networks.js";

// The CTA reads options.link.ios / options.link.android (lib/playinFramework3D/modules/playable.js).
const STORE_LINK_PREFIX = "options.link.";

/** Store-link overrides that the network may ignore (see storeUrl in ./networks.js). */
function storeLinkWarning(net, fields, values) {
  if (net.storeUrl === "always") return null;
  const changed = fields
    .filter((f) => f.path.startsWith(STORE_LINK_PREFIX) && f.path in values && values[f.path] !== f.default)
    .map((f) => f.path);
  if (!changed.length) return null;
  return net.storeUrl === "never"
    ? `${net.label} opens the store configured in the campaign; ${changed.join(", ")} has no effect`
    : `${net.label} may open the store configured in the campaign instead of ${changed.join(", ")}`;
}

function manifestFields(manifest) {
  return manifest.fields.map((f) => ({ aliases: [], ...f }));
}

/** Reads the editable schema and current values out of a release HTML. */
export function inspectRelease(html) {
  if (!hasBlock(html, "manifest"))
    throw new Error("no pl:manifest block — exported files can't be re-exported, use the release (dist/index.html)");
  const manifest = readJson(html, "manifest");
  if (manifest.format !== FORMAT_VERSION)
    throw new Error(`Unsupported release format ${manifest.format}; rebuild the release`);
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported schema version ${manifest.schemaVersion}`);
  if (!Array.isArray(manifest.fields) || !manifest.game?.id) throw new Error("Invalid release manifest");
  for (const block of BLOCKS) if (!hasBlock(html, block)) throw new Error(`Missing pl:${block} block`);
  if (new Set(manifest.fields.map((f) => f.path)).size !== manifest.fields.length)
    throw new Error("Duplicate field paths");
  return {
    manifest,
    overrides: readJson(html, "config"),
    assets: readAssets(html)
  };
}

/**
 * Parses a release once for many exports (every network × language): block offsets, embedded
 * config and assets, and a cache of asset checks. A release never changes, so an asset that passed
 * validation for a field type passes again. Treat the result as read-only.
 */
export function prepareRelease(html) {
  const info = inspectRelease(html);
  const ranges = BLOCKS.map((name) => ({ name, ...blockRange(html, name) })).sort((a, b) => a.start - b.start);
  ranges.forEach((r, i) => {
    if (i && r.start < ranges[i - 1].end) throw new Error(`pl:${r.name} overlaps pl:${ranges[i - 1].name}`);
  });
  return {
    html,
    ...info,
    ranges,
    gameCode: readGameCode(html),
    checked: new Map(),
    bytes: new Map()
  };
}

const toRelease = (release) => (typeof release === "string" ? prepareRelease(release) : release);

function validateReleaseAsset(rel, id, asset, field) {
  const key = `${id}\0${field.type}\0${field.maxBytes ?? ""}`;
  if (!rel.checked.has(key)) {
    try {
      validateAsset(id, asset, field);
      rel.checked.set(key, null);
    } catch (e) {
      rel.checked.set(key, e.message);
    }
  }
  const error = rel.checked.get(key);
  if (error !== null) throw new Error(error);
}

/** Rebuilds the release HTML with some blocks replaced, in one pass over the original. */
function replaceBlocks(rel, replacements) {
  const parts = [];
  let pos = 0;
  for (const r of rel.ranges) {
    if (!Object.hasOwn(replacements, r.name)) continue;
    parts.push(rel.html.slice(pos, r.start), replacements[r.name]);
    pos = r.end;
  }
  parts.push(rel.html.slice(pos));
  return parts.join("");
}

function insertBefore(html, tag, text) {
  const i = tag === "</head>" ? html.indexOf(tag) : html.lastIndexOf(tag);
  if (i === -1) throw new Error(`${tag} not found`);
  return html.slice(0, i) + text + html.slice(i);
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** UTF-8 size without encoding: the HTML is several MB and gets encoded once more when packaged. */
function byteLength(data) {
  if (typeof data !== "string") return data.length;
  let n = data.length;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length && (data.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 2;
      i++;
    } else n += 2;
  }
  return n;
}

/**
 * @param release   release HTML (dist/index.html) or prepareRelease(html)
 * @param options.overrides  { path: value } — asset fields take an asset id
 * @param options.uploads    { assetId: { mime, base64 } } for ids that are not in the release
 * @param options.network    one of EXPORT_NETWORKS
 * @param options.language   forces options.language ("auto" keeps device detection)
 * @param options.strict     true → unknown override paths fail the export; by default they are
 *                           reported as orphans so variants survive fields removed in newer releases
 * @returns {{ files: Array<{ name, data }>, report }}
 */
export function exportVariant(
  release,
  { overrides = {}, uploads = {}, network = "default", language = null, strict = false } = {}
) {
  for (const [name, value] of Object.entries({ overrides, uploads })) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  }
  const net = Object.prototype.hasOwnProperty.call(EXPORT_NETWORKS, network) && EXPORT_NETWORKS[network];
  if (!net) throw new Error(`unknown network "${network}"`);

  const rel = toRelease(release);
  const { manifest, overrides: embedded, assets: releaseAssets } = rel;
  const fields = manifestFields(manifest);

  const requested = { ...embedded, ...overrides };
  if (language) {
    const langField = fields.find((f) => f.type === "language");
    if (!langField) throw new Error("this playable has no language field");
    requested[langField.path] = language;
  }
  const { values, orphans, errors } = sanitizeOverrides(fields, requested);

  // ── assets ────────────────────────────────────────────────────────────
  if (strict && orphans.length) errors.push(`Unknown override paths: ${orphans.join(", ")}`);
  const assetFields = fields.filter((f) => ASSET_TYPES.includes(f.type));
  const typeOfId = new Map(assetFields.map((f) => [values[f.path] ?? f.default, f.type]));

  const { used, needed } = assetUsage(fields, values);
  const pruned = [];
  const missing = [];
  const assetList = [];
  for (const id of used) {
    validateAssetId(id);
    const uploaded = Object.prototype.hasOwnProperty.call(uploads, id);
    const src = uploaded ? uploads[id] : releaseAssets.get(id);
    if (!src || (!src.base64 && !src.src)) {
      missing.push(id);
      continue;
    }
    for (const field of assetFields.filter((f) => (values[f.path] ?? f.default) === id)) {
      try {
        if (uploaded) validateAsset(id, src, field);
        else validateReleaseAsset(rel, id, src, field);
      } catch (e) {
        errors.push(`${field.path}: ${e.message}`);
      }
    }
    const placeholder = !needed.has(id) && PLACEHOLDERS[typeOfId.get(id)];
    if (placeholder) pruned.push(id);
    assetList.push({
      id,
      fromRelease: !uploaded && !placeholder,
      ...(placeholder || { mime: src.mime, base64: src.base64 })
    });
  }
  if (missing.length) errors.push(...missing.map((id) => `asset "${id}" is neither in the release nor uploaded`));
  if (errors.length) throw new Error(`Export validation failed:\n${errors.join("\n")}`);
  const removed = [...releaseAssets.keys()].filter((id) => !used.has(id));

  const files = [];
  let assetsHtml;
  if (net.assetFiles) {
    assetsHtml = assetsBlock(
      assetList.map(({ id, mime, base64, fromRelease }) => {
        let bytes = fromRelease && rel.bytes.get(id);
        if (!bytes) {
          bytes = base64ToBytes(base64);
          if (fromRelease) rel.bytes.set(id, bytes);
        }
        files.push({ name: `assets/${id}`, data: bytes });
        return { id, mime, src: `assets/${id}` };
      })
    );
  } else {
    assetsHtml = assetsBlock(assetList.map(({ id, mime, base64 }) => ({ id, mime, base64 })));
  }

  // ── html ──────────────────────────────────────────────────────────────
  const code = rel.gameCode;
  const beforeGame = net.beforeGame ? net.beforeGame + "\n" : "";
  let game;
  if (net.inline === false) {
    game = beforeGame + `<script src="${net.script}"></script>`;
    files.push({ name: net.script, data: code });
  } else {
    game = beforeGame + gameBlock(code);
  }
  let out = replaceBlocks(rel, {
    manifest: "",
    config: configBlock(values),
    assets: assetsHtml,
    network: networkBlock(network, "publish"),
    game
  });
  // Insert before the LAST </head> / </body>: the game code may contain those strings too.
  if (net.head) out = insertBefore(out, "</head>", net.head + "\n");
  if (net.bodyEnd) out = insertBefore(out, "</body>", net.bodyEnd + "\n");

  files.unshift({ name: net.htmlName || "index.html", data: out });
  Object.entries(net.extraFiles || {}).forEach(([name, data]) => files.push({ name, data }));

  const sizeBytes = files.reduce((n, f) => n + byteLength(f.data), 0);
  return {
    files,
    report: {
      network,
      profileVersion: NETWORK_PROFILE_VERSION,
      releaseId: manifest.releaseId ?? null,
      language: values[fields.find((f) => f.type === "language")?.path] ?? null,
      sizeBytes,
      overLimit: net.container === "zip" ? null : sizeBytes > net.maxMb * 1024 * 1024,
      sizeBasis: net.container === "zip" ? "zip" : "html",
      maxMb: net.maxMb,
      storeUrl: net.storeUrl,
      warnings: [storeLinkWarning(net, fields, values)].filter(Boolean),
      applied: Object.keys(values).length,
      orphans,
      errors,
      pruned,
      removed
    }
  };
}

/** Package and enforce limits identically in Node and in a browser editor. */
export function packageVariant(release, options = {}) {
  const { files, report } = exportVariant(release, options);
  const net = EXPORT_NETWORKS[report.network];
  let data;
  if (net.container === "zip") {
    const entries = Object.create(null);
    for (const file of files) {
      validateAssetId(file.name);
      entries[file.name] = [
        typeof file.data === "string" ? strToU8(file.data) : file.data,
        { mtime: new Date(1980, 0, 1) }
      ];
    }
    if (net.maxFiles && files.length > net.maxFiles) throw new Error(`Too many files for ${report.network}`);
    data = zipSync(entries, { level: 9 });
  } else {
    if (files.length !== 1) throw new Error("Single HTML profile produced additional files");
    data = strToU8(files[0].data);
  }
  report.packageBytes = data.length;
  report.overLimit = data.length > net.maxMb * 1024 * 1024;
  if (report.overLimit) throw new Error(`${report.network}: packaged output exceeds ${net.maxMb} MiB`);
  return {
    files,
    data,
    extension: net.container === "zip" ? "zip" : "html",
    entryName: net.htmlName || "index.html",
    report
  };
}
