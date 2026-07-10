import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode runs against a live `archmap serve` for data + SSE.
    proxy: {
      "/api": { target: "http://localhost:4400", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
