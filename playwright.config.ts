import { defineConfig, devices } from "@playwright/test";

// Screen tests (e2e/): the real app in a phone-sized browser, with every
// outside service faked (e2e/fakes.ts). Screenshots go to e2e/screenshots.
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    ...devices["Pixel 7"],
    baseURL: "http://localhost:5199",
    geolocation: { latitude: -26.8036, longitude: 153.1216 },
    permissions: ["geolocation"],
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: { command: "npx vite --port 5199 --strictPort", url: "http://localhost:5199", reuseExistingServer: !process.env.CI },
});
