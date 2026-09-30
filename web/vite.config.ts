import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two pages: / is the landing, /app.html the live dashboard.
// In dev, /api is proxied to the hub on :8790.
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { index: "index.html", app: "app.html" } } },
  server: { proxy: { "/api": "http://localhost:8790" } },
});
