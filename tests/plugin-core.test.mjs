import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cartesianModeCombinations,
  desiredValueForMode,
  buildDesiredModel,
  buildDiffSummary,
  summariseDiffByKind,
  desiredVariableSignature,
  stableStringify,
  variantNameParts,
  upsertVariantNameProperty
} from '../packages/figma-plugin-core/src/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('flattens arbitrary mode dimensions deterministically for Figma collections', () => {
  const modes = cartesianModeCombinations([
    { id: 'theme', values: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }] },
    { id: 'viewport', values: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] }
  ]);
  assert.deepEqual(modes.map((mode) => mode.name), ['Light · Small', 'Light · Large', 'Dark · Small', 'Dark · Large']);
});

test('mode-specific values beat mode-independent fallback values', () => {
  const variable = {
    values: [
      { context: { modes: {}, conditions: [] }, value: { kind: 'literal', value: 1 } },
      { context: { modes: { theme: 'dark' }, conditions: [] }, value: { kind: 'literal', value: 2 } }
    ]
  };
  assert.equal(desiredValueForMode(variable, { theme: 'light' }).value, 1);
  assert.equal(desiredValueForMode(variable, { theme: 'dark' }).value, 2);
});

test('raw conditional variants are not treated as Figma mode values', () => {
  const variable = {
    values: [
      { context: { modes: {}, conditions: [{ kind: 'media', query: '(min-width: 800px)' }] }, value: { kind: 'literal', value: 99 } },
      { context: { modes: {}, conditions: [] }, value: { kind: 'literal', value: 12 } }
    ]
  };
  assert.equal(desiredValueForMode(variable, {}).value, 12);
});

test('buildDesiredModel groups variables into their manifest collections', () => {
  const desired = buildDesiredModel({
    schemaVersion: 2,
    platform: 'figma',
    diagnostics: { errors: [], warnings: [] },
    modeDimensions: [],
    collections: [
      { id: 'semantic', name: 'Semantic', publish: true, modeDimensions: [] },
      { id: 'primitive', name: 'Primitive', publish: false, modeDimensions: [] }
    ],
    variables: [
      { id: 'one', collectionId: 'semantic', name: 'One', type: 'FLOAT', scopes: [], values: [{ context: { modes: {}, conditions: [] }, value: { kind: 'literal', value: 1 } }] },
      { id: 'two', collectionId: 'primitive', name: 'Two', type: 'FLOAT', scopes: [], values: [{ context: { modes: {}, conditions: [] }, value: { kind: 'literal', value: 2 } }] }
    ],
    styles: []
  });
  assert.equal(desired.collections[0].variables.length, 1);
  assert.equal(desired.collections[1].variables.length, 1);
});

test('diff plans create, update and unchanged objects by BufferCore canonical identity', () => {
  const desired = {
    collections: [{ id: 'semantic', name: 'Semantic', publish: true, modes: [{ name: 'Default' }], variables: [
      { id: 'same', name: 'Same', collectionId: 'semantic', type: 'FLOAT', scopes: [] },
      { id: 'changed', name: 'Changed', collectionId: 'semantic', type: 'FLOAT', scopes: [] },
      { id: 'new', name: 'New', collectionId: 'semantic', type: 'FLOAT', scopes: [] }
    ] }],
    styles: []
  };
  const snapshot = {
    collections: [{ canonicalId: 'semantic', name: 'Semantic', publish: true, modeNames: ['Default'] }],
    variables: [
      { canonicalId: 'same', name: 'Same', collectionCanonicalId: 'semantic', type: 'FLOAT', scopes: [] },
      { canonicalId: 'changed', name: 'Old Name', collectionCanonicalId: 'semantic', type: 'FLOAT', scopes: [] }
    ],
    styles: []
  };
  const diff = buildDiffSummary(desired, snapshot);
  assert.equal(diff.variables.create.length, 1);
  assert.equal(diff.variables.update.length, 1);
  assert.equal(diff.variables.unchanged.length, 1);
});



test('plugin filters scopes by Figma variable type and applies explicit empty scopes to hide primitives', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /VALID_SCOPES_BY_TYPE/);
  assert.match(source, /if \(!Array\.isArray\(definition\.scopes\)\) return;/);
  assert.match(source, /variable\.scopes = scopes;/);
  assert.match(source, /explicit empty scope list is meaningful in Figma/);
  assert.match(source, /applyVariableScopes\(variable, definition, result\)/);
});

test('plugin treats rejected Figma scopes as a warning rather than aborting the whole apply', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /variable\.scopes = scopes;/);
  assert.match(source, /catch \(error\)/);
  assert.match(source, /Figma rejected scopes/);
});


test('plugin projects the hidden core opacity scale in Figma percentage-space so semantic aliases resolve correctly', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /isCoreOpacityPrimitive/);
  assert.match(source, /startsWith\('opacity\.'\)/);
  assert.match(source, /startsWith\('--bc-opacity-'\)/);
  assert.match(source, /value\.value \* 100/);
});


test('diff summary separates semantic variables, primitive variables, styles and divider imports', () => {
  const diff = {
    collections: {
      create: [
        { id: 'semantic.colour', kind: 'token' },
        { id: 'divider.semantic-primitive', kind: 'divider' }
      ],
      update: [{ desired: { id: 'primitive.radius', kind: 'token' } }],
      unchanged: []
    },
    variables: {
      create: [{ id: 's', layer: 'semantic' }, { id: 'p', layer: 'primitive' }],
      update: [{ desired: { id: 's2', layer: 'semantic' } }],
      unchanged: []
    },
    styles: { create: [{ id: 'style.one' }], update: [{ desired: { id: 'style.two' } }], unchanged: [] }
  };
  assert.deepEqual(summariseDiffByKind(diff), {
    create: { semanticVariables: 1, primitiveVariables: 1, styles: 1, dividerCollections: 1, collections: 1 },
    update: { semanticVariables: 1, primitiveVariables: 0, styles: 1, collections: 1 }
  });
});

test('plugin migrates variables out of the legacy two-collection model before stable bindings are locked', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /variable\.variableCollectionId !== collection\.id/);
  assert.match(source, /obsoleteVariables\.push\(oldVariable\)/);
  assert.match(source, /cleanupLegacyCollections/);
  assert.match(source, /new Set\(\['semantic', 'primitive'\]\)/);
});

test('collection diffs compare against the Figma sort name while preserving the visible BufferCore label', () => {
  const desired = {
    collections: [{ id: 'semantic.colour', name: 'Semantic: Colour', figmaName: '   Semantic: Colour', publish: true, modes: [{ name: 'Default' }], variables: [] }],
    styles: []
  };
  const snapshot = {
    collections: [{ canonicalId: 'semantic.colour', name: '   Semantic: Colour', publish: true, modeNames: ['Default'] }],
    variables: [],
    styles: []
  };
  const diff = buildDiffSummary(desired, snapshot);
  assert.equal(diff.collections.unchanged.length, 1);
  assert.equal(diff.collections.update.length, 0);
});

test('plugin UI exposes separate importing/updating summaries and change filters', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(source, />Importing</);
  assert.match(source, />Updating</);
  assert.match(source, /createSemantic/);
  assert.match(source, /createPrimitive/);
  assert.match(source, /createStyles/);
  assert.match(source, /createDividerRow/);
  assert.match(source, /data-filter="create"/);
  assert.match(source, /data-filter="update"/);
});


test('plugin treats intentionally unset baseline colours as deferred rather than hundreds of warnings', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /isExpectedUnsetLiteral/);
  assert.match(source, /result\.deferredValues \+= 1/);
});

test('plugin loads the actual Figma font family before binding typography variables', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /figma\.listAvailableFontsAsync/);
  assert.match(source, /figma\.loadFontAsync/);
  assert.match(source, /loadTextStyleFont/);
});

test('plugin applies WEB code syntax to every BufferCore variable', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /setVariableCodeSyntax\('WEB', web\)/);
  assert.match(source, /applyVariableCodeSyntax\(variable, definition, result\)/);
});

test('desired model carries explicit retired variables so apply can remove old broken imports', () => {
  const desired = buildDesiredModel({
    schemaVersion: 2,
    platform: 'figma',
    diagnostics: { errors: [], warnings: [] },
    modeDimensions: [],
    collections: [],
    variables: [],
    retiredVariables: [{ id: 'type.context.font.size', reason: 'runtime-hook' }],
    styles: []
  });
  assert.deepEqual(desired.retiredVariables, [{ id: 'type.context.font.size', reason: 'runtime-hook' }]);
});

test('plugin removes retired and orphaned BufferCore variables without touching unmanaged variables', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /cleanupRetiredVariables/);
  assert.match(source, /cleanupOrphanedVariables/);
  assert.match(source, /desiredIds\.has\(canonicalId\)/);
  assert.match(source, /if \(!canonicalId \|\| desiredIds\.has\(canonicalId\) \|\| retiredIds\.has\(canonicalId\)\) continue/);
  assert.match(source, /removedRetiredVariables/);
  assert.match(source, /removedOrphanedVariables/);
});

test('variable diffs compare against Figma presentation names while retaining clean BufferCore names', () => {
  const desired = {
    collections: [{ id: 'semantic.colour', name: 'Semantic: Colour', figmaName: ' Semantic: Colour', publish: true, modes: [{ name: 'Default' }], variables: [
      { id: 'color.text', name: 'Text / Default', figmaName: '    Text /    Default', collectionId: 'semantic.colour', type: 'COLOR', scopes: [] }
    ] }],
    styles: []
  };
  const snapshot = {
    collections: [{ canonicalId: 'semantic.colour', name: ' Semantic: Colour', publish: true, modeNames: ['Default'] }],
    variables: [{ canonicalId: 'color.text', name: '    Text /    Default', collectionCanonicalId: 'semantic.colour', type: 'COLOR', scopes: [] }],
    styles: []
  };
  const diff = buildDiffSummary(desired, snapshot);
  assert.equal(diff.variables.unchanged.length, 1);
  assert.equal(diff.variables.update.length, 0);
});

test('plugin applies variable figmaName rather than canonical display name', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /const figmaName = definition\.figmaName \|\| definition\.name/);
  assert.match(source, /variable\.name = figmaName/);
});

test('stable sync signatures include variable values so a second identical apply can be truly unchanged', async () => {
  const core = await import('../packages/figma-plugin-core/src/index.mjs');
  const definition = {
    id: 'space.gap', name: 'Gap', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true,
    modeValues: [{ mode: { name: 'Default' }, value: { kind: 'literal', value: 16 } }]
  };
  const signature = desiredVariableSignature(definition);
  assert.match(signature, /16/);
  assert.match(signature, /semantic\.spacing/);
});

test('diff detects Figma-only drift without treating it as a normal source update', async () => {
  const core = await import('../packages/figma-plugin-core/src/index.mjs');
  const desiredVariable = {
    id: 'space.gap', name: 'Gap', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true,
    modeValues: [{ mode: { name: 'Default' }, value: { kind: 'literal', value: 16 } }]
  };
  const desired = { collections: [{ id: 'semantic.spacing', name: 'Semantic: Spacing', figmaName: 'Semantic: Spacing', publish: true, modes: [{ name: 'Default' }], variables: [desiredVariable] }], styles: [] };
  const applied = desiredVariableSignature(desiredVariable);
  const snapshot = {
    collections: [{ canonicalId: 'semantic.spacing', name: 'Semantic: Spacing', publish: true, modeNames: ['Default'], liveSignature: core.desiredCollectionSignature(desired.collections[0]), appliedSignature: core.desiredCollectionSignature(desired.collections[0]), appliedLiveSignature: core.desiredCollectionSignature(desired.collections[0]) }],
    variables: [{ canonicalId: 'space.gap', liveSignature: stableStringify({ name: 'Gap manually edited', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true, modeValues: [{ mode: 'Default', value: { kind: 'literal', value: 16 } }] }), appliedSignature: applied, appliedLiveSignature: applied }],
    styles: []
  };
  const diff = buildDiffSummary(desired, snapshot);
  assert.equal(diff.variables.drift.length, 1);
  assert.equal(diff.variables.update.length, 0);
});

test('diff detects a conflict when both source and Figma changed since the last apply', async () => {
  const core = await import('../packages/figma-plugin-core/src/index.mjs');
  const desiredVariable = {
    id: 'space.gap', name: 'Gap', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true,
    modeValues: [{ mode: { name: 'Default' }, value: { kind: 'literal', value: 24 } }]
  };
  const oldDefinition = { ...desiredVariable, modeValues: [{ mode: { name: 'Default' }, value: { kind: 'literal', value: 16 } }] };
  const collection = { id: 'semantic.spacing', name: 'Semantic: Spacing', figmaName: 'Semantic: Spacing', publish: true, modes: [{ name: 'Default' }], variables: [desiredVariable] };
  const snapshot = {
    collections: [{ canonicalId: 'semantic.spacing', liveSignature: core.desiredCollectionSignature(collection), appliedSignature: core.desiredCollectionSignature(collection), appliedLiveSignature: core.desiredCollectionSignature(collection) }],
    variables: [{ canonicalId: 'space.gap', liveSignature: stableStringify({ name: 'Gap', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true, modeValues: [{ mode: 'Default', value: { kind: 'literal', value: 20 } }] }), appliedSignature: desiredVariableSignature(oldDefinition), appliedLiveSignature: desiredVariableSignature(oldDefinition) }],
    styles: []
  };
  const diff = buildDiffSummary({ collections: [collection], styles: [] }, snapshot);
  assert.equal(diff.variables.conflict.length, 1);
});

test('managed objects absent from the manifest are surfaced as orphaned and are not silently deleted', async () => {
  const core = await import('../packages/figma-plugin-core/src/index.mjs');
  const diff = buildDiffSummary({ collections: [], styles: [] }, {
    collections: [],
    variables: [{ canonicalId: 'old.token', name: 'Old token', liveSignature: '{}', appliedSignature: '{}', appliedLiveSignature: '{}' }],
    styles: []
  });
  assert.equal(diff.variables.orphaned.length, 1);
  assert.equal(diff.totals.orphaned, 1);
});

test('plugin persists canonical-to-Figma binding registry and applied signatures after a successful apply', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /buffercore\.bindingRegistry|BUFFERCORE_KEYS\.bindingRegistry/);
  assert.match(source, /stampAppliedState/);
  assert.match(source, /BUFFERCORE_KEYS\.appliedSignature/);
  assert.match(source, /figma\.root\.setPluginData/);
});

test('plugin blocks apply when drift or conflicts are present rather than overwriting Figma edits', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /Apply blocked:/);
  assert.match(source, /safety\.blocked/);
});

test('plugin UI surfaces drift, conflicts and orphaned managed objects and blocks unsafe apply', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(source, /data-filter="drift"/);
  assert.match(source, /data-filter="conflict"/);
  assert.match(source, /data-filter="orphaned"/);
  assert.match(source, /safetyCount/);
  assert.match(source, /message\.payload\.safety\?\.blocked/);
});


test('local workspace Flavour application is not disabled by dirty Git working trees', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /const githubMode = payload\.sourceMode === 'github'/);
  assert.match(html, /dirtyFlavoursBlockPull = githubMode && Boolean\(payload\.flavoursRepository\?\.dirty\)/);
  assert.match(html, /\$\('applyProjectFlavour'\)\.disabled = Boolean\(payload\.syncing\) \|\| !\$\('projectFlavourSelect'\)\?\.value/);
  assert.match(html, /Local workspace mode is using your current working tree/);
});


test('project Flavour swaps BC Foundation bindings to a registered published Flavour Foundations library', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /buildProjectFoundationSwapContext/);
  assert.match(code, /flavourFoundations\.bindings\?\.variables/);
  assert.match(code, /figma\.variables\.importVariableByKeyAsync/);
  assert.match(code, /setBoundVariableForPaint\(next, field, target\)/);
  assert.match(code, /node\.setBoundVariable\(field, target\)/);
});

test('Flavour Foundations workflow builds full resolved Foundations and registers the published library', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(code, /message\?\.type === 'apply-flavour-foundations'/);
  assert.match(code, /message\?\.type === 'register-flavour-foundations'/);
  assert.match(html, /Build into this file/);
  assert.match(html, /Register published library/);
});

test('project Flavour application does not create local adapter variables or literal colour overrides', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const start = code.indexOf('async function applyProjectFlavour');
  const end = code.indexOf('async function projectThemeStatus', start);
  const block = code.slice(start, end);
  assert.doesNotMatch(block, /createVariableCollection/);
  assert.doesNotMatch(block, /rgbaFromHex/);
  assert.match(block, /swapProjectNodeBindings/);
});


test('Flavours UI separates library-building and project-application into distinct workflows', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /Build Foundations Library/);
  assert.match(html, /Apply to Project/);
  assert.match(html, /id="flavourLibraryWorkflow"/);
  assert.match(html, /id="flavourProjectWorkflow"/);
  assert.match(html, /function setFlavourView/);
  assert.match(html, /body\.classList\.toggle\('flavours-active'/);
});

test('plugin exposes current Figma file context so Flavours opens in the relevant workflow', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(code, /message\?\.type === 'file-context'/);
  assert.match(code, /system: currentSystemIdentity\(\)/);
  assert.match(html, /isFlavourFoundations/);
  assert.match(html, /requestFileContext/);
});


test('Apply to Project only lists Flavours with a registered published Foundations library', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="projectFlavourSelect"/);
  assert.match(html, /refreshReadyProjectFlavours/);
  assert.match(html, /family\?\.layers\?\.foundations\?\.flavour/);
  assert.match(html, /variableCount > 0/);
  assert.match(html, /No published Flavours ready/);
  assert.match(html, /readyProjectFlavourIds\.has/);
});

test('library build workflow retains the full authored Flavour list independently from project-ready Flavours', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /Flavour to build/);
  assert.match(html, /authoredFlavours = payload\.flavours \|\| \[\]/);
  assert.match(html, /Choose a ready Flavour/);
  assert.match(html, /selectedBuildFlavourId/);
});


test('Help tab contains the minimal complete BufferCore and Flavour workflow', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /id="openHelp"/);
  assert.match(html, /id="tab-help"/);
  assert.match(html, /Initial BufferCore setup/);
  assert.match(html, /Set up a new Flavour/);
  assert.match(html, /Use a Flavour in a project/);
  assert.match(html, /manual safety check/);
  assert.match(html, /A Flavour only gets its own Foundations library/);
});


test('library registration is blocked until Figma reports all publishable assets CURRENT', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /getPublishStatusAsync/);
  assert.match(code, /'UNPUBLISHED'/);
  assert.match(code, /'CURRENT'/);
  assert.match(code, /CHANGED:\s*0/);
  assert.match(code, /await assertLayerPublishedCurrent\(layer\)/);
  assert.match(code, /Publish the latest library changes in Figma first/);
});

test('Foundation registration stores only publishable variables and styles that are CURRENT', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /variable\.hiddenFromPublishing/);
  assert.match(code, /collection\.hiddenFromPublishing/);
  assert.match(code, /Promise\.all\(variableCandidates\.map/);
  assert.match(code, /safePublishStatus\(variable\)/);
  assert.match(code, /safePublishStatus\(style\)/);
  assert.match(code, /status !== 'CURRENT'/);
});

test('register buttons stay disabled until an explicit publish-status check passes', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="checkFlavourPublishStatus"/);
  assert.match(html, /type: 'library-publish-status'/);
  assert.match(html, /dataset\.publishReady/);
  assert.match(html, /Publish in Figma, then Check status/);
  assert.match(html, /Publish the current library in Figma, then Refresh status/);
});


test('Auto Reconcile watches only incremental document changes and debounces them', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /\.on\('nodechange', handleAutoReconcilePageChange\)/);
  assert.match(code, /AUTO_RECONCILE_DEBOUNCE_MS = 350/);
  assert.match(code, /change\.type === 'CREATE'/);
  assert.match(code, /change\.type !== 'PROPERTY_CHANGE'/);
  assert.match(code, /figma\.getNodeByIdAsync\(id\)/);
  assert.match(code, /hasQueuedAncestor/);
  assert.doesNotMatch(code.slice(code.indexOf("function watchCurrentPageForAutoReconcile"), code.indexOf("async function applyProjectFlavour")), /loadAllPagesAsync/);
});

test('Auto Reconcile ignores its own edits and reuses the existing Foundation swap engine', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /autoReconcileBusy/);
  assert.match(code, /autoReconcileIgnoreUntil/);
  assert.match(code, /swapProjectNodeBindings\(root, context, report\)/);
  assert.match(code, /buildProjectFoundationSwapContext\(autoReconcileManifest\)/);
  assert.match(code, /armAutoReconcile\(manifest\)/);
});

test('Project UI exposes a persistent Auto Reconcile toggle with manual Reconcile fallback', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="autoReconcileToggle"/);
  assert.match(html, /Auto Reconcile/);
  assert.match(html, /type: 'set-auto-reconcile'/);
  assert.match(html, /Watching for new BufferCore components/);
  assert.match(html, /manual safety check/);
});


test('Help tab is ordered by actual usage and uses collapsible sections', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const useIndex = html.indexOf('Use a Flavour in a project');
  const setupFlavourIndex = html.indexOf('Set up a new Flavour');
  const initialIndex = html.indexOf('Initial BufferCore setup');

  assert.ok(useIndex >= 0);
  assert.ok(setupFlavourIndex > useIndex);
  assert.ok(initialIndex > setupFlavourIndex);
  assert.match(html, /<details class="help-section" open>/);
  assert.match(html, /<details class="help-section">\s*<summary>Set up a new Flavour<\/summary>/);
  assert.match(html, /<details class="help-section">\s*<summary>Initial BufferCore setup<\/summary>/);
  assert.match(html, /Auto Reconcile remaps new BC Foundation bindings/);
});


test('native relaunch experiment is removed and quick normal launch is restored', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.equal(manifest.menu, undefined);
  assert.equal(manifest.relaunchButtons, undefined);
  assert.doesNotMatch(code, /setRelaunchData/);
  assert.doesNotMatch(code, /figma\.command/);
  assert.doesNotMatch(html, /data-tab="extensions"/);
});

test('default opening tab is configurable and persisted in Figma client storage', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /clientStorage\.getAsync\(PLUGIN_SETTINGS_KEY\)/);
  assert.match(code, /clientStorage\.setAsync\(PLUGIN_SETTINGS_KEY, result\)/);
  assert.match(html, /id="openSettings"/);
  assert.match(html, /id="defaultOpeningTab"/);
    assert.match(html, /value="flavours">Flavours/);
  assert.match(html, /activateTab\(currentPluginSettings\.defaultTab\)/);
});


test('Auto Reconcile uses page nodechange in dynamic-page mode instead of documentchange', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(code, /figma\.on\('documentchange'/);
  assert.match(code, /\.on\('nodechange', handleAutoReconcilePageChange\)/);
  assert.match(code, /\.off\('nodechange', handleAutoReconcilePageChange\)/);
  assert.match(code, /figma\.on\('currentpagechange'/);
  assert.match(code, /event\.nodeChanges/);
  assert.match(code, /change\?\.node\?\.id/);
  assert.doesNotMatch(
    code.slice(code.indexOf('function watchCurrentPageForAutoReconcile'), code.indexOf("figma.on('currentpagechange'")),
    /loadAllPagesAsync/
  );
});


test('Context Remap builds a canonical plan from the generated Context contract', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /function buildContextRemapCssPlan/);
  assert.match(code, /function buildContextRemapCanonicalPlan/);
  assert.match(code, /contextTargetMappings/);
  assert.match(code, /ambiguous/);
  assert.match(code, /unavailable/);
});

test('Context Remap operates only on the current Figma selection and preserves variables', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function remapContextSelection');
  const end = code.indexOf('async function buildProjectFoundationSwapContext', start);
  const block = code.slice(start, end);

  assert.match(block, /figma\.currentPage\.selection/);
  assert.match(block, /remapContextNode/);
  assert.doesNotMatch(block, /loadAllPagesAsync/);
  assert.doesNotMatch(block, /createVariable/);
  assert.doesNotMatch(block, /setValueForMode/);
});

test('Core Remap resolves local Foundations variables before falling back to the registered library', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /async function localCanonicalVariables/);
  assert.match(code, /figma\.variables\.getLocalVariablesAsync/);
  assert.match(code, /runtime\.localVariables\?\.get\(canonicalId\)/);
  assert.match(code, /masterFoundations\?\.bindings\?\.variables/);
  assert.match(code, /figma\.variables\.importVariableByKeyAsync/);
  assert.match(code, /Apply Core in this Foundations file/);
});

test('generated states can bind local Foundation variables without requiring library registration', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function buildStateTransformRuntime');
  const end = code.indexOf('async function applyStateTransform', start);
  const block = code.slice(start, end);

  assert.match(block, /runtime\.localVariables = await localCanonicalVariables/);
  assert.match(block, /hasLocal/);
  assert.match(block, /hasPublished/);
  assert.match(block, /runtime\.localVariables\?\.get\(canonicalId\)/);
});

test('Core UI exposes selection Context remapping from manifest capabilities', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /Remap selection/);
  assert.match(html, /id="contextRemapDomain"/);
  assert.match(html, /id="contextRemapFrom"/);
  assert.match(html, /id="contextRemapTo"/);
  assert.match(html, /type: 'context-remap-capabilities'/);
  assert.match(html, /type: 'context-remap-selection'/);
});


test('Generate Context Set clones only the current selection and reuses Context Remap', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function generateContextSet');
  const end = code.indexOf('async function buildProjectFoundationSwapContext', start);
  const block = code.slice(start, end);

  assert.match(block, /figma\.currentPage\.selection/);
  assert.match(block, /originalGroup\.clone\(\)/);
  assert.match(block, /buildCoreContextRemapRuntime/);
  assert.match(block, /remapContextNode\(clone/);
  assert.doesNotMatch(block, /loadAllPagesAsync/);
  assert.doesNotMatch(block, /detachInstance/);
});

test('Generate Context Set creates a Disabled copy for the source Context as well as destination Contexts', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function generateContextSet');
  const end = code.indexOf('async function buildProjectFoundationSwapContext', start);
  const block = code.slice(start, end);

  assert.match(block, /sourceGeneratedStateIds = stateIds\.filter\(\(stateId\) => stateId !== 'default'\)/);
  assert.match(block, /contextTargetLabel\(manifest, domainId, sourceTargetId\)/);
  assert.match(block, /renameGeneratedGroupChildren\(cloneGroup, sourceLabel, stateId, domainId\)/);
  assert.match(block, /sourceGeneratedStateIds[\s\S]*applyStateTransformToGeneratedGroup/);
});

test('Generate preserves authored interaction states and derives Disabled only from State=Default variants', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const renameStart = code.indexOf('function renameGeneratedGroupChildren');
  const renameEnd = code.indexOf('async function applyStateTransformToGeneratedGroup', renameStart);
  const renameBlock = code.slice(renameStart, renameEnd);
  assert.match(renameBlock, /stateId && stateId !== 'default'/);
  assert.match(renameBlock, /: contextName;/);

  const pruneStart = code.indexOf('function pruneGeneratedGroupToSourceState');
  const pruneEnd = code.indexOf('function renameGeneratedGroupChildren', pruneStart);
  const pruneBlock = code.slice(pruneStart, pruneEnd);
  const stateHelperStart = code.indexOf('function variantStateProperty');
  const stateHelperEnd = code.indexOf('function pruneGeneratedGroupToSourceState', stateHelperStart);
  const stateHelperBlock = code.slice(stateHelperStart, stateHelperEnd);
  assert.match(stateHelperBlock, /property\.toLowerCase\(\) === 'state'/);
  assert.match(pruneBlock, /node\.remove\(\)/);
  assert.match(pruneBlock, /matchingVariants/);

  const generateStart = code.indexOf('async function generateContextSet');
  const generateEnd = code.indexOf('async function buildProjectFoundationSwapContext', generateStart);
  const generateBlock = code.slice(generateStart, generateEnd);
  const pruneCalls = generateBlock.match(/pruneGeneratedGroupToSourceState\(cloneGroup, 'default'\)/g) || [];
  assert.equal(pruneCalls.length, 2);
});


test('Generate skips Disabled variants that already exist in the authored matrix', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /function collectExistingVariantKeys/);
  assert.match(code, /function pruneGeneratedGroupAlreadyExisting/);
  assert.match(code, /collectExistingVariantKeys\(selection, 'disabled'\)/);
  assert.match(code, /existingVariantKeys\?\.has\(key\)/);

  const start = code.indexOf('async function generateContextSet');
  const end = code.indexOf('async function buildProjectFoundationSwapContext', start);
  const block = code.slice(start, end);
  assert.match(block, /const carriedDisabledVariantKeys = new Set\(\)/);
  assert.match(block, /collectExistingVariantKeys\(\[cloneGroup\], 'disabled'\)/);
  assert.match(block, /const disabledKeys = new Set\(\[\.\.\.existingDisabledVariantKeys, \.\.\.carriedDisabledVariantKeys\]\)/);
  assert.match(block, /pruneGeneratedGroupAlreadyExisting\(cloneGroup, disabledKeys, 'disabled'\)/);
  assert.match(block, /totals\.skippedExisting \+= dedupe\.removed/);
  assert.match(block, /if \(dedupe\.remaining === 0\)/);
});

test('generated naming walks nested variant nodes without renaming ordinary wrappers', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('function renameGeneratedGroupChildren');
  const end = code.indexOf('async function applyStateTransformToGeneratedGroup', start);
  const block = code.slice(start, end);

  assert.match(block, /variantNameParts\(node\?\.name\)/);
  assert.match(block, /if \(parsed\?\.parts\?\.length\)/);
  assert.match(block, /for \(const child of node\.children \|\| \[\]\) visit\(child\)/);
});

test('Generate Context Set validates all targets before cloning document nodes', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function generateContextSet');
  const end = code.indexOf('const generated = []', start);
  const validationBlock = code.slice(start, end);

  assert.match(validationBlock, /buildContextRemapCanonicalPlan/);
  assert.doesNotMatch(validationBlock, /\.clone\(\)/);
});

test('Generate Context Set uses native Figma Grid or Auto Layout and removes legacy sibling positioning', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function generateContextSet');
  const end = code.indexOf('function resolvedFlavourExtension', start);
  const block = code.slice(start, end);

  assert.match(code, /function arrangeGroupsWithNativeLayout/);
  assert.match(code, /frame\.layoutMode = 'GRID'/);
  assert.match(code, /frame\.gridItemsPositioning = 'ROW_AUTO_FLOW'/);
  assert.match(code, /frame\.gridAutoTracks = 'ROWS'/);
  assert.match(code, /frame\.gridColumnCount = layout\.columns/);
  assert.match(code, /frame\.layoutSizingHorizontal = 'HUG'/);
  assert.match(code, /frame\.layoutSizingVertical = 'HUG'/);
  assert.match(code, /track\.type = sizing === 'FIXED' \? 'FIXED' : 'HUG'/);
  assert.match(code, /frame\.layoutMode = layout\.direction/);
  assert.match(code, /item\.layoutPositioning = 'AUTO'/);
  assert.match(code, /nodeAbsoluteTransform\(originalGroup\)/);
  assert.match(code, /setNodeAbsoluteTransform\(item, resolvedAbsoluteTransforms\[index\], parent\)/);
  assert.match(block, /figma\.group\(selection, parent\)/);
  assert.match(block, /originalGroup\.clone\(\)/);
  assert.match(block, /arrangeGroupsWithNativeLayout\(parent, originalGroup, generatedGroups, options\)/);
  assert.match(block, /releaseTemporaryGroup\(originalGroup\)/);
  assert.doesNotMatch(code, /positionGeneratedSibling/);
  assert.doesNotMatch(code, /canPositionGeneratedSibling/);
});


test('Core UI exposes Generate Context Set with selectable targets', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /Create a Context set/);
  assert.match(html, /id="contextGenerateDomain"/);
  assert.match(html, /id="contextGenerateFrom"/);
  assert.match(html, /id="contextGenerateTargets"/);
  assert.match(html, /id="contextGenerateAll"/);
  assert.match(html, /id="contextGenerateClear"/);
  assert.match(html, /type: 'context-generate-set'/);
});


test('Generate UI defaults to native Grid presets and Settings can manage presets', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="contextGeneratePreset"/);
  assert.match(html, /id="contextGenerateLayoutMode"/);
  assert.match(html, /id="contextGenerateGridColumns"/);
  assert.match(html, /id="contextGenerateGridRowsMode"/);
  assert.match(html, /data-segmented-select="contextGenerateLayoutMode"/);
  assert.match(html, /id="contextGenerateCustomize"/);
  assert.match(html, /id="contextGenerateUsePreset"/);
  assert.match(html, /data-segmented-select="contextGenerateLayoutDirection"/);
  assert.match(html, /data-segmented-select="contextGenerateLayoutWrap"/);
  assert.match(html, /id="contextGeneratePresetPanel"/);
  assert.match(html, /id="contextGenerateCustomPanel"/);
  assert.match(html, /Grid preset/);
  assert.match(html, /Flow preset/);
  assert.match(html, /data-settings-view="generate"/);
  assert.match(html, /id="generatePresetAdd"/);
  assert.match(html, /id="generatePresetList"/);
  assert.match(html, /id="generatePresetEditor"/);
  assert.match(html, /defaultGeneratePresetId/);
  assert.match(html, /generatePresets/);
});

test('Flavour Extension capabilities come only from resolved manifest extension metadata', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /manifest\?\.flavour\?\.extensions/);
  assert.match(code, /function availableFlavourExtensions/);
  assert.match(code, /usableMappingCount/);
  const block = code.slice(code.indexOf('function availableFlavourExtensions'), code.indexOf('function buildFlavourExtensionPlan'));
  assert.doesNotMatch(block, /timber|pink|sand/i);
});

test('Flavour Extension remap uses registered Flavour Foundations and preserves variable bindings', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function buildFlavourExtensionRuntime');
  const end = code.indexOf('async function applyFlavourExtensionToSelection', start);
  const block = code.slice(start, end);

  assert.match(block, /familyState\(flavourId\)/);
  assert.match(block, /layers\?\.foundations\?\.flavour/);
  assert.match(block, /importVariableByKeyAsync/);
  assert.match(block, /setBoundVariableForPaint/);
  assert.doesNotMatch(block, /setValueForMode|createVariable/);
});

test('Flavour Extension apply and reset operate only on current selection', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function applyFlavourExtensionToSelection');
  const end = code.indexOf('async function buildProjectFoundationSwapContext', start);
  const block = code.slice(start, end);

  assert.match(block, /figma\.currentPage\.selection/);
  assert.match(code, /mappings\[targetCanonical\] = contextCanonical/);
  assert.match(code, /mappings\[contextCanonical\] = targetCanonical/);
  assert.doesNotMatch(block, /loadAllPagesAsync/);
});

test('plugin IA keeps everyday work in Tools and Flavours only', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /data-tab="tools">Tools<\/button>/);
  assert.match(html, /data-tab="flavours">Flavours<\/button>/);
  assert.doesNotMatch(html, /data-tab="core"/);
  assert.doesNotMatch(html, /data-tab="help"/);
  assert.match(html, /id="openHelp"/);
  assert.match(html, /id="openSettings"/);
});

test('Tools owns remap generate and Flavour Extensions', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const toolsStart = html.indexOf('id="tab-tools"');
  const flavoursStart = html.indexOf('id="tab-flavours"');
  const tools = html.slice(toolsStart, flavoursStart);

  assert.match(tools, /Remap selection/);
  assert.match(tools, /Create a Context set/);
  assert.match(tools, /<h3>Use Flavour-defined Context targets<\/h3>/);
  assert.match(tools, /id="flavourExtensionSelect"/);
});

test('one-time Core and repository setup live under Settings subnavigation', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const settingsStart = html.indexOf('id="tab-settings"');
  const helpStart = html.indexOf('id="tab-help"');
  const settings = html.slice(settingsStart, helpStart);

  assert.match(settings, /data-settings-view="general"/);
  assert.match(settings, /data-settings-view="core-setup"/);
  assert.match(settings, /data-settings-view="repository"/);
  assert.match(settings, /Master library/);
  assert.match(settings, /id="baselineSync"/);
  assert.match(settings, /id="repoRefresh"/);
  assert.match(settings, /id="sourceMode"/);
  assert.match(settings, /id="analyse"/);
  assert.match(settings, /id="apply"/);
});

test('default opening tab migrates old Core and Help values to Tools', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /stored\?\.defaultTab === 'core' \|\| stored\?\.defaultTab === 'help'/);
  assert.match(code, /new Set\(\['tools', 'flavours'\]\)/);
  assert.match(html, /<option value="tools">Tools<\/option>/);
  assert.match(html, /<option value="flavours">Flavours<\/option>/);
});


test('Focus generated results is persisted and controls zoom-centre behaviour', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /focusGeneratedResults: stored\?\.focusGeneratedResults !== false/);
  assert.match(code, /if \(options\.focusResults !== false\)/);
  assert.match(code, /scrollAndZoomIntoView\(generated\)/);
  assert.match(html, /id="focusGeneratedResultsToggle"/);
  assert.match(html, /focusResults: currentPluginSettings\.focusGeneratedResults/);
});

test('selection source auto-detection scores real canonical variable bindings', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /async function detectSelectionContextTargets/);
  assert.match(code, /collectSelectionCanonicalBindings/);
  assert.match(code, /contextTargetCanonicalIds/);
  assert.match(code, /projectSourceVariableCanonical/);
  assert.match(code, /status: 'mixed'/);
});

test('selection changes trigger source auto-detection without scanning the document', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /figma\.on\('selectionchange'/);
  assert.match(code, /type: 'selection-changed'/);
  assert.match(html, /type: 'selection-context-detect'/);
  assert.match(html, /Detected: \$\{detection\.label\}/);
  assert.doesNotMatch(
    code.slice(code.indexOf('async function detectSelectionContextTargets'), code.indexOf('async function buildCoreContextRemapRuntime')),
    /loadAllPagesAsync/
  );
});


test('plugin typography uses a 1rem readable baseline with explicit compact exceptions', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /:root\s*\{\s*font-size:16px;/);
  assert.match(html, /body,[\s\S]*?font-size:1rem;/);
  assert.match(html, /Compact\/supporting text is intentionally allowed below 1rem/);
  assert.match(html, /font-size:\.875rem/);
  assert.match(html, /Microcopy only/);
  assert.match(html, /font-size:\.8125rem/);
});

test('sticky plugin chrome uses translucent blur and a subtle separation shadow', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /\.app-header\s*\{[\s\S]*?position:sticky;[\s\S]*?backdrop-filter:blur\(12px\)/);
  assert.match(html, /\.tabs\s*\{[\s\S]*?position:sticky;[\s\S]*?background:color-mix[\s\S]*?box-shadow:0 5px 12px rgba\(0,0,0,\.07\)/);
});



test('variable type migration parks the old same-name variable before creating its replacement', () => {
  const source = fs.readFileSync(path.join(ROOT, 'plugin', 'src', 'code.mjs'), 'utf8');
  const start = source.indexOf('if (variable && variable.resolvedType !== definition.type)');
  const end = source.indexOf('} else if (variable && variable.variableCollectionId !== collection.id)', start);
  const block = source.slice(start, end);

  assert.match(block, /oldVariable\.name = `__BufferCore Migration \/ \${definition\.id} \/ \${oldVariable\.id}`/);
  assert.ok(block.indexOf('oldVariable.name =') < block.indexOf('figma.variables.createVariable(figmaName, collection, definition.type)'));
});

test('variable sync does not touch an unchanged Figma name when applying metadata-only updates', () => {
  const source = fs.readFileSync(path.join(ROOT, 'plugin', 'src', 'code.mjs'), 'utf8');
  assert.match(source, /if \(variable\.name !== figmaName\) variable\.name = figmaName;/);
  assert.doesNotMatch(source, /\n\s*variable\.name = figmaName;\n\s*applyVariableScopes/);
});

test('exposure-only variable migrations are safe updates, not drift or conflicts', async () => {
  const definition = {
    id: 'colour.text.primary', name: 'Text / Primary', collectionId: 'semantic.colour', type: 'COLOR',
    scopes: ['TEXT_FILL', 'SHAPE_FILL'], publish: true,
    modeValues: [{ mode: { name: 'Light' }, value: { kind: 'literal', value: { r: 0, g: 0, b: 0, a: 1 } } }]
  };
  const oldSource = { ...definition, scopes: ['ALL_FILLS'], publish: true };
  const oldLive = JSON.parse(desiredVariableSignature(oldSource));
  oldLive.scopes = ['ALL_FILLS'];
  const currentLive = { ...oldLive, scopes: ['FRAME_FILL'] };
  const desired = { collections: [{ id: 'semantic.colour', variables: [definition] }], styles: [] };
  const snapshot = {
    collections: [], styles: [],
    variables: [{
      canonicalId: definition.id,
      liveSignature: stableStringify(currentLive),
      appliedSignature: desiredVariableSignature(oldSource),
      appliedLiveSignature: stableStringify(oldLive)
    }]
  };
  const diff = buildDiffSummary(desired, snapshot);
  assert.equal(diff.variables.update.length, 1);
  assert.equal(diff.variables.drift.length, 0);
  assert.equal(diff.variables.conflict.length, 0);
});

test('exposure migration does not hide genuine variable value conflicts', async () => {
  const definition = {
    id: 'colour.text.primary', name: 'Text / Primary', collectionId: 'semantic.colour', type: 'COLOR',
    scopes: ['TEXT_FILL'], publish: true,
    modeValues: [{ mode: { name: 'Light' }, value: { kind: 'literal', value: { r: 0, g: 0, b: 0, a: 1 } } }]
  };
  const oldSource = { ...definition, scopes: ['ALL_FILLS'] };
  const oldLive = JSON.parse(desiredVariableSignature(oldSource));
  const currentLive = JSON.parse(JSON.stringify(oldLive));
  currentLive.scopes = ['FRAME_FILL'];
  currentLive.modeValues[0].value = { kind: 'literal', value: { r: 1, g: 0, b: 0, a: 1 } };
  const desired = { collections: [{ id: 'semantic.colour', variables: [definition] }], styles: [] };
  const snapshot = {
    collections: [], styles: [],
    variables: [{
      canonicalId: definition.id,
      liveSignature: stableStringify(currentLive),
      appliedSignature: desiredVariableSignature(oldSource),
      appliedLiveSignature: stableStringify(oldLive)
    }]
  };
  const diff = buildDiffSummary(desired, snapshot);
  assert.equal(diff.variables.update.length, 0);
  assert.equal(diff.variables.conflict.length, 1);
});


test('all master layer registrations can establish identity before publishing assets', () => {
  const source = fs.readFileSync(path.join(ROOT, 'plugin/src/code.mjs'), 'utf8');
  const block = source.slice(source.indexOf('async function registerCurrentSystemLayer'), source.indexOf('async function masterAssetCanonicalByKey'));
  assert.match(block, /const isMasterRegistration = role === 'master'/);
  assert.match(block, /isMasterRegistration[\s\S]*?currentLayerPublishStatus\(layer\)[\s\S]*?: await assertLayerPublishedCurrent\(layer\)/);
});


test('master registration is never blocked by publish-status UI gating', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /const masterRegistration = role === 'master'/);
  assert.match(html, /if \(!masterRegistration && \$\('registerSystemLayer'\)\.dataset\.publishReady !== 'true'\)/);
  assert.match(html, /dataset\.publishReady = masterRegistration \? 'true' : 'false'/);
});

test('Foundations master registration captures local publishable bindings even when publish status is stale', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function publishedFoundationBindings\(\{ requireCurrent = true \} = \{\}\)/);
  assert.match(source, /const localVariables = await figma\.variables\.getLocalVariablesAsync\(\)/);
  assert.match(source, /requireCurrent \? await safePublishStatus\(variable\) : 'CURRENT'/);
  assert.match(source, /publishedFoundationBindings\(\{ requireCurrent: false \}\)/);
});


test('registered master cards can open their Figma source file', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.equal(manifest.enablePrivatePluginApi, true);
  assert.match(code, /fileKey: figma\.fileKey \|\| null/);
  assert.match(code, /message\?\.type === 'open-registered-file'/);
  assert.match(code, /figma\.openExternal\(`https:\/\/www\.figma\.com\/design\/\$\{encodeURIComponent\(fileKey\)\}`\)/);
  assert.match(html, /data-family-card=\"foundations\"/);
  assert.match(html, /openRegisteredFamilyCard/);
  assert.match(html, /type: 'open-registered-file', fileKey/);
});


test('variant-name helper preserves comma-separated Figma property naming while updating an existing property', () => {
  const name = 'Type=Solid, Colour=Primary, Size=Large, Interaction=Default, State=Default, Content=Default';
  assert.equal(
    upsertVariantNameProperty(name, ['Colour', 'Color'], 'Secondary', 'Colour'),
    'Type=Solid, Colour=Secondary, Size=Large, Interaction=Default, State=Default, Content=Default'
  );
});

test('variant-name helper preserves slash-separated property naming', () => {
  const name = 'Type=Solid / Colour=Primary / Size=Large / State=Default';
  assert.equal(
    upsertVariantNameProperty(name, ['Colour', 'Color'], 'Accent', 'Colour'),
    'Type=Solid / Colour=Accent / Size=Large / State=Default'
  );
});

test('variant-name helper recognises British and American colour property names without duplicating them', () => {
  const name = 'Type=Solid, Color=Primary, State=Default';
  assert.equal(
    upsertVariantNameProperty(name, ['Colour', 'Color'], 'Warning', 'Colour'),
    'Type=Solid, Color=Warning, State=Default'
  );
});

test('variant-name helper can add a missing property using the existing delimiter style', () => {
  assert.equal(
    upsertVariantNameProperty('Type=Solid / Size=Large', ['Colour', 'Color'], 'Primary', 'Colour'),
    'Type=Solid / Size=Large / Colour=Primary'
  );
});

test('variant-name parser rejects ordinary slash names that are not variant property lists', () => {
  assert.equal(variantNameParts('Button / Primary'), null);
});

test('generated Context naming updates variant properties rather than stacking slash suffixes', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /upsertVariantNameProperty\(originalName, propertyNames, targetLabel/);
  assert.match(source, /upsertVariantNameProperty\(originalName, \['State'\], stateLabel/);
  assert.match(source, /renameGeneratedGroupChildren\(cloneGroup, targetLabel, stateId, domainId\)/);
  assert.match(source, /function disabledCopyName\(originalName\) \{\s*return generatedStateName\(originalName, 'disabled'\);/);
});


test('desired opacity signatures use Figma percentage-space values', async () => {
  const core = await import('../packages/figma-plugin-core/src/index.mjs');
  const signature = JSON.parse(core.desiredVariableSignature({
    id: 'opacity.45',
    cssVariable: '--bc-opacity-45',
    figmaName: '45',
    collectionId: 'primitive.opacity',
    type: 'FLOAT',
    scopes: ['OPACITY'],
    publish: false,
    modeValues: [{ mode: { name: 'Default' }, value: { kind: 'literal', value: 0.45 } }]
  }));
  assert.equal(signature.modeValues[0].value.value, 45);
});


test('Context Remap recovers stale registered variable keys from enabled Figma libraries', async () => {
  const code = await fs.promises.readFile(path.join(ROOT, 'plugin/src/code.mjs'), 'utf8');
  assert.match(code, /getAvailableLibraryVariableCollectionsAsync/);
  assert.match(code, /getVariablesInLibraryCollectionAsync/);
  assert.match(code, /staleKeysRecovered/);
});

test('plugin manifest permits Team Library lookup for resilient Context Remap', async () => {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'plugin/manifest.json'), 'utf8'));
  assert.ok(manifest.permissions?.includes('teamlibrary'));
});


test('plugin treats orphaned BufferCore variables as actionable apply work', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(source, /diff\.variables\?\.orphaned\?\.length/);
  assert.match(source, /stale BufferCore variable/);
});


test('Context text ambiguity resolver maps chromatic text cleanly into Neutral text', async () => {
  const { resolveContextMappingAmbiguity } = await import('../packages/figma-plugin-core/src/index.mjs');
  assert.equal(
    resolveContextMappingAmbiguity('colour', '--bc-color-text-primary', ['--bc-color-text', '--bc-color-text-inverse']),
    '--bc-color-text'
  );
  assert.equal(
    resolveContextMappingAmbiguity('colour', '--bc-color-text-primary-strong-inverse', ['--bc-color-text', '--bc-color-text-inverse']),
    '--bc-color-text-inverse'
  );
});

test('Context text ambiguity resolver maps Neutral text back to the closest chromatic role', async () => {
  const { resolveContextMappingAmbiguity } = await import('../packages/figma-plugin-core/src/index.mjs');
  assert.equal(
    resolveContextMappingAmbiguity('colour', '--bc-color-text', ['--bc-color-text-primary', '--bc-color-text-primary-strong']),
    '--bc-color-text-primary'
  );
  assert.equal(
    resolveContextMappingAmbiguity('colour', '--bc-color-text-inverse', ['--bc-color-text-primary', '--bc-color-text-primary-strong-inverse']),
    '--bc-color-text-primary-strong-inverse'
  );
});

test('Context ambiguity resolver stays strict outside Colour Text', async () => {
  const { resolveContextMappingAmbiguity } = await import('../packages/figma-plugin-core/src/index.mjs');
  assert.equal(
    resolveContextMappingAmbiguity('colour', '--bc-color-fill-primary', ['--bc-color-fill-neutral', '--bc-color-fill-neutral-strong']),
    null
  );
  assert.equal(
    resolveContextMappingAmbiguity('typography', '--bc-type-context', ['--bc-type-a', '--bc-type-b']),
    null
  );
});
