// The face's dev server. All of Lois lives in the SIDECAR (sidecar/server.ts)
// — the real process the app runs on; this config only proxies /api/lois/*
// there, so the brain, the key, and her hands never live in a dev harness
// again. In prod the Tauri shell spawns the same sidecar. Start both in dev:
//
//   npx tsx sidecar/server.ts                                  (Lois, port 5175)
//   VITE_VAULT=hacker-garage pnpm --filter @browser-operator/face dev

import { defineConfig } from "vite";

export default defineConfig(() => ({
  server: {
    proxy: {
      "/api/neon": { target: `http://127.0.0.1:${process.env.NEON_PORT || 5275}`, changeOrigin: false },
      "/api/lois": {
        target: `http://127.0.0.1:${process.env.LOIS_PORT || 5276}`,
        // Preserve the face Host so the sidecar can verify same-origin edits.
        changeOrigin: false,
      },
    },
  },
}));
