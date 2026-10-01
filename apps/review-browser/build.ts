import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as bundle, transform } from "esbuild";
import { build } from "vite";

import { makeLibavoidCspSafe } from "./libavoid-csp";

const root = path.dirname(fileURLToPath(import.meta.url));

const outdir = path.join(root, "dist");

const require = createRequire(import.meta.url);

await build({ configFile: path.join(root, "vite.config.ts") });

const contentFile = path.join(outdir, "content.js");

const content = await transform(await readFile(contentFile, "utf8"), {
  loader: "js",
  target: "chrome140",
  charset: "ascii",
  minify: true,
});

await writeFile(contentFile, content.code);

await bundle({
  entryPoints: [
    path.join(root, "src/background.ts"),
    path.join(root, "src/options.ts"),
  ],
  outdir,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome140",
  minify: true,
  plugins: [
    {
      name: "static-libavoid-bindings",
      setup(builder) {
        builder.onLoad(
          { filter: /[/\\]libavoid-js[/\\]dist[/\\]index\.js$/ },
          async ({ path }) => ({
            contents: makeLibavoidCspSafe(await readFile(path, "utf8")),
            loader: "js",
          }),
        );
      },
    },
  ],
});

await mkdir(path.join(outdir, "assets"), { recursive: true });

await Promise.all([
  copyFile(
    path.join(root, "manifest.json"),
    path.join(outdir, "manifest.json"),
  ),
  copyFile(path.join(root, "options.html"), path.join(outdir, "options.html")),
  copyFile(
    path.join(
      path.dirname(require.resolve("@mr_mint/elkjs-libavoid")),
      "libavoid.wasm",
    ),
    path.join(outdir, "assets/libavoid.wasm"),
  ),
]);
