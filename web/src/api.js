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
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const enc = encodeURIComponent;

export const api = {
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
  updateVariant: (id, patch) => request("PUT", `/api/variants/${id}`, patch),
  deleteVariant: (id) => request("DELETE", `/api/variants/${id}`),
  variantUploads: (id) => request("GET", `/api/variants/${id}/uploads`),

  uploadAsset: (name, base64) => request("POST", "/api/assets", { name, base64 }),

  async exportVariant(id, body) {
    const res = await request("POST", `/api/variants/${id}/export`, body, { raw: true });
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || "export";
    const warnings = JSON.parse(decodeURIComponent(res.headers.get("x-export-report") || "%5B%5D"));
    return { blob: await res.blob(), fileName: name, warnings };
  }
};

/** URL of an asset value: an upload ("u/…") or a file inside the release. */
export const assetUrl = (releaseId, id) =>
  id.startsWith("u/") ? `/api/assets/${id}` : `/api/releases/${releaseId}/assets/${id.split("/").map(enc).join("/")}`;

export const releasePlayUrl = (releaseId) => `/api/releases/${releaseId}/play`;
