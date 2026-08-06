import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    pool: "forks",
    maxWorkers: 2,
    fileParallelism: true,
  },
});
