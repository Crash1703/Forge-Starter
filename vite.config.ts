import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works from a subfolder such as
  // https://<user>.github.io/<repo>/ as well as from a domain root.
  base: "./",
  // MapLibre's worker is an ES module.
  worker: { format: "es" },
});
