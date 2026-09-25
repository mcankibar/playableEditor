export const formatBytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export const formatDate = (iso) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const META_KEYS = { $name: "Name", $tags: "Tags", $status: "Status", $pin: "Pinned release" };

/** "CTA › Color" for a field path (or the variant's own props: "$name" → "Name"). */
export function fieldName(fields, path) {
  if (META_KEYS[path]) return META_KEYS[path];
  const f = fields.find((x) => x.path === path);
  return f ? `${f.group} › ${f.label}` : path;
}

/** Short display of a value in lists and conflict dialogs. */
export function formatValue(v) {
  if (v === undefined) return "(default)";
  if (v === null) return "none";
  if (typeof v === "string") return v.startsWith("u/") ? "uploaded file" : v.length > 60 ? `${v.slice(0, 57)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

export const STATUSES = [
  { id: "draft", label: "Draft" },
  { id: "review", label: "In review" },
  { id: "approved", label: "Approved" },
  { id: "live", label: "Live" }
];

/** Downloads a Blob with a file name. */
export function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
