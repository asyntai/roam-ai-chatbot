// Three modes:
//   node build.mjs        bundles src/index.ts into extension.js, the file Roam loads
//   node build.mjs test   bundles the Roam-free modules for node --test
//   node build.mjs e2e    bundles the browser harness for the end-to-end test
import esbuild from "esbuild";
import process from "process";

const mode = process.argv[2] || "production";

if (mode === "e2e") {
    // The browser harness: datascript + fake extensionAPI as one script.
    await esbuild.build({
        entryPoints: ["tests/e2e/harness.mjs"],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2020",
        outfile: "tests/build/harness.js",
        logLevel: "warning",
    });
} else if (mode === "test") {
    await esbuild.build({
        entryPoints: ["src/api.ts", "src/text.ts", "src/sync.ts", "src/graph.ts", "src/store.ts", "src/ui.ts", "src/index.ts"],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        outdir: "tests/build",
        logLevel: "warning",
    });
} else {
    // Roam imports extension.js as an ES module and reads its default export.
    // Not minified, so a reviewer can read what ships.
    await esbuild.build({
        entryPoints: ["src/index.ts"],
        bundle: true,
        format: "esm",
        target: "es2020",
        platform: "browser",
        minify: false,
        legalComments: "none",
        outfile: "extension.js",
        logLevel: "info",
    });
}
