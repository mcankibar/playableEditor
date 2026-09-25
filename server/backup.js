// Daily backup of the whole Studio: a copy of the database per day plus the release and asset files.
// Release and asset files never change once written, so they are copied only once:
//
//   <backupDir>/db/studio-2026-09-25.db     one per day, the last `keep` are kept
//   <backupDir>/releases/<id>.html
//   <backupDir>/assets/<sha256>
//
// Restore: stop the Studio, copy db/studio-<day>.db to <data>/studio.db and the releases/ and
// assets/ folders into <data>/, start it again. Point STUDIO_BACKUP_DIR at another disk (or a
// synced folder) so a broken disk doesn't take the backup with it.
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 3600 * 1000;

function copyNew(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  let copied = 0;
  for (const file of fs.readdirSync(fromDir)) {
    if (file.endsWith(".part")) continue;
    const to = path.join(toDir, file);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(fromDir, file), to + ".part");
    fs.renameSync(to + ".part", to);
    copied++;
  }
  return copied;
}

export function listBackups(backupDir) {
  const dir = path.join(backupDir, "db");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^studio-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .map((file) => {
      const stat = fs.statSync(path.join(dir, file));
      return { file, day: file.slice(7, 17), size: stat.size, createdAt: stat.mtime.toISOString() };
    });
}

/** @returns {{ file, releases, assets }} what was written */
export function runBackup({ db, store, backupDir, keep = 14 }) {
  const dbDir = path.join(backupDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dbDir, `studio-${day}.db`);
  const part = file + ".part";
  fs.rmSync(part, { force: true });
  db.backupTo(part);

  const releases = copyNew(store.releasesDir, path.join(backupDir, "releases"));
  const assets = copyNew(store.assetsDir, path.join(backupDir, "assets"));
  const exports = copyNew(store.exportsDir, path.join(backupDir, "exports"));
  fs.renameSync(part, file); // Publish the snapshot only after all referenced immutable files exist.
  for (const old of listBackups(backupDir).slice(keep)) fs.rmSync(path.join(dbDir, old.file), { force: true });
  return { file, releases, assets, exports };
}

/** Backs up now if the last backup is older than a day, then checks every hour. */
export function scheduleBackups({ db, store, backupDir, keep, log }) {
  const check = () => {
    const [last] = listBackups(backupDir);
    if (last && Date.now() - Date.parse(last.createdAt) < DAY_MS) return;
    try {
      const out = runBackup({ db, store, backupDir, keep });
      log.info(`Backup written: ${out.file} (+${out.releases} releases, +${out.assets} files)`);
    } catch (e) {
      log.error(`Backup failed: ${e.message}`);
    }
  };
  check();
  const timer = setInterval(check, 3600 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
