import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Two pages: / is the landing, /app.html the live dashboard.
// In dev, /api is proxied to the hub on :8790.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { rollupOptions: { input: { index: "index.html", app: "app.html" } } },
  server: { proxy: { "/api": "http://localhost:8790" } },
});
