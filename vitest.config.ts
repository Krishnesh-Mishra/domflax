import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@domflax/core": pkg("core"),
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
