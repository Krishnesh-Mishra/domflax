import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    // Tests live in each package's sibling `test/` folder (never under `src/`, which now holds
    // only shipped source). Discover them recursively so subgrouped tests are still found.
    include: ["packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The Tailwind/CSS resolver suites JIT-compile a real engine on first resolve; a cold start can
    // exceed the 5s default on a fresh machine. Give the engine room so verify is deterministic.
    testTimeout: 60000,
    hookTimeout: 60000
  },
  resolve: {
    alias: {
      "@domflax/core": pkg("core"),
      "@domflax/pattern-kit/testing": fileURLToPath(
        new URL("./packages/pattern-kit/src/testing.ts", import.meta.url),
      ),
      "@domflax/pattern-kit": pkg("pattern-kit"),
      "@domflax/patterns": pkg("patterns"),
      "@domflax/resolver-tailwind": pkg("resolver-tailwind"),
      "@domflax/resolver-css": pkg("resolver-css"),
      "@domflax/frontend-jsx": pkg("frontend-jsx"),
      "@domflax/frontend-html": pkg("frontend-html"),
      "@domflax/verify": pkg("verify"),
      "@domflax/cli": pkg("cli")
    }
  }
});
