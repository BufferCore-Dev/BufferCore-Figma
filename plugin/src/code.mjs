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

figma.showUI(__html__, { width: 680, height: 760, themeColors: true });

const PLUGIN_SETTINGS_KEY = 'buffercore.plugin.settings';

async function readPluginSettings() {
  const stored = await figma.clientStorage.getAsync(PLUGIN_SETTINGS_KEY).catch(() => null);
  const migratedDefault = stored?.defaultTab === 'core' || stored?.defaultTab === 'help'
    ? 'tools'
    : stored?.defaultTab;
  const allowedTabs = new Set(['tools', 'flavours']);
  return {
    defaultTab: allowedTabs.has(migratedDefault) ? migratedDefault : 'tools',
    focusGeneratedResults: stored?.focusGeneratedResults !== false
  };
}

async function writePluginSettings(next = {}) {
  const current = await readPluginSettings();
  const allowedTabs = new Set(['tools', 'flavours']);
  const result = {
    ...current,
    ...(allowedTabs.has(next.defaultTab) ? { defaultTab: next.defaultTab } : {}),
    ...(typeof next.focusGeneratedResults === 'boolean'
      ? { focusGeneratedResults: next.focusGeneratedResults }
      : {})
  };
  await figma.clientStorage.setAsync(PLUGIN_SETTINGS_KEY, result);
  return result;
}

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



const FIGMA_SYSTEM_KEYS = Object.freeze({
  layer: 'buffercore.systemLayer',
  role: 'buffercore.systemRole',
  flavourId: 'buffercore.systemFlavourId'
});

const FIGMA_SYSTEM_LAYERS = Object.freeze([
  { id: 'foundations', name: 'Foundations', dependencies: [] },
  { id: 'elements', name: 'Elements', dependencies: ['foundations'] },
  { id: 'components', name: 'Components', dependencies: ['foundations', 'elements'] },
  { id: 'layout', name: 'Layout', dependencies: ['foundations', 'elements', 'components'] },
  { id: 'templates', name: 'Templates', dependencies: ['foundations', 'elements', 'components', 'layout'] },
  { id: 'pages', name: 'Pages', dependencies: ['foundations', 'elements', 'components', 'layout', 'templates'] }
]);

function layerDefinition(layerId) {
  return FIGMA_SYSTEM_LAYERS.find((item) => item.id === layerId) || null;
}

function currentSystemIdentity() {
  return {
    layer: figma.root.getPluginData(FIGMA_SYSTEM_KEYS.layer) || null,
    role: figma.root.getPluginData(FIGMA_SYSTEM_KEYS.role) || null,
    flavourId: figma.root.getPluginData(FIGMA_SYSTEM_KEYS.flavourId) || null
  };
}

function setSystemIdentity({ layer, role, flavourId = null }) {
  if (!layerDefinition(layer)) throw new Error(`Unknown BufferCore Figma layer: ${layer}`);
  if (!['master', 'flavour'].includes(role)) throw new Error(`Unknown BufferCore Figma role: ${role}`);
  if (role === 'flavour' && !flavourId) throw new Error('A Flavour must be selected for a Flavour library file.');
  figma.root.setPluginData(FIGMA_SYSTEM_KEYS.layer, layer);
  figma.root.setPluginData(FIGMA_SYSTEM_KEYS.role, role);
  figma.root.setPluginData(FIGMA_SYSTEM_KEYS.flavourId, role === 'flavour' ? flavourId : '');
  return currentSystemIdentity();
}

function inferSystemLayerFromName() {
  const name = String(figma.root.name || '').toLowerCase();
  if (name.includes('foundation')) return 'foundations';
  if (name.includes('element')) return 'elements';
  if (name.includes('component')) return 'components';
  if (name.includes('layout')) return 'layout';
  if (name.includes('template')) return 'templates';
  if (name.includes('page')) return 'pages';
  return null;
}

async function safePublishStatus(item) {
  if (!item || typeof item.getPublishStatusAsync !== 'function') return 'UNPUBLISHED';
  try {
    return await item.getPublishStatusAsync();
  } catch {
    return 'UNPUBLISHED';
  }
}

function summarisePublishStatuses(statuses) {
  const summary = { CURRENT: 0, CHANGED: 0, UNPUBLISHED: 0 };
  for (const status of statuses) {
    if (status in summary) summary[status] += 1;
    else summary.UNPUBLISHED += 1;
  }
  return summary;
}

async function currentLayerPublishStatus(layer) {
  const definition = layerDefinition(layer);
  if (!definition) throw new Error(`Unknown BufferCore Figma layer: ${layer}`);

  const statuses = [];
  const details = {
    layer,
    total: 0,
    current: 0,
    changed: 0,
    unpublished: 0,
    ready: false,
    state: 'empty'
  };

  if (layer === 'foundations') {
    const registry = readBindingRegistry();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const collectionsById = new Map(collections.map((collection) => [collection.id, collection]));

    const checkedCollections = new Set();
    for (const figmaId of Object.values(registry.variables || {})) {
      let variable = null;
      try { variable = await figma.variables.getVariableByIdAsync(figmaId); } catch {}
      if (!variable || variable.remote) continue;

      const collection = collectionsById.get(variable.variableCollectionId);
      const publishable = !variable.hiddenFromPublishing && collection && !collection.hiddenFromPublishing;
      if (!publishable) continue;

      statuses.push(await safePublishStatus(variable));

      if (!checkedCollections.has(collection.id)) {
        checkedCollections.add(collection.id);
        statuses.push(await safePublishStatus(collection));
      }
    }

    for (const figmaId of Object.values(registry.styles || {})) {
      let style = null;
      try { style = await figma.getStyleByIdAsync?.(figmaId); } catch {}
      if (!style || style.remote) continue;
      statuses.push(await safePublishStatus(style));
    }
  } else {
    const roots = await localComponentRoots();
    for (const node of roots) {
      if (!node || node.remote) continue;
      statuses.push(await safePublishStatus(node));
    }
  }

  const counts = summarisePublishStatuses(statuses);
  details.total = statuses.length;
  details.current = counts.CURRENT;
  details.changed = counts.CHANGED;
  details.unpublished = counts.UNPUBLISHED;

  if (!details.total) {
    details.state = 'empty';
    details.ready = false;
  } else if (details.unpublished > 0) {
    details.state = 'unpublished';
    details.ready = false;
  } else if (details.changed > 0) {
    details.state = 'changed';
    details.ready = false;
  } else {
    details.state = 'current';
    details.ready = details.current > 0;
  }

  return details;
}

function publishStatusMessage(status) {
  if (!status?.total) return 'No publishable library assets found in this file.';
  if (status.unpublished > 0) {
    return `${status.unpublished} publishable item(s) have never been published. Publish this library in Figma first.`;
  }
  if (status.changed > 0) {
    return `${status.changed} item(s) have unpublished changes. Publish the latest library changes in Figma first.`;
  }
  if (status.ready) {
    return `Published and current · ${status.current} item(s) ready to register.`;
  }
  return 'This library is not ready to register.';
}

async function assertLayerPublishedCurrent(layer) {
  const status = await currentLayerPublishStatus(layer);
  if (!status.ready) throw new Error(publishStatusMessage(status));
  return status;
}

async function publishedFoundationBindings() {
  const registry = readBindingRegistry();
  const variables = {};
  const styles = {};
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionsById = new Map(collections.map((collection) => [collection.id, collection]));

  for (const [canonicalId, figmaId] of Object.entries(registry.variables || {})) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(figmaId);
      const collection = variable ? collectionsById.get(variable.variableCollectionId) : null;
      const publishable = variable && !variable.remote
        && !variable.hiddenFromPublishing
        && collection
        && !collection.hiddenFromPublishing;
      if (!publishable) continue;
      if (await safePublishStatus(variable) !== 'CURRENT') continue;
      variables[canonicalId] = { key: variable.key, name: variable.name };
    } catch {}
  }

  for (const [canonicalId, figmaId] of Object.entries(registry.styles || {})) {
    try {
      const style = await figma.getStyleByIdAsync?.(figmaId);
      if (!style || style.remote) continue;
      if (await safePublishStatus(style) !== 'CURRENT') continue;
      styles[canonicalId] = { key: style.key, name: style.name, type: style.type || null };
    } catch {}
  }

  return { variables, styles };
}

async function registerCurrentSystemLayer({ layer, role, flavourId = null }) {
  const publishStatus = await assertLayerPublishedCurrent(layer);
  const identity = setSystemIdentity({ layer, role, flavourId });
  const definition = layerDefinition(layer);

  if (role === 'master' && layer === 'foundations') {
    const bindings = await publishedFoundationBindings();
    const payload = {
      schemaVersion: 1,
      role,
      layer,
      flavourId: null,
      fileName: figma.root.name || 'BC: Foundations',
      registeredAt: new Date().toISOString(),
      dependencies: definition.dependencies,
      bindings,
      assets: []
    };
    await repositoryBridgeRequest('/library-family/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return { ...identity, assets: 0, variables: Object.keys(bindings.variables).length, styles: Object.keys(bindings.styles).length, publishStatus };
  }

  if (role === 'flavour' && layer === 'foundations') {
    const target = currentLibraryTarget();
    if (!target || target !== `flavour:${flavourId}`) {
      throw new Error(`Apply ${flavourId} Foundations to this file before registering it as ${flavourId}: Foundations.`);
    }
    const bindings = await publishedFoundationBindings();
    const payload = {
      schemaVersion: 1,
      role,
      layer,
      flavourId,
      fileName: figma.root.name || `${flavourId}: Foundations`,
      registeredAt: new Date().toISOString(),
      dependencies: definition.dependencies,
      bindings,
      assets: []
    };
    await repositoryBridgeRequest('/library-family/register', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return { ...identity, assets: 0, variables: Object.keys(bindings.variables).length, styles: Object.keys(bindings.styles).length, publishStatus };
  }

  const roots = await localComponentRoots();
  const assets = [];
  for (const node of roots) {
    if (!node.key) continue;

    const sourceCanonical = role === 'flavour'
      ? node.getPluginData(COMPONENT_KEYS.masterComponentId)
      : ensureCanonicalComponentId(node, node.type === 'COMPONENT_SET' ? `${layer}:component-set` : `${layer}:component`);

    if (!sourceCanonical) continue;

    if (node.type === 'COMPONENT_SET') {
      assets.push({
        canonicalId: sourceCanonical,
        kind: 'COMPONENT_SET',
        key: node.key,
        name: node.name,
        variants: node.children.filter((child) => child.type === 'COMPONENT').map((child) => ({
          canonicalId: role === 'flavour'
            ? child.getPluginData(COMPONENT_KEYS.masterComponentId)
            : ensureCanonicalComponentId(child, `${sourceCanonical}/variant`),
          key: child.key,
          name: child.name
        }))
      });
    } else {
      assets.push({
        canonicalId: sourceCanonical,
        kind: 'COMPONENT',
        key: node.key,
        name: node.name,
        variants: []
      });
    }
  }

  const payload = {
    schemaVersion: 1,
    role,
    layer,
    flavourId: role === 'flavour' ? flavourId : null,
    fileName: figma.root.name || `${role === 'master' ? 'BC' : flavourId}: ${definition.name}`,
    registeredAt: new Date().toISOString(),
    dependencies: definition.dependencies,
    bindings: { variables: {}, styles: {} },
    assets
  };

  await repositoryBridgeRequest('/library-family/register', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return {
    ...identity,
    assets: assets.length,
    variants: assets.reduce((sum, item) => sum + (item.variants?.length || 0), 0)
  };
}

async function familyState(flavourId = null) {
  const suffix = flavourId ? `?flavour=${encodeURIComponent(flavourId)}` : '';
  return repositoryBridgeRequest(`/library-family/status${suffix}`);
}

async function assertLayerDependencies(layer, flavourId) {
  const state = await familyState(flavourId);
  const definition = layerDefinition(layer);
  const missing = (definition?.dependencies || []).filter((dependency) => {
    const row = state.layers?.[dependency];
    return !row?.master || !row?.flavour;
  });
  if (missing.length) {
    throw new Error(`Cannot sync ${layer}: missing registered master/Flavour dependencies: ${missing.join(', ')}.`);
  }
  return state;
}

async function importFlavourVariableForCanonical(canonicalId, flavourFamily) {
  const item = flavourFamily?.layers?.foundations?.flavour?.bindings?.variables?.[canonicalId];
  if (!item?.key || typeof figma.variables.importVariableByKeyAsync !== 'function') return null;
  try { return await figma.variables.importVariableByKeyAsync(item.key); } catch { return null; }
}

async function importFlavourStyleForCanonical(canonicalId, flavourFamily) {
  const item = flavourFamily?.layers?.foundations?.flavour?.bindings?.styles?.[canonicalId];
  if (!item?.key || typeof figma.importStyleByKeyAsync !== 'function') return null;
  try { return await figma.importStyleByKeyAsync(item.key); } catch { return null; }
}

function masterAssetCanonicalByKey(family, key) {
  if (!key) return null;
  for (const row of Object.values(family?.layers || {})) {
    for (const asset of row?.master?.assets || []) {
      if (asset.key === key) return asset.canonicalId;
      for (const variant of asset.variants || []) {
        if (variant.key === key) return variant.canonicalId;
      }
    }
  }
  return null;
}

function flavourAssetKeyByCanonical(family, canonicalId) {
  if (!canonicalId) return null;
  for (const row of Object.values(family?.layers || {})) {
    for (const asset of row?.flavour?.assets || []) {
      if (asset.canonicalId === canonicalId) return asset.key;
      for (const variant of asset.variants || []) {
        if (variant.canonicalId === canonicalId) return variant.key;
      }
    }
  }
  return null;
}

async function remapNestedMasterInstances(node, family) {
  if (node.type === 'INSTANCE') {
    let master = null;
    try { master = await node.getMainComponentAsync?.(); } catch {}
    const sourceKey = master?.key || null;
    const canonicalId = masterAssetCanonicalByKey(family, sourceKey);
    const flavourKey = flavourAssetKeyByCanonical(family, canonicalId);
    if (flavourKey && flavourKey !== sourceKey) {
      try {
        const target = await figma.importComponentByKeyAsync(flavourKey);
        await node.swapComponent(target);
      } catch {}
    }
  }

  if ('children' in node) {
    for (const child of node.children) await remapNestedMasterInstances(child, family);
  }
}

async function assertNoResidualMasterDependencies(node, family) {
  const masterKeys = new Set();
  for (const row of Object.values(family?.layers || {})) {
    for (const asset of row?.master?.assets || []) {
      if (asset.key) masterKeys.add(asset.key);
      for (const variant of asset.variants || []) if (variant.key) masterKeys.add(variant.key);
    }
  }

  const residual = [];
  const visit = async (current) => {
    if (current.type === 'INSTANCE') {
      try {
        const master = await current.getMainComponentAsync?.();
        if (master?.key && masterKeys.has(master.key)) residual.push({ name: current.name, key: master.key });
      } catch {}
    }
    if ('children' in current) for (const child of current.children) await visit(child);
  };
  await visit(node);
  return residual;
}

const COMPONENT_KEYS = Object.freeze({
  componentId: 'buffercore.componentId',
  masterComponentId: 'buffercore.masterComponentId',
  masterComponentKey: 'buffercore.masterComponentKey',
  masterComponentRevision: 'buffercore.masterComponentRevision'
});

function slug(value) {
  return String(value || 'component')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'component';
}

function ensureCanonicalComponentId(node, prefix = 'component') {
  const existing = node.getPluginData(COMPONENT_KEYS.componentId);
  if (existing) return existing;
  const id = `${prefix}:${slug(node.name)}:${String(node.id).replace(/[^a-zA-Z0-9]+/g, '-')}`;
  node.setPluginData(COMPONENT_KEYS.componentId, id);
  return id;
}

async function localComponentRoots() {
  if (typeof figma.loadAllPagesAsync === 'function') {
    await figma.loadAllPagesAsync();
  }

  const nodes = figma.root.findAllWithCriteria
    ? figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
    : figma.root.findAll((node) => node.type === 'COMPONENT' || node.type === 'COMPONENT_SET');

  return nodes.filter((node) => {
    if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') return false;
    return !node.remote;
  });
}

function readBindingRegistry() {
  const raw = figma.root.getPluginData(BUFFERCORE_KEYS.bindingRegistry);
  if (!raw) return { collections: {}, variables: {}, styles: {} };
  try { return JSON.parse(raw); } catch { return { collections: {}, variables: {}, styles: {} }; }
}

function masterAssetRevision(entry) {
  return JSON.stringify({
    kind: entry.kind,
    name: entry.name,
    key: entry.key,
    variants: entry.variants || []
  });
}

async function registerMasterFigmaAssets() {
  const target = currentLibraryTarget();
  if (target && target !== 'baseline') {
    throw new Error(`Master components can only be captured from the Baseline library. This file is ${target}.`);
  }

  const roots = await localComponentRoots();
  const components = [];
  for (const node of roots) {
    if (!node.key) continue;
    if (node.type === 'COMPONENT_SET') {
      const canonicalId = ensureCanonicalComponentId(node, 'component-set');
      const variants = node.children
        .filter((child) => child.type === 'COMPONENT')
        .map((child) => ({
          canonicalId: ensureCanonicalComponentId(child, `${canonicalId}/variant`),
          key: child.key,
          name: child.name
        }));
      components.push({
        canonicalId,
        kind: 'COMPONENT_SET',
        key: node.key,
        name: node.name,
        variants
      });
    } else {
      components.push({
        canonicalId: ensureCanonicalComponentId(node, 'component'),
        kind: 'COMPONENT',
        key: node.key,
        name: node.name,
        variants: []
      });
    }
  }

  if (!components.length) {
    throw new Error('No publishable local Figma assets were found. Build Elements, Components, Patterns, Templates or Layouts as Components/Component Sets in the Baseline master library, publish it, then register them.');
  }

  const registry = readBindingRegistry();
  const variableNames = {};
  for (const [canonicalId, figmaId] of Object.entries(registry.variables || {})) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(figmaId);
      if (variable) variableNames[variable.name] = canonicalId;
    } catch {}
  }

  const styleNames = {};
  for (const [canonicalId, figmaId] of Object.entries(registry.styles || {})) {
    try {
      const style = await figma.getStyleByIdAsync?.(figmaId);
      if (style) styleNames[style.name] = canonicalId;
    } catch {}
  }

  const registryMeta = {
    schemaVersion: 2,
    registeredAt: new Date().toISOString(),
    source: 'published-figma-master-library',
    sourceFile: figma.root.name || 'BufferCore Baseline',
    sourceLibraryTarget: 'baseline',

    // This registry is deliberately metadata only. The published Figma library
    // remains authoritative for structure, variants, component properties,
    // nested components and visual design. Flavour sync imports those live
    // published assets by key each time.
    bindingRegistry: registry,
    variableNames,
    styleNames,
    assets: components
  };

  await repositoryBridgeRequest('/master-assets', {
    method: 'POST',
    body: JSON.stringify(registryMeta)
  });

  return {
    count: components.length,
    variantCount: components.reduce((sum, item) => sum + (item.variants?.length || 0), 0),
    registryMeta
  };
}

async function variableForCanonical(registry, canonicalId) {
  const id = registry?.variables?.[canonicalId];
  if (!id) return null;
  try { return await figma.variables.getVariableByIdAsync(id); } catch { return null; }
}

async function styleForCanonical(registry, canonicalId) {
  const id = registry?.styles?.[canonicalId];
  if (!id || typeof figma.getStyleByIdAsync !== 'function') return null;
  try { return await figma.getStyleByIdAsync(id); } catch { return null; }
}

async function canonicalForSourceVariableAlias(alias, registryMeta) {
  if (!alias?.id) return null;
  const direct = Object.entries(registryMeta.bindingRegistry?.variables || {}).find(([, id]) => id === alias.id)?.[0];
  if (direct) return direct;
  try {
    const sourceVariable = await figma.variables.getVariableByIdAsync(alias.id);
    if (sourceVariable?.name && registryMeta.variableNames?.[sourceVariable.name]) {
      return registryMeta.variableNames[sourceVariable.name];
    }
  } catch {}
  return null;
}

async function remapPaintBindings(paint, registryMeta, targetRegistry) {
  if (!paint || typeof paint !== 'object' || !paint.boundVariables) return paint;
  let next = { ...paint };
  for (const [field, alias] of Object.entries(paint.boundVariables || {})) {
    const canonicalId = await canonicalForSourceVariableAlias(alias, registryMeta);
    if (!canonicalId) continue;
    const target = await variableForCanonical(targetRegistry, canonicalId);
    if (!target) continue;
    try { next = figma.variables.setBoundVariableForPaint(next, field, target); } catch {}
  }
  return next;
}

async function remapEffectBindings(effect, registryMeta, targetRegistry) {
  if (!effect || typeof effect !== 'object' || !effect.boundVariables) return effect;
  let next = { ...effect };
  for (const [field, alias] of Object.entries(effect.boundVariables || {})) {
    const canonicalId = await canonicalForSourceVariableAlias(alias, registryMeta);
    if (!canonicalId) continue;
    const target = await variableForCanonical(targetRegistry, canonicalId);
    if (!target) continue;
    try { next = figma.variables.setBoundVariableForEffect(next, field, target); } catch {}
  }
  return next;
}

async function remapNodeBindings(node, registryMeta, targetRegistry) {
  if (node.boundVariables && typeof node.setBoundVariable === 'function') {
    for (const [field, aliasOrAliases] of Object.entries(node.boundVariables)) {
      const alias = Array.isArray(aliasOrAliases) ? aliasOrAliases[0] : aliasOrAliases;
      const canonicalId = await canonicalForSourceVariableAlias(alias, registryMeta);
      if (!canonicalId) continue;
      const target = await variableForCanonical(targetRegistry, canonicalId);
      if (!target) continue;
      try { node.setBoundVariable(field, target); } catch {}
    }
  }

  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
    try { node.fills = await Promise.all(node.fills.map((paint) => remapPaintBindings(paint, registryMeta, targetRegistry))); } catch {}
  }
  if ('strokes' in node && node.strokes !== figma.mixed && Array.isArray(node.strokes)) {
    try { node.strokes = await Promise.all(node.strokes.map((paint) => remapPaintBindings(paint, registryMeta, targetRegistry))); } catch {}
  }
  if ('effects' in node && node.effects !== figma.mixed && Array.isArray(node.effects)) {
    try { node.effects = await Promise.all(node.effects.map((effect) => remapEffectBindings(effect, registryMeta, targetRegistry))); } catch {}
  }

  const styleFields = [
    ['fillStyleId', 'setFillStyleIdAsync'],
    ['strokeStyleId', 'setStrokeStyleIdAsync'],
    ['textStyleId', 'setTextStyleIdAsync'],
    ['effectStyleId', 'setEffectStyleIdAsync'],
    ['gridStyleId', 'setGridStyleIdAsync']
  ];
  for (const [field, setter] of styleFields) {
    if (!(field in node) || !node[field] || typeof node[setter] !== 'function') continue;
    let sourceStyle = null;
    try { sourceStyle = await figma.getStyleByIdAsync?.(node[field]); } catch {}
    const canonicalId = sourceStyle?.name ? registryMeta.styleNames?.[sourceStyle.name] : null;
    if (!canonicalId) continue;
    const targetStyle = await styleForCanonical(targetRegistry, canonicalId);
    if (!targetStyle) continue;
    try { await node[setter](targetStyle.id); } catch {}
  }

  if ('children' in node) {
    for (const child of node.children) await remapNodeBindings(child, registryMeta, targetRegistry);
  }
}

function copyNodeSurface(source, target) {
  const fields = [
    'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode',
    'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent',
    'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing',
    'counterAxisSpacing', 'layoutWrap', 'clipsContent', 'opacity',
    'blendMode', 'rotation', 'cornerRadius', 'topLeftRadius', 'topRightRadius',
    'bottomLeftRadius', 'bottomRightRadius', 'strokeWeight', 'strokeAlign',
    'strokeCap', 'strokeJoin', 'dashPattern', 'constraints', 'layoutAlign', 'layoutGrow'
  ];
  for (const field of fields) {
    if (!(field in source) || !(field in target)) continue;
    try { target[field] = source[field]; } catch {}
  }
  for (const field of ['fills', 'strokes', 'effects']) {
    if (!(field in source) || !(field in target) || source[field] === figma.mixed) continue;
    try { target[field] = source[field]; } catch {}
  }
  try { target.resizeWithoutConstraints(source.width, source.height); } catch {}
}

function replaceComponentContents(source, target) {
  copyNodeSurface(source, target);
  const oldChildren = [...target.children];
  for (const child of oldChildren) {
    try { child.remove(); } catch {}
  }
  for (const child of source.children) {
    try { target.appendChild(child.clone()); } catch {}
  }
}

async function detachedFromRemoteComponent(remoteComponent) {
  const instance = remoteComponent.createInstance();
  const detached = instance.detachInstance();
  return detached;
}

async function projectSingleComponent(entry, registryMeta, targetRegistry, existingByCanonical) {
  const remote = await figma.importComponentByKeyAsync(entry.key);
  const detached = await detachedFromRemoteComponent(remote);
  await remapNodeBindings(detached, registryMeta, targetRegistry);

  let target = existingByCanonical.get(entry.canonicalId);
  if (!target || target.type !== 'COMPONENT') {
    target = figma.createComponentFromNode(detached);
  } else {
    replaceComponentContents(detached, target);
    try { detached.remove(); } catch {}
  }

  target.name = entry.name;
  target.setPluginData(COMPONENT_KEYS.masterComponentId, entry.canonicalId);
  target.setPluginData(COMPONENT_KEYS.masterComponentKey, entry.key);
  target.setPluginData(COMPONENT_KEYS.masterComponentRevision, masterAssetRevision(entry));
  return target;
}

async function projectComponentSet(entry, registryMeta, targetRegistry, existingByCanonical) {
  const existingSet = existingByCanonical.get(entry.canonicalId);
  const existingVariants = new Map();
  if (existingSet?.type === 'COMPONENT_SET') {
    for (const child of existingSet.children) {
      if (child.type !== 'COMPONENT') continue;
      const id = child.getPluginData(COMPONENT_KEYS.masterComponentId);
      if (id) existingVariants.set(id, child);
    }
  }

  const projected = [];
  for (const variant of entry.variants || []) {
    const remote = await figma.importComponentByKeyAsync(variant.key);
    const detached = await detachedFromRemoteComponent(remote);
    await remapNodeBindings(detached, registryMeta, targetRegistry);

    let local = existingVariants.get(variant.canonicalId);
    if (local) {
      replaceComponentContents(detached, local);
      try { detached.remove(); } catch {}
    } else {
      local = figma.createComponentFromNode(detached);
    }
    local.name = variant.name;
    local.setPluginData(COMPONENT_KEYS.masterComponentId, variant.canonicalId);
    local.setPluginData(COMPONENT_KEYS.masterComponentKey, variant.key);
    projected.push(local);
  }

  let set = existingSet;
  if (!set || set.type !== 'COMPONENT_SET') {
    if (!projected.length) return null;
    set = figma.combineAsVariants(projected, figma.currentPage);
  } else {
    for (const local of projected) {
      if (local.parent !== set) set.appendChild(local);
    }
    const wanted = new Set((entry.variants || []).map((item) => item.canonicalId));
    for (const child of [...set.children]) {
      if (child.type !== 'COMPONENT') continue;
      const id = child.getPluginData(COMPONENT_KEYS.masterComponentId);
      if (id && !wanted.has(id)) {
        try { child.remove(); } catch {}
      }
    }
  }

  set.name = entry.name;
  set.setPluginData(COMPONENT_KEYS.masterComponentId, entry.canonicalId);
  set.setPluginData(COMPONENT_KEYS.masterComponentKey, entry.key);
  set.setPluginData(COMPONENT_KEYS.masterComponentRevision, masterAssetRevision(entry));
  return set;
}

async function syncMasterFigmaAssets() {
  const target = currentLibraryTarget();
  if (!target || !target.startsWith('flavour:')) {
    throw new Error('Apply the selected Flavour foundations to this dedicated Flavour library before syncing master Figma assets.');
  }

  const response = await repositoryBridgeRequest('/master-assets');
  const registryMeta = response.registry;
  if (!registryMeta?.assets?.length) {
    throw new Error('No master component registryMeta exists yet. Open the Baseline library and capture its published Components first.');
  }

  const targetRegistry = readBindingRegistry();
  const existing = await localComponentRoots();
  const existingByCanonical = new Map(
    existing
      .map((node) => [node.getPluginData(COMPONENT_KEYS.masterComponentId), node])
      .filter(([id]) => id)
  );

  let createdOrUpdated = 0;
  for (const entry of registryMeta.assets) {
    if (entry.kind === 'COMPONENT_SET') {
      const node = await projectComponentSet(entry, registryMeta, targetRegistry, existingByCanonical);
      if (node) createdOrUpdated += 1;
    } else {
      await projectSingleComponent(entry, registryMeta, targetRegistry, existingByCanonical);
      createdOrUpdated += 1;
    }
  }

  return {
    count: createdOrUpdated,
    sourceRegisteredAt: registryMeta.registeredAt,
    target
  };
}


async function syncSystemLayer(layer, flavourId) {
  const definition = layerDefinition(layer);
  if (!definition) throw new Error(`Unknown BufferCore Figma layer: ${layer}`);
  if (!flavourId) throw new Error('Choose a Flavour before syncing a Flavour library layer.');

  setSystemIdentity({ layer, role: 'flavour', flavourId });

  if (layer === 'foundations') {
    throw new Error('Foundations are synced with Pull + resolve, Inspect and Apply. Register the published Flavour Foundations after applying them.');
  }

  const family = await assertLayerDependencies(layer, flavourId);
  const master = family.layers?.[layer]?.master;
  if (!master?.assets?.length) {
    throw new Error(`BC: ${definition.name} has not been registered, or contains no published Components/Component Sets.`);
  }

  // Current Flavour file may not contain local Foundation variables/styles.
  // Load the published Flavour Foundation bindings by key when rebinding master assets.
  const targetRegistry = { variables: {}, styles: {} };
  const foundationFlavour = family.layers?.foundations?.flavour;

  for (const canonicalId of Object.keys(foundationFlavour?.bindings?.variables || {})) {
    const variable = await importFlavourVariableForCanonical(canonicalId, family);
    if (variable) targetRegistry.variables[canonicalId] = variable.id;
  }
  for (const canonicalId of Object.keys(foundationFlavour?.bindings?.styles || {})) {
    const style = await importFlavourStyleForCanonical(canonicalId, family);
    if (style) targetRegistry.styles[canonicalId] = style.id;
  }

  const registryMeta = {
    source: 'published-figma-master-library-family',
    sourceFile: master.fileName,
    sourceLibraryTarget: `master:${layer}`,
    registeredAt: master.registeredAt,
    bindingRegistry: family.layers?.foundations?.master?.bindings
      ? {
          variables: Object.fromEntries(Object.entries(family.layers.foundations.master.bindings.variables || {}).map(([id, value]) => [id, value.id || value.figmaId || ''])),
          styles: Object.fromEntries(Object.entries(family.layers.foundations.master.bindings.styles || {}).map(([id, value]) => [id, value.id || value.figmaId || '']))
        }
      : { variables: {}, styles: {} },
    variableNames: Object.fromEntries(Object.entries(family.layers?.foundations?.master?.bindings?.variables || {}).map(([id, value]) => [value.name, id])),
    styleNames: Object.fromEntries(Object.entries(family.layers?.foundations?.master?.bindings?.styles || {}).map(([id, value]) => [value.name, id])),
    assets: master.assets
  };

  // Map source alias IDs by importing published master Foundation variables by key.
  for (const [canonicalId, value] of Object.entries(family.layers?.foundations?.master?.bindings?.variables || {})) {
    if (!value?.key || typeof figma.variables.importVariableByKeyAsync !== 'function') continue;
    try {
      const imported = await figma.variables.importVariableByKeyAsync(value.key);
      registryMeta.bindingRegistry.variables[canonicalId] = imported.id;
      if (imported.name) registryMeta.variableNames[imported.name] = canonicalId;
    } catch {}
  }
  for (const [canonicalId, value] of Object.entries(family.layers?.foundations?.master?.bindings?.styles || {})) {
    if (!value?.key || typeof figma.importStyleByKeyAsync !== 'function') continue;
    try {
      const imported = await figma.importStyleByKeyAsync(value.key);
      registryMeta.bindingRegistry.styles[canonicalId] = imported.id;
      if (imported.name) registryMeta.styleNames[imported.name] = canonicalId;
    } catch {}
  }

  const existing = await localComponentRoots();
  const existingByCanonical = new Map(
    existing
      .map((node) => [node.getPluginData(COMPONENT_KEYS.masterComponentId), node])
      .filter(([id]) => id)
  );

  let synced = 0;
  const residual = [];
  for (const entry of master.assets) {
    let projected = null;
    if (entry.kind === 'COMPONENT_SET') {
      projected = await projectComponentSet(entry, registryMeta, targetRegistry, existingByCanonical);
    } else {
      projected = await projectSingleComponent(entry, registryMeta, targetRegistry, existingByCanonical);
    }
    if (!projected) continue;

    await remapNestedMasterInstances(projected, family);
    const left = await assertNoResidualMasterDependencies(projected, family);
    residual.push(...left);
    synced += 1;
  }

  if (residual.length) {
    throw new Error(`Sync stopped: ${residual.length} nested BufferCore master instance(s) could not be translated to ${flavourId} equivalents. Publish/register the required upstream Flavour layer first.`);
  }

  return {
    layer,
    flavourId,
    synced,
    masterRegisteredAt: master.registeredAt,
    dependencies: definition.dependencies,
    residualMasterDependencies: 0
  };
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


const PROJECT_THEME_KEYS = Object.freeze({
  flavourId: 'buffercore.project.flavourId',
  flavourName: 'buffercore.project.flavourName',
  appliedAt: 'buffercore.project.appliedAt',
  adapterCollection: 'buffercore.project.adapterCollection',
  adapterVariable: 'buffercore.project.adapterVariable',
  adapterStyle: 'buffercore.project.adapterStyle',
  sourceCanonical: 'buffercore.project.sourceCanonical',
  sourceStyleCanonical: 'buffercore.project.sourceStyleCanonical',
  autoReconcile: 'buffercore.project.autoReconcile'
});

function normaliseFigmaName(value) {
  return String(value || '').split('/').map((part) => part.trim()).join('/').replace(/\s+/g, ' ').trim();
}

function projectAutoReconcileEnabled() {
  return figma.root.getPluginData(PROJECT_THEME_KEYS.autoReconcile) !== 'false';
}

function projectThemeIdentity() {
  return {
    flavourId: figma.root.getPluginData(PROJECT_THEME_KEYS.flavourId) || null,
    flavourName: figma.root.getPluginData(PROJECT_THEME_KEYS.flavourName) || null,
    appliedAt: figma.root.getPluginData(PROJECT_THEME_KEYS.appliedAt) || null,
    autoReconcileEnabled: projectAutoReconcileEnabled()
  };
}

function stampProjectTheme(manifest) {
  const flavourId = manifest?.flavour?.id || manifest?.repository?.flavour || null;
  const flavourName = manifest?.flavour?.displayName || manifest?.flavour?.name || flavourId;
  if (!flavourId) throw new Error('A resolved Flavour manifest is required to theme a project file.');
  figma.root.setPluginData(PROJECT_THEME_KEYS.flavourId, String(flavourId));
  figma.root.setPluginData(PROJECT_THEME_KEYS.flavourName, String(flavourName || flavourId));
  figma.root.setPluginData(PROJECT_THEME_KEYS.appliedAt, new Date().toISOString());
  if (!figma.root.getPluginData(PROJECT_THEME_KEYS.autoReconcile)) {
    figma.root.setPluginData(PROJECT_THEME_KEYS.autoReconcile, 'true');
  }
}

async function localProjectAdapterCollections(flavourId) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return collections.filter((collection) => (
    collection.getPluginData(PROJECT_THEME_KEYS.adapterCollection) === flavourId
  ));
}

async function removeExistingProjectThemeAdapter(flavourId) {
  const styles = [
    ...await figma.getLocalTextStylesAsync(),
    ...await figma.getLocalEffectStylesAsync()
  ];
  for (const style of styles) {
    if (style.getPluginData(PROJECT_THEME_KEYS.adapterStyle) !== flavourId) continue;
    try { style.remove(); } catch {}
  }

  const variables = await figma.variables.getLocalVariablesAsync();
  for (const variable of variables) {
    if (variable.getPluginData(PROJECT_THEME_KEYS.adapterVariable) !== flavourId) continue;
    try { variable.remove(); } catch {}
  }

  const collections = await localProjectAdapterCollections(flavourId);
  for (const collection of collections) {
    try { collection.remove(); } catch {}
  }
}

function projectCanonicalIndexes(manifest) {
  const byName = new Map();
  const byCss = new Map();
  for (const definition of manifest?.variables || []) {
    for (const name of [definition.name, definition.figmaName]) {
      const normalised = normaliseFigmaName(name);
      if (normalised) byName.set(normalised, definition.id);
    }
    if (definition.cssVariable) byCss.set(definition.cssVariable, definition.id);
  }
  const styleByName = new Map((manifest?.styles || []).map((style) => [normaliseFigmaName(style.name), style.id]));
  return { byName, byCss, styleByName };
}

function canonicalByPublishedKey(bindings = {}) {
  const result = new Map();
  for (const [canonicalId, item] of Object.entries(bindings || {})) {
    if (item?.key) result.set(item.key, canonicalId);
  }
  return result;
}

async function projectSourceVariableCanonical(alias, indexes, sourceFamilies = []) {
  if (!alias?.id) return null;
  let source = null;
  try { source = await figma.variables.getVariableByIdAsync(alias.id); } catch {}
  if (!source) return null;

  for (const family of sourceFamilies) {
    const canonical = family.variableKeyToCanonical?.get(source.key);
    if (canonical) return canonical;
  }

  const canonical = source.getPluginData?.(BUFFERCORE_KEYS.variableId);
  if (canonical) return canonical;

  const webSyntax = source.codeSyntax?.WEB || null;
  if (webSyntax) {
    const match = String(webSyntax).match(/var\((--[^)]+)\)/);
    if (match && indexes.byCss.has(match[1])) return indexes.byCss.get(match[1]);
  }

  return indexes.byName.get(normaliseFigmaName(source.name)) || null;
}

async function projectSourceStyleCanonical(styleId, indexes, sourceFamilies = []) {
  if (!styleId || styleId === figma.mixed) return null;
  let style = null;
  try { style = await figma.getStyleByIdAsync?.(styleId); } catch {}
  if (!style) return null;

  for (const family of sourceFamilies) {
    const canonical = family.styleKeyToCanonical?.get(style.key);
    if (canonical) return canonical;
  }

  const canonical = style.getPluginData?.(BUFFERCORE_KEYS.styleId);
  if (canonical) return canonical;

  return indexes.styleByName.get(normaliseFigmaName(style.name)) || null;
}


function contextDomain(manifest, domainId) {
  return manifest?.contextContracts?.domains?.[domainId] || null;
}

function contextTargetMappings(domain, targetId) {
  if (!domain) return null;
  if (targetId === 'context') {
    return Object.fromEntries(
      Object.entries(domain.slots || {}).map(([cssVariable]) => [cssVariable, cssVariable])
    );
  }
  return domain.targets?.[targetId]?.mappings || null;
}

function buildContextRemapCssPlan(manifest, domainId, sourceTargetId, destinationTargetId) {
  const domain = contextDomain(manifest, domainId);
  if (!domain) throw new Error(`Unknown Context domain: ${domainId}.`);

  const sourceMappings = contextTargetMappings(domain, sourceTargetId);
  const destinationMappings = contextTargetMappings(domain, destinationTargetId);
  if (!sourceMappings) throw new Error(`Unknown Context source target: ${sourceTargetId}.`);
  if (!destinationMappings) throw new Error(`Unknown Context destination target: ${destinationTargetId}.`);

  const sourceCssToSlots = new Map();
  for (const slotCss of Object.keys(domain.slots || {})) {
    const sourceCss = sourceMappings[slotCss];
    if (!sourceCss) continue;
    if (!sourceCssToSlots.has(sourceCss)) sourceCssToSlots.set(sourceCss, []);
    sourceCssToSlots.get(sourceCss).push(slotCss);
  }

  const mappings = {};
  const ambiguous = [];
  const missing = [];

  for (const [sourceCss, slots] of sourceCssToSlots.entries()) {
    const destinations = [...new Set(
      slots.map((slotCss) => destinationMappings[slotCss]).filter(Boolean)
    )];

    if (!destinations.length) {
      missing.push({ sourceCss, slots });
      continue;
    }

    if (destinations.length > 1) {
      ambiguous.push({ sourceCss, slots, destinations });
      continue;
    }

    const destinationCss = destinations[0];
    if (sourceCss !== destinationCss) mappings[sourceCss] = destinationCss;
  }

  return {
    domainId,
    sourceTargetId,
    destinationTargetId,
    mappings,
    ambiguous,
    missing
  };
}

function buildContextRemapCanonicalPlan(manifest, domainId, sourceTargetId, destinationTargetId) {
  const cssPlan = buildContextRemapCssPlan(manifest, domainId, sourceTargetId, destinationTargetId);
  const byCss = new Map((manifest?.variables || [])
    .filter((item) => item?.cssVariable && item?.id)
    .map((item) => [item.cssVariable, item.id]));

  const mappings = {};
  const unavailable = [];

  for (const [sourceCss, destinationCss] of Object.entries(cssPlan.mappings)) {
    const sourceCanonical = byCss.get(sourceCss);
    const destinationCanonical = byCss.get(destinationCss);
    if (!sourceCanonical || !destinationCanonical) {
      unavailable.push({
        sourceCss,
        destinationCss,
        sourceCanonical: sourceCanonical || null,
        destinationCanonical: destinationCanonical || null
      });
      continue;
    }
    mappings[sourceCanonical] = destinationCanonical;
  }

  return { ...cssPlan, mappings, unavailable };
}

function availableFigmaContextDomains(manifest) {
  const emittedCss = new Set((manifest?.variables || []).map((item) => item?.cssVariable).filter(Boolean));
  const result = [];

  for (const [domainId, domain] of Object.entries(manifest?.contextContracts?.domains || {})) {
    const emittedSlots = Object.keys(domain.slots || {}).filter((cssVariable) => emittedCss.has(cssVariable));
    const availableTargets = Object.entries(domain.targets || {}).filter(([, target]) => (
      emittedSlots.some((slotCss) => emittedCss.has(target.mappings?.[slotCss]))
    ));

    if (!emittedSlots.length || !availableTargets.length) continue;

    result.push({
      id: domainId,
      label: domainId.charAt(0).toUpperCase() + domainId.slice(1),
      slotCount: emittedSlots.length,
      targets: [
        { id: 'context', label: 'Context' },
        ...availableTargets.map(([id, target]) => ({ id, label: target.label || id }))
      ]
    });
  }

  return result;
}


async function collectSelectionCanonicalBindings(node, indexes, sourceFamilies, counts) {
  const recordAlias = async (alias) => {
    const canonicalId = await projectSourceVariableCanonical(alias, indexes, sourceFamilies);
    if (!canonicalId) return;
    counts.set(canonicalId, (counts.get(canonicalId) || 0) + 1);
  };

  for (const aliasOrAliases of Object.values(node?.boundVariables || {})) {
    const aliases = Array.isArray(aliasOrAliases) ? aliasOrAliases : [aliasOrAliases];
    for (const alias of aliases) await recordAlias(alias);
  }

  for (const paints of [node?.fills, node?.strokes]) {
    if (paints === figma.mixed || !Array.isArray(paints)) continue;
    for (const paint of paints) {
      for (const alias of Object.values(paint?.boundVariables || {})) await recordAlias(alias);
    }
  }

  if (node?.effects !== figma.mixed && Array.isArray(node?.effects)) {
    for (const effect of node.effects) {
      for (const alias of Object.values(effect?.boundVariables || {})) await recordAlias(alias);
    }
  }

  if ('children' in node) {
    for (const child of node.children) {
      await collectSelectionCanonicalBindings(child, indexes, sourceFamilies, counts);
    }
  }
}

function contextTargetCanonicalIds(manifest, domainId, targetId) {
  const domain = contextDomain(manifest, domainId);
  if (!domain) return new Set();

  const cssMappings = contextTargetMappings(domain, targetId);
  if (!cssMappings) return new Set();

  const byCss = new Map((manifest?.variables || [])
    .filter((item) => item?.cssVariable && item?.id)
    .map((item) => [item.cssVariable, item.id]));

  return new Set(
    Object.values(cssMappings)
      .map((cssVariable) => byCss.get(cssVariable))
      .filter(Boolean)
  );
}

async function detectSelectionContextTargets(manifest) {
  const selection = [...(figma.currentPage.selection || [])];
  if (!selection.length) {
    return { selectionCount: 0, domains: {} };
  }

  const family = await familyState(manifest?.flavour?.id || null);
  const foundations = [
    family?.layers?.foundations?.master,
    family?.layers?.foundations?.flavour
  ].filter(Boolean);

  const sourceFamilies = foundations.map((item) => ({
    variableKeyToCanonical: canonicalByPublishedKey(item.bindings?.variables),
    styleKeyToCanonical: canonicalByPublishedKey(item.bindings?.styles)
  }));

  const indexes = projectCanonicalIndexes(manifest);
  const counts = new Map();

  for (const node of selection) {
    await collectSelectionCanonicalBindings(node, indexes, sourceFamilies, counts);
  }

  const domains = {};

  for (const [domainId, domain] of Object.entries(manifest?.contextContracts?.domains || {})) {
    const candidates = [
      { id: 'context', label: 'Context' },
      ...Object.entries(domain.targets || {}).map(([id, target]) => ({
        id,
        label: target.label || id
      }))
    ];

    const scored = candidates.map((candidate) => {
      const ids = contextTargetCanonicalIds(manifest, domainId, candidate.id);
      let score = 0;
      let matchedTokens = 0;
      for (const canonicalId of ids) {
        const count = counts.get(canonicalId) || 0;
        if (count) {
          score += count;
          matchedTokens += 1;
        }
      }
      return { ...candidate, score, matchedTokens };
    }).filter((item) => item.score > 0);

    scored.sort((a, b) => b.score - a.score || b.matchedTokens - a.matchedTokens);

    if (!scored.length) {
      domains[domainId] = { status: 'none', targetId: null, label: null, score: 0 };
      continue;
    }

    const top = scored[0];
    const tied = scored.filter((item) => item.score === top.score && item.matchedTokens === top.matchedTokens);

    domains[domainId] = tied.length === 1
      ? { status: 'detected', targetId: top.id, label: top.label, score: top.score, matchedTokens: top.matchedTokens }
      : { status: 'mixed', targetId: null, label: 'Mixed', score: top.score, matchedTokens: top.matchedTokens };
  }

  return {
    selectionCount: selection.length,
    bindingCount: [...counts.values()].reduce((sum, count) => sum + count, 0),
    domains
  };
}

async function buildCoreContextRemapRuntime(manifest, domainId, sourceTargetId, destinationTargetId) {
  const plan = buildContextRemapCanonicalPlan(manifest, domainId, sourceTargetId, destinationTargetId);
  const family = await familyState();
  const masterFoundations = family?.layers?.foundations?.master;

  if (!masterFoundations) {
    throw new Error('BC: Foundations must be published and registered before Context Remap can import target variables.');
  }

  return {
    plan,
    indexes: projectCanonicalIndexes(manifest),
    sourceFamilies: [{
      variableKeyToCanonical: canonicalByPublishedKey(masterFoundations.bindings?.variables),
      styleKeyToCanonical: canonicalByPublishedKey(masterFoundations.bindings?.styles)
    }],
    masterFoundations,
    importedVariables: new Map()
  };
}

async function coreContextTargetVariable(canonicalId, runtime, report) {
  if (runtime.importedVariables.has(canonicalId)) return runtime.importedVariables.get(canonicalId);

  const item = runtime.masterFoundations.bindings?.variables?.[canonicalId];
  if (!item?.key) {
    report.unresolved += 1;
    return null;
  }

  try {
    const variable = await figma.variables.importVariableByKeyAsync(item.key);
    runtime.importedVariables.set(canonicalId, variable);
    report.variablesImported += 1;
    return variable;
  } catch (error) {
    report.errors.push(`${canonicalId}: ${serialiseError(error)}`);
    return null;
  }
}

async function coreContextMappedVariable(alias, runtime, report) {
  const canonicalId = await projectSourceVariableCanonical(alias, runtime.indexes, runtime.sourceFamilies);
  if (!canonicalId) return null;

  const targetCanonical = runtime.plan.mappings[canonicalId];
  if (!targetCanonical) return null;

  return coreContextTargetVariable(targetCanonical, runtime, report);
}

async function remapContextPaints(paints, runtime, report) {
  if (paints === figma.mixed || !Array.isArray(paints)) return paints;
  const result = [];

  for (const paint of paints) {
    let next = paint;
    for (const [field, alias] of Object.entries(paint?.boundVariables || {})) {
      const target = await coreContextMappedVariable(alias, runtime, report);
      if (!target) continue;
      try {
        next = figma.variables.setBoundVariableForPaint(next, field, target);
        report.rebound += 1;
      } catch (error) {
        report.errors.push(serialiseError(error));
      }
    }
    result.push(next);
  }

  return result;
}

async function remapContextEffects(effects, runtime, report) {
  if (effects === figma.mixed || !Array.isArray(effects)) return effects;
  const result = [];

  for (const effect of effects) {
    let next = effect;
    for (const [field, alias] of Object.entries(effect?.boundVariables || {})) {
      const target = await coreContextMappedVariable(alias, runtime, report);
      if (!target) continue;
      try {
        next = figma.variables.setBoundVariableForEffect(next, field, target);
        report.rebound += 1;
      } catch (error) {
        report.errors.push(serialiseError(error));
      }
    }
    result.push(next);
  }

  return result;
}

async function remapContextNode(node, runtime, report) {
  report.nodesScanned += 1;

  if (node.boundVariables && typeof node.setBoundVariable === 'function') {
    for (const [field, aliasOrAliases] of Object.entries(node.boundVariables)) {
      const aliases = Array.isArray(aliasOrAliases) ? aliasOrAliases : [aliasOrAliases];
      for (const alias of aliases) {
        const target = await coreContextMappedVariable(alias, runtime, report);
        if (!target) continue;

        try {
          node.setBoundVariable(field, target);
          report.rebound += 1;
        } catch (error) {
          report.errors.push(serialiseError(error));
        }
        break;
      }
    }
  }

  if ('fills' in node) {
    try { node.fills = await remapContextPaints(node.fills, runtime, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }
  if ('strokes' in node) {
    try { node.strokes = await remapContextPaints(node.strokes, runtime, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }
  if ('effects' in node) {
    try { node.effects = await remapContextEffects(node.effects, runtime, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }

  if ('children' in node) {
    for (const child of node.children) {
      await remapContextNode(child, runtime, report);
    }
  }
}

async function remapContextSelection(manifest, domainId, sourceTargetId, destinationTargetId) {
  const selection = [...(figma.currentPage.selection || [])];
  if (!selection.length) throw new Error('Select at least one object or component before remapping Context.');

  if (sourceTargetId === destinationTargetId) {
    throw new Error('Choose different source and destination Context targets.');
  }

  const runtime = await buildCoreContextRemapRuntime(manifest, domainId, sourceTargetId, destinationTargetId);
  const report = {
    nodesScanned: 0,
    rebound: 0,
    variablesImported: 0,
    unresolved: 0,
    ambiguousMappings: runtime.plan.ambiguous.length,
    unavailableMappings: runtime.plan.unavailable.length,
    errors: []
  };

  for (const node of selection) {
    await remapContextNode(node, runtime, report);
  }

  return {
    domainId,
    sourceTargetId,
    destinationTargetId,
    selectionCount: selection.length,
    mappingCount: Object.keys(runtime.plan.mappings).length,
    plan: {
      ambiguous: runtime.plan.ambiguous,
      unavailable: runtime.plan.unavailable,
      missing: runtime.plan.missing
    },
    report: {
      ...report,
      errors: [...new Set(report.errors)].slice(0, 20)
    }
  };
}


function contextTargetLabel(manifest, domainId, targetId) {
  if (targetId === 'context') return 'Context';
  const domain = contextDomain(manifest, domainId);
  const target = domain?.targets?.[targetId];
  if (target?.label) return target.label;
  return String(targetId || '').replace(/(^|[-_\s])([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
}

function contextSetGeneratedName(originalName, targetLabel) {
  const base = String(originalName || 'Untitled').replace(/\s+\/\s+(Context|Neutral|Primary|Secondary|Accent|Success|Warning|Error|Info)$/i, '');
  return `${base} / ${targetLabel}`;
}

function canPositionGeneratedSibling(node) {
  const parent = node?.parent;
  if (!parent || parent.type === 'DOCUMENT' || parent.type === 'PAGE') return true;
  if ('layoutMode' in parent && parent.layoutMode && parent.layoutMode !== 'NONE') return false;
  return true;
}

function positionGeneratedSibling(original, clone, index, gap = 24) {
  if (!canPositionGeneratedSibling(clone)) return;
  if (!('x' in original) || !('y' in original) || !('x' in clone) || !('y' in clone)) return;

  const width = Number(original.width) || 0;
  try {
    clone.x = original.x + ((width + gap) * index);
    clone.y = original.y;
  } catch {}
}


const BUFFERCORE_STATE_KEYS = Object.freeze({
  appliedState: 'buffercore.appliedState'
});

function stateSemanticCanonicalId(manifest, stateId) {
  if (stateId === 'disabled') {
    return (manifest?.variables || []).find(
      (item) => item?.cssVariable === '--bc-interaction-disabled-opacity'
    )?.id || null;
  }
  return null;
}

async function buildStateTransformRuntime(manifest, stateIds = []) {
  const requested = [...new Set((stateIds || []).filter(Boolean))]
    .filter((stateId) => stateId !== 'default');

  const runtime = {
    requested,
    variables: new Map(),
    foundationBindings: null
  };

  if (!requested.length) return runtime;

  for (const stateId of requested) {
    if (!stateSemanticCanonicalId(manifest, stateId)) {
      throw new Error(`The active Foundation manifest does not expose the ${stateId} state semantic.`);
    }
  }

  const activeProject = projectThemeIdentity();
  if (activeProject?.flavourId) {
    try {
      const flavourFamily = await familyState(activeProject.flavourId);
      const flavourFoundations = flavourFamily?.layers?.foundations?.flavour;
      if (flavourFoundations) runtime.foundationBindings = flavourFoundations;
    } catch {}
  }

  if (!runtime.foundationBindings) {
    const family = await familyState();
    runtime.foundationBindings = family?.layers?.foundations?.master || null;
  }

  if (!runtime.foundationBindings) {
    throw new Error('A published and registered BufferCore Foundations library is required before applying generated states.');
  }

  for (const stateId of requested) {
    const canonicalId = stateSemanticCanonicalId(manifest, stateId);
    if (!runtime.foundationBindings.bindings?.variables?.[canonicalId]?.key) {
      throw new Error(
        `The current Foundation build contains ${stateId}, but the registered published Foundations library is out of date. `
        + `Rebuild BC: Foundations, publish it in Figma, then register Master Foundations again.`
      );
    }
  }

  return runtime;
}

async function stateTransformVariable(manifest, stateId, runtime, report) {
  if (runtime.variables.has(stateId)) return runtime.variables.get(stateId);

  const canonicalId = stateSemanticCanonicalId(manifest, stateId);
  const item = runtime.foundationBindings?.bindings?.variables?.[canonicalId];

  if (!canonicalId || !item?.key) {
    report.unresolved += 1;
    return null;
  }

  try {
    const variable = await figma.variables.importVariableByKeyAsync(item.key);
    runtime.variables.set(stateId, variable);
    report.variablesImported += 1;
    return variable;
  } catch (error) {
    report.errors.push(`${stateId}: ${serialiseError(error)}`);
    return null;
  }
}

async function applyStateTransform(node, manifest, stateId, runtime, report) {
  if (!stateId || stateId === 'default') return true;

  if (stateId === 'disabled') {
    const variable = await stateTransformVariable(manifest, stateId, runtime, report);
    if (!variable) return false;

    if (typeof node?.setBoundVariable !== 'function') {
      report.errors.push(`${node?.name || node?.type || 'Selection'}: opacity cannot be variable-bound.`);
      return false;
    }

    try {
      node.setBoundVariable('opacity', variable);
      node.setPluginData?.(BUFFERCORE_STATE_KEYS.appliedState, 'disabled');
      report.stateBindings += 1;
      return true;
    } catch (error) {
      report.errors.push(`${node?.name || node?.type || 'Selection'}: ${serialiseError(error)}`);
      return false;
    }
  }

  report.errors.push(`Unknown generated state: ${stateId}.`);
  return false;
}

function generatedStateLabel(stateId) {
  return stateId === 'disabled' ? 'Disabled' : 'Default';
}

function disabledCopyName(originalName) {
  const base = String(originalName || 'Untitled').replace(/\s+\/\s+Disabled$/i, '');
  return `${base} / Disabled`;
}

async function generateDisabledCopies(manifest, options = {}) {
  const selection = [...(figma.currentPage.selection || [])];
  if (!selection.length) throw new Error('Select at least one object or component before creating a Disabled copy.');

  const stateRuntime = await buildStateTransformRuntime(manifest, ['disabled']);
  const generated = [];
  const report = {
    sourceCount: selection.length,
    generatedCount: 0,
    stateBindings: 0,
    variablesImported: 0,
    unresolved: 0,
    errors: []
  };

  for (const original of selection) {
    if (typeof original.clone !== 'function') {
      report.errors.push(`${original.name || original.type}: this node cannot be cloned.`);
      continue;
    }

    let clone;
    try {
      clone = original.clone();
      clone.name = disabledCopyName(original.name);
      positionGeneratedSibling(original, clone, 1);
    } catch (error) {
      report.errors.push(`${original.name || original.type}: ${serialiseError(error)}`);
      try { clone?.remove(); } catch {}
      continue;
    }

    const applied = await applyStateTransform(clone, manifest, 'disabled', stateRuntime, report);
    if (!applied) {
      try { clone.remove(); } catch {}
      continue;
    }

    generated.push(clone);
    report.generatedCount += 1;
  }

  if (generated.length) {
    try { figma.currentPage.selection = generated; } catch {}
    if (options.focusResults !== false) {
      try { figma.viewport.scrollAndZoomIntoView(generated); } catch {}
    }
  }

  return {
    stateId: 'disabled',
    report: {
      ...report,
      errors: [...new Set(report.errors)].slice(0, 30)
    }
  };
}


async function generateContextSet(manifest, domainId, sourceTargetId, destinationTargetIds, options = {}) {
  const selection = [...(figma.currentPage.selection || [])];
  if (!selection.length) throw new Error('Select at least one object or component before generating a Context set.');

  const targets = [...new Set((destinationTargetIds || []).filter(Boolean))]
    .filter((targetId) => targetId !== sourceTargetId);

  if (!targets.length) throw new Error('Choose at least one destination Context target.');

  const stateIds = [...new Set((options.stateIds || ['default']).filter(Boolean))];
  if (!stateIds.length) throw new Error('Choose at least one generated state.');

  const supportedStateIds = new Set(['default', 'disabled']);
  for (const stateId of stateIds) {
    if (!supportedStateIds.has(stateId)) throw new Error(`Unknown generated state: ${stateId}.`);
  }

  const domain = contextDomain(manifest, domainId);
  if (!domain) throw new Error(`Unknown Context domain: ${domainId}.`);

  for (const targetId of targets) {
    buildContextRemapCanonicalPlan(manifest, domainId, sourceTargetId, targetId);
  }

  const stateRuntime = await buildStateTransformRuntime(manifest, stateIds);

  const generated = [];
  const totals = {
    sourceCount: selection.length,
    generatedCount: 0,
    nodesScanned: 0,
    rebound: 0,
    stateBindings: 0,
    variablesImported: 0,
    unresolved: 0,
    ambiguousMappings: 0,
    unavailableMappings: 0,
    errors: []
  };

  for (const original of selection) {
    let generatedIndex = 1;

    for (const targetId of targets) {
      const targetLabel = contextTargetLabel(manifest, domainId, targetId);

      let remapRuntime;
      try {
        remapRuntime = await buildCoreContextRemapRuntime(manifest, domainId, sourceTargetId, targetId);
      } catch (error) {
        totals.errors.push(`${targetLabel}: ${serialiseError(error)}`);
        continue;
      }

      for (const stateId of stateIds) {
        if (typeof original.clone !== 'function') {
          totals.errors.push(`${original.name || original.type}: this node cannot be cloned.`);
          continue;
        }

        let clone;
        try {
          clone = original.clone();
        } catch (error) {
          totals.errors.push(`${original.name || original.type}: ${serialiseError(error)}`);
          continue;
        }

        try {
          const defaultName = contextSetGeneratedName(original.name, targetLabel);
          clone.name = stateId === 'disabled'
            ? `${defaultName} / ${generatedStateLabel(stateId)}`
            : defaultName;
        } catch {}

        positionGeneratedSibling(original, clone, generatedIndex);
        generatedIndex += 1;

        try {
          const report = {
            nodesScanned: 0,
            rebound: 0,
            stateBindings: 0,
            variablesImported: 0,
            unresolved: 0,
            ambiguousMappings: remapRuntime.plan.ambiguous.length,
            unavailableMappings: remapRuntime.plan.unavailable.length,
            errors: []
          };

          await remapContextNode(clone, remapRuntime, report);

          const stateApplied = await applyStateTransform(
            clone,
            manifest,
            stateId,
            stateRuntime,
            report
          );

          if (!stateApplied) {
            totals.errors.push(...report.errors);
            try { clone.remove(); } catch {}
            continue;
          }

          totals.nodesScanned += report.nodesScanned;
          totals.rebound += report.rebound;
          totals.stateBindings += report.stateBindings;
          totals.variablesImported += report.variablesImported;
          totals.unresolved += report.unresolved;
          totals.ambiguousMappings += report.ambiguousMappings;
          totals.unavailableMappings += report.unavailableMappings;
          totals.errors.push(...report.errors);

          generated.push(clone);
          totals.generatedCount += 1;
        } catch (error) {
          totals.errors.push(`${targetLabel} / ${generatedStateLabel(stateId)}: ${serialiseError(error)}`);
          try { clone.remove(); } catch {}
        }
      }
    }
  }

  if (generated.length) {
    try { figma.currentPage.selection = generated; } catch {}
    if (options.focusResults !== false) {
      try { figma.viewport.scrollAndZoomIntoView(generated); } catch {}
    }
  }

  return {
    domainId,
    sourceTargetId,
    targetIds: targets,
    stateIds,
    targets: targets.map((id) => ({ id, label: contextTargetLabel(manifest, domainId, id) })),
    states: stateIds.map((id) => ({ id, label: generatedStateLabel(id) })),
    report: {
      ...totals,
      errors: [...new Set(totals.errors)].slice(0, 30)
    }
  };
}


function resolvedFlavourExtension(manifest, extensionId) {
  return (manifest?.flavour?.extensions || []).find((item) => item?.id === extensionId) || null;
}

function availableFlavourExtensions(manifest) {
  const emittedIds = new Set((manifest?.variables || []).map((item) => item?.id).filter(Boolean));

  return (manifest?.flavour?.extensions || []).map((extension) => {
    const usableMappings = (extension.mappings || []).filter((mapping) => (
      mapping?.context?.id
      && mapping?.target?.id
      && emittedIds.has(mapping.context.id)
      && emittedIds.has(mapping.target.id)
    ));

    return {
      id: extension.id,
      label: extension.label || extension.id,
      description: extension.description || '',
      domains: extension.domains || [...new Set(usableMappings.map((mapping) => mapping.domain).filter(Boolean))],
      mappingCount: extension.mappingCount ?? extension.mappings?.length ?? 0,
      usableMappingCount: usableMappings.length
    };
  }).filter((extension) => extension.usableMappingCount > 0);
}

function buildFlavourExtensionPlan(manifest, extensionId, direction = 'apply') {
  const extension = resolvedFlavourExtension(manifest, extensionId);
  if (!extension) throw new Error(`Unknown Flavour Extension: ${extensionId}.`);

  const emittedIds = new Set((manifest?.variables || []).map((item) => item?.id).filter(Boolean));
  const mappings = {};
  const unavailable = [];

  for (const mapping of extension.mappings || []) {
    const contextCanonical = mapping?.context?.id;
    const targetCanonical = mapping?.target?.id;
    if (!contextCanonical || !targetCanonical) continue;

    if (!emittedIds.has(contextCanonical) || !emittedIds.has(targetCanonical)) {
      unavailable.push({
        domain: mapping.domain || null,
        contextCanonical,
        targetCanonical
      });
      continue;
    }

    if (direction === 'reset') mappings[targetCanonical] = contextCanonical;
    else mappings[contextCanonical] = targetCanonical;
  }

  return {
    extensionId: extension.id,
    extensionLabel: extension.label || extension.id,
    direction,
    mappings,
    unavailable
  };
}

async function buildFlavourExtensionRuntime(manifest, extensionId, direction) {
  const flavourId = manifest?.flavour?.id;
  if (!flavourId) throw new Error('Resolve a Flavour manifest before using Extensions.');

  const activeProject = projectThemeIdentity();
  if (activeProject.flavourId !== flavourId) {
    throw new Error(`Apply ${manifest.flavour.displayName || flavourId} to this project before using its Extensions.`);
  }

  const family = await familyState(flavourId);
  const flavourFoundations = family?.layers?.foundations?.flavour;
  const masterFoundations = family?.layers?.foundations?.master;

  if (!flavourFoundations) {
    throw new Error(`The published ${manifest.flavour.displayName || flavourId} Foundations library is not registered.`);
  }

  const sourceFamilies = [];
  if (masterFoundations) {
    sourceFamilies.push({
      variableKeyToCanonical: canonicalByPublishedKey(masterFoundations.bindings?.variables),
      styleKeyToCanonical: canonicalByPublishedKey(masterFoundations.bindings?.styles)
    });
  }
  sourceFamilies.push({
    variableKeyToCanonical: canonicalByPublishedKey(flavourFoundations.bindings?.variables),
    styleKeyToCanonical: canonicalByPublishedKey(flavourFoundations.bindings?.styles)
  });

  return {
    plan: buildFlavourExtensionPlan(manifest, extensionId, direction),
    indexes: projectCanonicalIndexes(manifest),
    sourceFamilies,
    targetFoundations: flavourFoundations,
    importedVariables: new Map()
  };
}

async function flavourExtensionTargetVariable(canonicalId, runtime, report) {
  if (runtime.importedVariables.has(canonicalId)) return runtime.importedVariables.get(canonicalId);

  const item = runtime.targetFoundations?.bindings?.variables?.[canonicalId];
  if (!item?.key) {
    report.unresolved += 1;
    return null;
  }

  try {
    const variable = await figma.variables.importVariableByKeyAsync(item.key);
    runtime.importedVariables.set(canonicalId, variable);
    report.variablesImported += 1;
    return variable;
  } catch (error) {
    report.errors.push(`${canonicalId}: ${serialiseError(error)}`);
    return null;
  }
}

async function flavourExtensionMappedVariable(alias, runtime, report) {
  const canonicalId = await projectSourceVariableCanonical(alias, runtime.indexes, runtime.sourceFamilies);
  if (!canonicalId) return null;

  const targetCanonical = runtime.plan.mappings[canonicalId];
  if (!targetCanonical) return null;

  return flavourExtensionTargetVariable(targetCanonical, runtime, report);
}

async function remapFlavourExtensionPaints(paints, runtime, report) {
  if (paints === figma.mixed || !Array.isArray(paints)) return paints;
  const result = [];

  for (const paint of paints) {
    let next = paint;
    for (const [field, alias] of Object.entries(paint?.boundVariables || {})) {
      const target = await flavourExtensionMappedVariable(alias, runtime, report);
      if (!target) continue;
      try {
        next = figma.variables.setBoundVariableForPaint(next, field, target);
        report.rebound += 1;
      } catch (error) {
        report.errors.push(serialiseError(error));
      }
    }
    result.push(next);
  }

  return result;
}

async function remapFlavourExtensionEffects(effects, runtime, report) {
  if (effects === figma.mixed || !Array.isArray(effects)) return effects;
  const result = [];

  for (const effect of effects) {
    let next = effect;
    for (const [field, alias] of Object.entries(effect?.boundVariables || {})) {
      const target = await flavourExtensionMappedVariable(alias, runtime, report);
      if (!target) continue;
      try {
        next = figma.variables.setBoundVariableForEffect(next, field, target);
        report.rebound += 1;
      } catch (error) {
        report.errors.push(serialiseError(error));
      }
    }
    result.push(next);
  }

  return result;
}

async function remapFlavourExtensionNode(node, runtime, report) {
  report.nodesScanned += 1;

  if (node.boundVariables && typeof node.setBoundVariable === 'function') {
    for (const [field, aliasOrAliases] of Object.entries(node.boundVariables)) {
      const aliases = Array.isArray(aliasOrAliases) ? aliasOrAliases : [aliasOrAliases];
      for (const alias of aliases) {
        const target = await flavourExtensionMappedVariable(alias, runtime, report);
        if (!target) continue;
        try {
          node.setBoundVariable(field, target);
          report.rebound += 1;
        } catch (error) {
          report.errors.push(serialiseError(error));
        }
        break;
      }
    }
  }

  if ('fills' in node) {
    try { node.fills = await remapFlavourExtensionPaints(node.fills, runtime, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }
  if ('strokes' in node) {
    try { node.strokes = await remapFlavourExtensionPaints(node.strokes, runtime, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }
  if ('effects' in node) {
    try { node.effects = await remapFlavourExtensionEffects(node.effects, runtime, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }

  if ('children' in node) {
    for (const child of node.children) {
      await remapFlavourExtensionNode(child, runtime, report);
    }
  }
}

async function applyFlavourExtensionToSelection(manifest, extensionId, direction = 'apply') {
  const selection = [...(figma.currentPage.selection || [])];
  if (!selection.length) throw new Error('Select at least one object or component before applying a Flavour Extension.');

  const runtime = await buildFlavourExtensionRuntime(manifest, extensionId, direction);
  const mappingCount = Object.keys(runtime.plan.mappings).length;
  if (!mappingCount) {
    throw new Error(`${runtime.plan.extensionLabel} has no Figma-variable mappings available in this Flavour Foundations library.`);
  }

  const report = {
    nodesScanned: 0,
    rebound: 0,
    variablesImported: 0,
    unresolved: 0,
    unavailableMappings: runtime.plan.unavailable.length,
    errors: []
  };

  for (const node of selection) {
    await remapFlavourExtensionNode(node, runtime, report);
  }

  return {
    flavourId: manifest.flavour.id,
    extensionId: runtime.plan.extensionId,
    extensionLabel: runtime.plan.extensionLabel,
    direction,
    selectionCount: selection.length,
    mappingCount,
    report: {
      ...report,
      errors: [...new Set(report.errors)].slice(0, 20)
    }
  };
}

async function buildProjectFoundationSwapContext(manifest) {
  const flavourId = manifest?.flavour?.id || manifest?.repository?.flavour || null;
  if (!flavourId) throw new Error('Choose and resolve a Flavour before applying it to a project.');

  const family = await familyState(flavourId);
  const masterFoundations = family?.layers?.foundations?.master;
  const flavourFoundations = family?.layers?.foundations?.flavour;

  if (!masterFoundations) {
    throw new Error('BC: Foundations has not been registered. Register the published BC: Foundations library first.');
  }
  if (!flavourFoundations) {
    throw new Error(`No published Foundations library is registered for ${flavourId}. Build the Flavour Foundations file, publish it, then register it.`);
  }

  const sourceFamilies = [{
    variableKeyToCanonical: canonicalByPublishedKey(masterFoundations.bindings?.variables),
    styleKeyToCanonical: canonicalByPublishedKey(masterFoundations.bindings?.styles)
  }];

  const currentFlavourId = projectThemeIdentity().flavourId;
  if (currentFlavourId && currentFlavourId !== flavourId) {
    try {
      const currentFamily = await familyState(currentFlavourId);
      const currentFoundations = currentFamily?.layers?.foundations?.flavour;
      if (currentFoundations) {
        sourceFamilies.push({
          variableKeyToCanonical: canonicalByPublishedKey(currentFoundations.bindings?.variables),
          styleKeyToCanonical: canonicalByPublishedKey(currentFoundations.bindings?.styles)
        });
      }
    } catch {}
  }

  return {
    flavourId,
    masterFoundations,
    flavourFoundations,
    sourceFamilies,
    indexes: projectCanonicalIndexes(manifest),
    importedVariables: new Map(),
    importedStyles: new Map()
  };
}

async function projectTargetVariable(canonicalId, context, report) {
  if (context.importedVariables.has(canonicalId)) return context.importedVariables.get(canonicalId);

  const item = context.flavourFoundations.bindings?.variables?.[canonicalId];
  if (!item?.key) {
    report.unresolved += 1;
    return null;
  }

  try {
    const variable = await figma.variables.importVariableByKeyAsync(item.key);
    context.importedVariables.set(canonicalId, variable);
    report.variablesImported += 1;
    return variable;
  } catch (error) {
    report.errors.push(`${canonicalId}: ${serialiseError(error)}`);
    return null;
  }
}

async function projectTargetStyle(canonicalId, context, report) {
  if (context.importedStyles.has(canonicalId)) return context.importedStyles.get(canonicalId);

  const item = context.flavourFoundations.bindings?.styles?.[canonicalId];
  if (!item?.key) {
    report.unresolved += 1;
    return null;
  }

  try {
    const style = await figma.importStyleByKeyAsync(item.key);
    context.importedStyles.set(canonicalId, style);
    report.stylesImported += 1;
    return style;
  } catch (error) {
    report.errors.push(`${canonicalId}: ${serialiseError(error)}`);
    return null;
  }
}

async function swapProjectPaintBindings(paints, context, report) {
  if (paints === figma.mixed || !Array.isArray(paints)) return paints;
  const result = [];

  for (const paint of paints) {
    let next = paint;
    for (const [field, alias] of Object.entries(paint?.boundVariables || {})) {
      const canonicalId = await projectSourceVariableCanonical(alias, context.indexes, context.sourceFamilies);
      if (!canonicalId) continue;

      const target = await projectTargetVariable(canonicalId, context, report);
      if (!target) continue;

      try {
        next = figma.variables.setBoundVariableForPaint(next, field, target);
        report.rebound += 1;
      } catch (error) {
        report.errors.push(serialiseError(error));
      }
    }
    result.push(next);
  }
  return result;
}

async function swapProjectEffectBindings(effects, context, report) {
  if (effects === figma.mixed || !Array.isArray(effects)) return effects;
  const result = [];

  for (const effect of effects) {
    let next = effect;
    for (const [field, alias] of Object.entries(effect?.boundVariables || {})) {
      const canonicalId = await projectSourceVariableCanonical(alias, context.indexes, context.sourceFamilies);
      if (!canonicalId) continue;

      const target = await projectTargetVariable(canonicalId, context, report);
      if (!target) continue;

      try {
        next = figma.variables.setBoundVariableForEffect(next, field, target);
        report.rebound += 1;
      } catch (error) {
        report.errors.push(serialiseError(error));
      }
    }
    result.push(next);
  }
  return result;
}

async function swapProjectNodeBindings(node, context, report) {
  report.nodesScanned += 1;

  if (node.boundVariables && typeof node.setBoundVariable === 'function') {
    for (const [field, aliasOrAliases] of Object.entries(node.boundVariables)) {
      const aliases = Array.isArray(aliasOrAliases) ? aliasOrAliases : [aliasOrAliases];
      for (const alias of aliases) {
        const canonicalId = await projectSourceVariableCanonical(alias, context.indexes, context.sourceFamilies);
        if (!canonicalId) continue;

        const target = await projectTargetVariable(canonicalId, context, report);
        if (!target) continue;

        try {
          node.setBoundVariable(field, target);
          report.rebound += 1;
        } catch (error) {
          report.errors.push(serialiseError(error));
        }
        break;
      }
    }
  }

  if ('fills' in node) {
    try { node.fills = await swapProjectPaintBindings(node.fills, context, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }
  if ('strokes' in node) {
    try { node.strokes = await swapProjectPaintBindings(node.strokes, context, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }
  if ('effects' in node) {
    try { node.effects = await swapProjectEffectBindings(node.effects, context, report); }
    catch (error) { report.errors.push(serialiseError(error)); }
  }

  const styleFields = [
    ['fillStyleId', 'setFillStyleIdAsync'],
    ['strokeStyleId', 'setStrokeStyleIdAsync'],
    ['textStyleId', 'setTextStyleIdAsync'],
    ['effectStyleId', 'setEffectStyleIdAsync'],
    ['gridStyleId', 'setGridStyleIdAsync']
  ];

  for (const [field, setter] of styleFields) {
    if (!(field in node) || !node[field] || node[field] === figma.mixed || typeof node[setter] !== 'function') continue;

    const canonicalId = await projectSourceStyleCanonical(node[field], context.indexes, context.sourceFamilies);
    if (!canonicalId) continue;

    const target = await projectTargetStyle(canonicalId, context, report);
    if (!target || target.id === node[field]) continue;

    try {
      await node[setter](target.id);
      report.stylesRebound += 1;
    } catch (error) {
      report.errors.push(serialiseError(error));
    }
  }

  if ('children' in node) {
    for (const child of node.children) await swapProjectNodeBindings(child, context, report);
  }
}

async function removeAnyGeneratedProjectThemeObjects() {
  const variables = await figma.variables.getLocalVariablesAsync();
  for (const variable of variables) {
    if (!variable.getPluginData(PROJECT_THEME_KEYS.adapterVariable)) continue;
    try { variable.remove(); } catch {}
  }

  const styles = [...await figma.getLocalTextStylesAsync(), ...await figma.getLocalEffectStylesAsync()];
  for (const style of styles) {
    if (!style.getPluginData(PROJECT_THEME_KEYS.adapterStyle)) continue;
    try { style.remove(); } catch {}
  }

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    if (!collection.getPluginData(PROJECT_THEME_KEYS.adapterCollection)) continue;
    try { collection.remove(); } catch {}
  }
}

async function projectScopeRoots(scope) {
  if (scope === 'selection') {
    const selection = figma.currentPage.selection || [];
    if (!selection.length) throw new Error('Select one or more frames/components before applying the Flavour to Selection.');
    return [...selection];
  }
  if (scope === 'page') {
    if (typeof figma.currentPage.loadAsync === 'function') await figma.currentPage.loadAsync();
    return [...figma.currentPage.children];
  }
  if (scope === 'document') {
    if (typeof figma.loadAllPagesAsync === 'function') await figma.loadAllPagesAsync();
    return figma.root.children.flatMap((page) => [...page.children]);
  }
  throw new Error(`Unknown project Flavour scope: ${scope}`);
}

let autoReconcileManifest = null;
let autoReconcileTimer = null;
let autoReconcileBusy = false;
let autoReconcileIgnoreUntil = 0;
const autoReconcileNodeIds = new Set();
const AUTO_RECONCILE_DEBOUNCE_MS = 350;
const AUTO_RECONCILE_SELF_CHANGE_GUARD_MS = 650;

function autoReconcileState() {
  return {
    enabled: projectAutoReconcileEnabled(),
    armed: Boolean(autoReconcileManifest && projectThemeIdentity().flavourId),
    queued: autoReconcileNodeIds.size,
    busy: autoReconcileBusy
  };
}

function postAutoReconcileState(extra = {}) {
  try {
    figma.ui.postMessage({
      type: 'auto-reconcile-state',
      payload: { ...autoReconcileState(), ...extra }
    });
  } catch {}
}

function armAutoReconcile(manifest) {
  const manifestFlavour = manifest?.flavour?.id || manifest?.repository?.flavour || null;
  const projectFlavour = projectThemeIdentity().flavourId;
  if (!manifestFlavour || !projectFlavour || manifestFlavour !== projectFlavour) {
    autoReconcileManifest = null;
    postAutoReconcileState();
    return;
  }

  autoReconcileManifest = manifest;
  postAutoReconcileState();
}

function setProjectAutoReconcile(enabled, manifest = null) {
  figma.root.setPluginData(PROJECT_THEME_KEYS.autoReconcile, enabled ? 'true' : 'false');
  if (manifest) armAutoReconcile(manifest);
  if (!enabled) {
    autoReconcileNodeIds.clear();
    if (autoReconcileTimer) clearTimeout(autoReconcileTimer);
    autoReconcileTimer = null;
  }
  postAutoReconcileState();
}

function relevantAutoReconcileChange(change) {
  if (!autoReconcileNodeId(change)) return false;
  if (change.type === 'CREATE') return true;

  if (change.type !== 'PROPERTY_CHANGE') return false;
  const properties = Array.isArray(change.properties) ? change.properties : [];
  if (!properties.length) return false;

  const relevant = new Set([
    'fills',
    'strokes',
    'effects',
    'fillStyleId',
    'strokeStyleId',
    'textStyleId',
    'effectStyleId',
    'gridStyleId',
    'mainComponent',
    'componentProperties',
    'boundVariables'
  ]);

  return properties.some((property) => relevant.has(String(property)));
}

function scheduleAutoReconcileNode(nodeId) {
  if (!nodeId || !projectAutoReconcileEnabled() || !autoReconcileManifest) return;
  autoReconcileNodeIds.add(nodeId);

  if (autoReconcileTimer) clearTimeout(autoReconcileTimer);
  autoReconcileTimer = setTimeout(() => {
    autoReconcileTimer = null;
    flushAutoReconcileQueue().catch((error) => {
      postAutoReconcileState({ error: serialiseError(error) });
    });
  }, AUTO_RECONCILE_DEBOUNCE_MS);
}

function hasQueuedAncestor(node, queuedIds) {
  let parent = node?.parent || null;
  while (parent) {
    if (queuedIds.has(parent.id)) return true;
    parent = parent.parent || null;
  }
  return false;
}

async function queuedAutoReconcileRoots() {
  const ids = [...autoReconcileNodeIds];
  autoReconcileNodeIds.clear();

  const nodes = [];
  for (const id of ids) {
    let node = null;
    try { node = await figma.getNodeByIdAsync(id); } catch {}
    if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') continue;
    nodes.push(node);
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => !hasQueuedAncestor(node, nodeIds));
}

async function flushAutoReconcileQueue() {
  if (autoReconcileBusy || !projectAutoReconcileEnabled() || !autoReconcileManifest) return;
  if (!autoReconcileNodeIds.size) return;

  autoReconcileBusy = true;
  postAutoReconcileState();

  try {
    const roots = await queuedAutoReconcileRoots();
    if (!roots.length) return;

    const context = await buildProjectFoundationSwapContext(autoReconcileManifest);
    const report = {
      nodesScanned: 0,
      rebound: 0,
      stylesRebound: 0,
      variablesImported: 0,
      stylesImported: 0,
      unresolved: 0,
      errors: []
    };

    for (const root of roots) {
      await swapProjectNodeBindings(root, context, report);
    }

    autoReconcileIgnoreUntil = Date.now() + AUTO_RECONCILE_SELF_CHANGE_GUARD_MS;

    postAutoReconcileState({
      lastRun: {
        roots: roots.length,
        nodesScanned: report.nodesScanned,
        bindings: report.rebound + report.stylesRebound,
        unresolved: report.unresolved,
        errors: [...new Set(report.errors)].slice(0, 10)
      }
    });
  } finally {
    autoReconcileBusy = false;
    postAutoReconcileState();

    if (autoReconcileNodeIds.size && projectAutoReconcileEnabled()) {
      if (autoReconcileTimer) clearTimeout(autoReconcileTimer);
      autoReconcileTimer = setTimeout(() => {
        autoReconcileTimer = null;
        flushAutoReconcileQueue().catch((error) => {
          postAutoReconcileState({ error: serialiseError(error) });
        });
      }, AUTO_RECONCILE_DEBOUNCE_MS);
    }
  }
}

let autoReconcileWatchedPage = null;

function autoReconcileNodeId(change) {
  return change?.node?.id || change?.id || null;
}

function handleAutoReconcilePageChange(event) {
  if (!projectAutoReconcileEnabled() || !autoReconcileManifest || autoReconcileBusy) return;
  if (Date.now() < autoReconcileIgnoreUntil) return;

  for (const change of event.nodeChanges || []) {
    if (!relevantAutoReconcileChange(change)) continue;
    const nodeId = autoReconcileNodeId(change);
    if (nodeId) scheduleAutoReconcileNode(nodeId);
  }
}

function watchCurrentPageForAutoReconcile() {
  const page = figma.currentPage;
  if (!page || page === autoReconcileWatchedPage) return;

  if (autoReconcileWatchedPage) {
    try { autoReconcileWatchedPage.off('nodechange', handleAutoReconcilePageChange); } catch {}
  }

  autoReconcileWatchedPage = page;
  try { autoReconcileWatchedPage.on('nodechange', handleAutoReconcilePageChange); } catch (error) {
    postAutoReconcileState({ error: serialiseError(error) });
  }
}

watchCurrentPageForAutoReconcile();

figma.on('currentpagechange', () => {
  watchCurrentPageForAutoReconcile();
});

async function applyProjectFlavour(manifest, scope = 'document') {
  const context = await buildProjectFoundationSwapContext(manifest);
  const roots = await projectScopeRoots(scope);

  await removeAnyGeneratedProjectThemeObjects();

  const report = {
    nodesScanned: 0,
    rebound: 0,
    stylesRebound: 0,
    variablesImported: 0,
    stylesImported: 0,
    unresolved: 0,
    errors: []
  };

  for (const root of roots) await swapProjectNodeBindings(root, context, report);

  stampProjectTheme(manifest);
  armAutoReconcile(manifest);

  return {
    flavour: projectThemeIdentity(),
    scope,
    foundationLibrary: {
      fileName: context.flavourFoundations.fileName,
      registeredAt: context.flavourFoundations.registeredAt
    },
    adapter: {
      createdCollections: 0,
      updatedCollections: 0,
      createdVariables: 0,
      updatedVariables: 0,
      createdStyles: 0,
      updatedStyles: 0
    },
    report: {
      ...report,
      errors: [...new Set(report.errors)].slice(0, 20)
    }
  };
}

async function projectThemeStatus() {
  const identity = projectThemeIdentity();
  return {
    ...identity,
    adapterCollections: 0,
    adapterVariables: 0,
    adapterStyles: 0,
    autoReconcile: autoReconcileState()
  };
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

figma.on('selectionchange', () => {
  figma.ui.postMessage({ type: 'selection-changed' });
});

figma.ui.onmessage = async (message) => {
  try {
    if (message?.type === 'plugin-settings-get') {
      figma.ui.postMessage({ type: 'plugin-settings', payload: await readPluginSettings() });
      return;
    }
    if (message?.type === 'plugin-settings-set') {
      figma.ui.postMessage({ type: 'plugin-settings', payload: await writePluginSettings(message.settings || {}) });
      return;
    }
    if (message?.type === 'resize-window') {
      const width = Math.max(520, Math.min(1400, Number(message.width) || 680));
      const height = Math.max(420, Math.min(1400, Number(message.height) || 760));
      figma.ui.resize(Math.round(width), Math.round(height));
      return;
    }
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
    if (message?.type === 'library-publish-status') {
      const status = await currentLayerPublishStatus(message.layer);
      figma.ui.postMessage({
        type: 'library-publish-status',
        payload: { ...status, message: publishStatusMessage(status), requestFor: message.requestFor || null }
      });
      return;
    }
    if (message?.type === 'register-system-layer') {
      figma.ui.postMessage({ type: 'system-layer-registered', payload: await registerCurrentSystemLayer(message) });
      return;
    }
    if (message?.type === 'family-status') {
      figma.ui.postMessage({ type: 'family-status', payload: await familyState(message.flavourId || null) });
      return;
    }
    if (message?.type === 'sync-system-layer') {
      figma.ui.postMessage({ type: 'system-layer-synced', payload: await syncSystemLayer(message.layer, message.flavourId) });
      return;
    }
    if (message?.type === 'register-master-assets') {
      figma.ui.postMessage({ type: 'master-assets-registered', payload: await registerMasterFigmaAssets() });
      return;
    }
    if (message?.type === 'sync-master-assets') {
      figma.ui.postMessage({ type: 'master-assets-synced', payload: await syncMasterFigmaAssets() });
      return;
    }
    if (message?.type === 'apply-flavour-foundations') {
      const flavourId = message.manifest?.flavour?.id || message.manifest?.repository?.flavour || null;
      if (!flavourId) throw new Error('Resolve a Flavour before building its Foundations library.');
      const payload = await apply(message.manifest);
      setSystemIdentity({ layer: 'foundations', role: 'flavour', flavourId });
      figma.ui.postMessage({ type: 'flavour-foundations-applied', payload: { flavourId, apply: payload } });
      return;
    }
    if (message?.type === 'register-flavour-foundations') {
      const flavourId = message.flavourId || null;
      if (!flavourId) throw new Error('Choose a Flavour before registering its Foundations library.');
      figma.ui.postMessage({
        type: 'flavour-foundations-registered',
        payload: await registerCurrentSystemLayer({ layer: 'foundations', role: 'flavour', flavourId })
      });
      return;
    }
    if (message?.type === 'file-context') {
      figma.ui.postMessage({
        type: 'file-context',
        payload: {
          fileName: figma.root.name || '',
          system: currentSystemIdentity(),
          project: projectThemeIdentity()
        }
      });
      return;
    }
    if (message?.type === 'set-auto-reconcile') {
      setProjectAutoReconcile(Boolean(message.enabled), message.manifest || null);
      return;
    }
    if (message?.type === 'arm-auto-reconcile') {
      armAutoReconcile(message.manifest || null);
      return;
    }
    if (message?.type === 'selection-context-detect') {
      figma.ui.postMessage({
        type: 'selection-context-detected',
        payload: await detectSelectionContextTargets(message.manifest || {})
      });
      return;
    }
    if (message?.type === 'context-remap-capabilities') {
      figma.ui.postMessage({
        type: 'context-remap-capabilities',
        payload: { domains: availableFigmaContextDomains(message.manifest || {}) }
      });
      return;
    }
    if (message?.type === 'context-remap-selection') {
      figma.ui.postMessage({
        type: 'context-remap-result',
        payload: await remapContextSelection(
          message.manifest || {},
          message.domainId,
          message.sourceTargetId,
          message.destinationTargetId
        )
      });
      return;
    }
    if (message?.type === 'context-generate-set') {
      figma.ui.postMessage({
        type: 'context-generate-set-result',
        payload: await generateContextSet(
          message.manifest || {},
          message.domainId,
          message.sourceTargetId,
          message.destinationTargetIds || [],
          {
            stateIds: message.stateIds || ['default'],
            focusResults: message.focusResults !== false
          }
        )
      });
      return;
    }
    if (message?.type === 'context-generate-disabled-copy') {
      figma.ui.postMessage({
        type: 'context-generate-disabled-result',
        payload: await generateDisabledCopies(
          message.manifest || {},
          { focusResults: message.focusResults !== false }
        )
      });
      return;
    }
    if (message?.type === 'flavour-extension-capabilities') {
      figma.ui.postMessage({
        type: 'flavour-extension-capabilities',
        payload: {
          flavourId: message.manifest?.flavour?.id || null,
          extensions: availableFlavourExtensions(message.manifest || {})
        }
      });
      return;
    }
    if (message?.type === 'flavour-extension-selection') {
      figma.ui.postMessage({
        type: 'flavour-extension-result',
        payload: await applyFlavourExtensionToSelection(
          message.manifest || {},
          message.extensionId,
          message.direction === 'reset' ? 'reset' : 'apply'
        )
      });
      return;
    }
    if (message?.type === 'project-theme-status') {
      figma.ui.postMessage({ type: 'project-theme-status', payload: await projectThemeStatus() });
      return;
    }
    if (message?.type === 'apply-project-flavour') {
      figma.ui.postMessage({ type: 'project-flavour-applied', payload: await applyProjectFlavour(message.manifest, message.scope || 'document') });
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
