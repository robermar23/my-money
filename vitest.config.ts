import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
      // `server-only` is a Next.js virtual that errors if imported into a
      // client bundle. In vitest it doesn't exist; stub it to an empty module
      // so imports succeed and the runtime check is a no-op.
      "server-only": new URL("./vitest.stub-empty.ts", import.meta.url).pathname,
    },
  },
  test: {
    // Default environment is node; per-file override via `// @vitest-environment jsdom` comment.
    environment: "node",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**", "**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/app/**/*.tsx", "src/db/schema/**"],
    },
  },
});
