#!/usr/bin/env node
// Copies the release-format code (field schema, validation, patcher, network profiles) from the
// playable template into shared/playable, so the Studio exports exactly what `npm run export` does.
//
//   npm run sync-kit -- /path/to/template      (default: ../threejstemplate)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const FILES = [
  "kit/fields.js",
  "kit/resolve.js",
  "kit/assets.js",
  "build/blocks.js",
  "export/patch.js",
  "export/networks.js",
  "export/shims"
];

const root = path.resolve(process.argv[2] || process.env.PLAYABLE_TEMPLATE || "../threejstemplate");
const src = path.join(root, "playable");
const dest = path.resolve("shared/playable");
if (!fs.existsSync(path.join(src, "export/patch.js"))) {
  console.error(`No playable template at ${root} (expected playable/export/patch.js)`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
for (const file of FILES) {
  fs.cpSync(path.join(src, file), path.join(dest, file), { recursive: true });
}

let commit = null;
try {
  commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "playable"], { encoding: "utf8" }).trim();
  if (dirty) commit += "-dirty";
} catch {}

fs.writeFileSync(
  path.join(dest, "SOURCE.json"),
  JSON.stringify({ template: path.basename(root), commit, syncedAt: new Date().toISOString() }, null, 2) + "\n"
);
console.log(`✓ shared/playable ← ${root} (${commit ?? "no git"})`);
