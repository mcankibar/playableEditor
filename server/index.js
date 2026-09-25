// Starts the Studio on one port: the API plus the web UI (Vite middleware in dev, dist/ in production).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 5300);
const host = process.env.HOST || "localhost";
const dataDir = path.resolve(root, process.env.PLAYABLE_DATA || "data");

const app = await buildApp({ dataDir, logger: { level: production ? "info" : "warn" } });

if (production) {
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: path.join(root, "dist") });
} else {
  const { default: middie } = await import("@fastify/middie");
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(root, "vite.config.js"),
    server: { middlewareMode: true },
    appType: "spa"
  });
  await app.register(middie);
  // Vite's SPA fallback would answer /api requests (e.g. the preview iframe) with the UI.
  app.use((req, res, next) => (req.url.startsWith("/api/") ? next() : vite.middlewares(req, res, next)));
  app.addHook("onClose", () => vite.close());
}

await app.listen({ port, host });
console.log(`Playable Studio → http://localhost:${port}  (data: ${dataDir})`);
