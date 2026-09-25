// Field helpers used by src/params.js to mark which parts of the game config are editable.
//
// Common opts for every field: { label, hint, restart }. restart: true marks a value that the game
// only reads when it starts; a preview change of it restarts the game instead of updating it live.
//
// Anything wrapped in a helper becomes an editable field (it shows up in the manifest, in the dev
// panel and in the Studio). Plain values stay internal constants that only the developer changes.
//
// This file is shared by the browser runtime and the Node build/export tooling, so it must stay
// dependency-free.

export const FIELD = "__plField";
export const LOC = "__plLocalization";

function field(type, defaultValue, opts = {}) {
  return { [FIELD]: true, type, default: defaultValue, ...opts };
}

/** Number. opts: { min, max, step, label, hint } */
export const num = (value, opts) => field("number", value, opts);

/** Boolean switch. */
export const bool = (value, opts) => field("boolean", value, opts);

/**
 * Color. Accepts 0xRRGGBB numbers or "#rrggbb" strings; the resolved value keeps the format of the
 * default so existing components keep working.
 */
export const color = (value, opts) =>
  field("color", value, { format: typeof value === "number" ? "number" : "string", ...opts });

/**
 * Text. Inside a loc() block a text is localizable: its value is a { lang: string } map and
 * a plain string default is treated as English.
 */
export const text = (value, opts) => field("text", value, opts);

/** One of a fixed set of values. */
export const select = (value, options, opts) => field("select", value, { options, ...opts });

/** Language selector: "auto" (device language) or one of the languages found in the texts. */
export const language = (value = "auto", opts) => field("language", value, opts);

// ── Asset fields ─────────────────────────────────────────────────────────────
// The default is a path relative to the assets/ folder. At runtime the value becomes a loader
// entry ({ key, data | zipData | assetPath, variant? }) that the framework loaders understand.
// opts: { variant, enabledBy, label, maxBytes, key }
//   key: the name the loaders store the asset under (defaults to the asset id). Use it when game
//        code looks assets up by a fixed name, e.g. loadedTexturesInGameMap.get("board").

export const image = (file, opts) => field("image", file, opts);
export const sound = (file, opts) => field("sound", file, opts);
/** GLB model; ".glb.zip" files are unzipped at runtime. */
export const model = (file, opts) => field("model", file, opts);
export const font = (file, opts) => field("font", file, opts);
/**
 * Raw data file: JSON (parsed at runtime), plain text (string) or a ZIP (kept as a data URI).
 * Mostly used through atlas() and spine().
 */
export const data = (file, opts) => field("data", file, opts);

export const ASSET_TYPES = ["image", "sound", "model", "font", "data"];

/**
 * Sprite atlas (TexturePacker JSON hash + PNG). Loaded by the atlas loader under `${key}_PNG`.
 *   assets: { gems: atlas("gems", "gems/gems.png", "gems/gems.json") }
 */
export function atlas(key, png, json, opts = {}) {
  return [
    image(png, { ...opts, key: `${key}_PNG`, variant: "image", loader: "atlas" }),
    data(json, { ...opts, key: `${key}_JSON`, variant: "JSON", loader: "atlas" })
  ];
}

/**
 * Spine skeleton: texture PNG, skeleton JSON (optionally zipped) and the .atlas text file.
 * The component receives it as selectedSpines[slot].
 */
export function spine(key, png, json, atlasText, opts = {}) {
  return [
    image(png, { ...opts, key: `${key}_PNG`, variant: "image", loader: "spine" }),
    data(json, { ...opts, key: `${key}_JSON`, variant: "JSON", loader: "spine" }),
    data(atlasText, { ...opts, key: `${key}_ATLAS_TXT`, variant: "atlasTxt", loader: "spine" })
  ];
}

// ── Structure helpers ────────────────────────────────────────────────────────

/** Gives a readable label to a component (or any object) in the editor. */
export function group(label, body) {
  return Object.defineProperty(body, "__plGroup", { value: label, enumerable: false });
}

/**
 * Marks a localization block. Write it once (language-agnostic); at runtime it is expanded to
 * { en: {...}, tr: {...}, ... } for every language used by any localized text in the config.
 */
export function loc(body) {
  return { [LOC]: true, body };
}

/** { portrait: num(p), landscape: num(l) } */
export function orient(portrait, landscape, opts) {
  return { portrait: num(portrait, opts), landscape: num(landscape, opts) };
}

const UNIT = { min: 0, max: 1, step: 0.005 };

/** Relative screen position for both orientations, 0..1. */
export function pos(px, py, lx = px, ly = py) {
  return {
    portrait: { x: num(px, UNIT), y: num(py, UNIT) },
    landscape: { x: num(lx, UNIT), y: num(ly, UNIT) }
  };
}

export function defineConfig(definition) {
  return definition;
}

export const isField = (node) => !!node && typeof node === "object" && node[FIELD] === true;
export const isLoc = (node) => !!node && typeof node === "object" && node[LOC] === true;
