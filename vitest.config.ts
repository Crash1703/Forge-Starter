import { defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config";

// Unit tests only: the stress tests on real roads (stress/) run with `npm run stress`.
export default mergeConfig(vite, defineConfig({ test: { include: ["src/**/*.test.{ts,tsx}"] } }));
