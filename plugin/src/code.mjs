import {
  BUFFERCORE_KEYS,
  buildDesiredModel,
  buildDiffSummary,
  summariseDiffByKind,
  stableStringify,
  desiredCollectionSignature,
  desiredVariableSignature,
  desiredStyleSignature,
  libraryTargetForManifest,
  libraryKindForManifest,
  buildBindingTranslationRegistry
} from '../../packages/figma-plugin-core/src/index.mjs';

figma.showUI(__html__, { width: 620, height: 780, themeColors: true });

const REPOSITORY_BRIDGE_URL = 'http://localhost:3847';

async function repositoryBridgeRequest(path, options = {}) {
  const response = await fetch(REPOSITORY_BRIDGE_URL + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Bridge request failed (${response.status})`);
  }
  return payload;
}


function serialiseError(error) {
  return error instanceof Error ? error.message : String(error);
}

function rgbaFromHex(value) {
  const input = String(value || '').trim().replace(/^#/, '');
  let hex = input;
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((char) => char + char).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a: alpha
  };
}

const VALID_SCOPES_BY_TYPE = {
  COLOR: new Set(['ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR']),
  FLOAT: new Set(['CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'OPACITY', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT']),
  STRING: new Set(['TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE'])
};

function supportedScopes(type, scopes = []) {
  const allowed = VALID_SCOPES_BY_TYPE[type];
  if (!allowed) return [];
  return [...new Set(scopes)].filter((scope) => allowed.has(scope));
}

function applyVariableCodeSyntax(variable, definition, result) {
  const web = definition.codeSyntax?.WEB || (definition.cssVariable ? `var(${definition.cssVariable})` : null);
  if (!web || typeof variable.setVariableCodeSyntax !== 'function') return;
  try {
    variable.setVariableCodeSyntax('WEB', web);
  } catch (error) {
    result.warnings.push(`${definition.id}: could not set WEB code syntax ${web}. ${serialiseError(error)}`);
  }
}

function applyVariableScopes(variable, definition, result) {
  const requested = definition.scopes || [];
  if (!requested.length) return;

  const scopes = supportedScopes(definition.type, requested);
  const ignored = requested.filter((scope) => !scopes.includes(scope));
  if (ignored.length) {
    result.warnings.push(`${definition.id}: ignored incompatible Figma scopes for ${definition.type}: ${ignored.join(', ')}`);
  }
  if (!scopes.length) return;

  try {
    variable.scopes = scopes;
  } catch (error) {
    result.warnings.push(`${definition.id}: Figma rejected scopes ${scopes.join(', ')}; kept the existing/default scope. ${error?.message || error}`);
  }
}

function figmaLiteral(variable, value) {
  if (value?.kind !== 'literal') return null;
  if (variable.type === 'COLOR') {
    if (typeof value.value === 'object' && value.value && 'r' in value.value) return value.value;
    return rgbaFromHex(value.value);
  }
  if (variable.type === 'FLOAT') return typeof value.value === 'number' ? value.value : null;
  if (variable.type === 'BOOLEAN') return typeof value.value === 'boolean' ? value.value : null;
  if (variable.type === 'STRING') return value.value == null ? null : String(value.value);
  return null;
}

function isExpectedUnsetLiteral(definition, value) {
  if (definition.type !== 'COLOR' || value?.kind !== 'literal') return false;
  const source = String(value.sourceValue ?? value.value ?? '').trim().toLowerCase();
  return source === 'initial' || source.includes(' initial ') || source.includes('(initial') || source.includes('initial)');
}

let availableFontsPromise = null;
async function loadTextStyleFont(binding, result) {
  const family = typeof binding?.fallback === 'string' ? binding.fallback.trim() : '';
  if (!family) return null;
  try {
    availableFontsPromise ||= figma.listAvailableFontsAsync();
    const fonts = await availableFontsPromise;
    const candidates = fonts.filter((entry) => entry.fontName.family === family);
    if (!candidates.length) {
      result.warnings.push(`Font family ${family} is not available in this Figma environment.`);
      return null;
    }
    const chosen = candidates.find((entry) => /^(regular|normal|book)$/i.test(entry.fontName.style)) || candidates[0];
    await figma.loadFontAsync(chosen.fontName);
    return chosen.fontName;
  } catch (error) {
    result.warnings.push(`Could not load font family ${family}: ${serialiseError(error)}`);
    return null;
  }
}

async function localSnapshot() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const textStyles = await figma.getLocalTextStylesAsync();
  const effectStyles = await figma.getLocalEffectStylesAsync();
  const collectionCanonicalById = new Map(collections.map((collection) => [collection.id, collection.getPluginData(BUFFERCORE_KEYS.collectionId)]));
  const variableCanonicalById = new Map(variables.map((variable) => [variable.id, variable.getPluginData(BUFFERCORE_KEYS.variableId)]));
  const modeNameByCollectionAndId = new Map();
  for (const collection of collections) {
    for (const mode of collection.modes) modeNameByCollectionAndId.set(`${collection.id}|${mode.modeId}`, mode.name);
  }

  function normaliseLiveValue(variable, value) {
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
      return { kind: 'alias', tokenId: variableCanonicalById.get(value.id) || value.id };
    }
    if (variable.resolvedType === 'COLOR' && value && typeof value === 'object' && 'r' in value) {
      return { kind: 'literal', value: { r: value.r, g: value.g, b: value.b, a: value.a ?? 1 } };
    }
    return { kind: 'literal', value };
  }

  const snapshotCollections = collections.map((collection) => {
    const item = {
      figmaId: collection.id,
      canonicalId: collection.getPluginData(BUFFERCORE_KEYS.collectionId) || null,
      name: collection.name,
      publish: !Boolean(collection.hiddenFromPublishing),
      modeNames: collection.modes.map((mode) => mode.name),
      appliedSignature: collection.getPluginData(BUFFERCORE_KEYS.appliedSignature) || null,
      appliedLiveSignature: collection.getPluginData(BUFFERCORE_KEYS.appliedLiveSignature) || null
    };
    item.liveSignature = stableStringify({ name: item.name, publish: item.publish, modes: item.modeNames });
    return item;
  });

  const snapshotVariables = variables.map((variable) => {
    const collectionId = collectionCanonicalById.get(variable.variableCollectionId) || null;
    const modeValues = Object.entries(variable.valuesByMode || {}).map(([modeId, value]) => ({
      mode: modeNameByCollectionAndId.get(`${variable.variableCollectionId}|${modeId}`) || modeId,
      value: normaliseLiveValue(variable, value)
    })).sort((a, b) => a.mode.localeCompare(b.mode));
    const item = {
      figmaId: variable.id,
      canonicalId: variable.getPluginData(BUFFERCORE_KEYS.variableId) || null,
      name: variable.name,
      type: variable.resolvedType,
      collectionCanonicalId: collectionId,
      scopes: [...(variable.scopes || [])],
      publish: !Boolean(variable.hiddenFromPublishing),
      modeValues,
      appliedSignature: variable.getPluginData(BUFFERCORE_KEYS.appliedSignature) || null,
      appliedLiveSignature: variable.getPluginData(BUFFERCORE_KEYS.appliedLiveSignature) || null
    };
    item.liveSignature = stableStringify({
      name: item.name,
      collectionId: item.collectionCanonicalId,
      type: item.type,
      scopes: [...item.scopes].sort(),
      publish: item.publish,
      modeValues: item.modeValues
    });
    return item;
  });

  const snapshotStyles = [
    ...textStyles.map((style) => ({ style, type: 'TEXT' })),
    ...effectStyles.map((style) => ({ style, type: 'EFFECT' }))
  ].map(({ style, type }) => {
    const item = {
      figmaId: style.id,
      canonicalId: style.getPluginData(BUFFERCORE_KEYS.styleId) || null,
      name: style.name,
      type,
      appliedSignature: style.getPluginData(BUFFERCORE_KEYS.appliedSignature) || null,
      appliedLiveSignature: style.getPluginData(BUFFERCORE_KEYS.appliedLiveSignature) || null
    };
    item.liveSignature = stableStringify({ name: item.name, type: item.type });
    return item;
  });

  return { collections: snapshotCollections, variables: snapshotVariables, styles: snapshotStyles };
}

function ensureCollectionModes(collection, desiredModes) {
  const wanted = desiredModes.length ? desiredModes : [{ name: 'Default' }];
  let modes = collection.modes;
  if (!modes.length) throw new Error(`Collection ${collection.name} has no modes.`);

  if (modes[0].name !== wanted[0].name) collection.renameMode(modes[0].modeId, wanted[0].name);
  modes = collection.modes;

  for (const mode of wanted) {
    if (!modes.some((existing) => existing.name === mode.name)) collection.addMode(mode.name);
  }

  modes = collection.modes;
  for (const existing of [...modes]) {
    if (wanted.some((mode) => mode.name === existing.name)) continue;
    try { collection.removeMode(existing.modeId); } catch {}
  }
}

async function ensureCollections(desired, result) {
  const existing = await figma.variables.getLocalVariableCollectionsAsync();
  const byCanonicalId = new Map(existing.map((collection) => [collection.getPluginData(BUFFERCORE_KEYS.collectionId), collection]).filter(([id]) => id));
  const byName = new Map(existing.map((collection) => [collection.name, collection]));
  const collectionByCanonicalId = new Map();

  for (const definition of desired.collections) {
    const figmaName = definition.figmaName || definition.name;
    let collection = byCanonicalId.get(definition.id) || byName.get(figmaName) || byName.get(definition.name);
    if (!collection) {
      collection = figma.variables.createVariableCollection(figmaName);
      result.createdCollections += 1;
    } else {
      result.updatedCollections += 1;
    }
    collection.name = figmaName;
    collection.setPluginData(BUFFERCORE_KEYS.collectionId, definition.id);
    collection.setPluginData(BUFFERCORE_KEYS.schemaVersion, String(desired.schemaVersion));
    if ('hiddenFromPublishing' in collection) collection.hiddenFromPublishing = !definition.publish;
    ensureCollectionModes(collection, definition.modes);
    collectionByCanonicalId.set(definition.id, collection);
  }
  return collectionByCanonicalId;
}

async function ensureVariables(desired, collections, result) {
  const existing = await figma.variables.getLocalVariablesAsync();
  const byCanonicalId = new Map(existing.map((variable) => [variable.getPluginData(BUFFERCORE_KEYS.variableId), variable]).filter(([id]) => id));
  const byCollectionAndName = new Map(existing.map((variable) => [`${variable.variableCollectionId}|${variable.name}`, variable]));
  const variableByCanonicalId = new Map();
  const obsoleteVariables = [];

  for (const collectionDefinition of desired.collections) {
    if (collectionDefinition.kind === 'divider') continue;
    const collection = collections.get(collectionDefinition.id);
    for (const definition of collectionDefinition.variables) {
      const figmaName = definition.figmaName || definition.name;
      let variable = byCanonicalId.get(definition.id) || byCollectionAndName.get(`${collection.id}|${figmaName}`) || byCollectionAndName.get(`${collection.id}|${definition.name}`);
      if (variable && variable.resolvedType !== definition.type) {
        // Figma cannot change a variable's resolved type in place. Replace the
        // old plugin-owned variable so canonical capability fixes (for example
        // unset colour tokens previously imported as STRING) can migrate safely.
        const oldVariable = variable;
        variable = figma.variables.createVariable(figmaName, collection, definition.type);
        obsoleteVariables.push(oldVariable);
        result.migratedVariables += 1;
      } else if (variable && variable.variableCollectionId !== collection.id) {
        const oldVariable = variable;
        variable = figma.variables.createVariable(figmaName, collection, definition.type);
        obsoleteVariables.push(oldVariable);
        result.migratedVariables += 1;
      } else if (!variable) {
        variable = figma.variables.createVariable(figmaName, collection, definition.type);
        result.createdVariables += 1;
      } else {
        result.updatedVariables += 1;
      }

      variable.name = figmaName;
      applyVariableScopes(variable, definition, result);
      applyVariableCodeSyntax(variable, definition, result);
      variable.setPluginData(BUFFERCORE_KEYS.variableId, definition.id);
      variable.setPluginData(BUFFERCORE_KEYS.schemaVersion, String(desired.schemaVersion));
      if ('hiddenFromPublishing' in variable) variable.hiddenFromPublishing = !definition.publish;
      variableByCanonicalId.set(definition.id, variable);
      if (definition.cssVariable) variableByCanonicalId.set(definition.cssVariable, variable);
    }
  }

  return { variables: variableByCanonicalId, obsoleteVariables };
}

function modeIdFor(collection, modeName) {
  return collection.modes.find((mode) => mode.name === modeName)?.modeId || null;
}

function applyVariableValues(desired, collections, variables, result) {
  for (const collectionDefinition of desired.collections) {
    const collection = collections.get(collectionDefinition.id);
    for (const definition of collectionDefinition.variables) {
      const variable = variables.get(definition.id);
      if (!variable) continue;
      for (const modeValue of definition.modeValues) {
        const modeId = modeIdFor(collection, modeValue.mode.name);
        if (!modeId) continue;
        if (modeValue.value?.kind === 'alias') continue;
        const literal = figmaLiteral(definition, modeValue.value);
        if (literal == null) {
          if (isExpectedUnsetLiteral(definition, modeValue.value)) {
            result.deferredValues += 1;
            continue;
          }
          result.warnings.push(`${definition.id}: value for ${modeValue.mode.name} is not directly representable in Figma; skipped.`);
          result.skipped += 1;
          continue;
        }
        variable.setValueForMode(modeId, literal);
        result.literalValuesSet += 1;
      }
    }
  }
}

function applyAliases(desired, collections, variables, result) {
  for (const collectionDefinition of desired.collections) {
    const collection = collections.get(collectionDefinition.id);
    for (const definition of collectionDefinition.variables) {
      const variable = variables.get(definition.id);
      if (!variable) continue;
      for (const modeValue of definition.modeValues) {
        if (modeValue.value?.kind !== 'alias') continue;
        const target = variables.get(modeValue.value.tokenId);
        const modeId = modeIdFor(collection, modeValue.mode.name);
        if (!target || !modeId) {
          result.warnings.push(`${definition.id}: alias target ${modeValue.value.tokenId} is unavailable; skipped.`);
          result.skipped += 1;
          continue;
        }
        variable.setValueForMode(modeId, figma.variables.createVariableAlias(target));
        result.aliasesSet += 1;
      }
    }
  }
}

async function ensureTextStyle(definition, variables, result, existingById, existingByName) {
  let style = existingById.get(definition.id) || existingByName.get(`TEXT|${definition.name}`);
  if (!style) {
    style = figma.createTextStyle();
    result.createdStyles += 1;
  } else result.updatedStyles += 1;
  style.name = definition.name;
  style.setPluginData(BUFFERCORE_KEYS.styleId, definition.id);

  const loadedFontName = await loadTextStyleFont(definition.bindings?.['font-family'], result);
  if (loadedFontName) {
    try { style.fontName = loadedFontName; } catch {}
  }

  const fieldMap = {
    'font-family': 'fontFamily',
    'font-size': 'fontSize',
    'font-weight': 'fontWeight',
    'line-height': 'lineHeight',
    'letter-spacing': 'letterSpacing'
  };
  for (const [property, binding] of Object.entries(definition.bindings || {})) {
    const variable = variables.get(binding.tokenId);
    const field = fieldMap[property];
    if (!variable || !field || typeof style.setBoundVariable !== 'function') continue;
    const floatFields = new Set(['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']);
    if (floatFields.has(field) && variable.resolvedType !== 'FLOAT') continue;
    if (field === 'fontFamily' && variable.resolvedType !== 'STRING') continue;
    try {
      style.setBoundVariable(field, variable);
      result.styleBindings += 1;
    } catch (error) {
      result.warnings.push(`${definition.id}: could not bind ${property}: ${serialiseError(error)}`);
    }
  }
}

async function ensureEffectStyle(definition, variables, result, existingById, existingByName) {
  if (!Array.isArray(definition.effects) || definition.effects.length === 0) {
    result.warnings.push(`${definition.id}: effect recipe is not yet materialised; skipped.`);
    result.skipped += 1;
    return;
  }
  let style = existingById.get(definition.id) || existingByName.get(`EFFECT|${definition.name}`);
  if (!style) {
    style = figma.createEffectStyle();
    result.createdStyles += 1;
  } else result.updatedStyles += 1;
  style.name = definition.name;

  const effects = [];
  for (const definitionEffect of definition.effects) {
    const { colorTokenId, ...plainEffect } = definitionEffect;
    if (!colorTokenId) {
      effects.push(plainEffect);
      continue;
    }

    const colorVariable = variables.get(colorTokenId);
    if (!colorVariable || colorVariable.resolvedType !== 'COLOR') {
      result.warnings.push(`${definition.id}: shadow colour variable ${colorTokenId} is unavailable; kept fallback colour.`);
      effects.push(plainEffect);
      continue;
    }

    try {
      const boundEffect = figma.variables.setBoundVariableForEffect(plainEffect, 'color', colorVariable);
      effects.push(boundEffect);
      result.styleBindings += 1;
    } catch (error) {
      result.warnings.push(`${definition.id}: could not bind shadow colour ${colorTokenId}: ${serialiseError(error)}`);
      effects.push(plainEffect);
    }
  }

  style.effects = effects;
  style.setPluginData(BUFFERCORE_KEYS.styleId, definition.id);
}

async function ensureStyles(desired, variables, result) {
  const text = await figma.getLocalTextStylesAsync();
  const effects = await figma.getLocalEffectStylesAsync();
  const all = [
    ...text.map((style) => ({ style, type: 'TEXT' })),
    ...effects.map((style) => ({ style, type: 'EFFECT' }))
  ];
  const existingById = new Map(all.map(({ style }) => [style.getPluginData(BUFFERCORE_KEYS.styleId), style]).filter(([id]) => id));
  const existingByName = new Map(all.map(({ style, type }) => [`${type}|${style.name}`, style]));

  for (const definition of desired.styles) {
    if (definition.type === 'TEXT') await ensureTextStyle(definition, variables, result, existingById, existingByName);
    if (definition.type === 'EFFECT') await ensureEffectStyle(definition, variables, result, existingById, existingByName);
  }
}

function cleanupMigratedVariables(obsoleteVariables, result) {
  for (const variable of obsoleteVariables || []) {
    try {
      variable.remove();
      result.removedLegacyVariables += 1;
    } catch (error) {
      result.warnings.push(`Could not remove migrated legacy variable ${variable.name}: ${serialiseError(error)}`);
    }
  }
}

async function cleanupRetiredVariables(desired, result) {
  const retiredIds = new Set((desired.retiredVariables || []).map((item) => item.id).filter(Boolean));
  if (!retiredIds.size) return;

  const variables = await figma.variables.getLocalVariablesAsync();
  for (const variable of variables) {
    const canonicalId = variable.getPluginData(BUFFERCORE_KEYS.variableId);
    if (!canonicalId || !retiredIds.has(canonicalId)) continue;
    try {
      variable.remove();
      result.removedRetiredVariables += 1;
    } catch (error) {
      result.warnings.push(`Could not remove retired BufferCore variable ${variable.name}: ${serialiseError(error)}`);
    }
  }
}

async function cleanupLegacyCollections(result) {
  const legacyIds = new Set(['semantic', 'primitive']);
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    const canonicalId = collection.getPluginData(BUFFERCORE_KEYS.collectionId);
    if (!legacyIds.has(canonicalId)) continue;
    try {
      collection.remove();
      result.removedLegacyCollections += 1;
    } catch (error) {
      result.warnings.push(`Could not remove legacy collection ${collection.name}: ${serialiseError(error)}`);
    }
  }
}

function syncSafety(diff) {
  return {
    blocked: (diff.totals?.drift || 0) + (diff.totals?.conflict || 0) > 0,
    drift: diff.totals?.drift || 0,
    conflict: diff.totals?.conflict || 0,
    orphaned: diff.totals?.orphaned || 0
  };
}

async function stampAppliedState(desired) {
  const liveSnapshot = await localSnapshot();
  const liveCollections = new Map(liveSnapshot.collections.map((item) => [item.canonicalId, item.liveSignature]));
  const liveVariables = new Map(liveSnapshot.variables.map((item) => [item.canonicalId, item.liveSignature]));
  const liveStyles = new Map(liveSnapshot.styles.map((item) => [item.canonicalId, item.liveSignature]));
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  const textStyles = await figma.getLocalTextStylesAsync();
  const effectStyles = await figma.getLocalEffectStylesAsync();

  const desiredCollections = new Map(desired.collections.map((definition) => [definition.id, definition]));
  const desiredVariables = new Map(desired.collections.flatMap((collection) => collection.variables.map((variable) => [variable.id, { ...variable, collectionId: collection.id }])));
  const desiredStyles = new Map(desired.styles.map((definition) => [definition.id, definition]));

  const registry = { schemaVersion: desired.schemaVersion, collections: {}, variables: {}, styles: {} };

  for (const collection of collections) {
    const id = collection.getPluginData(BUFFERCORE_KEYS.collectionId);
    const definition = desiredCollections.get(id);
    if (!definition) continue;
    collection.setPluginData(BUFFERCORE_KEYS.appliedSignature, desiredCollectionSignature(definition));
    collection.setPluginData(BUFFERCORE_KEYS.appliedLiveSignature, liveCollections.get(id) || '');
    registry.collections[id] = collection.id;
  }
  for (const variable of variables) {
    const id = variable.getPluginData(BUFFERCORE_KEYS.variableId);
    const definition = desiredVariables.get(id);
    if (!definition) continue;
    variable.setPluginData(BUFFERCORE_KEYS.appliedSignature, desiredVariableSignature(definition));
    variable.setPluginData(BUFFERCORE_KEYS.appliedLiveSignature, liveVariables.get(id) || '');
    registry.variables[id] = variable.id;
  }
  for (const style of [...textStyles, ...effectStyles]) {
    const id = style.getPluginData(BUFFERCORE_KEYS.styleId);
    const definition = desiredStyles.get(id);
    if (!definition) continue;
    style.setPluginData(BUFFERCORE_KEYS.appliedSignature, desiredStyleSignature(definition));
    style.setPluginData(BUFFERCORE_KEYS.appliedLiveSignature, liveStyles.get(id) || '');
    registry.styles[id] = style.id;
  }

  figma.root.setPluginData(BUFFERCORE_KEYS.bindingRegistryVersion, '1');
  figma.root.setPluginData(BUFFERCORE_KEYS.bindingRegistry, JSON.stringify(registry));
}

function currentLibraryTarget() {
  return figma.root.getPluginData(BUFFERCORE_KEYS.libraryTarget) || null;
}

function hasManagedBufferCoreState() {
  return Boolean(figma.root.getPluginData(BUFFERCORE_KEYS.bindingRegistry));
}

function libraryTargetSafety(manifest) {
  const requested = libraryTargetForManifest(manifest);
  const current = currentLibraryTarget();
  return {
    requested,
    current,
    blocked: Boolean(current && current !== requested),
    claimOnApply: Boolean(!current && hasManagedBufferCoreState())
  };
}

function stampLibraryTarget(manifest) {
  const target = libraryTargetForManifest(manifest);
  figma.root.setPluginData(BUFFERCORE_KEYS.libraryTarget, target);
  figma.root.setPluginData(BUFFERCORE_KEYS.libraryKind, libraryKindForManifest(manifest));

  const raw = figma.root.getPluginData(BUFFERCORE_KEYS.bindingRegistry);
  if (!raw) return;
  try {
    const registry = buildBindingTranslationRegistry(JSON.parse(raw));
    figma.root.setPluginData(BUFFERCORE_KEYS.bindingTranslationRegistry, JSON.stringify(registry));
  } catch {}
}

async function analyse(manifest) {
  const desired = buildDesiredModel(manifest);
  const snapshot = await localSnapshot();
  const diff = buildDiffSummary(desired, snapshot);
  const target = libraryTargetSafety(manifest);
  const safety = syncSafety(diff);
  if (target.blocked) safety.blocked = true;
  return {
    desired,
    diff,
    safety,
    libraryTarget: target,
    library: manifest.library || null,
    changeSummary: summariseDiffByKind(diff),
    manifestWarnings: manifest.diagnostics?.warnings || []
  };
}

async function apply(manifest) {
  const target = libraryTargetSafety(manifest);
  if (target.blocked) {
    throw new Error(`This Figma file is locked to ${target.current}. Open the matching library file instead of applying ${target.requested} over it.`);
  }
  const desired = buildDesiredModel(manifest);
  const beforeSnapshot = await localSnapshot();
  const beforeDiff = buildDiffSummary(desired, beforeSnapshot);
  const safety = syncSafety(beforeDiff);
  if (safety.blocked) {
    throw new Error(`Apply blocked: ${safety.drift} Figma drift item(s) and ${safety.conflict} conflict(s) must be resolved first. No BufferCore changes were applied.`);
  }
  const result = {
    createdCollections: 0,
    updatedCollections: 0,
    createdVariables: 0,
    updatedVariables: 0,
    migratedVariables: 0,
    removedLegacyVariables: 0,
    removedRetiredVariables: 0,
    removedLegacyCollections: 0,
    literalValuesSet: 0,
    aliasesSet: 0,
    createdStyles: 0,
    updatedStyles: 0,
    styleBindings: 0,
    deferredValues: 0,
    skipped: 0,
    warnings: []
  };
  const collections = await ensureCollections(desired, result);
  const ensured = await ensureVariables(desired, collections, result);
  const variables = ensured.variables;
  applyVariableValues(desired, collections, variables, result);
  applyAliases(desired, collections, variables, result);
  await ensureStyles(desired, variables, result);
  cleanupMigratedVariables(ensured.obsoleteVariables, result);
  await cleanupRetiredVariables(desired, result);
  await cleanupLegacyCollections(result);
  await stampAppliedState(desired);
  stampLibraryTarget(manifest);
  const snapshot = await localSnapshot();
  const diff = buildDiffSummary(desired, snapshot);
  return {
    result,
    desired,
    diff,
    safety: syncSafety(diff),
    libraryTarget: libraryTargetSafety(manifest),
    library: manifest.library || null,
    changeSummary: summariseDiffByKind(diff)
  };
}

figma.ui.onmessage = async (message) => {
  try {
    if (message?.type === 'bridge-request') {
      const requestId = message.requestId;
      try {
        const payload = await repositoryBridgeRequest(message.path, message.options || {});
        figma.ui.postMessage({ type: 'bridge-response', requestId, ok: true, payload });
      } catch (error) {
        figma.ui.postMessage({ type: 'bridge-response', requestId, ok: false, error: serialiseError(error) });
      }
      return;
    }
    if (message?.type === 'analyse') {
      figma.ui.postMessage({ type: 'analysis', payload: await analyse(message.manifest) });
      return;
    }
    if (message?.type === 'apply') {
      figma.ui.postMessage({ type: 'applied', payload: await apply(message.manifest) });
      return;
    }
    if (message?.type === 'close') figma.closePlugin();
  } catch (error) {
    figma.ui.postMessage({ type: 'error', message: serialiseError(error) });
  }
};
