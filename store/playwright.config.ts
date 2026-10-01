import { defineConfig } from "@playwright/test";

// Google Play screenshots (store/screenshots.spec.ts): the real app, real map
// and Ride Forge's real servers, on a 1080 × 1920 phone screen at Caloundra.
//   npx playwright test -c store/playwright.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: "screenshots.spec.ts",
  timeout: 1_800_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    baseURL: "http://localhost:5299",
    geolocation: { latitude: -26.8036, longitude: 153.1216 },
    permissions: ["geolocation"],
    colorScheme: "light",
    timezoneId: "Australia/Brisbane",
    locale: "en-AU",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  // Run from the repo root (Playwright would otherwise start it in store/).
  webServer: { command: "npx vite --port 5299 --strictPort", cwd: "..", url: "http://localhost:5299", reuseExistingServer: true, timeout: 120_000 },
});
