import { defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config";

// The stress tests on real roads (see stress/README.md): long, and they need the route server.
export default mergeConfig(vite, defineConfig({ test: { include: ["stress/**/*.stress.ts"], testTimeout: 3_600_000, silent: false } }));
