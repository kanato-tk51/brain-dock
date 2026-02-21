import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "pnpm build && pnpm start --port 3100",
    port: 3100,
    timeout: 180000,
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://localhost:3100",
  },
});
