import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "main") {
    return {
      build: {
        emptyOutDir: true,
        outDir: "dist/main",
        rollupOptions: {
          external: ["electron", /^node:/u],
          input: "src-main/main.ts",
          output: {
            entryFileNames: "main.js",
            format: "es",
          },
        },
        ssr: true,
      },
    };
  }
  if (mode === "preload") {
    return {
      ssr: {
        noExternal: true,
      },
      build: {
        emptyOutDir: true,
        outDir: "dist/preload",
        rollupOptions: {
          external: ["electron"],
          input: "src-main/preload.ts",
          output: {
            entryFileNames: "preload.cjs",
            format: "cjs",
          },
        },
        ssr: true,
      },
    };
  }
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5_173,
      strictPort: true,
    },
    build: {
      outDir: "dist-renderer",
      emptyOutDir: true,
    },
  };
});
