import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cartesianModeCombinations,
  desiredValueForMode,
  buildDesiredModel,
  buildDiffSummary,
  summariseDiffByKind
} from '../packages/figma-plugin-core/src/index.mjs';

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



test('plugin filters scopes by the exact Figma variable type and never writes an empty scope list', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /VALID_SCOPES_BY_TYPE/);
  assert.match(source, /if \(!requested\.length\) return;/);
  assert.match(source, /if \(!scopes\.length\) return;/);
  assert.match(source, /applyVariableScopes\(variable, definition, result\)/);
});

test('plugin treats rejected Figma scopes as a warning rather than aborting the whole apply', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /variable\.scopes = scopes;/);
  assert.match(source, /catch \(error\)/);
  assert.match(source, /Figma rejected scopes/);
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

test('plugin removes only explicitly retired BufferCore variables', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /cleanupRetiredVariables/);
  assert.match(source, /desired\.retiredVariables/);
  assert.match(source, /retiredIds\.has\(canonicalId\)/);
  assert.match(source, /removedRetiredVariables/);
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
  const signature = core.desiredVariableSignature(definition);
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
  const applied = core.desiredVariableSignature(desiredVariable);
  const snapshot = {
    collections: [{ canonicalId: 'semantic.spacing', name: 'Semantic: Spacing', publish: true, modeNames: ['Default'], liveSignature: core.desiredCollectionSignature(desired.collections[0]), appliedSignature: core.desiredCollectionSignature(desired.collections[0]), appliedLiveSignature: core.desiredCollectionSignature(desired.collections[0]) }],
    variables: [{ canonicalId: 'space.gap', liveSignature: core.stableStringify({ name: 'Gap manually edited', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true, modeValues: [{ mode: 'Default', value: { kind: 'literal', value: 16 } }] }), appliedSignature: applied, appliedLiveSignature: applied }],
    styles: []
  };
  const diff = core.buildDiffSummary(desired, snapshot);
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
    variables: [{ canonicalId: 'space.gap', liveSignature: core.stableStringify({ name: 'Gap', collectionId: 'semantic.spacing', type: 'FLOAT', scopes: ['GAP'], publish: true, modeValues: [{ mode: 'Default', value: { kind: 'literal', value: 20 } }] }), appliedSignature: core.desiredVariableSignature(oldDefinition), appliedLiveSignature: core.desiredVariableSignature(oldDefinition) }],
    styles: []
  };
  const diff = core.buildDiffSummary({ collections: [collection], styles: [] }, snapshot);
  assert.equal(diff.variables.conflict.length, 1);
});

test('managed objects absent from the manifest are surfaced as orphaned and are not silently deleted', async () => {
  const core = await import('../packages/figma-plugin-core/src/index.mjs');
  const diff = core.buildDiffSummary({ collections: [], styles: [] }, {
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


test('resize grip sends mouse-delta dimensions to figma.ui.resize without changing the subtle grip UI', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(html, /id="resizeGrip"/);
  assert.match(html, /addEventListener\('mousedown'/);
  assert.match(html, /event\.movementX/);
  assert.match(html, /type: 'resize-window'/);
  assert.doesNotMatch(html, /id="sizeWide"/);

  assert.match(code, /message\?\.type === 'resize-window'/);
  assert.match(code, /figma\.ui\.resize/);
});


test('project Flavour adapter is sparse and only materialises bindings used by the consumer file', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /collectProjectThemeRequirements/);
  assert.match(code, /requiredVariableIds = new Set\(\)/);
  assert.match(code, /requiredStyleIds = new Set\(\)/);
  assert.match(code, /ensureProjectThemeAdapter\(\s*manifest,\s*requiredVariableIds,\s*requiredStyleIds/s);
  assert.match(code, /BC Project Theme · \$\{flavourName\}/);
  assert.doesNotMatch(code, /BC Theme · \$\{flavourName\} · \$\{definition\.name\}/);
});

test('applying a project Flavour removes old full adapters and does not materialise extension primitives automatically', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /removeExistingProjectThemeAdapter/);
  assert.match(code, /Extensions remain Flavour primitive additions/);
  assert.match(code, /Surface them as metadata only/);
});


test('local workspace Flavour application is not disabled by dirty Git working trees', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /const githubMode = payload\.sourceMode === 'github'/);
  assert.match(html, /dirtyFlavoursBlockPull = githubMode && Boolean\(payload\.flavoursRepository\?\.dirty\)/);
  assert.match(html, /\$\('applyProjectFlavour'\)\.disabled = Boolean\(payload\.syncing\) \|\| !select\.value/);
  assert.match(html, /Local workspace mode is using your current working tree/);
});


test('project Flavour application uses direct overrides and creates no local Foundation clone', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /applyProjectLiteralNode/);
  assert.match(code, /removeAnyGeneratedProjectThemeObjects/);
  assert.match(code, /createdVariables: 0/);
  assert.match(code, /createdCollections: 0/);
  assert.doesNotMatch(code, /createVariableCollection\(`BC Project Theme/);
});

test('project paint bindings resolve to Flavour literals rather than new local variables', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /applyProjectLiteralPaints/);
  assert.match(code, /setBoundVariableForPaint\(paint, field, null\)/);
  assert.match(code, /resolveProjectThemeLiteral/);
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
  assert.match(html, /Build \/ update this file/);
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
  assert.match(html, /data-tab="help"/);
  assert.match(html, /id="tab-help"/);
  assert.match(html, /Set up Core once/);
  assert.match(html, /Build a Flavour Foundations library/);
  assert.match(html, /Apply a Flavour to a project/);
  assert.match(html, /Reconcile after BC updates/);
  assert.match(html, /Flavours only get their own Foundations library/);
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

  assert.match(code, /!variable\.hiddenFromPublishing/);
  assert.match(code, /!collection\.hiddenFromPublishing/);
  assert.match(code, /safePublishStatus\(variable\) !== 'CURRENT'/);
  assert.match(code, /safePublishStatus\(style\) !== 'CURRENT'/);
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
  assert.match(html, /manual safety check after larger library updates/);
});


test('manifest exposes native BufferCore commands and relaunch buttons', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));

  assert.deepEqual(
    manifest.menu.map((item) => item.command),
    ['open', 'flavours', 'extensions']
  );
  assert.deepEqual(
    manifest.relaunchButtons.map((item) => item.command),
    ['open', 'extensions']
  );
});

test('plugin installs BufferCore relaunch data without scanning the document', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /setRelaunchData\(BUFFERCORE_RELAUNCH_DATA\)/);
  assert.match(code, /figma\.on\('selectionchange'/);
  assert.match(code, /\.slice\(0, 50\)/);
  const relaunchBlock = code.slice(
    code.indexOf('function installBufferCoreRelaunchData'),
    code.indexOf("figma.on('selectionchange'")
  );
  assert.doesNotMatch(relaunchBlock, /findAll|loadAllPagesAsync/);
});

test('native commands route directly to Flavours and Extensions UI', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /figma\.command === 'flavours'/);
  assert.match(code, /figma\.command === 'extensions'/);
  assert.match(html, /data-tab="extensions"/);
  assert.match(html, /id="tab-extensions"/);
  assert.match(html, /type: 'ui-ready'/);
  assert.match(html, /message\.type === 'launch-route'/);
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
  assert.match(html, /value="core">Core/);
  assert.match(html, /value="flavours">Flavours/);
  assert.match(html, /value="help">Help/);
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

test('Core Remap imports canonical target variables from registered BC Foundations', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /masterFoundations\.bindings\?\.variables/);
  assert.match(code, /figma\.variables\.importVariableByKeyAsync/);
  assert.match(code, /BC: Foundations must be published and registered/);
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
  assert.match(block, /original\.clone\(\)/);
  assert.match(block, /buildCoreContextRemapRuntime/);
  assert.match(block, /remapContextNode\(clone/);
  assert.doesNotMatch(block, /loadAllPagesAsync/);
  assert.doesNotMatch(block, /detachInstance/);
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

test('Generate Context Set names and arranges generated siblings without forcing auto-layout coordinates', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /contextSetGeneratedName/);
  assert.match(code, /positionGeneratedSibling/);
  assert.match(code, /parent\.layoutMode/);
  assert.match(code, /clone\.x = original\.x/);
});

test('Core UI exposes Generate Context Set with selectable targets', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /Generate Context set/);
  assert.match(html, /id="contextGenerateDomain"/);
  assert.match(html, /id="contextGenerateFrom"/);
  assert.match(html, /id="contextGenerateTargets"/);
  assert.match(html, /id="contextGenerateAll"/);
  assert.match(html, /id="contextGenerateClear"/);
  assert.match(html, /type: 'context-generate-set'/);
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

test('Project Flavours UI exposes manifest-driven Extensions with Apply and Reset to Context', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /<div class="panel-title">Extensions<\/div>/);
  assert.match(html, /id="flavourExtensionSelect"/);
  assert.match(html, /id="applyFlavourExtension"/);
  assert.match(html, /id="resetFlavourExtension"/);
  assert.match(html, /Reset to Context/);
  assert.match(html, /type: 'flavour-extension-capabilities'/);
  assert.match(html, /type: 'flavour-extension-selection'/);
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
  assert.match(tools, /Generate Context set/);
  assert.match(tools, /<div class="panel-title">Extensions<\/div>/);
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


test('plugin resize uses window-level drag tracking so dragging survives leaving the grip', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="resizeGrip"/);
  assert.match(html, /id="resizeHeightGrip"/);
  assert.match(html, /window\.addEventListener\('mousemove', moveDrag\)/);
  assert.match(html, /window\.addEventListener\('mouseup', endDrag\)/);
  assert.match(html, /drag\.mode === 'height' \? drag\.width/);
});

test('plugin resize supports substantially taller windows', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /Math\.min\(1400, Number\(message\.height\)/);
  assert.match(code, /Math\.max\(420,/);
  assert.match(html, /const MAX_H = 1400/);
  assert.match(html, /const MIN_H = 420/);
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


test('plugin removes all custom drag resize UI and logic', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /resizeGrip|resizeHeightGrip|resize-grip|resize-height-grip|bc-resizing/);
  assert.doesNotMatch(html, /mousedown[\s\S]*requestResize|pointerdown[\s\S]*requestResize/);
  assert.doesNotMatch(code, /message\?\.type === 'resize-window'/);
});

test('plugin uses official figma.ui.resize only through named window presets', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /const WINDOW_PRESETS =/);
  assert.match(code, /figma\.ui\.resize\(size\.width, size\.height\)/);
  assert.match(code, /window-preset-apply/);
  assert.match(html, /id="windowPreset"/);
  assert.match(html, /Extra Tall · 680 × 1200/);
});

test('window preset persists and is restored when the plugin opens', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /windowPreset: allowedWindowPresets\.has\(stored\?\.windowPreset\)/);
  assert.match(code, /applyWindowPreset\(settings\.windowPreset\)/);
});


test('header and nav share one sticky chrome container', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /<div class="top-chrome">\s*<header class="app-header">/);
  assert.match(html, /<\/nav>\s*<\/div>\s*<main class="workspace">/);
  assert.match(html, /\.top-chrome\s*\{[\s\S]*?position:sticky;[\s\S]*?top:0;/);
  assert.match(html, /\.top-chrome \.app-header\s*\{[\s\S]*?position:relative;/);
  assert.match(html, /\.top-chrome \.tabs\s*\{[\s\S]*?position:relative;/);
});


test('plugin opens at a larger desktop-first size', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /figma\.showUI\(__html__, \{ width: 900, height: 1000/);
  assert.match(code, /comfortable: \{ width: 900, height: 1000 \}/);
  assert.match(code, /tall: \{ width: 900, height: 1200 \}/);
  assert.match(code, /wide: \{ width: 1100, height: 1000 \}/);
});

test('legacy small window presets migrate to comfortable size', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /standard: 'comfortable'/);
  assert.match(code, /large: 'comfortable'/);
  assert.match(code, /windowPreset: allowedWindowPresets\.has\(storedWindowPreset\) \? storedWindowPreset : 'comfortable'/);
});


test('compact UI pass reduces typography and spacing for dense plugin use', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /:root\s*\{\s*font-size:14px;/);
  assert.match(html, /\.app-header\s*\{\s*padding:14px 20px 12px;/);
  assert.match(html, /\.panel-body\s*\{\s*padding:12px;/);
  assert.match(html, /\.control-label\s*\{[\s\S]*?font-size:\.78rem/);
  assert.match(html, /\.context-target-option\s*\{[\s\S]*?font-size:\.82rem/);
});

test('sticky header keeps explicit bottom padding in compact pass', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /\.app-header\s*\{\s*padding:14px 20px 12px;/);
  assert.match(html, /\.tabs\s*\{\s*padding:6px 20px 0;/);
});


test('fresh utility rebuild uses compact top chrome with no sidebar', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /class="utility-chrome"/);
  assert.match(html, /class="utility-header"/);
  assert.match(html, /class="utility-tabs"/);
  assert.doesNotMatch(html, /class="app-sidebar"/);
});

test('Tools are rebuilt as flat divider-separated sections', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const toolsStart = html.indexOf('id="tab-tools"');
  const flavoursStart = html.indexOf('id="tab-flavours"');
  const tools = html.slice(toolsStart, flavoursStart);

  assert.match(tools, /class="tool-kicker">Remap<\/div>/);
  assert.match(tools, /class="tool-kicker">Generate<\/div>/);
  assert.match(tools, /class="tool-kicker">Extensions<\/div>/);
  assert.doesNotMatch(tools, /class="panel"/);
  assert.match(html, /\.tool-section,[\s\S]*?border-bottom:1px solid var\(--bc-line\)/);
});

test('Flavours and Settings use lightweight inline subnavigation', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /\.workflow-switch,[\s\S]*?border:0;/);
  assert.match(html, /\.workflow-button\.active::after/);
  assert.match(html, /\.settings-nav-button\.active::after/);
});


test('mini design system defines coherent foundations and components', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /BUFFERCORE FIGMA MINI DESIGN SYSTEM/);
  assert.match(html, /--bc-accent:#6758ff/);
  assert.match(html, /--bc-r-xl:16px/);
  assert.match(html, /--bc-shadow-soft:/);
  assert.match(html, /\.bc-appbar\{/);
  assert.match(html, /\.bc-tool-tabs\{/);
  assert.match(html, /\.bc-tool-surface,/);
});

test('Tools now show one focused workspace at a time', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /data-tool-view="remap"/);
  assert.match(html, /data-tool-view="generate"/);
  assert.match(html, /data-tool-view="extensions"/);
  assert.match(html, /data-tool-panel="generate" hidden/);
  assert.match(html, /function activateToolView/);
});

test('new app shell uses compact branded chrome and segmented navigation', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /class="bc-appbar"/);
  assert.match(html, /class="bc-primary-nav"/);
  assert.match(html, /class="bc-brand-mark"/);
  assert.doesNotMatch(html, /class="app-sidebar"/);
});


test('design system polish increases global readability and control sizing', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /font-size:15px/);
  assert.match(html, /\.bc-icon-button\s*\{[\s\S]*?width:36px;[\s\S]*?height:36px;/);
  assert.match(html, /select,[\s\S]*?min-height:40px;/);
  assert.match(html, /\.action,[\s\S]*?min-height:38px;/);
});

test('accent colour is reserved and headings no longer use blue accent text', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /--bc-accent:#6357e8/);
  assert.match(html, /\.bc-eyebrow,[\s\S]*?color:var\(--bc-text-soft\)/);
  assert.match(html, /\.bc-primary-tab\.active\s*\{[\s\S]*?color:var\(--bc-text\)/);
});

test('page and surface padding use shared design system spacing tokens', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /--bc-page-x:22px/);
  assert.match(html, /--bc-page-y:22px/);
  assert.match(html, /--bc-surface-pad:20px/);
  assert.match(html, /\.workspace\s*\{[\s\S]*?padding:var\(--bc-page-y\) var\(--bc-page-x\) 28px;/);
});


test('size-only correction preserves design-system layout at 780px default', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /figma\.showUI\(__html__, \{ width: 780, height: 860/);
  assert.match(html, /SIZE-ONLY CORRECTION/);
  assert.match(html, /@media \(max-width:620px\)/);
  assert.match(html, /class="bc-tool-tabs"/);
  assert.match(html, /class="bc-tool-surface"/);
});

test('size-only correction uses medium control and type scale', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /font-size:14px/);
  assert.match(html, /\.bc-icon-button\s*\{[\s\S]*?width:34px;[\s\S]*?height:34px;/);
  assert.match(html, /select,[\s\S]*?min-height:36px;/);
  assert.match(html, /\.action,[\s\S]*?min-height:35px;/);
});


test('General settings has explicit top padding', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /\.settings-view\[data-settings-panel="general"\]\s*\{\s*padding-top:16px;/);
});

test('font size setting persists and applies root scale', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(code, /fontScale: allowedFontScales\.has\(stored\?\.fontScale\) \? stored\.fontScale : 'default'/);
  assert.match(html, /id="fontScale"/);
  assert.match(html, /function applyFontScale\(scale\)/);
  assert.match(html, /html\[data-font-scale="small"\]/);
  assert.match(html, /html\[data-font-scale="default"\]/);
  assert.match(html, /html\[data-font-scale="large"\]/);
});


test('General settings uses live sliders for window dimensions and root font size', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="windowWidthRange"[^>]*type="range"/);
  assert.match(html, /id="windowHeightRange"[^>]*type="range"/);
  assert.match(html, /id="fontSizeRange"[^>]*type="range"/);
  assert.match(html, /min="12\.5" max="16\.5" step="0\.25"/);
  assert.match(html, /document\.documentElement\.style\.fontSize = `\$\{size\}px`/);
});

test('window dimensions and exact font size persist as numeric settings', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /windowWidth: clampNumber\(stored\?\.windowWidth/);
  assert.match(code, /windowHeight: clampNumber\(stored\?\.windowHeight/);
  assert.match(code, /fontSizePx: clampNumber\(stored\?\.fontSizePx/);
  assert.match(code, /message\?\.type === 'window-size-apply'/);
});


test('Help and Settings utility icons have active states', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /\$\('openHelp'\)\?\.classList\.toggle\('active', name === 'help'\)/);
  assert.match(html, /\$\('openSettings'\)\?\.classList\.toggle\('active', name === 'settings'\)/);
  assert.match(html, /\.bc-icon-button\.active\s*\{/);
});

test('motion system animates tabs panels and help accordion', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /@keyframes bc-panel-enter/);
  assert.match(html, /classList\.add\('bc-enter'\)/);
  assert.match(html, /\.bc-tool-tab::after/);
  assert.match(html, /details\.addEventListener\('toggle'/);
  assert.match(html, /\.help-body\s*\{[\s\S]*?max-height/);
  assert.match(html, /prefers-reduced-motion: reduce/);
});


test('window supports drag resizing from right bottom and corner handles', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /data-resize-axis="x"/);
  assert.match(html, /data-resize-axis="y"/);
  assert.match(html, /data-resize-axis="xy"/);
  assert.match(html, /function startWindowResize\(event, axis\)/);
  assert.match(html, /type: 'window-resize-live'/);
  assert.match(html, /type: 'window-resize-commit'/);
});

test('drag resizing uses the same persisted numeric window sizing system as sliders', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /message\?\.type === 'window-resize-live'/);
  assert.match(code, /applyWindowSize\(message\.width, message\.height\)/);
  assert.match(code, /message\?\.type === 'window-resize-commit'/);
  assert.match(code, /writePluginSettings\(\{\s*windowWidth: message\.width,\s*windowHeight: message\.height/);
});


test('Flavour workflow uses one consistent spacing rhythm', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /FLAVOUR WORKFLOW SPACING NORMALISATION/);
  assert.match(html, /\.bc-flavour-surface \.flavour-workflow\s*\{[\s\S]*?padding:18px;/);
  assert.match(html, /\.bc-flavour-surface \.flow-section,[\s\S]*?margin:0 0 16px;[\s\S]*?padding:0 0 16px;/);
  assert.match(html, /\.bc-flavour-surface \.project-status-bar\s*\{[\s\S]*?padding:12px;/);
  assert.match(html, /\.bc-flavour-surface \.auto-reconcile-row\s*\{[\s\S]*?margin-top:14px;/);
});


test('font size slider supports up to 24px', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(html, /id="fontSizeRange"[^>]*max="24"/);
  assert.match(html, /Math\.min\(24, Number\(value\) \|\| 14\)/);
  assert.match(code, /clampNumber\(stored\?\.fontSizePx, 12\.5, 24, legacyFontSize\)/);
  assert.match(code, /clampNumber\(next\.fontSizePx, 12\.5, 24, current\.fontSizePx\)/);
});


test('Flavours and Settings use the same navigation treatment as Tools', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /UNIFIED NAVIGATION \+ MOTION LANGUAGE/);
  assert.match(html, /\.bc-tool-tabs,\s*\.workflow-switch,\s*\.settings-nav\s*\{/);
  assert.match(html, /\.bc-tool-tab,\s*\.workflow-button,\s*\.settings-nav-button\s*\{/);
  assert.match(html, /\.workflow-button\.active::after/);
  assert.match(html, /\.settings-nav-button\.active::after/);
});

test('Flavour view switching uses the same panel entrance animation as Tools', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /playPanelEntrance\(activeFlavourView === 'library' \? libraryPanel : projectPanel\)/);
  assert.match(html, /\.workflow-button:focus-visible/);
});


test('all four navigation groups use the exact same tablist component markup', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const tablists = html.match(/class="bc-tablist"/g) || [];
  assert.equal(tablists.length, 4);

  const oldMarkupClasses = [
    'class="bc-tool-tabs"',
    'class="workflow-switch"',
    'class="settings-nav"',
    'class="bc-primary-tab',
    'class="bc-tool-tab',
    'class="workflow-button',
    'class="settings-nav-button'
  ];
  for (const oldClass of oldMarkupClasses) {
    assert.equal(html.includes(oldClass), false, oldClass);
  }
});

test('exact shared tab component owns one box model only', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /EXACT SAME TAB COMPONENT — NO VARIANTS/);
  assert.match(html, /\.bc-tablist\s*\{[\s\S]*?margin:0;[\s\S]*?padding:5px;[\s\S]*?gap:6px;/);
  assert.match(html, /\.bc-tab\s*\{[\s\S]*?min-height:42px;[\s\S]*?margin:0;[\s\S]*?padding:0 10px;/);
  assert.match(html, /\.bc-tab-icon\s*\{[\s\S]*?width:21px;[\s\S]*?height:21px;[\s\S]*?margin:0;[\s\S]*?padding:0;/);
});


test('header navigation is restored as a separate lightweight component', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /HEADER NAV RESTORED/);
  assert.match(html, /class="bc-primary-tab active"[^>]*data-tab="tools"/);
  assert.match(html, /class="bc-primary-tab"[^>]*data-tab="flavours"/);

  const bodyTablists = html.match(/class="bc-tablist"/g) || [];
  assert.equal(bodyTablists.length, 3);
});

test('body tab groups remain the exact same shared component', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /data-tool-view="remap"/);
  assert.match(html, /data-flavour-view="library"/);
  assert.match(html, /data-settings-view="general"/);

  assert.match(html, /\.bc-tablist\s*\{[\s\S]*?padding:5px;[\s\S]*?gap:6px;/);
  assert.match(html, /\.bc-tab\s*\{[\s\S]*?min-height:42px;[\s\S]*?padding:0 10px;/);
});


test('Flavours matches Tools page structure intro nav then surface', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const flavoursStart = html.indexOf('id="tab-flavours"');
  const settingsStart = html.indexOf('id="tab-settings"');
  const flavours = html.slice(flavoursStart, settingsStart);

  const intro = flavours.indexOf('class="bc-page-intro"');
  const nav = flavours.indexOf('class="bc-tablist"');
  const surface = flavours.indexOf('class="bc-flavour-surface"');

  assert.ok(intro >= 0);
  assert.ok(nav > intro);
  assert.ok(surface > nav);
  assert.doesNotMatch(
    flavours.slice(surface, flavours.indexOf('id="flavourLibraryWorkflow"')),
    /class="bc-tablist"/
  );
});

test('Tools and Flavours use the same outer gap and zero nav surface margins', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /#tab-tools,\s*#tab-flavours\s*\{\s*gap:16px;/);
  assert.match(html, /#tab-tools > \.bc-tablist,\s*#tab-flavours > \.bc-tablist\s*\{\s*margin:0;/);
  assert.match(html, /#tab-tools > \.bc-tool-surface,\s*#tab-flavours > \.bc-flavour-surface\s*\{\s*margin:0;/);
});


test('Generate targets are grouped into core roles and states with group select all', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /label: 'Core roles'/);
  assert.match(html, /targetIds: \['neutral', 'primary', 'secondary', 'accent'\]/);
  assert.match(html, /label: 'States'/);
  assert.match(html, /targetIds: \['success', 'warning', 'error', 'info'\]/);
  assert.match(html, /data-group-toggle/);
  assert.match(html, /syncContextTargetGroupToggles/);
});

test('Generate target grouping stays compact and global select all only selects targets', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /\.context-target-picker\s*\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\$\('contextGenerateTargets'\)\.querySelectorAll\('input\[data-context-target\]'\)/);
  assert.match(html, /input\[data-context-target\]:checked/);
});


test('plugin UI uses one canonical disabled state opacity rule', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /--bc-interaction-disabled-opacity:\s*\.45/);
  assert.match(html, /:disabled,\s*\[aria-disabled="true"\]\s*\{[\s\S]*?opacity:var\(--bc-interaction-disabled-opacity\)/);
  assert.equal((html.match(/button:disabled\s*\{[^}]*opacity/g) || []).length, 0);
  assert.equal((html.match(/opacity:\s*\.42/g) || []).length, 0);
});


test('Generate exposes Default and Disabled as state choices without mixing state into colour targets', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  assert.match(html, /id="contextGenerateStates"/);
  assert.match(html, /data-context-state[^>]*value="default"[^>]*checked/);
  assert.match(html, /data-context-state[^>]*value="disabled"/);
  assert.match(html, /stateIds: selectedContextGenerateStates\(\)/);
  assert.match(html, /id="contextGenerateDisabledCopy"/);
});

test('Disabled generated state binds Semantic Interaction opacity instead of creating disabled colours', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('function stateSemanticCanonicalId');
  const end = code.indexOf('async function generateContextSet', start);
  const block = code.slice(start, end);

  assert.match(block, /--bc-interaction-disabled-opacity/);
  assert.match(block, /setBoundVariable\('opacity', variable\)/);
  assert.match(block, /buildStateTransformRuntime/);
  assert.doesNotMatch(block, /bc-color-disabled|Primary Disabled|Accent Disabled/);
  assert.doesNotMatch(block, /opacity\s*=\s*0\.45/);
});

test('Generate creates target by state combinations while preserving Context remap separately', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  const start = code.indexOf('async function generateContextSet');
  const end = code.indexOf('function resolvedFlavourExtension', start);
  const block = code.slice(start, end);

  assert.match(block, /for \(const targetId of targets\)/);
  assert.match(block, /for \(const stateId of stateIds\)/);
  assert.match(block, /remapContextNode\(clone, remapRuntime, report\)/);
  assert.match(block, /applyStateTransform/);
});

test('Create Disabled copy works independently of Context target generation', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');

  const start = code.indexOf('async function generateDisabledCopies');
  const end = code.indexOf('async function generateContextSet', start);
  const block = code.slice(start, end);

  assert.match(block, /figma\.currentPage\.selection/);
  assert.match(block, /original\.clone\(\)/);
  assert.match(block, /applyStateTransform\(clone, manifest, 'disabled'/);
  assert.doesNotMatch(block, /remapContextNode/);
  assert.match(html, /type: 'context-generate-disabled-copy'/);
  assert.match(code, /message\?\.type === 'context-generate-disabled-copy'/);
});


test('state generation distinguishes an outdated published Foundations registry from a missing source token', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');

  assert.match(code, /registered published Foundations library is out of date/);
  assert.match(code, /publish it in Figma/);
  assert.match(code, /register Master Foundations again/);
});
