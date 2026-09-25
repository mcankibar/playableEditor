// The patchable HTML format. Shared by the Vite plugin (writes it) and the exporter (rewrites it).
// Works in Node and in the browser: no fs, no Buffer.
//
// Every block sits between HTML comment markers so it can be found and replaced without parsing
// HTML. Base64 and escaped JSON can never contain "<!--", so the markers are unambiguous.
//
//   <!--pl:network--><script id="pl-network">window.__PL_NETWORK__="default";</script><!--/pl:network-->
//   <!--pl:manifest--><script type="application/json" id="pl-manifest">{...}</script><!--/pl:manifest-->
//   <!--pl:config--><script type="application/json" id="pl-config">{...}</script><!--/pl:config-->
//   <!--pl:assets--> <script type="text/plain" data-pl-asset="id" data-mime="...">BASE64</script> ... <!--/pl:assets-->
//   <!--pl:game--><script id="pl-game">...game bundle...</script><!--/pl:game-->

export const FORMAT_VERSION = 2;
export const BLOCKS = ["network", "manifest", "config", "assets", "game"];

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  glb: "model/gltf-binary",
  zip: "application/zip",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  json: "application/json"
};

export function mimeOf(fileName) {
  return MIME[String(fileName).split(".").pop().toLowerCase()] || "application/octet-stream";
}

/** JSON that is safe inside a <script> element. */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** JS that is safe inside a <script> element. */
export function scriptJs(code) {
  // "\/" and "\x21" are valid escapes in strings and in regexes (also with the u flag).
  return code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\x21--");
}

export function wrap(name, inner) {
  return `<!--pl:${name}-->${inner}<!--/pl:${name}-->`;
}

export const networkBlock = (network, mode = "preview") =>
  wrap(
    "network",
    `<script id="pl-network">window.__PL_NETWORK__=${scriptJson(network)};window.__PL_MODE__=${scriptJson(
      mode
    )};</script>`
  );
export const manifestBlock = (manifest) =>
  wrap("manifest", `<script type="application/json" id="pl-manifest">${scriptJson(manifest)}</script>`);
export const configBlock = (overrides) =>
  wrap("config", `<script type="application/json" id="pl-config">${scriptJson(overrides)}</script>`);
export const gameBlock = (code) => wrap("game", `<script id="pl-game">${scriptJs(code)}</script>`);

/** assets: Array<{ id, mime, base64 } | { id, mime, src }> */
export function assetsBlock(assets) {
  const tags = assets.map(({ id, mime, base64, src }) =>
    src
      ? `<script type="text/plain" data-pl-asset="${escapeAttr(id)}" data-mime="${escapeAttr(
          mime
        )}" data-src="${escapeAttr(src)}"></script>`
      : `<script type="text/plain" data-pl-asset="${escapeAttr(id)}" data-mime="${escapeAttr(mime)}">${base64}</script>`
  );
  return wrap("assets", "\n" + tags.join("\n") + "\n");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function unescapeAttr(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function markerRange(html, name) {
  const open = `<!--pl:${name}-->`;
  const close = `<!--/pl:${name}-->`;
  const start = html.indexOf(open);
  const end = html.indexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  if (html.indexOf(open, start + open.length) !== -1 || html.indexOf(close, end + close.length) !== -1)
    throw new Error(`Duplicate pl:${name} block`);
  return {
    start,
    end: end + close.length,
    innerStart: start + open.length,
    innerEnd: end
  };
}

export function hasBlock(html, name) {
  return markerRange(html, name) !== null;
}

export function readBlock(html, name) {
  const r = markerRange(html, name);
  if (!r) throw new Error(`pl:${name} block not found — is this a playable build?`);
  return html.slice(r.innerStart, r.innerEnd);
}

export function replaceBlock(html, name, replacement) {
  const r = markerRange(html, name);
  if (!r) throw new Error(`pl:${name} block not found — is this a playable build?`);
  return html.slice(0, r.start) + replacement + html.slice(r.end);
}

function scriptBody(block) {
  const m = /^<script[^>]*>([\s\S]*)<\/script>$/.exec(block.trim());
  if (!m) throw new Error("malformed block: " + block.slice(0, 80));
  return m[1];
}

export function readJson(html, name) {
  return JSON.parse(scriptBody(readBlock(html, name)));
}

export function readGameCode(html) {
  return scriptBody(readBlock(html, "game"));
}

/** @returns Map<id, { id, mime, base64?, src? }> */
export function readAssets(html) {
  const inner = readBlock(html, "assets");
  const re =
    /<script type="text\/plain" data-pl-asset="([^"]*)" data-mime="([^"]*)"(?: data-src="([^"]*)")?>([\s\S]*?)<\/script>/g;
  const out = new Map();
  let m;
  while ((m = re.exec(inner))) {
    const id = unescapeAttr(m[1]);
    if (out.has(id)) throw new Error(`Duplicate asset id: ${id}`);
    out.set(id, m[3] ? { id, mime: m[2], src: unescapeAttr(m[3]) } : { id, mime: m[2], base64: m[4] });
  }
  return out;
}

/** Smallest valid files used in place of assets that a disabled component never shows/plays. */
export const PLACEHOLDERS = {
  image: {
    mime: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  }
};
