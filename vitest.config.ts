import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // `lcov` is what the SonarQube scanner reads; `text` keeps the numbers
      // visible in the CI log without opening an artifact.
      reporter: ["text", "lcov"],
      // Default `include` is only files touched by a test, which would hide an
      // entirely untested module from the coverage figure Sonar records.
      include: ["src/**/*.{ts,tsx}"],
      // Barrel files re-export and nothing else, so their coverage is noise.
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/index.ts"],
    },
  },
});
