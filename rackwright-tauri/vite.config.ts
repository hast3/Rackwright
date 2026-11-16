import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420, strictPort: true,
    // Web dev mode: forward API calls to the Rust server.
    proxy: mode === "web" ? { "/api": "http://127.0.0.1:8080", "/healthz": "http://127.0.0.1:8080" } : undefined,
  },
}));
