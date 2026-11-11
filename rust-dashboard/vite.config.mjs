import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const project = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@\/shared\/components$/,
        replacement: fileURLToPath(new URL("./components.ts", import.meta.url)),
      },
      { find: /^@\//, replacement: `${project}src/` },
    ],
  },
  build: {
    outDir: fileURLToPath(new URL("../.build/rust-dashboard/", import.meta.url)),
    emptyOutDir: true,
  },
});
