// Pure functions that turn a config definition (src/params.js) plus a flat override map into the
// plain gameConfig object the framework components expect. Shared by the browser runtime and the
// Node build/export tooling — keep it dependency-free.
//
// Override map format (also the format of variant files and of the pl-config block):
//   { "components.ctaButton1.scale.portrait": 0.4,
//     "components.banner1.localization.caption": { "en": "Hi", "tr": "Selam" },
//     "components.inGameLogo1.assets.logo": "u/3fa9c1d2e4b5.png" }

import { ASSET_TYPES, isField, isLoc } from "./fields.js";

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function humanize(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Walks the definition and returns every editable field with its metadata.
 * @returns {Array<{path, type, default, label, group, localized, enabledBy, constantDisabled, aliases, ...opts}>}
 */
export function collectFields(definition) {
  const out = [];

  function visit(node, path, ctx) {
    if (isField(node)) {
      const { __plField, was, ...meta } = node;
      const localized = ctx.inLoc && node.type === "text";
      const enabledBy = node.enabledBy || ctx.enabledBy || null;
      out.push({
        ...meta,
        path: path.join("."),
        label: node.label || humanize(path.slice(ctx.groupDepth).join(" ")),
        group: ctx.group,
        localized,
        default: localized ? toLocalized(node.default) : node.default,
        enabledBy: ASSET_TYPES.includes(node.type) ? enabledBy : null,
        constantDisabled: ASSET_TYPES.includes(node.type) ? ctx.constantDisabled : false,
        aliases: was ? [].concat(was) : []
      });
      return;
    }
    if (isLoc(node)) {
      visit(node.body, path, { ...ctx, inLoc: true });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, [...path, i], ctx));
      return;
    }
    if (!isPlainObject(node)) return;

    let next = ctx;
    if (node.__plGroup) next = { ...next, group: node.__plGroup, groupDepth: path.length };
    else if (path.length === 2 && path[0] === "components") next = { ...next, group: humanize(path[1]), groupDepth: 2 };
    else if (path.length === 1 && path[0] === "options") next = { ...next, group: "Options", groupDepth: 1 };

    // The nearest isEnabled switch decides whether the assets below it are needed at all.
    if ("isEnabled" in node) {
      const flag = node.isEnabled;
      if (isField(flag))
        next = {
          ...next,
          enabledBy: [...path, "isEnabled"].join("."),
          constantDisabled: false
        };
      else next = { ...next, enabledBy: null, constantDisabled: flag === false };
    }

    Object.keys(node).forEach((key) => visit(node[key], [...path, key], next));
  }

  visit(definition, [], {
    group: "General",
    groupDepth: 0,
    inLoc: false,
    enabledBy: null,
    constantDisabled: false
  });
  return out;
}

export function toLocalized(value) {
  if (isPlainObject(value)) return value;
  return { en: value == null ? "" : String(value) };
}

/** Languages used by any localized text (defaults + overrides). "en" always comes first. */
export function collectLanguages(fields, overrides = {}) {
  const langs = new Set(["en"]);
  fields.forEach((f) => {
    if (!f.localized) return;
    Object.keys(f.default || {}).forEach((l) => langs.add(l));
    const o = overrides[f.path];
    if (isPlainObject(o)) Object.keys(o).forEach((l) => langs.add(l));
  });
  return [...langs];
}

function toHex(value) {
  if (typeof value === "number") return "#" + value.toString(16).padStart(6, "0");
  return String(value);
}

/**
 * Validates and normalizes a single override value. Returns { value } or { error }.
 * Colors are normalized to "#rrggbb" strings, numbers are clamped to their range.
 */
export function normalizeValue(field, value) {
  switch (field.type) {
    case "number": {
      if (typeof value !== "number") return { error: "expected a number" };
      let n = value;
      if ((field.integer || field.step === 1) && !Number.isInteger(n)) return { error: "expected an integer" };
      if (!Number.isFinite(n)) return { error: "not a number" };
      if (typeof field.min === "number") n = Math.max(field.min, n);
      if (typeof field.max === "number") n = Math.min(field.max, n);
      return { value: n };
    }
    case "boolean":
      return typeof value === "boolean" ? { value } : { error: "expected a boolean" };
    case "color": {
      const hex = toHex(value);
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return { error: "expected #rrggbb" };
      return { value: hex.toLowerCase() };
    }
    case "text":
      if (field.localized) {
        const map = toLocalized(value);
        const clean = {};
        for (const [lang, s] of Object.entries(map)) {
          if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(lang) || typeof s !== "string")
            return { error: "expected language-to-text map" };
          clean[lang] = s;
        }
        return { value: clean };
      }
      return typeof value === "string" ? { value } : { error: "expected text" };
    case "select":
      if (!field.options.includes(value)) return { error: `must be one of ${field.options.join(", ")}` };
      return { value };
    case "language":
      return typeof value === "string" ? { value } : { error: "expected text" };
    default:
      // asset fields: an asset id (path under assets/ or an uploaded id)
      if (typeof value !== "string" || !value) return { error: "expected an asset id" };
      return { value };
  }
}

/**
 * Checks an override map against the fields. Renamed paths (field `was`) are migrated, unknown
 * paths are reported as orphans and dropped, invalid values are reported and dropped.
 */
export function sanitizeOverrides(fields, overrides = {}) {
  const byPath = new Map(fields.map((f) => [f.path, f]));
  const aliasOf = new Map();
  fields.forEach((f) => (f.aliases || []).forEach((a) => aliasOf.set(a, f.path)));

  const values = {};
  const orphans = [];
  const errors = [];
  Object.entries(overrides).forEach(([rawPath, raw]) => {
    const path = byPath.has(rawPath) ? rawPath : aliasOf.get(rawPath);
    const field = path && byPath.get(path);
    if (!field) {
      orphans.push(rawPath);
      return;
    }
    const res = normalizeValue(field, raw);
    if (res.error) errors.push(`${path}: ${res.error}`);
    else values[path] = res.value;
  });
  const languages = collectLanguages(fields, values);
  for (const field of fields.filter((f) => f.type === "language")) {
    const lang = values[field.path] ?? field.default;
    if (lang !== "auto" && !languages.includes(lang)) {
      errors.push(`${field.path}: unsupported language "${lang}"`);
      delete values[field.path];
    }
  }
  return { values, orphans, errors };
}

function outputValue(field, value) {
  if (field.type === "color" && field.format === "number") {
    return typeof value === "number" ? value : parseInt(String(value).replace("#", ""), 16);
  }
  return value;
}

/**
 * Builds the plain gameConfig.
 * @param definition   the object exported by src/params.js
 * @param overrides    sanitized override map (see sanitizeOverrides)
 * @param assetEntry   (assetId, field) => loader entry; lets the runtime decide how assets load
 */
export function resolveConfig(definition, overrides = {}, assetEntry = (id) => id) {
  const fields = collectFields(definition);
  const byPath = new Map(fields.map((f) => [f.path, f]));
  const languages = collectLanguages(fields, overrides);

  function valueOf(path) {
    const field = byPath.get(path);
    return path in overrides ? overrides[path] : field.default;
  }

  function build(node, path, lang) {
    if (isField(node)) {
      const p = path.join(".");
      const field = byPath.get(p);
      const value = valueOf(p);
      if (ASSET_TYPES.includes(field.type)) return assetEntry(value, field);
      if (field.localized) {
        const map = toLocalized(value);
        return map[lang] ?? map.en ?? "";
      }
      return outputValue(field, value);
    }
    if (isLoc(node)) {
      const expanded = {};
      languages.forEach((l) => (expanded[l] = build(node.body, path, l)));
      return expanded;
    }
    if (Array.isArray(node)) return node.map((child, i) => build(child, [...path, i], lang));
    if (isPlainObject(node)) {
      const out = {};
      Object.keys(node).forEach((key) => (out[key] = build(node[key], [...path, key], lang)));
      return out;
    }
    return node;
  }

  return { config: build(definition, [], "en"), fields, languages };
}

/** Asset ids referenced by the resolved config, and those only needed by disabled components. */
export function assetUsage(fields, overrides = {}) {
  const valueOf = (f) => (f.path in overrides ? overrides[f.path] : f.default);
  const used = new Set();
  const needed = new Set();
  fields.forEach((f) => {
    if (!ASSET_TYPES.includes(f.type)) return;
    const id = valueOf(f);
    used.add(id);
    const enabledField = f.enabledBy && fields.find((x) => x.path === f.enabledBy);
    const enabled = f.constantDisabled ? false : enabledField ? valueOf(enabledField) !== false : true;
    if (enabled) needed.add(id);
  });
  return { used, needed };
}
