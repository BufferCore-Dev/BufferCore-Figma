export const BUFFERCORE_KEYS = Object.freeze({
  collectionId: 'buffercore.collectionId',
  variableId: 'buffercore.variableId',
  styleId: 'buffercore.styleId',
  schemaVersion: 'buffercore.figmaSchemaVersion',
  appliedSignature: 'buffercore.appliedSignature',
  appliedLiveSignature: 'buffercore.appliedLiveSignature',
  bindingRegistry: 'buffercore.bindingRegistry',
  bindingRegistryVersion: 'buffercore.bindingRegistryVersion'
});

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
  // Figma style APIs expose different bound-value shapes by style type. For
  // stable identity we track the public style contract here and keep detailed
  // content application in the plugin. This still detects rename/type drift.
  return stableStringify({ name: definition.name, type: definition.type });
}

export function buildDiffSummary(desired, snapshot) {
  const collectionDiff = diffByCanonicalId(desired.collections, snapshot.collections, desiredCollectionSignature, (a, b) => {
    return (a.figmaName || a.name) === b.name && a.publish === b.publish && stableStringify(a.modes.map((m) => m.name)) === stableStringify(b.modeNames || []);
  });

  const desiredVariables = desired.collections.flatMap((collection) => collection.variables.map((variable) => ({ ...variable, collectionId: collection.id })));
  const variableDiff = diffByCanonicalId(desiredVariables, snapshot.variables, desiredVariableSignature, (a, b) => {
    return (a.figmaName || a.name) === b.name && a.collectionId === b.collectionCanonicalId && a.type === b.type && stableStringify(a.scopes || []) === stableStringify(b.scopes || []);
  });
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
