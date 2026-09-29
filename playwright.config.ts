import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:8080",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:8080/api/health",
    reuseExistingServer: !process.env.CI,
    env: { DATA_DIR: "data/browser-test", HOST: "127.0.0.1" },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  workers: 1,
});
