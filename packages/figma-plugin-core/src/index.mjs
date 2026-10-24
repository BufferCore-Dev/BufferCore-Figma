export const BUFFERCORE_KEYS = Object.freeze({
  collectionId: 'buffercore.collectionId',
  variableId: 'buffercore.variableId',
  styleId: 'buffercore.styleId',
  schemaVersion: 'buffercore.figmaSchemaVersion',
  appliedSignature: 'buffercore.appliedSignature',
  appliedLiveSignature: 'buffercore.appliedLiveSignature',
  bindingRegistry: 'buffercore.bindingRegistry',
  bindingRegistryVersion: 'buffercore.bindingRegistryVersion',
  libraryTarget: 'buffercore.libraryTarget',
  libraryKind: 'buffercore.libraryKind',
  bindingTranslationRegistry: 'buffercore.bindingTranslationRegistry'
});

export function libraryTargetForManifest(manifest) {
  const flavourId = manifest?.flavour?.id || manifest?.library?.flavourId || null;
  return flavourId ? `flavour:${flavourId}` : 'baseline';
}

export function libraryKindForManifest(manifest) {
  return libraryTargetForManifest(manifest) === 'baseline' ? 'baseline' : 'flavour';
}

export function buildBindingTranslationRegistry(bindingRegistry = {}) {
  return {
    collections: { ...(bindingRegistry.collections || {}) },
    variables: { ...(bindingRegistry.variables || {}) },
    styles: { ...(bindingRegistry.styles || {}) }
  };
}

export function translateCanonicalBinding(binding, registry = {}) {
  if (!binding) return null;
  const canonicalId = typeof binding === 'string'
    ? binding
    : binding.tokenId || binding.styleId || binding.id;
  if (!canonicalId) return null;
  if (registry.variables?.[canonicalId]) {
    return { kind: 'variable', canonicalId, figmaId: registry.variables[canonicalId] };
  }
  if (registry.styles?.[canonicalId]) {
    return { kind: 'style', canonicalId, figmaId: registry.styles[canonicalId] };
  }
  return null;
}

export function cartesianModeCombinations(modeDimensions = []) {
  if (!Array.isArray(modeDimensions) || modeDimensions.length === 0) {
    return [{ id: 'default', name: 'Default', modes: {} }];
  }

  let combinations = [{ idParts: [], nameParts: [], modes: {} }];
  for (const dimension of modeDimensions) {
    const values = Array.isArray(dimension.values) ? dimension.values : [];
    if (!dimension?.id || values.length === 0) continue;
    const next = [];
    for (const existing of combinations) {
      for (const value of values) {
        const id = typeof value === 'string' ? value : value.id;
        const name = typeof value === 'string' ? value : value.name;
        next.push({
          idParts: [...existing.idParts, `${dimension.id}:${id}`],
          nameParts: [...existing.nameParts, String(name || id)],
          modes: { ...existing.modes, [dimension.id]: id }
        });
      }
    }
    combinations = next;
  }

  if (!combinations.length) return [{ id: 'default', name: 'Default', modes: {} }];
  return combinations.map((item) => ({
    id: item.idParts.join('|') || 'default',
    name: item.nameParts.join(' · ') || 'Default',
    modes: item.modes
  }));
}

export function contextMatchesMode(contextModes = {}, mode = {}) {
  return Object.entries(contextModes || {}).every(([key, value]) => mode[key] === value);
}

export function desiredValueForMode(variable, mode) {
  const candidates = (variable.values || []).filter((item) => {
    const conditions = item.context?.conditions || [];
    if (conditions.length) return false;
    return contextMatchesMode(item.context?.modes || {}, mode);
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => Object.keys(b.context?.modes || {}).length - Object.keys(a.context?.modes || {}).length);
  return candidates[0].value || null;
}

export function buildDesiredModel(manifest) {
  if (!manifest || manifest.platform !== 'figma') throw new Error('Expected a BufferCore Figma manifest.');
  if ((manifest.diagnostics?.errors || []).length) throw new Error('Figma manifest contains errors and cannot be applied.');

  const canonicalByTokenRef = new Map();
  for (const variable of manifest.variables || []) {
    if (variable?.id) canonicalByTokenRef.set(variable.id, variable.id);
    if (variable?.cssVariable) canonicalByTokenRef.set(variable.cssVariable, variable.id);
  }

  const collections = (manifest.collections || []).map((collection) => {
    const modes = cartesianModeCombinations(collection.modeDimensions || manifest.modeDimensions || []);
    return {
      id: collection.id,
      name: collection.name,
      figmaName: collection.figmaName || collection.name,
      sortRank: collection.sortRank ?? null,
      publish: collection.publish !== false,
      kind: collection.kind || 'token',
      layer: collection.layer ?? null,
      foundation: collection.foundation ?? null,
      modes,
      variables: (manifest.variables || [])
        .filter((variable) => variable.collectionId === collection.id)
        .map((variable) => ({
          ...variable,
          modeValues: modes.map((mode) => {
            const value = desiredValueForMode(variable, mode.modes);
            if (!value) return null;
            if (value.kind === 'alias') {
              return { mode, value: { ...value, tokenId: canonicalByTokenRef.get(value.tokenId) || value.tokenId } };
            }
            return { mode, value };
          }).filter(Boolean)
        }))
    };
  });

  return {
    schemaVersion: manifest.schemaVersion,
    collections,
    retiredVariables: [...(manifest.retiredVariables || [])],
    styles: [...(manifest.styles || [])]
  };
}

export function diffByCanonicalId(desiredItems, currentItems, signatureForDesired = stableStringify, legacyEquals = null) {
  const currentById = new Map((currentItems || []).filter((item) => item?.canonicalId).map((item) => [item.canonicalId, item]));
  const desiredIds = new Set((desiredItems || []).map((item) => item.id));
  const create = [];
  const update = [];
  const unchanged = [];
  const drift = [];
  const conflict = [];
  const orphaned = (currentItems || []).filter((item) => item?.canonicalId && !desiredIds.has(item.canonicalId));

  for (const desired of desiredItems || []) {
    const current = currentById.get(desired.id);
    if (!current) {
      create.push(desired);
      continue;
    }

    const desiredSignature = signatureForDesired(desired);
    const liveSignature = current.liveSignature || null;
    if (!liveSignature && typeof legacyEquals === 'function') {
      if (legacyEquals(desired, current)) unchanged.push({ desired, current });
      else update.push({ desired, current, desiredSignature });
      continue;
    }
    const appliedSignature = current.appliedSignature || null;
    const appliedLiveSignature = current.appliedLiveSignature || null;

    // Objects imported before signature tracking are a clean one-time update.
    if (!appliedSignature || !appliedLiveSignature) {
      update.push({ desired, current, desiredSignature });
      continue;
    }

    const figmaChanged = liveSignature !== appliedLiveSignature;
    const sourceChanged = desiredSignature !== appliedSignature;
    if (!figmaChanged && !sourceChanged) unchanged.push({ desired, current });
    else if (figmaChanged && sourceChanged) conflict.push({ desired, current, desiredSignature });
    else if (figmaChanged) drift.push({ desired, current, desiredSignature });
    else update.push({ desired, current, desiredSignature });
  }

  return { create, update, unchanged, drift, conflict, orphaned };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function canonicalModeValue(definition, entry) {
  const value = entry?.value || null;
  if (!value) return null;
  if (value.kind === 'alias') return { kind: 'alias', tokenId: value.tokenId };
  if (value.kind !== 'literal') return value;
  let literal = value.value;
  if (definition.type === 'COLOR' && literal && typeof literal === 'object') {
    literal = { r: literal.r, g: literal.g, b: literal.b, a: literal.a ?? 1 };
  }
  // Figma's OPACITY variable scope stores values in percentage space (45 = 45%).
  // BufferCore's canonical CSS opacity scale remains normalised (0.45 = 45%).
  // Project the value here as well as at apply-time so Inspect can detect that an
  // existing 0.45 Figma value needs updating to 45 instead of reporting 0 changes.
  if (definition.type === 'FLOAT' && typeof literal === 'number') {
    const isCoreOpacityPrimitive = String(definition.id || '').startsWith('opacity.')
      || String(definition.cssVariable || '').startsWith('--bc-opacity-');
    if (((definition.scopes || []).includes('OPACITY') || isCoreOpacityPrimitive)
      && literal >= 0 && literal <= 1) {
      literal = Number((literal * 100).toFixed(6));
    }
  }
  return { kind: 'literal', value: literal };
}

export function desiredCollectionSignature(definition) {
  return stableStringify({
    name: definition.figmaName || definition.name,
    publish: definition.publish !== false,
    modes: (definition.modes || []).map((mode) => mode.name)
  });
}

export function desiredVariableSignature(definition) {
  return stableStringify({
    name: definition.figmaName || definition.name,
    collectionId: definition.collectionId,
    type: definition.type,
    scopes: [...(definition.scopes || [])].sort(),
    publish: definition.publish !== false,
    modeValues: (definition.modeValues || []).map((entry) => ({
      mode: entry.mode.name,
      value: canonicalModeValue(definition, entry)
    })).sort((a, b) => a.mode.localeCompare(b.mode))
  });
}

export function desiredStyleSignature(definition) {
  // Track the generated style contract rather than name/type alone so source
  // typography changes (including unitless CSS line-height -> Figma percent)
  // are applied even when the style keeps the same canonical id.
  return stableStringify({
    name: definition.name,
    type: definition.type,
    leadingTrim: definition.leadingTrim || null,
    lineHeight: definition.lineHeight || null,
    bindings: definition.bindings || null,
    effects: definition.effects || null
  });
}

function parseSignature(signature) {
  if (!signature || typeof signature !== 'string') return null;
  try {
    const parsed = JSON.parse(signature);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function withoutKeys(value, keys) {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function signatureChangedOnlyIn(signatureA, signatureB, keys) {
  const a = parseSignature(signatureA);
  const b = parseSignature(signatureB);
  if (!a || !b) return false;
  return stableStringify(withoutKeys(a, keys)) === stableStringify(withoutKeys(b, keys));
}

function reclassifyManagedMetadata(diff, keys) {
  // Scopes/publishing are BufferCore-managed Figma exposure metadata. When a
  // contract migration changes only those fields, it must not be mistaken for
  // user-authored design drift. Genuine name/type/value/mode edits still remain
  // drift/conflicts and keep the safety gate intact.
  const update = [...(diff.update || [])];
  const drift = [];
  const conflict = [];

  for (const item of diff.drift || []) {
    const exposureOnly = signatureChangedOnlyIn(
      item.current?.appliedLiveSignature,
      item.current?.liveSignature,
      keys
    );
    if (exposureOnly) update.push(item);
    else drift.push(item);
  }

  for (const item of diff.conflict || []) {
    const sourceExposureOnly = signatureChangedOnlyIn(
      item.current?.appliedSignature,
      item.desiredSignature,
      keys
    );
    const figmaExposureOnly = signatureChangedOnlyIn(
      item.current?.appliedLiveSignature,
      item.current?.liveSignature,
      keys
    );
    if (sourceExposureOnly && figmaExposureOnly) update.push(item);
    else conflict.push(item);
  }

  return { ...diff, update, drift, conflict };
}

export function buildDiffSummary(desired, snapshot) {
  const rawCollectionDiff = diffByCanonicalId(desired.collections, snapshot.collections, desiredCollectionSignature, (a, b) => {
    return (a.figmaName || a.name) === b.name && a.publish === b.publish && stableStringify(a.modes.map((m) => m.name)) === stableStringify(b.modeNames || []);
  });
  const collectionDiff = reclassifyManagedMetadata(rawCollectionDiff, ['publish']);

  const desiredVariables = desired.collections.flatMap((collection) => collection.variables.map((variable) => ({ ...variable, collectionId: collection.id })));
  const rawVariableDiff = diffByCanonicalId(desiredVariables, snapshot.variables, desiredVariableSignature, (a, b) => {
    return (a.figmaName || a.name) === b.name && a.collectionId === b.collectionCanonicalId && a.type === b.type && stableStringify(a.scopes || []) === stableStringify(b.scopes || []);
  });
  const variableDiff = reclassifyManagedMetadata(rawVariableDiff, ['scopes', 'publish']);
  const styleDiff = diffByCanonicalId(desired.styles, snapshot.styles, desiredStyleSignature, (a, b) => a.name === b.name && a.type === b.type);

  const groups = [collectionDiff, variableDiff, styleDiff];
  return {
    collections: collectionDiff,
    variables: variableDiff,
    styles: styleDiff,
    totals: {
      create: groups.reduce((n, group) => n + group.create.length, 0),
      update: groups.reduce((n, group) => n + group.update.length, 0),
      unchanged: groups.reduce((n, group) => n + group.unchanged.length, 0),
      drift: groups.reduce((n, group) => n + group.drift.length, 0),
      conflict: groups.reduce((n, group) => n + group.conflict.length, 0),
      orphaned: groups.reduce((n, group) => n + group.orphaned.length, 0)
    }
  };
}


export function summariseDiffByKind(diff) {
  const countVariables = (items, layer) => (items || []).filter((item) => {
    const desired = item?.desired || item;
    return desired?.layer === layer;
  }).length;
  const countStyles = (items) => (items || []).length;
  const countDividers = (items) => (items || []).filter((item) => {
    const desired = item?.desired || item;
    return desired?.kind === 'divider';
  }).length;

  return {
    create: {
      semanticVariables: countVariables(diff?.variables?.create, 'semantic'),
      primitiveVariables: countVariables(diff?.variables?.create, 'primitive'),
      styles: countStyles(diff?.styles?.create),
      dividerCollections: countDividers(diff?.collections?.create),
      collections: (diff?.collections?.create || []).filter((item) => item?.kind !== 'divider').length
    },
    update: {
      semanticVariables: countVariables(diff?.variables?.update, 'semantic'),
      primitiveVariables: countVariables(diff?.variables?.update, 'primitive'),
      styles: countStyles(diff?.styles?.update),
      collections: (diff?.collections?.update || []).filter((item) => item?.desired?.kind !== 'divider').length
    }
  };
}




export function contextCssSemanticTraits(cssVariable) {
  const source = String(cssVariable || '').toLowerCase();
  const has = (token) => new RegExp(`(?:^|-)${token}(?:-|$)`).test(source);
  return {
    inverse: has('inverse'),
    strong: has('strong'),
    muted: has('muted'),
    subtle: has('subtle'),
    soft: has('soft'),
    bold: has('bold')
  };
}

export function resolveContextMappingAmbiguity(domainId, sourceCss, destinations) {
  const candidates = [...new Set((destinations || []).filter(Boolean))];
  if (candidates.length <= 1) return candidates[0] || null;

  // Colour Text has a deliberately smaller Neutral family than the chromatic
  // roles. That means one canonical text token can legitimately occupy more
  // than one Context slot. Resolve those collisions by preserving the semantic
  // traits carried by the actual bound token (especially inverse text), instead
  // of dropping the binding as ambiguous. Other Context domains keep the strict
  // ambiguity behaviour.
  if (domainId !== 'colour' || !String(sourceCss || '').includes('-color-text')) return null;

  const weights = { inverse: 100, strong: 20, muted: 10, subtle: 10, soft: 10, bold: 10 };
  const sourceTraits = contextCssSemanticTraits(sourceCss);
  const ranked = candidates.map((destination) => {
    const destinationTraits = contextCssSemanticTraits(destination);
    let score = 0;
    for (const [trait, weight] of Object.entries(weights)) {
      score += sourceTraits[trait] === destinationTraits[trait] ? weight : -weight;
    }
    return { destination, score };
  }).sort((a, b) => b.score - a.score || a.destination.localeCompare(b.destination));

  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  return ranked[0].destination;
}

export function variantNameParts(name) {
  const source = String(name ?? '').trim();
  if (!source || !source.includes('=')) return null;

  // Figma normally separates variant properties with commas, while some
  // BufferCore-authored sets use slash-separated property names. Preserve the
  // authored convention rather than converting the whole component name.
  const delimiterMatch = source.match(/\s*,\s*|\s+\/\s+/);
  const delimiter = delimiterMatch?.[0] || null;
  const rawParts = delimiter ? source.split(delimiterMatch[0]) : [source];
  const parts = rawParts.map((part) => {
    const match = String(part).trim().match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!match) return null;
    return { property: match[1].trim(), value: match[2].trim() };
  });

  if (parts.some((part) => !part)) return null;
  return { source, delimiter, parts };
}

export function upsertVariantNameProperty(name, propertyNames, value, preferredPropertyName = null) {
  const parsed = variantNameParts(name);
  if (!parsed) return null;

  const candidates = [...new Set((propertyNames || [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean))];
  if (!candidates.length) return parsed.source;

  const nextParts = parsed.parts.map((part) => ({ ...part }));
  const index = nextParts.findIndex((part) => candidates.includes(part.property.toLowerCase()));
  const nextValue = String(value ?? '').trim();

  if (index >= 0) {
    nextParts[index].value = nextValue;
  } else {
    nextParts.push({
      property: String(preferredPropertyName || propertyNames?.[0] || 'Variant').trim(),
      value: nextValue
    });
  }

  const delimiter = parsed.delimiter || ', ';
  return nextParts.map((part) => `${part.property}=${part.value}`).join(delimiter);
}
