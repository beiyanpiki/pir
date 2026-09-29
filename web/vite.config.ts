import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA builds to the pir package's dist/web, which `pir serve --web`
// serves statically; dev mode proxies the API to a local serve instance.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8790", changeOrigin: false },
    },
  },
});
