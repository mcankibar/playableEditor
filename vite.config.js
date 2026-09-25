import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("web"),
  plugins: [react()],
  build: { outDir: here("dist"), emptyOutDir: true },
  // The web UI imports the release-format code (field helpers, validation) from shared/.
  server: { fs: { allow: [here(".")] } }
});
