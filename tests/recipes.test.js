import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandRecipe } from "../server/recipes.js";
import { openDb } from "../server/db.js";
const manifest = {
  fields: [
    { path: "speed", type: "number", default: 1, min: 0, max: 3 },
    { path: "color", type: "color", default: "#ff0000" },
    { path: "logo", type: "image", default: "logo.png" }
  ],
  assets: { "logo.png": { type: "image" } }
};
const recipe = {
  name: "CTA experiment",
  axes: [
    { path: "speed", values: [1, 2] },
    { path: "color", values: ["#ff0000", "#00ff00"] }
  ]
};
test("recipe Cartesian product preserves base overrides and rejects invalid combinations before writing", () => {
  const out = expandRecipe(recipe, manifest, { logo: "logo.png" });
  assert.equal(out.length, 4);
  assert.deepEqual(out[3].overrides, { logo: "logo.png", speed: 2, color: "#00ff00" });
  for (const axes of [
    [{ path: "speed", values: [4] }],
    [{ path: "speed", values: [1, 1] }],
    [{ path: "missing", values: [1] }],
    [{ path: "logo", values: ["missing.png"] }],
    [
      { path: "speed", values: [1] },
      { path: "speed", values: [2] }
    ],
    [
      { path: "speed", values: Array.from({ length: 11 }, (_, i) => i / 10) },
      { path: "color", values: Array.from({ length: 10 }, (_, i) => "#00000" + i) }
    ]
  ])
    assert.throws(() => expandRecipe({ ...recipe, axes }, manifest, {}));
  assert.throws(() => expandRecipe(recipe, manifest, { removedField: 1 }));
});
test("nested recipe transaction rolls back every draft on failure and preserves provenance on success", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-db-"));
  const db = openDb(path.join(dir, "studio.db"));
  try {
    const { release } = db.addRelease(
      { game: { id: "test", title: "Test" }, releaseHash: "r1", gameVersion: "1", notes: "", size: 1, fieldCount: 3 },
      () => {}
    );
    const candidates = expandRecipe(recipe, manifest, {});
    assert.throws(() =>
      db.generateRecipe(
        "test",
        "run1",
        "hash",
        { releaseId: release.id },
        [candidates[0], { ...candidates[1], name: null }],
        "tester"
      )
    );
    assert.equal(db.recipeRun("run1"), undefined);
    assert.equal(db.listVariants("test").length, 1);
    const result = db.generateRecipe("test", "run2", "hash", { releaseId: release.id }, candidates, "tester");
    assert.equal(db.listVariants("test").length, 5);
    assert.equal(db.getVariant(result.variantIds[0]).recipeOrigin.runId, "run2");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
