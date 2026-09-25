// Shared by build/export and the browser editor. Never trust an uploaded filename or MIME.
import { unzipSync } from "fflate";

export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const MODEL_CAPABILITIES = {
  draco: false,
  ktx2: false,
  meshopt: true,
  externalResources: false
};

export function validateAssetId(id) {
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(id) ||
    id.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe asset id: ${String(id)}`);
  }
  return id;
}

export function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Invalid or oversized base64 asset");
  }
  const raw = atob(value);
  if (btoa(raw) !== value) throw new Error("Non-canonical base64 asset");
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

export function detectMime(bytes) {
  if (bytes[0] === 137 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF") {
    if (ascii(bytes, 8, 4) === "WEBP") return "image/webp";
    if (ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  }
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 255 && (bytes[1] & 246) === 240) return "audio/aac";
  if (bytes[0] === 255 && (bytes[1] & 224) === 224) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 4, 4) === "ftyp") return "audio/mp4";
  for (const [magic, mime] of [
    ["wOFF", "font/woff"],
    ["wOF2", "font/woff2"],
    ["OTTO", "font/otf"],
    ["glTF", "model/gltf-binary"]
  ]) {
    if (ascii(bytes, 0, 4) === magic) return mime;
  }
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return "font/ttf";
  if (ascii(bytes, 0, 2) === "PK") return "application/zip";
  const text = textMime(bytes);
  if (text) return text;
  throw new Error("Unsupported asset file signature");
}

/** "application/json" / "text/plain" for UTF-8 text files (atlas JSON, Spine .atlas), else null. */
function textMime(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
  // Binary files decode as UTF-8 surprisingly often; reject control characters other than whitespace.
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return null;
  try {
    JSON.parse(text);
    return "application/json";
  } catch (e) {
    return "text/plain";
  }
}

export function inspectGlb(bytes) {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "glTF") throw new Error("Expected a GLB model");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length ||
    view.getUint32(16, true) !== 0x4e4f534a
  ) {
    throw new Error("Invalid GLB header");
  }
  const end = 20 + view.getUint32(12, true);
  if (end > bytes.length) throw new Error("Truncated GLB JSON");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, end)));
  const extensions = new Set([...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]);
  for (const name of ["KHR_draco_mesh_compression", "KHR_texture_basisu"]) {
    if (extensions.has(name))
      throw new Error(`${name} is not supported by this release; upload an uncompressed GLB or use meshopt`);
  }
  for (const resource of [...(json.buffers || []), ...(json.images || [])]) {
    if (resource.uri && !resource.uri.startsWith("data:")) throw new Error("GLB external resources are not supported");
  }
  return json;
}

export function modelBytes(bytes, zipped) {
  if (!zipped) return bytes;
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (total > MAX_ASSET_BYTES) throw new Error("Model ZIP expands beyond the asset limit");
      validateAssetId(file.name.replace(/\/$/, ""));
      if (
        file.name.startsWith("__MACOSX/") ||
        file.name.split("/").some((part) => part.startsWith(".")) ||
        file.name.endsWith("/")
      )
        return false;
      validateAssetId(file.name);
      return file.name.toLowerCase().endsWith(".glb");
    }
  });
  const models = Object.values(files);
  if (models.length !== 1) throw new Error("Model ZIP must contain exactly one GLB");
  return models[0];
}

export function validateAsset(id, asset, field) {
  validateAssetId(id);
  if (!asset || asset.src) throw new Error(`Asset ${id} must contain inline bytes in the release`);
  const bytes = decodeBase64(asset.base64);
  if (bytes.length > (field.maxBytes ?? MAX_ASSET_BYTES)) throw new Error(`Asset ${id} exceeds its size limit`);
  const mime = asset.mime;
  let matches = false;
  switch (field.type) {
    case "image":
      matches =
        (mime === "image/png" && bytes[0] === 137 && ascii(bytes, 1, 3) === "PNG") ||
        (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
        (mime === "image/gif" && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) ||
        (mime === "image/webp" && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP");
      break;
    case "sound":
      matches =
        (mime === "audio/aac" && bytes[0] === 255 && (bytes[1] & 246) === 240) ||
        (mime === "audio/mpeg" && (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224))) ||
        (mime === "audio/ogg" && ascii(bytes, 0, 4) === "OggS") ||
        (mime === "audio/wav" && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") ||
        (mime === "audio/mp4" && ascii(bytes, 4, 4) === "ftyp");
      break;
    case "font":
      matches =
        (mime === "font/woff" && ascii(bytes, 0, 4) === "wOFF") ||
        (mime === "font/woff2" && ascii(bytes, 0, 4) === "wOF2") ||
        (mime === "font/otf" && ascii(bytes, 0, 4) === "OTTO") ||
        (mime === "font/ttf" && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
      break;
    case "data":
      matches =
        (mime === "application/zip" && ascii(bytes, 0, 2) === "PK") ||
        ((mime === "application/json" || mime === "text/plain") && textMime(bytes) === mime);
      break;
    case "model": {
      const zipped = /\.zip$/i.test(id);
      matches = zipped ? mime === "application/zip" : mime === "model/gltf-binary";
      if (matches) inspectGlb(modelBytes(bytes, zipped));
      break;
    }
  }
  if (!matches) throw new Error(`Asset ${id}: content/MIME does not match ${field.type}`);
  return bytes;
}
