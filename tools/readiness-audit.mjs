#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDesiredModel,
  buildDiffSummary,
  desiredCollectionSignature,
  desiredVariableSignature,
  desiredStyleSignature,
  stableStringify
} from '../packages/figma-plugin-core/src/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'generated', 'figma', 'buffercore.figma.json');

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function flattenVariables(desired) {
  return desired.collections.flatMap((collection) => collection.variables.map((variable) => ({ ...variable, collectionId: collection.id })));
}
function snapshotFromDesired(desired) {
  const collections = desired.collections.map((collection) => ({
    canonicalId: collection.id,
    name: collection.figmaName || collection.name,
    publish: collection.publish !== false,
    modeNames: (collection.modes || []).map((mode) => mode.name),
    liveSignature: desiredCollectionSignature(collection),
    appliedSignature: desiredCollectionSignature(collection),
    appliedLiveSignature: desiredCollectionSignature(collection)
  }));
  const variables = flattenVariables(desired).map((variable) => {
    const signature = desiredVariableSignature(variable);
    return {
      canonicalId: variable.id,
      name: variable.figmaName || variable.name,
      collectionCanonicalId: variable.collectionId,
      type: variable.type,
      scopes: variable.scopes || [],
      liveSignature: signature,
      appliedSignature: signature,
      appliedLiveSignature: signature
    };
  });
  const styles = desired.styles.map((style) => {
    const signature = desiredStyleSignature(style);
    return {
      canonicalId: style.id,
      name: style.name,
      type: style.type,
      liveSignature: signature,
      appliedSignature: signature,
      appliedLiveSignature: signature
    };
  });
  return { collections, variables, styles };
}
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

if (!fs.existsSync(manifestPath)) fail(`Figma manifest not found: ${manifestPath}`);
const manifest = readJson(manifestPath);
const variables = manifest.variables || [];
const collections = manifest.collections || [];
const styles = manifest.styles || [];
const diagnostics = manifest.diagnostics || { errors: [], warnings: [] };

assert(!(diagnostics.errors || []).length, `Figma manifest has ${diagnostics.errors.length} error(s).`);
assert(!(diagnostics.warnings || []).length, `Figma manifest has ${diagnostics.warnings.length} warning(s).`);

const colourVariables = variables.filter((variable) => variable.foundation === 'colour');
assert(colourVariables.length > 0, 'No Colour variables were generated.');
assert(colourVariables.every((variable) => variable.type === 'COLOR'), 'Every generated Colour variable must use Figma COLOR type.');

const families = ['primary','secondary','accent','success','warning','error','info'];
for (const family of families) {
  assert(variables.some((variable) => variable.cssVariable === `--bc-color-text-${family}-strong-inverse`), `Missing Text ${family} Strong Inverse.`);
  assert(!variables.some((variable) => variable.cssVariable === `--bc-color-text-${family}-inverse-strong`), `Legacy Text ${family} Inverse Strong is still present.`);
  assert(!variables.some((variable) => variable.cssVariable === `--bc-color-text-${family}-inverse`), `Redundant Text ${family} Base Inverse is still present.`);
}

const missingWeb = variables.filter((variable) => variable.publish !== false && !variable.codeSyntax?.WEB);
assert(!missingWeb.length, `${missingWeb.length} published variable(s) are missing WEB code syntax.`);

const ids = new Set(variables.map((variable) => variable.id));
const byId = new Map(variables.map((variable) => [variable.id, variable]));
const unresolved = [];
const semanticAliasProblems = [];
for (const variable of variables) {
  for (const entry of variable.values || []) {
    const value = entry.value || {};
    if (value.kind !== 'alias') continue;
    if (!ids.has(value.tokenId)) unresolved.push(`${variable.id} -> ${value.tokenId}`);
    if (variable.layer === 'semantic' && byId.get(value.tokenId)?.layer !== 'primitive') {
      semanticAliasProblems.push(`${variable.id} -> ${value.tokenId}`);
    }
  }
}
assert(!unresolved.length, `Unresolved aliases: ${unresolved.slice(0, 5).join(', ')}`);
assert(!semanticAliasProblems.length, `Semantic aliases must resolve directly to Primitive variables: ${semanticAliasProblems.slice(0, 5).join(', ')}`);

const dimensions = new Map((manifest.modeDimensions || []).map((dimension) => [dimension.name, (dimension.values || []).map((value) => value.name)]));
assert(stableStringify(dimensions.get('Theme')) === stableStringify(['Light','Dark']), 'Theme modes must be Light / Dark.');
assert(stableStringify(dimensions.get('Viewport')) === stableStringify(['Small','Medium','Large']), 'Viewport modes must be Small / Medium / Large.');

const semanticColour = variables.filter((variable) => variable.collectionId === 'semantic.colour');
const roots = [];
for (const variable of semanticColour) {
  const rootName = String(variable.name || '').split(' / ')[0];
  if (rootName && !roots.includes(rootName)) roots.push(rootName);
}
const requiredRootOrder = ['Fill','Text','Border','Surface','Canvas','Interaction','Tones'];
let previous = -1;
for (const rootName of requiredRootOrder) {
  const index = roots.indexOf(rootName);
  assert(index >= 0, `Semantic Colour is missing ${rootName}.`);
  assert(index > previous, `Semantic Colour presentation order is wrong around ${rootName}.`);
  previous = index;
}

const textStyles = styles.filter((style) => style.type === 'TEXT');
const effectStyles = styles.filter((style) => style.type === 'EFFECT');
assert(textStyles.length > 0, 'No Text Styles were generated.');
assert(effectStyles.length > 0, 'No Effect Styles were generated.');


const declaredContext = manifest.foundationContracts?.context || {};
const contextProjections = manifest.contextProjections || {};

for (const [domainId, contract] of Object.entries(declaredContext)) {
  const projection = contextProjections[domainId];
  assert(projection, `Missing Figma Context projection for ${domainId}.`);
  assert(projection.representation === contract.figma?.representation, `${domainId} Figma representation does not match its Foundation contract.`);

  if (projection.representation === 'variables') {
    assert(Object.values(projection.slots || {}).every((item) => item.available), `${domainId} has unavailable Context variables.`);
    assert(Object.values(projection.targets || {}).flatMap((target) => Object.values(target.mappings || {})).every((item) => item.available), `${domainId} has unavailable target variable mappings.`);
  }

  if (projection.representation === 'text-styles') {
    assert(Object.values(projection.targets || {}).every((item) => item.available), `${domainId} has unavailable Text Style targets.`);
  }

  if (projection.representation === 'effect-styles') {
    assert(Object.values(projection.targets || {}).flatMap((target) => Object.values(target.styles || {})).every((item) => item.available), `${domainId} has unavailable Effect Style targets.`);
  }
}

const disabledState = manifest.interactionStates?.disabled;
assert(disabledState?.available, 'Disabled state is not available in generated Figma Foundations.');
assert(disabledState.representation === 'variable', 'Disabled state must project as a Figma variable.');
assert((disabledState.scopes || []).includes('OPACITY'), 'Disabled state variable must use Figma OPACITY scope.');

const desired = buildDesiredModel(manifest);
const emptyDiff = buildDiffSummary(desired, { collections: [], variables: [], styles: [] });
assert(emptyDiff.totals.create === collections.length + variables.length + styles.length, 'Clean-file import count does not match generated model.');
assert(emptyDiff.totals.update === 0 && emptyDiff.totals.conflict === 0, 'Clean-file diff contains unexpected updates/conflicts.');

const syncedSnapshot = snapshotFromDesired(desired);
const secondDiff = buildDiffSummary(desired, syncedSnapshot);
assert(secondDiff.totals.create === 0, 'Second identical sync would create objects.');
assert(secondDiff.totals.update === 0, 'Second identical sync would update objects.');
assert(secondDiff.totals.drift === 0, 'Second identical sync reports drift.');
assert(secondDiff.totals.conflict === 0, 'Second identical sync reports conflicts.');
assert(secondDiff.totals.orphaned === 0, 'Second identical sync reports orphaned objects.');
assert(secondDiff.totals.unchanged === collections.length + variables.length + styles.length, 'Second identical sync is not fully unchanged.');

const changedDesired = deepClone(desired);
const targetCollection = changedDesired.collections.find((collection) => collection.variables.some((variable) => variable.layer === 'semantic' && variable.foundation === 'colour'));
const targetVariable = targetCollection?.variables.find((variable) => variable.layer === 'semantic' && variable.foundation === 'colour' && variable.modeValues?.length);
assert(targetVariable, 'Could not find a Semantic Colour variable for one-token update simulation.');
const firstModeValue = targetVariable.modeValues[0];
if (firstModeValue.value?.kind === 'alias') firstModeValue.value.tokenId = firstModeValue.value.tokenId === 'color.neutral.50' ? 'color.neutral.60' : 'color.neutral.50';
else firstModeValue.value = { kind: 'literal', value: '__readiness_changed__' };
const changedDiff = buildDiffSummary(changedDesired, syncedSnapshot);
assert(changedDiff.variables.update.length === 1, `Expected exactly one variable update after one-token change, got ${changedDiff.variables.update.length}.`);
assert(changedDiff.totals.create === 0 && changedDiff.totals.conflict === 0 && changedDiff.totals.orphaned === 0, 'One-token update simulation produced unsafe diff state.');

console.log('BufferCore Figma readiness');
console.log('────────────────────────────────');
console.log(`Generated               : ${manifest.generatedAt || 'unknown'}`);
console.log(`Collections             : ${collections.length}`);
console.log(`Variables               : ${variables.length}`);
console.log(`Colour variables        : ${colourVariables.length} (all COLOR)`);
console.log(`Text styles             : ${textStyles.length}`);
console.log(`Effect styles           : ${effectStyles.length}`);
console.log(`Context projections     : Colour variables / Typography Text Styles / Shadow Effect Styles`);
console.log(`Interaction states      : Disabled → OPACITY variable`);
console.log(`Theme modes             : ${dimensions.get('Theme').join(' / ')}`);
console.log(`Viewport modes          : ${dimensions.get('Viewport').join(' / ')}`);
console.log(`Semantic Colour order   : ${requiredRootOrder.join(' -> ')}`);
console.log(`Clean import            : ${emptyDiff.totals.create} managed objects`);
console.log(`Identical second sync   : ${secondDiff.totals.unchanged} unchanged, 0 churn`);
console.log(`One-token update        : 1 variable update, 0 unsafe changes`);
console.log(`Diagnostics             : 0 errors, 0 warnings`);
console.log('');
console.log('READY: generated Figma artifact and sync model pass automated readiness checks.');
