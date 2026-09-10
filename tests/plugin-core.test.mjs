import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cartesianModeCombinations,
  desiredValueForMode,
  buildDesiredModel,
  buildDiffSummary,
  summariseDiffByKind,
  libraryTargetForManifest,
  libraryKindForManifest,
  buildBindingTranslationRegistry,
  translateCanonicalBinding
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

test('library target identity keeps Baseline and each Flavour as separate Figma libraries', () => {
  assert.equal(libraryTargetForManifest({ platform: 'figma', flavour: null }), 'baseline');
  assert.equal(libraryKindForManifest({ platform: 'figma', flavour: null }), 'baseline');
  assert.equal(libraryTargetForManifest({ platform: 'figma', flavour: { id: 'wallwood' } }), 'flavour:wallwood');
  assert.equal(libraryKindForManifest({ platform: 'figma', flavour: { id: 'wallwood' } }), 'flavour');
});

test('canonical binding translation maps Core identities to this library own stable Figma IDs', () => {
  const registry = buildBindingTranslationRegistry({
    collections: { 'semantic.colour': 'VariableCollection:1' },
    variables: { 'colour.fill.primary': 'Variable:10' },
    styles: { 'type.heading.1': 'TextStyle:2' }
  });
  assert.deepEqual(translateCanonicalBinding('colour.fill.primary', registry), {
    kind: 'variable',
    canonicalId: 'colour.fill.primary',
    figmaId: 'Variable:10'
  });
  assert.deepEqual(translateCanonicalBinding({ styleId: 'type.heading.1' }, registry), {
    kind: 'style',
    canonicalId: 'type.heading.1',
    figmaId: 'TextStyle:2'
  });
  assert.equal(translateCanonicalBinding('missing', registry), null);
});

test('master Figma asset projection is captured from Baseline and persisted through the local bridge', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const bridge = await fs.readFile(new URL('../tools/repository-bridge.mjs', import.meta.url), 'utf8');
  assert.match(code, /registerMasterFigmaAssets/);
  assert.match(code, /sourceLibraryTarget: 'baseline'/);
  assert.match(code, /\/master-assets/);
  assert.match(bridge, /req\.url === '\/master-assets'/);
  assert.match(bridge, /buffercore\.master-figma-assets\.json/);
});

test('Flavour component projection imports master components then rebinds detached structure to the Flavour registry', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /importComponentByKeyAsync/);
  assert.match(code, /detachInstance/);
  assert.match(code, /remapNodeBindings/);
  assert.match(code, /setBoundVariableForPaint/);
  assert.match(code, /setBoundVariableForEffect/);
  assert.match(code, /targetRegistry/);
});

test('projected Components update existing local component identities instead of delete and recreate', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /existingByCanonical/);
  assert.match(code, /replaceComponentContents/);
  assert.match(code, /masterComponentId/);
  assert.match(code, /masterComponentRevision/);
});

test('projected component sets preserve existing variants where canonical IDs still exist and remove only retired projected variants', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /projectComponentSet/);
  assert.match(code, /existingVariants/);
  assert.match(code, /figma\.combineAsVariants/);
  assert.match(code, /wanted\.has\(id\)/);
});

test('plugin UI exposes explicit library-family registration and Flavour layer sync actions', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /Register this Figma file/);
  assert.match(html, /Sync this Flavour layer/);
  assert.match(html, /published BufferCore Figma master library owns design assets/);
});


test('published Figma master library remains authoritative and registry stores only identities/binding metadata', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /source: 'published-figma-master-library'/);
  assert.match(code, /metadata only/);
  assert.match(code, /importComponentByKeyAsync/);
  assert.match(code, /registryMeta\.assets/);
  assert.doesNotMatch(code, /source: 'git'.*assets/s);
});

test('master asset UI names Elements Components Patterns Templates and Layouts as Figma-authored publishable assets', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  for (const label of ['Elements', 'Components', 'Patterns', 'Templates', 'Layouts']) assert.match(html, new RegExp(label));
  assert.match(html, /publishable Components\/Component Sets/);
});


test('Figma library family uses the six BufferCore design files with dependency-aware projection', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  for (const layer of ['foundations', 'elements', 'components', 'layout', 'templates', 'pages']) {
    assert.match(code, new RegExp(`id: '${layer}'`));
  }
  assert.match(code, /components'.*dependencies: \['foundations', 'elements'\]/s);
  assert.match(code, /layout'.*dependencies: \['foundations', 'elements', 'components'\]/s);
  assert.match(code, /templates'.*dependencies: \['foundations', 'elements', 'components', 'layout'\]/s);
  assert.match(code, /pages'.*dependencies: \['foundations', 'elements', 'components', 'layout', 'templates'\]/s);
});

test('non-Foundation Flavour sync reads current published BC assets and translates nested master instances to upstream Flavour assets', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /syncSystemLayer/);
  assert.match(code, /assertLayerDependencies/);
  assert.match(code, /remapNestedMasterInstances/);
  assert.match(code, /swapComponent/);
  assert.match(code, /flavourAssetKeyByCanonical/);
  assert.match(code, /assertNoResidualMasterDependencies/);
});

test('Flavour family imports published Flavour Foundation variables and styles by library key rather than requiring local duplicate Foundations', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /importVariableByKeyAsync/);
  assert.match(code, /importStyleByKeyAsync/);
  assert.match(code, /family\.layers\?\.foundations\?\.flavour/);
});

test('Figma-authored asset identity remains stable across projections and resyncs', async () => {
  const fs = await import('node:fs/promises');
  const code = await fs.readFile(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(code, /masterComponentId/);
  assert.match(code, /existingByCanonical/);
  assert.match(code, /replaceComponentContents/);
  assert.match(code, /masterComponentRevision/);
});

test('family UI exposes all six master and Flavour layers instead of one monolithic master library', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  for (const label of ['BC: Foundations','BC: Elements','BC: Components','BC: Layout','BC: Templates','BC: Pages']) {
    assert.ok(html.includes(label), `Missing ${label}`);
  }
  assert.match(html, /Register this Figma file/);
  assert.match(html, /Sync this Flavour layer/);
  assert.match(html, /BufferCore system layers/);
});
