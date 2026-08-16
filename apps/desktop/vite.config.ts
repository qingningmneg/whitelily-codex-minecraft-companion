import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";

export default defineConfig(({ mode }): UserConfig => {
  if (mode === "main") {
    return {
      ssr: {
        noExternal: true,
      },
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
          input: {
            preload: "src-main/preload.ts",
            avatarPreviewPreload: "src-preview/avatarPreviewPreload.ts",
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === "preload" ? "preload.cjs" : "avatar-preview-preload.cjs",
            format: "cjs",
          },
        },
        ssr: true,
      },
    };
  }
  return {
    base: "./",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5_173,
      strictPort: true,
    },
    build: {
      outDir: "dist-renderer",
      emptyOutDir: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("index.html", import.meta.url)),
          avatarPreview: fileURLToPath(new URL("src-preview/avatarPreview.html", import.meta.url)),
        },
      },
    },
  };
});
