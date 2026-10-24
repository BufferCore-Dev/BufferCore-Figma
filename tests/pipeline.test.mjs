import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildFigmaManifest, validateFigmaManifest, disambiguateFigmaHierarchyLeaves } from "../packages/figma-schema/src/index.mjs";

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

test("primitive variables are hidden from Figma pickers and publishing", () => {
  const canonicalPath = writeCanonical(canonicalFixture([
    token({ id: "opacity.80", cssVariable: "--bc-opacity-80", foundation: "effects", path: ["opacity", "80"], valueType: "number", value: "0.8", unit: null })
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.deepEqual(manifest.variables[0].scopes, []);
  assert.equal(manifest.variables[0].publish, false);
  assert.equal(manifest.collections[0].publish, false);
});

test("semantic variables use purpose-led Figma picker scopes", () => {
  const colourPrimitive = token({ id: "color.brand", cssVariable: "--bc-color-brand", foundation: "colour", path: ["color", "brand"], valueType: "color", value: "#6633ff", unit: null });
  const dimensionPrimitive = token({ id: "size.16", cssVariable: "--bc-size-16", foundation: "sizing", path: ["size", "16"], valueType: "dimension", value: "16px", unit: "px" });

  const specs = [
    ["color.text.primary", "--bc-color-text-primary", "colour", ["color", "text", "primary"], "color", colourPrimitive, ["ALL_FILLS", "STROKE_COLOR"]],
    ["color.fill.primary", "--bc-color-fill-primary", "colour", ["color", "fill", "primary"], "color", colourPrimitive, ["FRAME_FILL", "SHAPE_FILL"]],
    ["color.border.primary", "--bc-color-border-primary", "colour", ["color", "border", "primary"], "color", colourPrimitive, ["STROKE_COLOR"]],
    ["radius.control", "--bc-radius-control", "radius", ["radius", "control"], "dimension", dimensionPrimitive, ["CORNER_RADIUS"]],
    ["size.control", "--bc-size-control", "sizing", ["size", "control"], "dimension", dimensionPrimitive, ["WIDTH_HEIGHT", "GAP"]]
  ];

  const semantics = specs.map(([id, cssVariable, foundation, tokenPath, valueType, primitive]) => {
    const item = token({ id, cssVariable, layer: "semantic", foundation, path: tokenPath, valueType, value: `var(${primitive.cssVariable})`, unit: null });
    item.variants[0].references = [primitive.id];
    item.variants[0].resolved = primitive.variants[0].resolved;
    return item;
  });

  const canonicalPath = writeCanonical(canonicalFixture([...semantics, colourPrimitive, dimensionPrimitive]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  for (const [id,,,,,, expectedScopes] of specs) {
    const variable = manifest.variables.find((item) => item.id === id);
    assert.ok(variable, `missing ${id}`);
    assert.deepEqual(variable.scopes, expectedScopes, id);
    assert.equal(variable.publish, true, id);
  }
  for (const primitive of manifest.variables.filter((item) => item.layer === "primitive")) {
    assert.deepEqual(primitive.scopes, [], primitive.id);
    assert.equal(primitive.publish, false, primitive.id);
  }
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


test("samples BufferCore fluid spacing into Small Medium Large Figma modes", () => {
  const primitive = token({
    id: "size.fluid.md",
    cssVariable: "--bc-size-fluid-md",
    foundation: "spacing",
    path: ["size", "fluid", "md"],
    valueType: "expression",
    value: "clamp(2rem, calc(2rem + ((1vw - 0.3rem) * 1.1111)), 2.5rem)",
    unit: null
  });
  const semantic = token({
    id: "fluid.md",
    cssVariable: "--bc-fluid-md",
    layer: "semantic",
    foundation: "spacing",
    path: ["fluid", "md"],
    valueType: "expression",
    value: "var(--bc-size-fluid-md)",
    unit: null
  });
  semantic.variants[0].references = ["size.fluid.md"];
  semantic.variants[0].resolved = "clamp(2rem, calc(2rem + ((1vw - 0.3rem) * 1.1111)), 2.5rem)";

  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  const primitiveCollection = manifest.collections.find((item) => item.id === "primitive.spacing");
  const semanticCollection = manifest.collections.find((item) => item.id === "semantic.spacing");
  assert.deepEqual(primitiveCollection.modeDimensions.map((item) => item.id), ["viewport"]);
  assert.deepEqual(semanticCollection.modeDimensions.map((item) => item.id), ["viewport"]);

  const primitiveVariable = manifest.variables.find((item) => item.id === "size.fluid.md");
  assert.equal(primitiveVariable.type, "FLOAT");
  assert.deepEqual(primitiveVariable.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
  assert.deepEqual(primitiveVariable.values.map((item) => item.value.value), [32, 36, 40]);

  const semanticVariable = manifest.variables.find((item) => item.id === "fluid.md");
  assert.equal(semanticVariable.type, "FLOAT");
  assert.deepEqual(semanticVariable.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
  assert.ok(semanticVariable.values.every((item) => item.value.kind === "alias" && item.value.tokenId === "size.fluid.md"));
});

test("samples 3XS fluid spacing into Small Medium Large Figma modes", () => {
  const primitive = token({
    id: "size.fluid.3xs",
    cssVariable: "--bc-size-fluid-3xs",
    foundation: "spacing",
    path: ["size", "fluid", "3xs"],
    valueType: "expression",
    value: "clamp(0.25rem, calc(0.25rem + ((1vw - 0.3rem) * 0.5556)), 0.5rem)",
    unit: null
  });
  const semantic = token({
    id: "fluid.3xs",
    cssVariable: "--bc-fluid-3xs",
    layer: "semantic",
    foundation: "spacing",
    path: ["fluid", "3xs"],
    valueType: "expression",
    value: "var(--bc-size-fluid-3xs)",
    unit: null
  });
  semantic.variants[0].references = ["size.fluid.3xs"];
  semantic.variants[0].resolved = "clamp(0.25rem, calc(0.25rem + ((1vw - 0.3rem) * 0.5556)), 0.5rem)";

  const canonicalPath = writeCanonical(canonicalFixture([primitive, semantic]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const primitiveVariable = manifest.variables.find((item) => item.id === "size.fluid.3xs");
  assert.deepEqual(primitiveVariable.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
  assert.deepEqual(primitiveVariable.values.map((item) => item.value.value), [4, 6, 8]);
  const semanticVariable = manifest.variables.find((item) => item.id === "fluid.3xs");
  assert.deepEqual(semanticVariable.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
  assert.ok(semanticVariable.values.every((item) => item.value.kind === "alias" && item.value.tokenId === "size.fluid.3xs"));
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

test("Figma semantic colour IA stays shallow and avoids redundant Base hierarchy leaves", () => {
  const primitive = token({ id: "color.neutral.50", cssVariable: "--bc-color-neutral-50", layer: "primitive", foundation: "colour", path: ["color", "neutral", "50"], valueType: "color", value: "#808080", unit: null });
  const makeSemantic = (id, tokenPath) => {
    const item = token({ id, cssVariable: `--bc-${id.replaceAll('.', '-')}`, layer: "semantic", foundation: "colour", path: tokenPath, valueType: "color", value: "var(--bc-color-neutral-50)", unit: null });
    item.variants[0].references = [primitive.id];
    item.variants[0].resolved = "#808080";
    return item;
  };
  const canonicalPath = writeCanonical(canonicalFixture([
    primitive,
    makeSemantic("color.text", ["color", "text"]),
    makeSemantic("color.text.primary", ["color", "text", "primary"]),
    makeSemantic("color.text.primary.strong", ["color", "text", "primary", "strong"]),
    makeSemantic("color.text.primary.strong.inverse", ["color", "text", "primary", "strong", "inverse"]),
    makeSemantic("color.fill.primary", ["color", "fill", "primary"]),
    makeSemantic("color.fill.primary.strong", ["color", "fill", "primary", "strong"]),
    makeSemantic("color.surface.general.primary.strong", ["color", "surface", "general", "primary", "strong"]),
    makeSemantic("color.link.visited.inverse", ["color", "link", "visited", "inverse"])
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const names = Object.fromEntries(manifest.variables.filter((item) => item.layer === "semantic").map((item) => [item.id, item.name]));

  assert.equal(names["color.text"], "Text / Neutral / Base");
  assert.equal(names["color.text.primary"], "Text / Primary / Base");
  assert.equal(names["color.text.primary.strong"], "Text / Primary / Strong");
  assert.equal(names["color.text.primary.strong.inverse"], "Text / Primary / Strong Inverse");
  assert.equal(names["color.fill.primary"], "Fill / Primary / Base");
  assert.equal(names["color.fill.primary.strong"], "Fill / Primary / Strong");
  assert.equal(names["color.surface.general.primary.strong"], "Surface / General / Primary / Strong");
  assert.equal(names["color.link.visited.inverse"], "Interaction / Link / Visited Inverse");
  assert.ok(Object.values(names).every((name) => !name.includes(" / Strong / Base")));
});



test("Figma primitive colour IA preserves dark ramp qualifiers and all emitted names stay unique per collection", () => {
  const makePrimitive = (id, tokenPath) => token({
    id,
    cssVariable: `--bc-${id.replaceAll('.', '-')}`,
    layer: "primitive",
    foundation: "colour",
    path: tokenPath,
    valueType: "color",
    value: "#808080",
    unit: null
  });
  const canonicalPath = writeCanonical(canonicalFixture([
    makePrimitive("color.ground.ramp.1.tint.90", ["color", "ground", "ramp", "1", "tint", "90"]),
    makePrimitive("color.ground.dark.ramp.1.tint.90", ["color", "ground", "dark", "ramp", "1", "tint", "90"]),
    makePrimitive("color.ground.ramp.1", ["color", "ground", "ramp", "1"]),
    makePrimitive("color.ground.dark.ramp.1", ["color", "ground", "dark", "ramp", "1"])
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const byId = Object.fromEntries(manifest.variables.map((item) => [item.id, item.name]));

  assert.equal(byId["color.ground.ramp.1.tint.90"], "Ground / Ramp 1 / T90");
  assert.equal(byId["color.ground.dark.ramp.1.tint.90"], "Ground / Dark / Ramp 1 / T90");
  assert.equal(byId["color.ground.ramp.1"], "Ground / Ramp 1 / Base");
  assert.equal(byId["color.ground.dark.ramp.1"], "Ground / Dark / Ramp 1 / Base");

  const seen = new Set();
  for (const variable of manifest.variables) {
    const key = `${variable.collectionId}|${variable.figmaName || variable.name}`;
    assert.equal(seen.has(key), false, `duplicate Figma variable name: ${key}`);
    seen.add(key);
  }
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
    "Fill / Primary / Base",
    "Border / Primary / Base",
    "Surface / General / Primary / Base",
    "Canvas / Primary",
    "Interaction / Link / Base",
    "Tones / Primary / T90",
    "Tones / Secondary / Base",
    "Tones / Accent / Base",
    "Text / Primary / Base"
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


test("Figma manifest preserves Context contracts and resolved Flavour Extensions", () => {
  const canonical = canonicalFixture([
    token({ id: "color.fill.context", cssVariable: "--bc-color-fill-context", layer: "semantic", foundation: "colour", path: ["color", "fill", "context"], valueType: "color", value: "#123456", unit: null }),
    token({ id: "color.fill.timber", cssVariable: "--bc-color-fill-timber", layer: "semantic", foundation: "colour", path: ["color", "fill", "timber"], valueType: "color", value: "#654321", unit: null })
  ]);
  canonical.contextContracts = {
    schemaVersion: 1,
    source: "levels/foundations/utilities/_index.scss",
    domains: {
      colour: {
        slots: { "--bc-color-fill-context": { id: "color.fill.context", cssVariable: "--bc-color-fill-context", foundation: "colour", valueType: "color" } },
        targets: {}, slotCount: 1, targetCount: 0
      }
    },
    diagnostics: []
  };
  canonical.flavour = {
    id: "wood",
    displayName: "Wood",
    source: "../BufferCore-Flavours/flavours/wood/flavour.json",
    overrideCount: 0,
    semanticMappingCount: 0,
    extensionCount: 1,
    extensions: [{
      id: "timber",
      label: "Timber",
      description: "",
      domains: ["colour"],
      mappingCount: 1,
      mappings: [{
        domain: "colour",
        foundation: "colour",
        context: { id: "color.fill.context", cssVariable: "--bc-color-fill-context" },
        target: { id: "color.fill.timber", cssVariable: "--bc-color-fill-timber" }
      }]
    }]
  };

  const canonicalPath = writeCanonical(canonical);
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  assert.equal(manifest.contextContracts.domains.colour.slotCount, 1);
  assert.equal(manifest.flavour.extensionCount, 1);
  assert.equal(manifest.flavour.extensions[0].id, "timber");
  assert.equal(validateFigmaManifest(manifest).length, 0);
});


test("Disabled Interaction opacity projects as a semantic OPACITY variable", () => {
  const primitive = token({
    id: "opacity.45",
    cssVariable: "--bc-opacity-45",
    foundation: "effects",
    path: ["opacity", "45"],
    valueType: "number",
    value: "0.45",
    unit: null
  });
  const disabled = token({
    id: "interaction.disabled.opacity",
    cssVariable: "--bc-interaction-disabled-opacity",
    layer: "semantic",
    foundation: "interaction",
    path: ["interaction", "disabled", "opacity"],
    valueType: "number",
    value: "var(--bc-opacity-45)",
    unit: null
  });
  disabled.variants[0].references = ["opacity.45"];
  disabled.variants[0].resolved = "0.45";

  const canonicalPath = writeCanonical(canonicalFixture([disabled, primitive]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  const variable = manifest.variables.find((item) => item.id === disabled.id);
  assert.ok(variable);
  assert.equal(variable.collectionId, "semantic.interaction");
  assert.equal(variable.name, "Disabled / Opacity");
  assert.deepEqual(variable.scopes, ["OPACITY"]);
  assert.deepEqual(variable.values[0].value, { kind: "alias", tokenId: "opacity.45" });

  const primitiveVariable = manifest.variables.find((item) => item.id === primitive.id);
  assert.equal(primitiveVariable.name, "Opacity / 45");
});

test("Colour presentation no longer defines a Disabled colour family", () => {
  const source = fs.readFileSync(new URL("../packages/figma-schema/src/index.mjs", import.meta.url), "utf8");
  assert.equal(source.includes('["disabled", "focus", "link", "placeholder"]'), false);
});


test("Figma carries explicit Context projections for Colour, Typography and Shadows", (t) => {
  const engineManifest = path.resolve(figmaRoot, "../BufferCore-Engine/generated/manifest/buffercore.json");
  if (!fs.existsSync(engineManifest)) return t.skip("BufferCore-Engine sibling manifest is not present in this standalone Figma checkout.");
  const canonical = JSON.parse(fs.readFileSync(engineManifest, "utf8"));
  const canonicalPath = writeCanonical(canonical);
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  assert.equal(manifest.contextProjections.colour.representation, "variables");
  assert.equal(manifest.contextProjections.colour.slotCount, 15);
  assert.equal(Object.keys(manifest.contextProjections.colour.targets).length, 8);

  assert.equal(manifest.contextProjections.typography.representation, "text-styles");
  assert.equal(Object.keys(manifest.contextProjections.typography.targets).length, 22);
  assert.ok(Object.values(manifest.contextProjections.typography.targets).every((item) => item.available));

  assert.equal(manifest.contextProjections.shadows.representation, "effect-styles");
  assert.equal(manifest.contextProjections.shadows.slotCount, 3);
  assert.equal(Object.keys(manifest.contextProjections.shadows.targets).length, 3);
  assert.ok(Object.values(manifest.contextProjections.shadows.targets)
    .flatMap((target) => Object.values(target.styles))
    .every((item) => item.available));
});

test("Figma publishes Disabled as a required OPACITY interaction-state projection", (t) => {
  const engineManifest = path.resolve(figmaRoot, "../BufferCore-Engine/generated/manifest/buffercore.json");
  if (!fs.existsSync(engineManifest)) return t.skip("BufferCore-Engine sibling manifest is not present in this standalone Figma checkout.");
  const canonical = JSON.parse(fs.readFileSync(engineManifest, "utf8"));
  const canonicalPath = writeCanonical(canonical);
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  assert.equal(manifest.interactionStates.disabled.available, true);
  assert.equal(manifest.interactionStates.disabled.representation, "variable");
  assert.ok(manifest.interactionStates.disabled.scopes.includes("OPACITY"));
  assert.equal(manifest.interactionStates.disabled.variableId, "interaction.disabled.opacity");
});

test("dedicated Dark Ground and direct Canvas aliases survive the Figma projection", () => {
  const lightGround = token({
    id: "color.ground.ramp.1",
    cssVariable: "--bc-color-ground-ramp-1",
    foundation: "colour",
    path: ["color", "ground", "ramp", "1"],
    valueType: "color",
    value: "#faf7f2",
    unit: null
  });
  const darkGround = token({
    id: "color.ground.dark.ramp.1",
    cssVariable: "--bc-color-ground-dark-ramp-1",
    foundation: "colour",
    path: ["color", "ground", "dark", "ramp", "1"],
    valueType: "color",
    value: "#00002a",
    unit: null
  });
  const canvas = token({
    id: "color.canvas.primary",
    cssVariable: "--bc-color-canvas-primary",
    layer: "semantic",
    foundation: "colour",
    path: ["color", "canvas", "primary"],
    valueType: "color",
    value: "var(--bc-color-ground-ramp-1)",
    unit: null,
    modes: { "colour-scheme": "light" }
  });
  canvas.variants[0].references = [lightGround.id];
  canvas.variants[0].resolved = "#faf7f2";
  canvas.variants.push({
    ...canvas.variants[0],
    context: { modes: { "colour-scheme": "dark" }, conditions: [] },
    rawValue: "var(--bc-color-ground-dark-ramp-1)",
    references: [darkGround.id],
    resolved: "#00002a"
  });

  const canonicalPath = writeCanonical(canonicalFixture([canvas, lightGround, darkGround]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });

  assert.ok(manifest.variables.some((item) => item.id === darkGround.id));
  const projected = manifest.variables.find((item) => item.id === canvas.id);
  assert.ok(projected);
  const light = projected.values.find((item) => item.context.modes["colour-scheme"] === "light");
  const dark = projected.values.find((item) => item.context.modes["colour-scheme"] === "dark");
  assert.deepEqual(light.value, { kind: "alias", tokenId: lightGround.id });
  assert.deepEqual(dark.value, { kind: "alias", tokenId: darkGround.id });
});


test('Figma projection disambiguates hierarchy leaves with Base', () => {
  const variables = [
    { collectionId: 'semantic-colour', id: 'fill.neutral', name: 'Fill / Neutral', figmaName: 'Fill / Neutral' },
    { collectionId: 'semantic-colour', id: 'fill.neutral.strong', name: 'Fill / Neutral / Strong', figmaName: 'Fill / Neutral / Strong' },
    { collectionId: 'semantic-colour', id: 'text', name: 'Text', figmaName: 'Text' },
    { collectionId: 'semantic-colour', id: 'text.primary', name: 'Text / Primary', figmaName: 'Text / Primary' }
  ];
  disambiguateFigmaHierarchyLeaves(variables);
  assert.equal(variables[0].name, 'Fill / Neutral / Base');
  assert.equal(variables[1].name, 'Fill / Neutral / Strong');
  assert.equal(variables[2].name, 'Text / Base');
  assert.equal(variables[3].name, 'Text / Primary');
});


test("projects border widths, blur radii and container gutters to compatible Figma FLOAT scopes", () => {
  const tokens = [
    token({ id: "stroke.width.1", cssVariable: "--bc-stroke-width-1", layer: "primitive", foundation: "stroke", path: ["stroke", "width", "1"], valueType: "dimension", value: "1px", unit: "px" }),
    token({ id: "border.width.xs", cssVariable: "--bc-border-width-xs", layer: "semantic", foundation: "borders", path: ["border", "width", "xs"], valueType: "dimension", value: "var(--bc-stroke-width-1)", unit: null }),
    token({ id: "blur.6", cssVariable: "--bc-blur-6", layer: "primitive", foundation: "effects", path: ["blur", "6"], valueType: "string", value: "blur(6px)", unit: null }),
    token({ id: "blur.soft", cssVariable: "--bc-blur-soft", layer: "semantic", foundation: "effects", path: ["blur", "soft"], valueType: "string", value: "var(--bc-blur-6)", unit: null }),
    token({ id: "container.space.sm", cssVariable: "--bc-container-space-sm", layer: "primitive", foundation: "containers", path: ["container", "space", "sm"], valueType: "expression", value: "clamp(1rem, 3vw, 2rem)", unit: null }),
    token({ id: "container.gutter.sm", cssVariable: "--bc-container-gutter-sm", layer: "semantic", foundation: "containers", path: ["container", "gutter", "sm"], valueType: "expression", value: "var(--bc-container-space-sm)", unit: null })
  ];
  tokens[1].variants[0].references = ["stroke.width.1"];
  tokens[3].variants[0].references = ["blur.6"];
  tokens[5].variants[0].references = ["container.space.sm"];
  const fixture = canonicalFixture(tokens);
  const canonicalPath = writeCanonical(fixture);
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const border = manifest.variables.find((item) => item.id === "border.width.xs");
  const blur = manifest.variables.find((item) => item.id === "blur.soft");
  const gutter = manifest.variables.find((item) => item.id === "container.gutter.sm");
  assert.equal(border.type, "FLOAT");
  assert.deepEqual(border.scopes, ["STROKE_FLOAT"]);
  assert.equal(blur.type, "FLOAT");
  assert.deepEqual(blur.scopes, ["EFFECT_FLOAT"]);
  assert.equal(gutter.type, "FLOAT");
  assert.deepEqual(gutter.scopes, ["GAP"]);
  assert.deepEqual(gutter.values.map((item) => item.context.modes.viewport), ["small", "medium", "large"]);
});


test("text styles use standard vertical trim while mirroring CSS line-height ratios", () => {
  const tokens = [
    token({ id: "type.heading.1.font.family", cssVariable: "--bc-type-heading-1-font-family", layer: "semantic", foundation: "typography", path: ["type", "heading", "1", "font", "family"], valueType: "string", value: "Parkinsans", unit: null }),
    token({ id: "type.heading.1.font.size", cssVariable: "--bc-type-heading-1-font-size", layer: "semantic", foundation: "typography", path: ["type", "heading", "1", "font", "size"], valueType: "dimension", value: "32px", unit: "px" }),
    token({ id: "type.heading.1.font.weight", cssVariable: "--bc-type-heading-1-font-weight", layer: "semantic", foundation: "typography", path: ["type", "heading", "1", "font", "weight"], valueType: "number", value: "700", unit: null }),
    token({ id: "type.heading.1.line.height", cssVariable: "--bc-type-heading-1-line-height", layer: "semantic", foundation: "typography", path: ["type", "heading", "1", "line", "height"], valueType: "number", value: "1.3", unit: null }),
    token({ id: "type.heading.1.letter.spacing", cssVariable: "--bc-type-heading-1-letter-spacing", layer: "semantic", foundation: "typography", path: ["type", "heading", "1", "letter", "spacing"], valueType: "dimension", value: "0.32px", unit: "px" })
  ];
  const canonicalPath = writeCanonical(canonicalFixture(tokens));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const style = manifest.styles.find((item) => item.id === "text.heading.1");
  assert.ok(style);
  assert.equal(style.name, "Heading / H1");
  assert.equal(style.leadingTrim, "NONE");
  assert.deepEqual(style.lineHeight, { unit: "PERCENT", value: 130 });
  assert.equal(style.bindings["line-height"].fallback, 1.3);
});

test("text style leaves include searchable role prefixes", () => {
  const tokens = [];
  for (const [role, index] of [["display", 6], ["heading", 2], ["paragraph", 3], ["label", 4], ["overline", 2]]) {
    for (const [property, valueType, value, unit] of [
      ["font-family", "string", "Parkinsans", null],
      ["font-size", "dimension", "16px", "px"],
      ["font-weight", "number", "600", null],
      ["line-height", "number", "1.3", null],
      ["letter-spacing", "dimension", "0px", "px"]
    ]) {
      tokens.push(token({
        id: `type.${role}.${index}.${property.replaceAll('-', '.')}`,
        cssVariable: `--bc-type-${role}-${index}-${property}`,
        layer: "semantic",
        foundation: "typography",
        path: ["type", role, String(index), ...property.split("-")],
        valueType,
        value,
        unit
      }));
    }
  }
  const canonicalPath = writeCanonical(canonicalFixture(tokens));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const names = new Map(manifest.styles.filter((item) => item.type === "TEXT").map((item) => [item.id, item.name]));
  assert.equal(names.get("text.display.6"), "Display / D6");
  assert.equal(names.get("text.heading.2"), "Heading / H2");
  assert.equal(names.get("text.paragraph.3"), "Paragraph / P3");
  assert.equal(names.get("text.label.4"), "Label / L4");
  assert.equal(names.get("text.overline.2"), "Overline / O2");
});


test("semantic text colours are available to text and vector/icon fills and sort last in fill pickers", () => {
  const primitive = token({ id: "color.neutral.50", cssVariable: "--bc-color-neutral-50", layer: "primitive", foundation: "colour", path: ["color", "neutral", "50"], valueType: "color", value: "#808080", unit: null });
  const makeSemantic = (id, path) => {
    const item = token({ id, cssVariable: `--bc-${id.replaceAll('.', '-')}`, layer: "semantic", foundation: "colour", path, valueType: "color", value: "var(--bc-color-neutral-50)", unit: null });
    item.variants[0].references = ["color.neutral.50"];
    item.variants[0].resolved = "#808080";
    return item;
  };
  const canonicalPath = writeCanonical(canonicalFixture([
    primitive,
    makeSemantic("color.fill.primary", ["color", "fill", "primary"]),
    makeSemantic("color.surface.general.primary", ["color", "surface", "general", "primary"]),
    makeSemantic("color.text.primary", ["color", "text", "primary"])
  ]));
  const manifest = buildFigmaManifest({ rootDir: figmaRoot, canonicalPath, configPath });
  const text = manifest.variables.find((variable) => variable.id === "color.text.primary");
  const fill = manifest.variables.find((variable) => variable.id === "color.fill.primary");
  const surface = manifest.variables.find((variable) => variable.id === "color.surface.general.primary");
  assert.deepEqual(text.scopes, ["ALL_FILLS", "STROKE_COLOR"]);
  const leadingSpaces = (value) => String(value || "").length - String(value || "").trimStart().length;
  assert.ok(leadingSpaces(text.figmaName) < leadingSpaces(fill.figmaName));
  assert.ok(leadingSpaces(text.figmaName) < leadingSpaces(surface.figmaName));
});
