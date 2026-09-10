import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildFigmaManifest, validateFigmaManifest } from "../packages/figma-schema/src/index.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const figmaRoot = path.resolve(testsDir, "..");
const configPath = path.join(figmaRoot, "config", "figma", "mapping.json");

function writeCanonical(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buffercore-figma-"));
  const file = path.join(dir, "buffercore.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

function token({ id, cssVariable, layer = "primitive", foundation = "radius", path: tokenPath, valueType = "dimension", unit = "px", value = "4px", modes = {} }) {
  return {
    id,
    cssVariable,
    layer,
    foundation,
    path: tokenPath,
    groupPath: tokenPath.slice(0, -1),
    valueType,
    units: unit ? [unit] : [],
    variants: [{
      context: { modes, conditions: [] },
      rawValue: value,
      references: [],
      resolved: value,
      value: { type: valueType === "mixed" ? "string" : valueType, unit },
      source: { file: "levels/foundations/test.scss", line: 1, kind: "source" }
    }],
    platforms: {}
  };
}

function canonicalFixture(tokens, diagnostics = { errors: [], warnings: [] }) {
  return {
    schemaVersion: 3,
    system: "BufferCore",
    source: { root: "../BufferCore", foundations: "levels/foundations" },
    modeDimensions: [{ id: "colour-scheme", values: ["light", "dark"] }],
    foundations: [],
    tokens,
    diagnostics
  };
}

test("maps canonical capabilities rather than Foundation-name type tables", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "custom.space", cssVariable: "--bc-custom-space", foundation: "future-foundation", path: ["custom", "space"], valueType: "dimension", value: "1rem", unit: "rem" })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.variables[0].type, "FLOAT");
  assert.equal(manifest.variables[0].values[0].value.value, 16);
});

test("splits collections by layer and Foundation with a deterministic visual divider", () => {
  const radiusPrimitive = token({ id: "radius.sm", cssVariable: "--bc-radius-sm", path: ["radius", "sm"] });
  const radiusSemantic = token({ id: "radius.control", cssVariable: "--bc-radius-control", layer: "semantic", path: ["radius", "control"], value: "var(--bc-radius-sm)", unit: null });
  radiusSemantic.variants[0].references = ["radius.sm"];
  radiusSemantic.variants[0].resolved = "4px";
  const colourPrimitive = token({ id: "color.blue", cssVariable: "--bc-color-blue", foundation: "colour", path: ["color", "blue"], valueType: "color", value: "#0000ff", unit: null });
  const colourSemantic = token({ id: "color.text", cssVariable: "--bc-color-text", layer: "semantic", foundation: "colour", path: ["color", "text"], valueType: "color", value: "var(--bc-color-blue)", unit: null });
  colourSemantic.variants[0].references = ["color.blue"];
  colourSemantic.variants[0].resolved = "#0000ff";
  const canonicalPath = writeCanonical(canonicalFixture([radiusSemantic, colourSemantic, radiusPrimitive, colourPrimitive]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.deepEqual(manifest.collections.map(({ id, name, kind, publish }) => ({ id, name, kind, publish })), [
    { id: "semantic.colour", name: "Semantic: Colour", kind: "token", publish: true },
    { id: "semantic.radius", name: "Semantic: Radius", kind: "token", publish: true },
    { id: "divider.semantic-primitive", name: "────────────────────", kind: "divider", publish: false },
    { id: "primitive.colour", name: "Primitive: Colour", kind: "token", publish: false },
    { id: "primitive.radius", name: "Primitive: Radius", kind: "token", publish: false }
  ]);
  assert.equal(manifest.variables.find((item) => item.id === "radius.control").collectionId, "semantic.radius");
  assert.equal(manifest.variables.find((item) => item.id === "radius.sm").collectionId, "primitive.radius");
});

test("number tokens with opacity intent receive the Figma OPACITY scope", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "overlay.opacity", cssVariable: "--bc-overlay-opacity", foundation: "effects", path: ["overlay", "opacity"], valueType: "number", value: "80", unit: null })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.deepEqual(manifest.variables[0].scopes, ["OPACITY"]);
});

test("carries arbitrary canonical mode dimensions without hard-coding Light/Dark", () => {
  const primitive = token({ id: "size.base", cssVariable: "--bc-size-base", layer: "primitive", foundation: "sizing", path: ["size", "base"] });
  const semantic = token({ id: "size.control", cssVariable: "--bc-size-control", layer: "semantic", foundation: "sizing", path: ["size", "control"], modes: { viewport: "medium" }, value: "var(--bc-size-base)", unit: null });
  semantic.variants[0].references = ["size.base"];
  semantic.variants[0].resolved = "4px";
  const fixture = canonicalFixture([primitive, semantic]);
  fixture.modeDimensions = [{ id: "viewport", values: ["small", "medium", "large"] }];
  const canonicalPath = writeCanonical(fixture);
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.modeDimensions[0].id, "viewport");
  assert.deepEqual(manifest.variables[0].values[0].context.modes, { viewport: "medium" });
});

test("preserves aliases as canonical token references", () => {
  const primitive = token({ id: "radius.sm", cssVariable: "--bc-radius-sm", path: ["radius", "sm"] });
  const semantic = token({ id: "radius.control", cssVariable: "--bc-radius-control", layer: "semantic", path: ["radius", "control"] });
  semantic.variants[0].rawValue = "var(--bc-radius-sm)";
  semantic.variants[0].resolved = "4px";
  semantic.variants[0].references = ["radius.sm"];
  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const value = manifest.variables.find((item) => item.id === "radius.control").values[0].value;
  assert.deepEqual(value, { kind: "alias", tokenId: "radius.sm" });
});

test("generates Figma-ready blur Effect Styles", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "blur.soft", cssVariable: "--bc-blur-soft", layer: "semantic", foundation: "effects", path: ["blur", "soft"], valueType: "string", value: "blur(6px)", unit: null })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const style = manifest.styles.find((item) => item.type === "EFFECT");
  assert.equal(style.effectType, "BACKGROUND_BLUR");
  assert.equal(style.effects[0].radius, 6);
});

test("manifest contract validation catches broken collection references", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "radius.sm", cssVariable: "--bc-radius-sm", path: ["radius", "sm"] })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  manifest.variables[0].collectionId = "missing";
  assert.ok(validateFigmaManifest(manifest).some((message) => message.includes("Unknown collection")));
});

test("rejects canonical manifests with Engine errors", () => {
  const canonicalPath = writeCanonical(canonicalFixture([], { errors: [{ code: "broken-reference" }], warnings: [] }));
  assert.throws(() => buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath }), /contains 1 error\(s\)/);
});

test("collection sort metadata enforces Semantic → divider → Primitive without changing visible labels", () => {
  const colourPrimitive = token({ id: "color.neutral.100", cssVariable: "--bc-color-neutral-100", layer: "primitive", foundation: "colour", path: ["color", "neutral", "100"], valueType: "color", value: "#000000", unit: null });
  const colourSemantic = token({ id: "color.text.default", cssVariable: "--bc-color-text-default", layer: "semantic", foundation: "colour", path: ["color", "text", "default"], valueType: "color", value: "var(--bc-color-neutral-100)", unit: null });
  colourSemantic.variants[0].references = ["color.neutral.100"];
  colourSemantic.variants[0].resolved = "#000000";
  const typePrimitive = token({ id: "type.size.16", cssVariable: "--bc-type-size-16", layer: "primitive", foundation: "typography", path: ["type", "size", "16"] });
  const typeSemantic = token({ id: "type.paragraph.1.font.size", cssVariable: "--bc-type-paragraph-1-font-size", layer: "semantic", foundation: "typography", path: ["type", "paragraph", "1", "font", "size"], value: "var(--bc-type-size-16)", unit: null });
  typeSemantic.variants[0].references = ["type.size.16"];
  typeSemantic.variants[0].resolved = "4px";
  const canonicalPath = writeCanonical(canonicalFixture([colourSemantic, typeSemantic, colourPrimitive, typePrimitive]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.deepEqual(manifest.collections.map((item) => item.name), [
    "Semantic: Colour",
    "Semantic: Typography",
    "────────────────────",
    "Primitive: Colour",
    "Primitive: Typography"
  ]);
  assert.deepEqual(manifest.collections.map((item) => item.sortRank), [1, 2, 3, 4, 5]);
  assert.ok(manifest.collections.every((item) => item.figmaName.trimStart() === item.name));
  const leadingSpaces = (value) => value.length - value.trimStart().length;
  assert.ok(leadingSpaces(manifest.collections[0].figmaName) > leadingSpaces(manifest.collections[1].figmaName));
  assert.ok(leadingSpaces(manifest.collections[2].figmaName) > leadingSpaces(manifest.collections[3].figmaName));
});

test("materialises semantic layered shadows as Figma Effect Styles instead of deferred warnings", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({
      id: "shadow.medium.resting",
      cssVariable: "--bc-shadow-medium-resting",
      layer: "semantic",
      foundation: "shadows",
      path: ["shadow", "medium", "resting"],
      valueType: "composite",
      value: "0.6px 0.7px 0.8px 0 rgba(from #000000 r g b / 0.65), 2.4px 2.8px 3.3px -2px rgba(from #000000 r g b / 0.49)",
      unit: null
    })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const style = manifest.styles.find((item) => item.id === "effect.shadow.medium.resting");
  assert.equal(style.type, "EFFECT");
  assert.equal(style.effects.length, 2);
  assert.deepEqual(style.effects[0].offset, { x: 0.6, y: 0.7 });
  assert.equal(style.effects[0].radius, 0.8);
  assert.equal(style.effects[0].spread, 0);
  assert.equal(style.effects[0].color.a, 0.65);
  assert.equal(style.name, "Shadow / Medium / Resting");
  assert.ok(!manifest.diagnostics.warnings.some((item) => item.code === "figma-shadow-style-deferred"));
});


test("treats intentionally unset colour tokens as COLOR capabilities", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({
      id: "color.neutral.100",
      cssVariable: "--bc-color-neutral-100",
      layer: "primitive",
      foundation: "colour",
      path: ["color", "neutral", "100"],
      valueType: "string",
      value: "initial",
      unit: null
    })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const variable = manifest.variables.find((item) => item.id === "color.neutral.100");
  assert.equal(variable.type, "COLOR");
});

test("materialises unset-colour shadow recipes with a canonical colour binding", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({
      id: "shadow.medium.resting",
      cssVariable: "--bc-shadow-medium-resting",
      layer: "semantic",
      foundation: "shadows",
      path: ["shadow", "medium", "resting"],
      valueType: "composite",
      value: "0.6px 0.7px 0.8px 0 rgba(from initial r g b/0.65), 2.4px 2.8px 3.3px -2px rgba(from initial r g b/0.49)",
      unit: null
    })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const style = manifest.styles.find((item) => item.id === "effect.shadow.medium.resting");
  assert.equal(style.effects.length, 2);
  assert.equal(style.effects[0].colorTokenId, "--bc-color-shadow");
  assert.equal(style.effects[0].color.a, 0.65);
  assert.ok(!manifest.diagnostics.warnings.some((item) => item.code === "figma-shadow-style-unresolved"));
});





test("inherits Figma variable types through aliases", () => {
  const primitive = token({ id: "type.weight.700", cssVariable: "--bc-type-weight-700", foundation: "typography", path: ["type", "weight", "700"], valueType: "number", value: "700", unit: null });
  const semantic = token({ id: "type.heading.1.font.weight", cssVariable: "--bc-type-heading-1-font-weight", layer: "semantic", foundation: "typography", path: ["type", "heading", "1", "font-weight"], valueType: "string", value: "var(--bc-type-weight-700)", unit: null });
  semantic.variants[0].references = ["type.weight.700"];
  semantic.variants[0].resolved = "700";
  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.variables.find((item) => item.id === semantic.id).type, "FLOAT");
});

test("samples fluid typography into Small Medium Large Figma viewport modes", () => {
  const primitive = token({ id: "type.size.16", cssVariable: "--bc-type-size-16", foundation: "typography", path: ["type", "size", "16"], valueType: "expression", value: "clamp(2.75rem, -1.25rem + 13.3333vw, 8.75rem)", unit: null });
  const semantic = token({ id: "type.display.1.font.size", cssVariable: "--bc-type-display-1-font-size", layer: "semantic", foundation: "typography", path: ["type", "display", "1", "font-size"], valueType: "string", value: "var(--bc-type-size-16)", unit: null });
  semantic.variants[0].references = ["type.size.16"];
  semantic.variants[0].resolved = "clamp(2.75rem, -1.25rem + 13.3333vw, 8.75rem)";
  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const collection = manifest.collections.find((item) => item.id === "primitive.typography");
  assert.deepEqual(collection.modeDimensions.map((item) => item.id), ["viewport"]);
  const variable = manifest.variables.find((item) => item.id === "type.size.16");
  assert.equal(variable.type, "FLOAT");
  assert.deepEqual(variable.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
  assert.deepEqual(variable.values.map((item) => item.value.value), [44, 92, 140]);
  const semanticVariable = manifest.variables.find((item) => item.id === semantic.id);
  assert.equal(semanticVariable.type, "FLOAT");
  assert.deepEqual(semanticVariable.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
});

test("converts CSS font stacks to a Figma font family literal", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "type.font.family.primary", cssVariable: "--bc-type-font-family-primary", foundation: "typography", path: ["type", "font-family", "primary"], valueType: "string", value: '"Parkinsans", sans-serif', unit: null })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.variables[0].values[0].value.value, "Parkinsans");
});

test("semantic aliases are flattened to their primitive Figma source", () => {
  const primitive = token({ id: "radius.sm", cssVariable: "--bc-radius-sm", layer: "primitive", foundation: "radius", path: ["radius", "sm"], valueType: "dimension", value: "4px", unit: "px" });
  const semanticBase = token({ id: "radius.control", cssVariable: "--bc-radius-control", layer: "semantic", foundation: "radius", path: ["radius", "control"], valueType: "dimension", value: "var(--bc-radius-sm)", unit: null });
  semanticBase.variants[0].references = ["radius.sm"];
  semanticBase.variants[0].resolved = "4px";
  const semanticAlias = token({ id: "radius.input", cssVariable: "--bc-radius-input", layer: "semantic", foundation: "radius", path: ["radius", "input"], valueType: "dimension", value: "var(--bc-radius-control)", unit: null });
  semanticAlias.variants[0].references = ["radius.control"];
  semanticAlias.variants[0].resolved = "4px";
  const canonicalPath = writeCanonical(canonicalFixture([primitive, semanticBase, semanticAlias]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const value = manifest.variables.find((item) => item.id === "radius.input").values[0].value;
  assert.deepEqual(value, { kind: "alias", tokenId: "radius.sm" });
});

test("every generated Figma variable carries WEB var(--token) code syntax", () => {
  const primitive = token({ id: "radius.sm", cssVariable: "--bc-radius-sm", layer: "primitive", foundation: "radius", path: ["radius", "sm"], valueType: "dimension", value: "4px", unit: "px" });
  const canonicalPath = writeCanonical(canonicalFixture([primitive]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const variable = manifest.variables.find((item) => item.id === "radius.sm");
  assert.deepEqual(variable.codeSyntax, { WEB: "var(--bc-radius-sm)" });
});

test("semantic runtime hooks and composite recipes are not emitted as broken Figma variables", () => {
  const primitive = token({ id: "type.size.16", cssVariable: "--bc-type-size-16", layer: "primitive", foundation: "typography", path: ["type", "size", "16"], valueType: "dimension", value: "1rem", unit: "rem" });
  const role = token({ id: "type.paragraph.2.font.size", cssVariable: "--bc-type-paragraph-2-font-size", layer: "semantic", foundation: "typography", path: ["type", "paragraph", "2", "font", "size"], valueType: "dimension", value: "var(--bc-type-size-16)", unit: null });
  role.variants[0].references = ["type.size.16"];
  role.variants[0].resolved = "1rem";
  const contextHook = token({ id: "type.context.font.size", cssVariable: "--bc-type-context-font-size", layer: "semantic", foundation: "typography", path: ["type", "context", "font", "size"], valueType: "string", value: "initial", unit: null });
  const composite = token({ id: "motion.feedback", cssVariable: "--bc-motion-feedback", layer: "semantic", foundation: "motion", path: ["motion", "feedback"], valueType: "composite", value: "var(--bc-motion-duration-120) var(--bc-motion-easing-standard)", unit: null });
  composite.variants[0].references = ["motion.duration.120", "motion.easing.standard"];

  const canonicalPath = writeCanonical(canonicalFixture([primitive, role, contextHook, composite]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  assert.ok(manifest.variables.some((item) => item.id === "type.paragraph.2.font.size"));
  assert.ok(!manifest.variables.some((item) => item.id === "type.context.font.size"));
  assert.ok(!manifest.variables.some((item) => item.id === "motion.feedback"));
  assert.ok(manifest.retiredVariables.some((item) => item.id === "type.context.font.size" && item.reason === "runtime-hook"));
  assert.ok(manifest.retiredVariables.some((item) => item.id === "motion.feedback" && item.reason === "composite"));
});

test("every emitted semantic Figma variable aliases through to a Primitive", () => {
  const primitive = token({ id: "radius.sm", cssVariable: "--bc-radius-sm", layer: "primitive", foundation: "radius", path: ["radius", "sm"], valueType: "dimension", value: "4px", unit: "px" });
  const semantic = token({ id: "radius.control", cssVariable: "--bc-radius-control", layer: "semantic", foundation: "radius", path: ["radius", "control"], valueType: "dimension", value: "var(--bc-radius-sm)", unit: null });
  semantic.variants[0].references = ["radius.sm"];
  semantic.variants[0].resolved = "4px";
  const literalSemantic = token({ id: "radius.bad", cssVariable: "--bc-radius-bad", layer: "semantic", foundation: "radius", path: ["radius", "bad"], valueType: "dimension", value: "7px", unit: "px" });

  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic, literalSemantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const semanticVariables = manifest.variables.filter((item) => item.layer === "semantic");

  assert.equal(semanticVariables.length, 1);
  assert.deepEqual(semanticVariables[0].values[0].value, { kind: "alias", tokenId: "radius.sm" });
  assert.ok(manifest.retiredVariables.some((item) => item.id === "radius.bad" && item.reason === "non-alias-semantic"));
});

test("Figma presentation IA flattens semantic typography into role level property", () => {
  const primitive = token({ id: "type.size.16", cssVariable: "--bc-type-size-16", layer: "primitive", foundation: "typography", path: ["type", "size", "16"], valueType: "dimension", value: "1rem", unit: "rem" });
  const semantic = token({ id: "type.display.1.font.size", cssVariable: "--bc-type-display-1-font-size", layer: "semantic", foundation: "typography", path: ["type", "display", "1", "font", "size"], valueType: "dimension", value: "var(--bc-type-size-16)", unit: null });
  semantic.variants[0].references = ["type.size.16"];
  semantic.variants[0].resolved = "1rem";
  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const variable = manifest.variables.find((item) => item.id === semantic.id);
  assert.equal(variable.name, "Display / 1 / Size");
  assert.match(variable.figmaName, /Display\s*\/.*1\s*\/.*Size$/);
});

test("Figma presentation IA groups semantic interaction colours together", () => {
  const primitive = token({ id: "color.link.base", cssVariable: "--bc-color-link-base", layer: "primitive", foundation: "colour", path: ["color", "interaction", "link"], valueType: "color", value: "#123456", unit: null });
  const semantic = token({ id: "color.link.visited", cssVariable: "--bc-color-link-visited", layer: "semantic", foundation: "colour", path: ["color", "link", "visited"], valueType: "color", value: "var(--bc-color-link-base)", unit: null });
  semantic.variants[0].references = ["color.link.base"];
  semantic.variants[0].resolved = "#123456";
  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.variables.find((item) => item.id === semantic.id).name, "Interaction / Link / Visited");
});

test("Figma presentation IA compacts colour tones and orders tint to base to shade", () => {
  const make = (id, path, value) => token({ id, cssVariable: `--bc-${id.replaceAll('.', '-')}`, layer: "primitive", foundation: "colour", path, valueType: "color", value, unit: null });
  const tokens = [
    make("color.identity.ramp.1.shade.10", ["color", "identity", "ramp", "1", "shade", "10"], "#111111"),
    make("color.identity.ramp.1", ["color", "identity", "ramp", "1"], "#222222"),
    make("color.identity.ramp.1.tint.90", ["color", "identity", "ramp", "1", "tint", "90"], "#eeeeee")
  ];
  const canonicalPath = writeCanonical(canonicalFixture(tokens));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.deepEqual(manifest.variables.map((item) => item.name), [
    "Identity / Ramp 1 / T90",
    "Identity / Ramp 1 / Base",
    "Identity / Ramp 1 / S10"
  ]);
});

test("Figma presentation IA makes shadow primitives strength-first", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "shadow.geometry.soft.resting.1", cssVariable: "--bc-shadow-geometry-soft-resting-1", layer: "primitive", foundation: "shadows", path: ["shadow", "geometry", "soft", "resting", "1"], valueType: "string", value: "0 1px 2px", unit: null })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.variables[0].name, "Shadow / Soft / Resting / Geometry / 1");
});


test("Figma semantic colour IA prioritises common roles and groups tones last", () => {
  const primitive = token({ id: "color.neutral.50", cssVariable: "--bc-color-neutral-50", layer: "primitive", foundation: "colour", path: ["color", "neutral", "50"], valueType: "color", value: "#808080", unit: null });
  const makeSemantic = (id, path) => {
    const item = token({ id, cssVariable: `--bc-${id.replaceAll('.', '-')}`, layer: "semantic", foundation: "colour", path, valueType: "color", value: "var(--bc-color-neutral-50)", unit: null });
    item.variants[0].references = ["color.neutral.50"];
    item.variants[0].resolved = "#808080";
    return item;
  };
  const canonicalPath = writeCanonical(canonicalFixture([
    primitive,
    makeSemantic("color.primary.tint.90", ["color", "primary", "tint", "90"]),
    makeSemantic("color.fill.primary", ["color", "fill", "primary"]),
    makeSemantic("color.text.primary", ["color", "text", "primary"]),
    makeSemantic("color.border.primary", ["color", "border", "primary"]),
    makeSemantic("color.surface.general.primary", ["color", "surface", "general", "primary"]),
    makeSemantic("color.canvas.primary", ["color", "canvas", "primary"]),
    makeSemantic("color.link", ["color", "link"]),
    makeSemantic("color.secondary", ["color", "secondary"]),
    makeSemantic("color.accent", ["color", "accent"])
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const semantic = manifest.variables.filter((item) => item.layer === "semantic");
  assert.deepEqual(semantic.map((item) => item.name), [
    "Fill / Primary",
    "Text / Primary",
    "Border / Primary",
    "Surface / General / Primary",
    "Canvas / Primary",
    "Interaction / Link",
    "Tones / Primary / T90",
    "Tones / Secondary / Base",
    "Tones / Accent / Base"
  ]);
});


test("carries resolved Flavour provenance into the Figma manifest", () => {
  const canonical = canonicalFixture([
    token({ id: "radius.sm", cssVariable: "--bc-radius-sm", path: ["radius", "sm"] })
  ]);
  canonical.flavour = { id: "wallwood", displayName: "Wallwood", source: "../BufferCore-Flavours/flavours/wallwood/flavour.json", overrideCount: 12 };
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath: writeCanonical(canonical), configPath });
  assert.deepEqual(manifest.flavour, canonical.flavour);
});

test("Figma manifest identifies Baseline as a pure Core library target", () => {
  const primitive = token({ id: "colour.primary", cssVariable: "--bc-color-primary", foundation: "colour", path: ["colour", "primary"], valueType: "color", value: "#123456", unit: null });
  const canonicalPath = writeCanonical(canonicalFixture([primitive]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.library.target, "baseline");
  assert.equal(manifest.library.kind, "baseline");
  assert.equal(manifest.library.flavourOverrideCount, 0);
  assert.equal(manifest.library.inheritedPrimitiveCount, 1);
});

test("resolved Flavour manifest remains complete while marking only primitive overrides as Flavour-owned", () => {
  const overridden = token({ id: "colour.primary", cssVariable: "--bc-color-primary", foundation: "colour", path: ["colour", "primary"], valueType: "color", value: "#00aa55", unit: null });
  overridden.variants[0].source.kind = "flavour";

  const inherited = token({ id: "space.4", cssVariable: "--bc-space-4", foundation: "spacing", path: ["space", "4"], valueType: "dimension", value: "16px", unit: "px" });

  const semantic = token({ id: "colour.fill.primary", cssVariable: "--bc-color-fill-primary", layer: "semantic", foundation: "colour", path: ["colour", "fill", "primary"], valueType: "color", value: "var(--bc-color-primary)", unit: null });
  semantic.variants[0].references = ["colour.primary"];
  semantic.variants[0].resolved = "#00aa55";

  const fixture = canonicalFixture([overridden, inherited, semantic]);
  fixture.flavour = { id: "wallwood", displayName: "Wallwood", overrideCount: 1, semanticMappingCount: 0 };
  const canonicalPath = writeCanonical(fixture);
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  assert.equal(manifest.library.target, "flavour:wallwood");
  assert.equal(manifest.library.kind, "flavour");
  assert.equal(manifest.variables.length, 3);
  assert.equal(manifest.library.flavourOverrideCount, 1);
  assert.equal(manifest.library.inheritedPrimitiveCount, 1);
  assert.equal(manifest.variables.find((item) => item.id === "colour.primary").provenance.flavourOverride, true);
  assert.equal(manifest.variables.find((item) => item.id === "space.4").provenance.flavourOverride, false);
  assert.equal(manifest.variables.find((item) => item.id === "colour.fill.primary").values[0].value.kind, "alias");
});

test("Core updates flow into inherited Flavour values while Flavour-owned primitive values remain unchanged", () => {
  const flavourPrimitive = token({ id: "colour.primary", cssVariable: "--bc-color-primary", foundation: "colour", path: ["colour", "primary"], valueType: "color", value: "#00aa55", unit: null });
  flavourPrimitive.variants[0].source.kind = "flavour";
  const inheritedBefore = token({ id: "space.4", cssVariable: "--bc-space-4", foundation: "spacing", path: ["space", "4"], valueType: "dimension", value: "16px", unit: "px" });
  const inheritedAfter = structuredClone(inheritedBefore);
  inheritedAfter.variants[0].rawValue = "18px";
  inheritedAfter.variants[0].resolved = "18px";

  const base = canonicalFixture([flavourPrimitive, inheritedBefore]);
  base.flavour = { id: "wallwood", displayName: "Wallwood", overrideCount: 1, semanticMappingCount: 0 };
  const next = canonicalFixture([structuredClone(flavourPrimitive), inheritedAfter]);
  next.flavour = structuredClone(base.flavour);

  const before = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath: writeCanonical(base), configPath });
  const after = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath: writeCanonical(next), configPath });

  assert.equal(before.variables.find((item) => item.id === "colour.primary").values[0].value.value, "#00aa55");
  assert.equal(after.variables.find((item) => item.id === "colour.primary").values[0].value.value, "#00aa55");
  assert.equal(before.variables.find((item) => item.id === "space.4").values[0].value.value, 16);
  assert.equal(after.variables.find((item) => item.id === "space.4").values[0].value.value, 18);
});
