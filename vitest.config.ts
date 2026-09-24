import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: unit tests cover the pure scanning engine and
// must not boot the Cloudflare/Workers dev plugin.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
