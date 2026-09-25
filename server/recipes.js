import { normalizeValue, sanitizeOverrides } from "../shared/playable/kit/resolve.js";
const fail = (message) => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};
export function expandRecipe(recipe, manifest, base, assetExists = () => false) {
  if (!recipe || typeof recipe.name !== "string" || !recipe.name.trim() || recipe.name.length > 60)
    fail("Recipe name must be 1–60 characters");
  if (!Array.isArray(recipe.axes) || !recipe.axes.length || recipe.axes.length > 6) fail("Choose 1–6 fields");
  if (JSON.stringify(recipe).length > 100000) fail("Recipe is too large");
  const fields = new Map(manifest.fields.map((f) => [f.path, f]));
  const paths = new Set();
  let combinations = [{}];
  for (const axis of recipe.axes) {
    if (!axis || typeof axis !== "object") fail("Invalid recipe field");
    const field = fields.get(axis.path);
    if (!field || paths.has(axis.path)) fail("Unknown or repeated recipe field");
    paths.add(axis.path);
    if (!Array.isArray(axis.values) || !axis.values.length || axis.values.length > 20)
      fail("Each field needs 1–20 values");
    const values = axis.values.map((value) => {
      const result = normalizeValue(field, value);
      if (result.error) fail(`${axis.path}: ${result.error}`);
      if (field.type === "number" && result.value !== value) fail(`${axis.path}: outside allowed range`);
      if (["image", "sound", "model", "font", "data"].includes(field.type)) {
        const asset = manifest.assets?.[result.value];
        if (!(asset?.type === field.type || assetExists(result.value, field.type)))
          fail(`${axis.path}: missing or incompatible asset`);
      }
      return result.value;
    });
    if (new Set(values.map((v) => JSON.stringify(v))).size !== values.length)
      fail("Repeated values produce duplicate variants");
    if (combinations.length * values.length > 100) fail("A recipe can generate at most 100 variants at once");
    combinations = combinations.flatMap((c) => values.map((value) => ({ ...c, [axis.path]: value })));
  }
  if (Buffer.byteLength(JSON.stringify(base)) * combinations.length > 8 * 1024 * 1024)
    fail("Combined overrides exceed the 8 MB recipe budget");
  return combinations.map((changes, i) => {
    const overrides = { ...base, ...changes };
    for (const [path, value] of Object.entries(overrides)) {
      const field = fields.get(path);
      if (
        field &&
        ["image", "sound", "model", "font", "data"].includes(field.type) &&
        !(manifest.assets?.[value]?.type === field.type || assetExists(value, field.type))
      )
        fail(`${path}: missing or incompatible asset`);
    }
    const checked = sanitizeOverrides(manifest.fields, overrides);
    if (checked.orphans.length || checked.errors.length) fail([...checked.orphans, ...checked.errors].join("; "));
    return { name: `${recipe.name.trim()} · ${String(i + 1).padStart(3, "0")}`, overrides: checked.values, changes };
  });
}
