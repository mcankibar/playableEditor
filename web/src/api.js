/** Fired when the session is gone (expired, signed out elsewhere); App shows the login page. */
export const UNAUTHORIZED_EVENT = "studio:unauthorized";

async function request(method, url, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === "string") init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(url, init);
  if (res.status === 401 && url !== "/api/login") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {}
    // status and the body (e.g. a 409's conflicts) travel with the error.
    throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const enc = encodeURIComponent;

export const api = {
  recipes: (gameId) => request("GET", `/api/games/${enc(gameId)}/recipes`),
  recipeAction: (gameId, action, body) =>
    request("POST", `/api/games/${enc(gameId)}/recipes${action ? "/" + action : ""}`, body),
  me: () => request("GET", "/api/me"),
  login: (username, password) => request("POST", "/api/login", { username, password }),
  logout: () => request("POST", "/api/logout"),

  networks: () => request("GET", "/api/networks"),
  games: () => request("GET", "/api/games"),
  game: (gameId) => request("GET", `/api/games/${enc(gameId)}`),
  manifest: (releaseId) => request("GET", `/api/releases/${releaseId}/manifest`),
  uploadRelease: (html, notes = "") =>
    request("POST", `/api/releases?notes=${enc(notes)}`, html, { headers: { "content-type": "text/html" } }),

  createVariant: (gameId, body) => request("POST", `/api/games/${enc(gameId)}/variants`, body),
  importVariant: (gameId, file) => request("POST", `/api/games/${enc(gameId)}/variants/import`, file),
  /** body: { baseRevision, set, unset, name, tags, status, pinnedReleaseId, baseReleaseId, force } */
  patchVariant: (id, body) => request("PATCH", `/api/variants/${id}`, body),
  trash: (gameId) => request("GET", `/api/games/${enc(gameId)}/trash`),
  restoreDeleted: (gameId, id) => request("POST", `/api/games/${enc(gameId)}/trash/${id}/restore`),
  deleteVariant: (id) => request("DELETE", `/api/variants/${id}`),
  saveThumbnail: (id, dataUrl) =>
    request("PUT", `/api/variants/${id}/thumbnail`, { jpeg: String(dataUrl).replace(/^data:image\/jpeg;base64,/, "") }),
  variantUploads: (id) => request("GET", `/api/variants/${id}/uploads`),
  revisions: (id) => request("GET", `/api/variants/${id}/revisions`),
  revision: (id, revision) => request("GET", `/api/variants/${id}/revisions/${revision}`),
  restore: (id, revision, baseRevision) => request("POST", `/api/variants/${id}/restore`, { revision, baseRevision }),
  playtestSnapshot: (id, releaseId, revision) =>
    request("POST", `/api/variants/${id}/playtest-snapshot`, { releaseId, revision }),
  savePlaytest: (id, result) => request("POST", `/api/variants/${id}/playtest`, result),

  uploadAsset: (name, base64, gameId) => request("POST", "/api/assets", { name, base64, gameId }),
  gameAssets: (gameId) => request("GET", `/api/games/${enc(gameId)}/assets`),

  estimate: (releaseId, overrides) => request("POST", `/api/releases/${releaseId}/estimate`, { overrides }),
  deleteRelease: (id) => request("DELETE", `/api/releases/${id}`),
  deleteGame: (gameId) => request("DELETE", `/api/games/${enc(gameId)}?confirm=${enc(gameId)}`),

  exports: (gameId) => request("GET", `/api/games/${enc(gameId)}/exports`),
  startExportJob: (gameId, body) => request("POST", `/api/games/${enc(gameId)}/export-jobs`, body),
  job: (id) => request("GET", `/api/jobs/${id}`),

  maintenance: () => request("GET", "/api/maintenance"),
  backupNow: () => request("POST", "/api/maintenance/backup"),
  collectGarbage: () => request("POST", "/api/maintenance/gc"),

  async exportVariant(id, body) {
    const res = await request("POST", `/api/variants/${id}/export`, body, { raw: true });
    const warnings = JSON.parse(decodeURIComponent(res.headers.get("x-export-report") || "%5B%5D"));
    return { ...(await fileOf(res)), warnings, exportId: Number(res.headers.get("x-export-id")) };
  },

  /** The file of a past export, made again; identical: whether the bytes match the original. */
  async downloadExport(id) {
    const res = await request("GET", `/api/exports/${id}/download`, undefined, { raw: true });
    return { ...(await fileOf(res)), identical: res.headers.get("x-export-identical") === "1" };
  },

  downloadJob: async (id) => fileOf(await request("GET", `/api/jobs/${id}/download`, undefined, { raw: true }))
};

/** An uploaded file as a data URI (what the preview iframe needs). */
export async function assetDataUri(id) {
  const res = await fetch(`/api/assets/${id}`);
  if (!res.ok) throw new Error(`${id}: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${id}: couldn't read the file`));
    reader.readAsDataURL(blob);
  });
}

async function fileOf(res) {
  const fileName = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "export";
  return { blob: await res.blob(), fileName };
}

/** URL of an asset value: an upload ("u/…") or a file inside the release. */
export const assetUrl = (releaseId, id) =>
  id.startsWith("u/") ? `/api/assets/${id}` : `/api/releases/${releaseId}/assets/${id.split("/").map(enc).join("/")}`;

export const releasePlayUrl = (releaseId) => `/api/releases/${releaseId}/play`;
