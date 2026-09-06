#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildFigmaManifest } from "../packages/figma-schema/src/index.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const validateOnly = process.argv.includes("--validate-only");
const engineArgIndex = process.argv.indexOf("--engine");
const engineRoot = engineArgIndex >= 0 && process.argv[engineArgIndex + 1]
  ? path.resolve(process.cwd(), process.argv[engineArgIndex + 1])
  : path.resolve(rootDir, "../BufferCore-Engine");
const canonicalPath = path.join(engineRoot, "generated", "manifest", "buffercore.json");
const output = path.join(rootDir, "generated", "figma", "buffercore.figma.json");

try {
  const manifest = buildFigmaManifest({ rootDir, canonicalPath });

  const errorCount = manifest.diagnostics.errors.length;
  const warningCount = manifest.diagnostics.warnings.length;

  console.log("");
  console.log("BufferCore Figma build");
  console.log("────────────────────────────────");
  console.log(`Canonical source        : ${path.relative(rootDir, canonicalPath).split(path.sep).join("/")}`);
  console.log(`Flavour                 : ${manifest.flavour ? `${manifest.flavour.displayName} (${manifest.flavour.overrideCount} overrides)` : "Core baseline"}`);
  console.log(`Collections             : ${manifest.collections.length}`);
  console.log(`Variables               : ${manifest.variables.length}`);
  const textStyleCount = manifest.styles.filter((style) => style.type === "TEXT").length;
  const effectStyleCount = manifest.styles.filter((style) => style.type === "EFFECT").length;
  console.log(`Text styles             : ${textStyleCount}`);
  console.log(`Effect styles           : ${effectStyleCount}`);
  console.log(`Errors                  : ${errorCount}`);
  console.log(`Warnings                : ${warningCount}`);

  if (warningCount) {
    console.log("");
    console.log("Warnings");
    for (const warning of manifest.diagnostics.warnings.slice(0, 30)) {
      const subject = warning.token || warning.style || "";
      console.log(`- [${warning.code}] ${subject}`.trim());
    }
    if (warningCount > 30) console.log(`- …and ${warningCount - 30} more`);
  }

  if (errorCount) {
    console.log("");
    console.log("Errors");
    for (const error of manifest.diagnostics.errors.slice(0, 30)) {
      const subject = error.token || "";
      console.log(`- [${error.code}] ${subject}`.trim());
    }
    if (errorCount > 30) console.log(`- …and ${errorCount - 30} more`);
  }

  if (!validateOnly) {
    const outputDir = path.dirname(output);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log("");
    console.log(`Manifest: ${path.relative(rootDir, output).split(path.sep).join("/")}`);
  }

  console.log("");
  if (errorCount) process.exitCode = 1;
} catch (error) {
  if (!validateOnly && fs.existsSync(output)) fs.rmSync(output);
  console.error("");
  console.error("BufferCore Figma build failed");
  console.error(error?.message || String(error));
  console.error("");
  process.exitCode = 1;
}
