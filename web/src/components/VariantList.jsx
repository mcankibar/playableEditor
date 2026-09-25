import { api } from "../api.js";
import { formatDate } from "../format.js";

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function VariantList({
  gameId,
  variants,
  selectedId,
  overrides,
  uploads,
  onSelect,
  onChanged,
  onError,
  beforeChange
}) {
  const selected = variants.find((v) => v.id === selectedId);

  const act = (fn) => async () => {
    try {
      beforeChange();
      await fn();
    } catch (e) {
      onError(e.message);
    }
  };

  const create = act(async () => {
    const name = window.prompt("Yeni varyantın adı:", "");
    if (!name) return;
    onChanged((await api.createVariant(gameId, { name })).id);
  });

  const duplicate = act(async () => {
    const name = window.prompt("Kopyanın adı:", `${selected.name} kopya`);
    if (!name) return;
    onChanged((await api.createVariant(gameId, { name, copyFrom: selected.id })).id);
  });

  const rename = act(async () => {
    const name = window.prompt("Yeni ad:", selected.name);
    if (!name || name === selected.name) return;
    await api.updateVariant(selected.id, { name });
    onChanged();
  });

  const remove = act(async () => {
    if (!window.confirm(`"${selected.name}" silinsin mi? Bu geri alınamaz.`)) return;
    await api.deleteVariant(selected.id);
    onChanged(variants.find((v) => v.id !== selected.id).id);
  });

  const importFile = async (file) => {
    try {
      const json = JSON.parse(await file.text());
      onChanged((await api.importVariant(gameId, json)).id);
    } catch (e) {
      onError(`İçe aktarılamadı: ${e.message}`);
    }
  };

  // Same format as the template's dev panel: usable with `npm run export -- --variant=file.json`.
  const exportJson = () => {
    const used = {};
    Object.values(overrides).forEach((v) => {
      if (typeof v === "string" && uploads[v]) used[v] = uploads[v];
    });
    const file = { name: selected.name, overrides, uploads: used };
    download(
      `${selected.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`,
      new Blob([JSON.stringify(file, null, 2)], { type: "application/json" })
    );
  };

  return (
    <nav className="variants">
      <div className="variants-head">
        <span>Varyantlar</span>
        <button className="small" onClick={create}>
          + Yeni
        </button>
      </div>
      <ul>
        {variants.map((v) => {
          const count = Object.keys(v.id === selectedId ? overrides : v.overrides).length;
          return (
            <li key={v.id}>
              <button
                className={`variant${v.id === selectedId ? " active" : ""}`}
                onClick={() => v.id !== selectedId && onSelect(v.id)}
              >
                <span className="variant-name">{v.name}</span>
                <span className="muted small">
                  {count ? `${count} değişiklik` : "varsayılan"} · {formatDate(v.updatedAt)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="variant-actions">
        <button className="small" onClick={duplicate}>
          Kopyala
        </button>
        <button className="small" onClick={rename}>
          Yeniden adlandır
        </button>
        <button className="small danger" onClick={remove} disabled={variants.length < 2}>
          Sil
        </button>
        <label className="button small" title="Template dev panelinin indirdiği variant.json">
          İçe aktar
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files[0];
              e.target.value = "";
              if (file) importFile(file);
            }}
          />
        </label>
        <button className="small" onClick={exportJson} title="npm run export -- --variant=… ile kullanılabilir">
          JSON indir
        </button>
      </div>
    </nav>
  );
}

export { download };
