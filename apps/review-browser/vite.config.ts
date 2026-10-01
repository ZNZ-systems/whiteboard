import path from "node:path";

import { mergeConfig } from "vite";

import canvasConfig from "../../packages/review/app/desktop.vite.config";

export default mergeConfig(
  {
    ...canvasConfig,
    build: { ...canvasConfig.build, rollupOptions: undefined },
    plugins: canvasConfig.plugins?.filter(
      (plugin) =>
        !plugin ||
        !("name" in plugin) ||
        plugin.name !== "harden-libavoid-trusted-types",
    ),
  },
  {
    root: __dirname,
    resolve: {
      alias: {
        "@mr_mint/elkjs-libavoid": path.join(__dirname, "src/layout-proxy.ts"),
      },
    },
    build: {
      outDir: path.join(__dirname, "dist"),
      manifest: false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { content: path.join(__dirname, "src/content.ts") },
        preserveEntrySignatures: false,
        output: {
          format: "iife",
          inlineDynamicImports: true,
          entryFileNames: "content.js",
          assetFileNames: (asset: { names: string[] }) =>
            asset.names.some((name) => name.endsWith(".css"))
              ? "assets/content.css"
              : "assets/[name]-[hash][extname]",
        },
      },
    },
    experimental: {
      renderBuiltUrl(filename: string, context: { hostType: string }) {
        if (context.hostType === "js")
          return {
            runtime: `chrome.runtime.getURL(${JSON.stringify(filename)})`,
          };

        return { relative: true };
      },
    },
  },
);
