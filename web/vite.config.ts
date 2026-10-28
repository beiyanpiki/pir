import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The review workspace is built into the pir package's dist/web, which
// `pir serve --web` serves statically; dev mode proxies the API to a local
// serve instance.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PIR_DEV_API ?? "http://127.0.0.1:8790",
        changeOrigin: false,
        secure: false,
      },
    },
  },
});