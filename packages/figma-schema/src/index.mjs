import fs from "node:fs";
import path from "node:path";

function title(value) {
  return String(value ?? "")
    .split(/[-_. ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pathStartsWith(value = [], prefix = []) {
  return prefix.every((part, index) => value[index] === part);
}

function modeDisplay(group, value, config) {
  return config.modeAliases?.[group]?.values?.[value] || title(value);
}

function modeGroupDisplay(group, config) {
  return config.modeAliases?.[group]?.name || title(group);
}

function getModeDimensions(canonical, config) {
  const source = canonical.modeDimensions || [];
  const dimensions = source.map((dimension) => ({
    id: dimension.id,
    name: modeGroupDisplay(dimension.id, config),
    values: (dimension.values || []).map((value) => ({
      id: typeof value === "string" ? value : value.id,
      name: modeDisplay(dimension.id, typeof value === "string" ? value : value.id, config)
    }))
  }));

  const viewport = config.viewportSampling?.enabled !== false ? config.viewportSampling?.dimension : null;
  if (viewport?.id && Array.isArray(viewport.values) && viewport.values.length && !dimensions.some((item) => item.id === viewport.id)) {
    dimensions.push({
      id: viewport.id,
      name: viewport.name || modeGroupDisplay(viewport.id, config),
      values: viewport.values.map((value) => ({ id: value.id, name: value.name || title(value.id) }))
    });
  }
  return dimensions;
}

function collectionFor(token, config) {
  const definition = config.collections?.[token.layer];
  if (!definition || !token.foundation) return null;
  const foundationName = config.foundationNames?.[token.foundation] || title(token.foundation);
  return {
    id: `${token.layer}.${token.foundation}`,
    name: `${definition.name}: ${foundationName}`,
    publish: Boolean(definition.publish),
    kind: "token",
    layer: token.layer,
    foundation: token.foundation
  };
}

function primitiveColourName(token, config) {
  if (token.foundation !== "colour" || token.layer !== "primitive") return null;
  const parts = token.path || [];
  const rampIndex = parts.indexOf("ramp");
  if (rampIndex < 0 || !parts[rampIndex + 1]) return null;

  const groupParts = parts.slice(1, rampIndex);
  const rampNo = parts[rampIndex + 1];
  const remainder = parts.slice(rampIndex + 2);
  let leaf = config.naming?.primitiveColour?.base || "Base";
  if (remainder[0] === "tint" && remainder[1]) {
    leaf = (config.naming?.primitiveColour?.tint || "T{value}").replace("{value}", remainder[1]);
  } else if (remainder[0] === "shade" && remainder[1]) {
    leaf = (config.naming?.primitiveColour?.shade || "S{value}").replace("{value}", remainder[1]);
  } else if (remainder.length) {
    return null;
  }
  return [...groupParts.map(title), `Ramp ${rampNo}`, leaf].join(config.naming?.separator || " / ");
}

function displaySegment(value) {
  const raw = String(value ?? "");
  const upper = new Map([
    ["xs", "XS"], ["2xs", "2XS"], ["3xs", "3XS"], ["sm", "SM"], ["md", "MD"],
    ["lg", "LG"], ["xl", "XL"], ["2xl", "2XL"], ["ui", "UI"], ["rem", "REM"]
  ]);
  return upper.get(raw.toLowerCase()) || title(raw);
}

function scaleRank(value) {
  const order = ["none", "3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "full"];
  const index = order.indexOf(String(value ?? "").toLowerCase());
  if (index >= 0) return index + 1;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return 100 + numeric;
  return 500;
}

function tonePresentation(parts, prefix = []) {
  if (!parts.length) return { segments: [...prefix, "Base"], ranks: [...prefix.map((_, index) => index + 1), 100] };
  if (parts[0] === "tint" && parts[1]) {
    return { segments: [...prefix, `T${parts[1]}`], ranks: [...prefix.map((_, index) => index + 1), 100 - Number(parts[1])] };
  }
  if (parts[0] === "shade" && parts[1]) {
    return { segments: [...prefix, `S${parts[1]}`], ranks: [...prefix.map((_, index) => index + 1), 100 + Number(parts[1])] };
  }
  return null;
}

function colourPresentation(token) {
  const parts = [...(token.path || [])];
  if (parts[0] === "color") parts.shift();

  if (token.layer === "primitive") {
    const rootRank = { identity: 1, ground: 2, neutral: 3, status: 4, interaction: 5 };
    const root = parts[0];
    if (root === "identity" || root === "ground") {
      const rampIndex = parts.indexOf("ramp");
      if (rampIndex >= 0 && parts[rampIndex + 1]) {
        const tone = tonePresentation(parts.slice(rampIndex + 2), [displaySegment(root), `Ramp ${parts[rampIndex + 1]}`]);
        if (tone) return { ...tone, ranks: [rootRank[root], Number(parts[rampIndex + 1]), tone.ranks.at(-1)] };
      }
    }
    if (root === "neutral" && parts[1] != null) {
      return { segments: ["Neutral", displaySegment(parts[1])], ranks: [rootRank.neutral, scaleRank(parts[1])] };
    }
    if (root === "status" && parts[1]) {
      const statusOrder = { success: 1, warning: 2, error: 3, info: 4 };
      const tone = tonePresentation(parts.slice(2), ["Status", displaySegment(parts[1])]);
      if (tone) return { ...tone, ranks: [rootRank.status, statusOrder[parts[1]] || 50, tone.ranks.at(-1)] };
    }
    if (root === "interaction") {
      return { segments: ["Interaction", ...parts.slice(1).map(displaySegment)], ranks: [rootRank.interaction, ...parts.slice(1).map(scaleRank)] };
    }
  }

  if (token.layer === "semantic") {
    // Semantic colour is ordered by day-to-day design usage, not source-token order.
    // Shared tones are deliberately grouped at the bottom because they are useful
    // foundations for semantic roles, but are reached for less often in Figma.
    const rootOrder = { fill: 1, text: 2, border: 3, surface: 4, canvas: 5, interaction: 6, tones: 7, overlay: 8, shadow: 9 };
    const roleOrder = { general: 1, neutral: 2, primary: 3, secondary: 4, accent: 5, success: 6, warning: 7, error: 8, info: 9, context: 10, inverse: 11, strong: 12, soft: 13, subtle: 14, bold: 15 };
    const root = parts[0];

    if (["primary", "secondary", "accent"].includes(root)) {
      const toneOrder = { primary: 1, secondary: 2, accent: 3 };
      const tone = tonePresentation(parts.slice(1), ["Tones", displaySegment(root)]);
      if (tone) return { ...tone, ranks: [rootOrder.tones, toneOrder[root], tone.ranks.at(-1)] };
    }

    if (["disabled", "focus", "link", "placeholder"].includes(root)) {
      const interactionOrder = { link: 1, focus: 2, placeholder: 3, disabled: 4 };
      return { segments: ["Interaction", displaySegment(root), ...parts.slice(1).map(displaySegment)], ranks: [rootOrder.interaction, interactionOrder[root], ...parts.slice(1).map((part) => roleOrder[part] || scaleRank(part))] };
    }

    if (root) {
      return { segments: [displaySegment(root), ...parts.slice(1).map(displaySegment)], ranks: [rootOrder[root] || 50, ...parts.slice(1).map((part) => roleOrder[part] || scaleRank(part))] };
    }
  }
  return null;
}

function typographyPresentation(token) {
  const parts = [...(token.path || [])];
  if (parts[0] === "type") parts.shift();
  if (token.layer === "semantic" && parts.length >= 3) {
    const roleOrder = { display: 1, heading: 2, paragraph: 3, label: 4, overline: 5 };
    const role = parts[0];
    const level = parts[1];
    const propertyParts = parts.slice(2);
    let property = propertyParts.map(displaySegment).join(" ");
    if (propertyParts[0] === "font") property = displaySegment(propertyParts[1]);
    if (propertyParts[0] === "line" && propertyParts[1] === "height") property = "Line Height";
    if (propertyParts[0] === "letter" && propertyParts[1] === "spacing") property = "Letter Spacing";
    if (propertyParts[0] === "text" && propertyParts[1] === "transform") property = "Text Transform";
    const propertyOrder = { Family: 1, Size: 2, Weight: 3, "Line Height": 4, "Letter Spacing": 5, "Text Transform": 6, Style: 7 };
    return { segments: [displaySegment(role), displaySegment(level), property], ranks: [roleOrder[role] || 50, scaleRank(level), propertyOrder[property] || 50] };
  }
  if (token.layer === "primitive") {
    if (parts[0] === "font" && parts[1] === "family") return { segments: ["Font", "Family", ...parts.slice(2).map(displaySegment)], ranks: [1, 1, ...parts.slice(2).map(scaleRank)] };
    if (parts[0] === "weight") return { segments: ["Font", "Weight", ...parts.slice(1).map(displaySegment)], ranks: [1, 2, ...parts.slice(1).map(scaleRank)] };
    const rootOrder = { size: 2, leading: 3, tracking: 4 };
    if (rootOrder[parts[0]]) return { segments: [displaySegment(parts[0]), ...parts.slice(1).map(displaySegment)], ranks: [rootOrder[parts[0]], ...parts.slice(1).map(scaleRank)] };
  }
  return null;
}

function genericFoundationPresentation(token) {
  const parts = [...(token.path || [])];
  const foundation = token.foundation;
  if (foundation === "spacing") {
    const clean = token.layer === "primitive" && parts[0] === "size" ? parts.slice(1) : parts;
    return { segments: clean.map(displaySegment), ranks: [1, ...clean.slice(1, -1).map(() => 1), scaleRank(clean.at(-1))] };
  }
  if (foundation === "sizing") {
    const clean = parts[0] === "size" ? parts.slice(1) : parts;
    return { segments: clean.map(displaySegment), ranks: [1, ...clean.slice(1).map(scaleRank)] };
  }
  if (foundation === "radius") {
    const clean = parts.filter((part) => part !== "radius" && part !== "value");
    return { segments: clean.map(displaySegment), ranks: clean.map(scaleRank) };
  }
  if (foundation === "borders" || foundation === "stroke") {
    const clean = parts.filter((part) => !["border", "stroke"].includes(part));
    return { segments: clean.map(displaySegment), ranks: clean.map((part, index) => index ? scaleRank(part) : 1) };
  }
  if (foundation === "shadows") {
    const clean = parts[0] === "shadow" ? parts.slice(1) : parts;
    const strengthOrder = { soft: 1, medium: 2, strong: 3, context: 4 };
    const stateOrder = { resting: 1, floating: 2, fallen: 3 };
    if (token.layer === "semantic") return { segments: clean.map(displaySegment), ranks: [strengthOrder[clean[0]] || 50, stateOrder[clean[1]] || 50] };
    if (clean[0] === "geometry" || clean[0] === "opacity") {
      const [kind, strength, state, layer] = clean;
      return { segments: [displaySegment(strength), displaySegment(state), displaySegment(kind), displaySegment(layer)], ranks: [strengthOrder[strength] || 50, stateOrder[state] || 50, kind === "geometry" ? 1 : 2, scaleRank(layer)] };
    }
  }
  if (foundation === "motion") {
    const clean = parts[0] === "motion" ? parts.slice(1) : parts;
    const semanticOrder = { instant: 1, feedback: 2, interaction: 3, enter: 4, exit: 5, expand: 6, emphasis: 7 };
    if (token.layer === "semantic") return { segments: clean.map(displaySegment), ranks: [semanticOrder[clean[0]] || 50, clean[1] === "duration" ? 1 : 2] };
    const primitiveRoot = { duration: 1, easing: 2 };
    return { segments: clean.map(displaySegment), ranks: [primitiveRoot[clean[0]] || 50, ...clean.slice(1).map(scaleRank)] };
  }
  if (foundation === "effects") {
    const clean = parts[0] === "blur" ? parts.slice(1) : parts;
    return { segments: ["Blur", ...clean.map(displaySegment)], ranks: [1, ...clean.map(scaleRank)] };
  }
  if (foundation === "breakpoints") {
    const clean = parts[0] === "breakpoint" ? parts.slice(1) : parts;
    const viewportOrder = { sm: 1, small: 1, md: 2, medium: 2, lg: 3, large: 3, xl: 4, wide: 4, min: 0 };
    return { segments: clean.map(displaySegment), ranks: clean.map((part, index) => index === 0 && part === "reference" ? 5 : (viewportOrder[part] ?? scaleRank(part))) };
  }
  if (foundation === "containers") {
    const clean = parts[0] === "container" ? parts.slice(1) : parts;
    if (token.layer === "semantic" && clean[0] === "max") {
      const rest = clean.slice(1);
      return { segments: ["Max Width", ...rest.map(displaySegment)], ranks: [1, ...rest.map(scaleRank)] };
    }
    const rootOrder = { width: 1, max: 1, gutter: 2, space: 2 };
    return { segments: clean.map(displaySegment), ranks: [rootOrder[clean[0]] || 50, ...clean.slice(1).map(scaleRank)] };
  }
  if (foundation === "z-index") {
    const clean = parts.filter((part) => !["z", "value", "layer"].includes(part));
    const order = { base: 1, raised: 2, floating: 3, sticky: 4, overlay: 5, modal: 6, toast: 7 };
    return { segments: clean.map(displaySegment), ranks: clean.map((part) => order[part] || scaleRank(part)) };
  }
  return null;
}

function presentationFor(token, config) {
  let presentation = null;
  if (token.foundation === "colour") presentation = colourPresentation(token);
  else if (token.foundation === "typography") presentation = typographyPresentation(token);
  else presentation = genericFoundationPresentation(token);
  if (!presentation?.segments?.length) {
    const fallback = primitiveColourName(token, config);
    const cleanName = fallback || (() => {
      const pathParts = [...(token.path || [])];
      if (pathParts[0] === "color" || pathParts[0] === "type") pathParts.shift();
      return pathParts.map(displaySegment).join(config.naming?.separator || " / ");
    })();
    const segments = cleanName.split(config.naming?.separator || " / ");
    presentation = { segments, ranks: segments.map((_, index) => index + 1) };
  }
  const separator = config.naming?.separator || " / ";
  const name = presentation.segments.join(separator);
  const maxSpaces = Number(config.variableOrdering?.maxLeadingSpaces || 40);
  const figmaName = config.variableOrdering?.strategy === "segment-leading-spaces"
    ? presentation.segments.map((segment, index) => `${" ".repeat(Math.max(0, maxSpaces - Math.min(maxSpaces, Number(presentation.ranks?.[index] || 50))))}${segment}`).join(separator)
    : name;
  const sortKey = (presentation.ranks || []).map((rank) => String(Math.max(0, Number(rank) || 0)).padStart(5, "0")).join(".");
  return { name, figmaName, sortKey };
}

function variableName(token, config) {
  return presentationFor(token, config).name;
}

function isFluidClamp(value) {
  return /^clamp\(\s*-?\d+(?:\.\d+)?(?:rem|px)\s*,[\s\S]+,[\s\S]+\)$/i.test(String(value ?? "").trim());
}

function figmaType(token, config, tokenById = new Map(), seen = new Set()) {
  // Canonical colour tokens can intentionally be unset (`initial`) in the
  // framework baseline, so their literal valueType may be `string`. Their
  // canonical path/foundation still tells us the design capability is colour.
  if (token.foundation === "colour" || (token.path || [])[0] === "color") return "COLOR";

  const variant = primaryVariant(token);
  const raw = variant?.resolved ?? variant?.rawValue;
  if (token.foundation === "typography" && isFluidClamp(raw)) return "FLOAT";

  const alias = variant ? aliasReference(variant) : null;
  if (alias && !seen.has(alias)) {
    const target = tokenById.get(alias);
    if (target) {
      const nextSeen = new Set(seen);
      nextSeen.add(alias);
      const inherited = figmaType(target, config, tokenById, nextSeen);
      if (inherited) return inherited;
    }
  }

  return config.valueTypes?.[token.valueType] || null;
}

function scopesFor(token, config) {
  for (const rule of config.scopeRules || []) {
    const match = rule.match || {};
    if (match.foundation && match.foundation !== token.foundation) continue;
    if (match.layer && match.layer !== token.layer) continue;
    if (match.valueType && match.valueType !== token.valueType) continue;
    if (match.pathPrefix && !pathStartsWith(token.path || [], match.pathPrefix)) continue;
    if (match.pathContains && !(token.path || []).includes(match.pathContains)) continue;
    if (match.cssVariableIncludes && !String(token.cssVariable || "").includes(match.cssVariableIncludes)) continue;
    return rule.scopes || [];
  }
  return [];
}

function aliasReference(variant) {
  if (
    Array.isArray(variant.references) &&
    variant.references.length === 1 &&
    /^var\(\s*--bc-[A-Za-z0-9_-]+\s*\)$/.test(String(variant.rawValue || ""))
  ) return variant.references[0];
  return null;
}

function variantForModes(token, modes = {}) {
  const variants = token?.variants || [];
  const keys = Object.keys(modes || {});
  if (keys.length) {
    const exact = variants.find((variant) => {
      const candidate = variant.context?.modes || {};
      return keys.every((key) => candidate[key] === modes[key]);
    });
    if (exact) return exact;
  }
  return variants.find((variant) => Object.keys(variant.context?.modes || {}).length === 0) || primaryVariant(token);
}

function primitiveAliasTarget(aliasId, modes, tokenById, seen = new Set()) {
  if (!aliasId || seen.has(aliasId)) return null;
  const target = tokenById.get(aliasId);
  if (!target) return null;
  if (target.layer === "primitive") return target.id;

  const nextSeen = new Set(seen);
  nextSeen.add(aliasId);
  const targetVariant = variantForModes(target, modes);
  const nextAlias = targetVariant ? aliasReference(targetVariant) : null;
  if (!nextAlias) return null;
  return primitiveAliasTarget(nextAlias, modes, tokenById, nextSeen);
}

function semanticVariableDisposition(token, tokenById) {
  if (token.layer !== "semantic") return { materialise: true, reason: null };

  const variants = (token.variants || []).filter((variant) => !(variant.context?.conditions || []).length);
  if (!variants.length) return { materialise: false, reason: "conditional-only" };

  for (const variant of variants) {
    const alias = aliasReference(variant);
    if (!alias) {
      const raw = String(variant.rawValue ?? variant.resolved ?? "").trim();
      if (raw === "initial") return { materialise: false, reason: "runtime-hook" };
      if ((variant.references || []).length > 1) return { materialise: false, reason: "composite" };
      return { materialise: false, reason: "non-alias-semantic" };
    }

    const primitiveId = primitiveAliasTarget(alias, variant.context?.modes || {}, tokenById);
    if (!primitiveId) return { materialise: false, reason: "non-primitive-alias-chain" };
  }

  return { materialise: true, reason: null };
}

function variableTokens(tokens, tokenById) {
  return tokens.filter((token) => semanticVariableDisposition(token, tokenById).materialise);
}

function parseNumberWithUnit(value) {
  const match = String(value ?? "").trim().match(/^(-?\d+(?:\.\d+)?)([a-z%]+)?$/i);
  if (!match) return null;
  return { number: Number(match[1]), unit: (match[2] || "").toLowerCase() || null };
}

function firstFontFamily(value) {
  const first = String(value ?? "").split(",")[0].trim();
  return first.replace(/^(["'])(.*)\1$/, "$2");
}

function toPx(value, rootFontSizePx = 16) {
  const parsed = parseNumberWithUnit(value);
  if (!parsed) return null;
  if (!parsed.unit || parsed.unit === "px") return parsed.number;
  if (parsed.unit === "rem" || parsed.unit === "em") return parsed.number * rootFontSizePx;
  return null;
}

function evaluateFluidClamp(value, viewportWidthPx, rootFontSizePx = 16) {
  const match = String(value ?? "").trim().match(/^clamp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^\)]+)\s*\)$/i);
  if (!match) return null;
  const minimum = toPx(match[1], rootFontSizePx);
  const maximum = toPx(match[3], rootFontSizePx);
  if (minimum == null || maximum == null) return null;

  const middle = match[2].trim();
  const term = middle.match(/^(-?\d+(?:\.\d+)?)(rem|px)\s*([+-])\s*(\d+(?:\.\d+)?)vw$/i);
  if (!term) return null;
  const base = toPx(`${term[1]}${term[2]}`, rootFontSizePx);
  const vw = Number(term[4]) * viewportWidthPx / 100;
  const preferred = term[3] === "-" ? base - vw : base + vw;
  return Math.max(minimum, Math.min(maximum, preferred));
}

function viewportSampling(config) {
  const dimension = config.viewportSampling?.enabled !== false ? config.viewportSampling?.dimension : null;
  if (!dimension?.id || !Array.isArray(dimension.values)) return null;
  return {
    id: dimension.id,
    values: dimension.values.filter((value) => value?.id && Number.isFinite(Number(value.widthPx)))
  };
}

function toFigmaLiteral(token, variant, config, diagnostics, tokenById = new Map(), viewportWidthPx = null) {
  const raw = variant.resolved ?? variant.rawValue;
  const type = figmaType(token, config, tokenById);
  if (type === "COLOR") return raw;
  if (type === "STRING") {
    if (token.foundation === "typography" && String(token.cssVariable || "").includes("font-family")) return firstFontFamily(raw);
    return raw;
  }
  if (type === "BOOLEAN") {
    if (raw === true || raw === false) return raw;
    if (String(raw).trim() === "true") return true;
    if (String(raw).trim() === "false") return false;
    diagnostics.errors.push({ code: "figma-boolean-invalid", token: token.cssVariable, value: raw });
    return null;
  }
  if (type !== "FLOAT") return raw;

  let parsed = parseNumberWithUnit(raw);
  if (!parsed && viewportWidthPx != null && isFluidClamp(raw)) {
    const sampled = evaluateFluidClamp(raw, viewportWidthPx, Number(config.units?.rootFontSizePx || 16));
    if (sampled != null) return Number(sampled.toFixed(3));
  }
  if (!parsed) {
    diagnostics.warnings.push({ code: "figma-number-expression", token: token.cssVariable, value: raw });
    return null;
  }

  const root = Number(config.units?.rootFontSizePx || 16);
  if (!parsed.unit || parsed.unit === "px" || parsed.unit === "ms") return parsed.number;
  if (parsed.unit === "rem" || parsed.unit === "em") return parsed.number * root;
  if (parsed.unit === "s" && token.valueType === "duration") return parsed.number * 1000;

  diagnostics.warnings.push({
    code: "figma-number-unit-unsupported",
    token: token.cssVariable,
    value: raw,
    unit: parsed.unit
  });
  return null;
}

function tokenValues(token, config, diagnostics, tokenById) {
  const sampling = viewportSampling(config);
  const values = [];

  for (const variant of token.variants || []) {
    const sourceAlias = aliasReference(variant);
    const alias = token.layer === "semantic"
      ? (primitiveAliasTarget(sourceAlias, variant.context?.modes || {}, tokenById) || sourceAlias)
      : sourceAlias;
    const target = alias ? tokenById.get(alias) : null;
    const raw = variant.resolved ?? variant.rawValue;
    const targetVariant = target ? primaryVariant(target) : null;
    const targetRaw = targetVariant?.resolved ?? targetVariant?.rawValue;
    const fluid = isFluidClamp(raw);
    const fluidAlias = Boolean(alias && target && isFluidClamp(targetRaw));

    if (sampling && (fluid || fluidAlias) && Object.keys(variant.context?.modes || {}).length === 0) {
      for (const mode of sampling.values) {
        values.push({
          context: { modes: { [sampling.id]: mode.id }, conditions: [...(variant.context?.conditions || [])] },
          value: alias
            ? { kind: "alias", tokenId: alias }
            : {
                kind: "literal",
                value: toFigmaLiteral(token, variant, config, diagnostics, tokenById, Number(mode.widthPx)),
                sourceValue: raw,
                sourceUnit: variant.value?.unit ?? null
              }
        });
      }
      continue;
    }

    values.push({
      context: {
        modes: { ...(variant.context?.modes || {}) },
        conditions: [...(variant.context?.conditions || [])]
      },
      value: alias
        ? { kind: "alias", tokenId: alias }
        : {
            kind: "literal",
            value: toFigmaLiteral(token, variant, config, diagnostics, tokenById),
            sourceValue: raw,
            sourceUnit: variant.value?.unit ?? null
          }
    });
  }
  return values;
}

function collectionModeDimensions(tokens, canonicalModeDimensions, collection, config) {
  if (collection.kind === "divider") return [];
  const used = new Set();
  const tokenById = new Map();
  for (const token of tokens) {
    tokenById.set(token.id, token);
    tokenById.set(token.cssVariable, token);
  }
  const sampling = viewportSampling(config);

  for (const token of tokens) {
    if (token.layer !== collection.layer || token.foundation !== collection.foundation) continue;
    for (const variant of token.variants || []) {
      for (const dimensionId of Object.keys(variant.context?.modes || {})) used.add(dimensionId);
      if (sampling) {
        const raw = variant.resolved ?? variant.rawValue;
        const alias = aliasReference(variant);
        const target = alias ? tokenById.get(alias) : null;
        const targetVariant = target ? primaryVariant(target) : null;
        const targetRaw = targetVariant?.resolved ?? targetVariant?.rawValue;
        if (isFluidClamp(raw) || isFluidClamp(targetRaw)) used.add(sampling.id);
      }
    }
  }
  return canonicalModeDimensions.filter((dimension) => used.has(dimension.id));
}

function orderedFoundations(tokens, layer, config) {
  const present = new Set(tokens.filter((token) => token.layer === layer).map((token) => token.foundation));
  const preferred = config.collectionOrder?.[layer] || config.foundationOrder || [];
  const ordered = preferred.filter((foundation) => present.has(foundation));
  const remaining = [...present].filter((foundation) => !ordered.includes(foundation)).sort();
  return [...ordered, ...remaining];
}

function applyCollectionOrdering(collections, config) {
  const enabled = config.collectionOrdering?.enabled !== false;
  const strategy = config.collectionOrdering?.strategy || "leading-spaces";
  const total = collections.length;

  return collections.map((collection, index) => {
    const sortRank = index + 1;
    let figmaName = collection.name;

    // Figma does not expose a collection reorder API. In the Local Variables
    // authoring UI, leading spaces are retained for sorting but are visually
    // collapsed in normal display, giving us a deterministic semantic → divider
    // → primitive order without polluting the visible collection labels.
    if (enabled && strategy === "leading-spaces") {
      figmaName = `${" ".repeat(Math.max(1, total - index))}${collection.name}`;
    }

    return { ...collection, sortRank, figmaName };
  });
}

function buildCollections(tokens, config, modeDimensions) {
  const collections = [];
  const layers = ["semantic", "primitive"];
  const hasLayer = Object.fromEntries(layers.map((layer) => [layer, tokens.some((token) => token.layer === layer)]));

  for (const layer of layers) {
    if (!hasLayer[layer] || !config.collections?.[layer]) continue;
    for (const foundation of orderedFoundations(tokens, layer, config)) {
      const sample = tokens.find((token) => token.layer === layer && token.foundation === foundation);
      const collection = collectionFor(sample, config);
      collections.push({
        ...collection,
        modeDimensions: collectionModeDimensions(tokens, modeDimensions, collection, config)
      });
    }

    if (layer === "semantic" && hasLayer.primitive && config.divider?.enabled !== false) {
      collections.push({
        id: config.divider?.id || "divider.semantic-primitive",
        name: config.divider?.name || "────────────────────",
        publish: false,
        kind: "divider",
        layer: null,
        foundation: null,
        modeDimensions: []
      });
    }
  }

  return applyCollectionOrdering(collections, config);
}

function primaryVariant(token) {
  return (token.variants || []).find((variant) => !(variant.context?.conditions || []).length) || token.variants?.[0] || null;
}

function resolveStyleFallback(token, config, diagnostics, tokenById, seen = new Set()) {
  if (!token || seen.has(token.id)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(token.id);
  const variant = primaryVariant(token);
  if (!variant) return null;
  const alias = aliasReference(variant);
  if (alias) return resolveStyleFallback(tokenById.get(alias), config, diagnostics, tokenById, nextSeen);

  const raw = variant.resolved ?? variant.rawValue;
  if (isFluidClamp(raw)) {
    const sampling = viewportSampling(config);
    const medium = sampling?.values.find((item) => item.id === "medium") || sampling?.values[Math.floor((sampling?.values.length || 1) / 2)];
    if (medium) return evaluateFluidClamp(raw, Number(medium.widthPx), Number(config.units?.rootFontSizePx || 16));
  }
  return toFigmaLiteral(token, variant, config, diagnostics, tokenById);
}

function styleBinding(token, config, diagnostics, tokenById) {
  const variant = primaryVariant(token);
  if (!variant) return null;
  const alias = aliasReference(variant);
  return {
    tokenId: token.id,
    cssVariable: token.cssVariable,
    fallback: resolveStyleFallback(token, config, diagnostics, tokenById),
    value: alias ? { kind: "alias", tokenId: alias } : {
      kind: "literal",
      value: toFigmaLiteral(token, variant, config, diagnostics, tokenById),
      sourceValue: variant.resolved ?? variant.rawValue,
      sourceUnit: variant.value?.unit ?? null
    }
  };
}


function buildTextStyles(tokens, config, diagnostics) {
  if (!config.textStyles?.enabled) return [];
  const byCss = new Map(tokens.map((token) => [token.cssVariable, token]));
  const tokenById = new Map();
  for (const token of tokens) { tokenById.set(token.id, token); tokenById.set(token.cssVariable, token); }
  const styles = [];

  for (const [role, indexes] of Object.entries(config.textStyles.roles || {})) {
    for (const index of indexes) {
      const bindings = {};
      const missing = [];
      for (const property of config.textStyles.properties || []) {
        const cssVariable = `--bc-type-${role}-${index}-${property}`;
        const token = byCss.get(cssVariable);
        if (!token) {
          missing.push(cssVariable);
          continue;
        }
        bindings[property] = styleBinding(token, config, diagnostics, tokenById);
      }
      if (missing.length) {
        diagnostics.warnings.push({ code: "figma-text-style-incomplete", style: `${title(role)} / ${index}`, missing });
        continue;
      }
      styles.push({
        id: `text.${role}.${index}`,
        type: "TEXT",
        name: `${title(role)} / ${index}`,
        bindings
      });
    }
  }
  return styles;
}

function parseBlur(value) {
  const match = String(value ?? "").trim().match(/^blur\((-?\d+(?:\.\d+)?)px\)$/i);
  return match ? Number(match[1]) : null;
}

function splitTopLevelCommas(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const input = String(value ?? "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseCssColor(value) {
  const raw = String(value ?? "").trim();
  let match = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (match) {
    let hex = match[1];
    if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
    const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: alpha
    };
  }

  match = raw.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!match) return null;
  const alpha = match[4]
    ? (match[4].endsWith("%") ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]))
    : 1;
  return { r: Number(match[1]) / 255, g: Number(match[2]) / 255, b: Number(match[3]) / 255, a: alpha };
}

function parseShadowLayer(value, { fallbackColorTokenId = null } = {}) {
  const input = String(value ?? "").trim();
  const match = input.match(/^(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)(?:px)?\s+rgba\(from\s+(.+?)\s+r\s+g\s+b\s*\/\s*([\d.]+%?)\)$/i);
  if (!match) return null;

  const sourceColor = String(match[5] || "").trim();
  const layerOpacity = match[6].endsWith("%") ? Number(match[6].slice(0, -1)) / 100 : Number(match[6]);
  let color = parseCssColor(sourceColor);
  let colorTokenId = null;

  // BufferCore's framework baseline intentionally leaves brand/project colour
  // primitives unset. Sass serialises relative colours from those values as
  // `rgba(from initial ...)`. Geometry and layer opacity are still valid, so
  // preserve them and bind the effect colour to the canonical Shadow colour
  // variable in Figma rather than treating the whole style as unresolved.
  if (!color && sourceColor.toLowerCase() === "initial" && fallbackColorTokenId) {
    color = { r: 0, g: 0, b: 0, a: 1 };
    colorTokenId = fallbackColorTokenId;
  }
  if (!color) return null;

  return {
    type: "DROP_SHADOW",
    color: { ...color, a: Math.max(0, Math.min(1, color.a * layerOpacity)) },
    ...(colorTokenId ? { colorTokenId } : {}),
    offset: { x: Number(match[1]), y: Number(match[2]) },
    radius: Math.max(0, Number(match[3])),
    spread: Number(match[4]),
    visible: true,
    blendMode: "NORMAL"
  };
}

function parseShadowRecipe(value, options = {}) {
  const layers = splitTopLevelCommas(value);
  if (!layers.length) return null;
  const effects = layers.map((layer) => parseShadowLayer(layer, options));
  return effects.every(Boolean) ? effects : null;
}

function buildEffectStyles(tokens, config, diagnostics) {
  if (!config.effectStyles?.enabled) return [];
  const styles = [];

  for (const token of tokens) {
    if (token.foundation === "effects" && token.layer === "semantic" && pathStartsWith(token.path || [], config.effectStyles.blurPrefix || ["blur"])) {
      const variant = primaryVariant(token);
      const blur = parseBlur(variant?.resolved ?? variant?.rawValue);
      if (blur == null) {
        diagnostics.warnings.push({ code: "figma-blur-style-unresolved", token: token.cssVariable, value: variant?.resolved ?? variant?.rawValue ?? null });
        continue;
      }
      styles.push({
        id: `effect.${token.id}`,
        type: "EFFECT",
        effectType: "BACKGROUND_BLUR",
        name: `Blur / ${title((token.path || []).at(-1))}`,
        sourceTokenId: token.id,
        effects: [{ type: "BACKGROUND_BLUR", radius: blur, visible: true }]
      });
    }

    if (token.foundation === config.effectStyles.shadowFoundation && token.layer === "semantic" && /^--bc-shadow-(?!context-)/.test(token.cssVariable)) {
      const variant = primaryVariant(token);
      const sourceCss = variant?.resolved ?? variant?.rawValue ?? null;
      const effects = parseShadowRecipe(sourceCss, { fallbackColorTokenId: "--bc-color-shadow" });
      if (!effects) {
        diagnostics.warnings.push({ code: "figma-shadow-style-unresolved", token: token.cssVariable, value: sourceCss });
        continue;
      }
      styles.push({
        id: `effect.${token.id}`,
        type: "EFFECT",
        effectType: "DROP_SHADOW",
        name: `Shadow / ${(token.path || []).slice(1).map(title).join(" / ") || variableName(token, config)}`,
        sourceTokenId: token.id,
        sourceCss,
        effects
      });
    }
  }

  return styles;
}

export function validateFigmaManifest(manifest) {
  const errors = [];
  const required = ["schemaVersion", "platform", "system", "modeDimensions", "collections", "variables", "retiredVariables", "styles", "diagnostics"];
  for (const key of required) if (!(key in manifest)) errors.push(`Missing ${key}`);
  if (manifest.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (manifest.platform !== "figma") errors.push("platform must be figma");
  if (!Array.isArray(manifest.collections)) errors.push("collections must be an array");
  if (!Array.isArray(manifest.variables)) errors.push("variables must be an array");
  if (!Array.isArray(manifest.retiredVariables)) errors.push("retiredVariables must be an array");
  if (!Array.isArray(manifest.styles)) errors.push("styles must be an array");

  const collectionIds = new Set((manifest.collections || []).map((item) => item.id));
  const variableIds = new Set();
  for (const variable of manifest.variables || []) {
    if (!variable.id || !variable.name || !variable.collectionId || !variable.type || !Array.isArray(variable.values)) {
      errors.push(`Invalid variable ${variable.id || "<unknown>"}`);
    }
    if (variableIds.has(variable.id)) errors.push(`Duplicate variable id ${variable.id}`);
    variableIds.add(variable.id);
    if (!collectionIds.has(variable.collectionId)) errors.push(`Unknown collection ${variable.collectionId} for ${variable.id}`);
  }
  return errors;
}

export function buildFigmaManifest({
  rootDir,
  canonicalPath = path.resolve(rootDir, "../BufferCore-Engine/generated/manifest/buffercore.json"),
  configPath = path.join(rootDir, "config", "figma", "mapping.json")
}) {
  if (!fs.existsSync(canonicalPath)) throw new Error(`Canonical BufferCore manifest not found at: ${canonicalPath}. Run npm run core:build first.`);
  if (!fs.existsSync(configPath)) throw new Error(`BufferCore Figma mapping not found at: ${configPath}.`);

  const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  const canonicalErrors = canonical.diagnostics?.errors || [];
  if (canonicalErrors.length) throw new Error(`Canonical BufferCore manifest contains ${canonicalErrors.length} error(s). Rebuild and fix BufferCore-Engine before generating Figma output.`);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const diagnostics = { errors: [], warnings: [] };
  const modeDimensions = getModeDimensions(canonical, config);

  const tokenById = new Map();
  for (const token of canonical.tokens || []) { tokenById.set(token.id, token); tokenById.set(token.cssVariable, token); }

  // Figma Variables are only emitted for semantic values that can preserve the
  // BufferCore contract as a real alias chain ending at a Primitive. Runtime
  // context hooks (`initial`) and composite recipes belong to their Figma
  // representation (for example Effect Styles), not broken STRING variables.
  const materialisedTokens = variableTokens(canonical.tokens || [], tokenById);
  const collections = buildCollections(materialisedTokens, config, modeDimensions);
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));

  const retiredVariables = (canonical.tokens || [])
    .filter((token) => token.layer === "semantic")
    .map((token) => ({ token, disposition: semanticVariableDisposition(token, tokenById) }))
    .filter(({ disposition }) => !disposition.materialise)
    .map(({ token, disposition }) => ({ id: token.id, cssVariable: token.cssVariable, reason: disposition.reason }));

  const variables = [];
  for (const token of materialisedTokens) {
    const collection = collectionFor(token, config);
    if (!collection || !collectionById.has(collection.id)) continue;
    const type = figmaType(token, config, tokenById);
    if (!type) {
      diagnostics.errors.push({ code: "figma-type-unmapped", token: token.cssVariable, valueType: token.valueType });
      continue;
    }
    variables.push({
      id: token.id,
      cssVariable: token.cssVariable,
      foundation: token.foundation,
      layer: token.layer,
      path: token.path || [],
      groupPath: token.groupPath || [],
      valueType: token.valueType,
      units: token.units || [],
      collectionId: collection.id,
      name: presentationFor(token, config).name,
      figmaName: presentationFor(token, config).figmaName,
      sortKey: presentationFor(token, config).sortKey,
      type,
      scopes: scopesFor(token, config),
      publish: collection.publish,
      codeSyntax: { WEB: `var(${token.cssVariable})` },
      values: tokenValues(token, config, diagnostics, tokenById)
    });
  }

  const collectionOrder = new Map(collections.map((collection, index) => [collection.id, index]));
  variables.sort((a, b) => {
    const collectionDelta = (collectionOrder.get(a.collectionId) ?? 9999) - (collectionOrder.get(b.collectionId) ?? 9999);
    if (collectionDelta) return collectionDelta;
    const sortDelta = String(a.sortKey || "").localeCompare(String(b.sortKey || ""), undefined, { numeric: true, sensitivity: "base" });
    if (sortDelta) return sortDelta;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  const styles = [
    ...buildTextStyles(canonical.tokens || [], config, diagnostics),
    ...buildEffectStyles(canonical.tokens || [], config, diagnostics)
  ].sort((a, b) => `${a.type}/${a.name}`.localeCompare(`${b.type}/${b.name}`));

  const manifest = {
    schemaVersion: 2,
    platform: "figma",
    system: "BufferCore",
    generatedAt: new Date().toISOString(),
    source: {
      canonicalManifest: "generated/manifest/buffercore.json",
      mapping: "config/figma/mapping.json"
    },
    repository: canonical.repository || null,
    flavour: canonical.flavour || null,
    modeDimensions,
    collections,
    variables,
    retiredVariables,
    styles,
    diagnostics
  };

  const validationErrors = validateFigmaManifest(manifest);
  for (const message of validationErrors) diagnostics.errors.push({ code: "figma-manifest-invalid", message });
  return manifest;
}
