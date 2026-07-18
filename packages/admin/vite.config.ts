import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The SPA's own build, producing `dist-spa/`. This is a separate toolchain
 * from the plugin's tsup build.
 *
 * `base` is what makes the emitted asset URLs resolve under `/admin/assets/`,
 * matching where `registerAdminRoutes` serves them from, so it has to stay in
 * sync with `DEFAULT_ROUTE` in `src/index.ts`.
 */
export default defineConfig({
  root: "spa",
  base: "/admin/",
  plugins: [tailwindcss(), react()],
  resolve: {
    // Mirrored in `tsconfig.spa.json` for typecheck and `vitest.config.ts` for
    // the jsdom suite, which imports these modules directly.
    alias: {
      "@": fileURLToPath(new URL("./spa", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist-spa",
    emptyOutDir: true,
  },
});
