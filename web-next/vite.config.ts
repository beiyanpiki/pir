import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The "/next" workspace is an independent SPA build. It is mounted by
// pir serve under /next/ so it can be dogfooded next to the legacy app
// until that app is removed (the migration's second step).
export default defineConfig({
  plugins: [react()],
  base: "/next/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/web-next",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 5175,
    proxy: {
      "/api": {
        target: process.env.PIR_DEV_API ?? "http://127.0.0.1:8790",
        changeOrigin: false,
        secure: false,
      },
    },
  },
});
