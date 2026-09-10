import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { repositoryState, syncRepository, buildRepositoryMetadata } from '../packages/repository-sync/src/index.mjs';

function fakeRunner({ branch = 'main', commit = 'abc123', status = '', remoteUrl = 'git@github.com:BufferCoreSystem/BufferCore.git', afterCommit = null } = {}) {
  const calls = [];
  let currentBranch = branch;
  let currentCommit = commit;
  const run = (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(' ');
    if (joined === 'rev-parse --is-inside-work-tree') return 'true';
    if (joined === 'branch --show-current') return currentBranch;
    if (joined === 'rev-parse HEAD') return currentCommit;
    if (joined === 'status --porcelain=v1') return status;
    if (joined.startsWith('remote get-url')) return remoteUrl;
    if (args[0] === 'switch' && args[1] && args[1] !== '--track') { currentBranch = args[1]; return ''; }
    if (args[0] === 'switch' && args[1] === '--track') { currentBranch = args[3]; return ''; }
    if (args[0] === 'merge') { if (afterCommit) currentCommit = afterCommit; return ''; }
    if (args[0] === 'fetch') return '';
    throw new Error(`Unexpected command: ${command} ${joined}`);
  };
  return { run, calls };
}

test('repository state captures branch, commit, remote and cleanliness', () => {
  const { run } = fakeRunner();
  const state = repositoryState('.', { run });
  assert.equal(state.branch, 'main');
  assert.equal(state.commit, 'abc123');
  assert.equal(state.remoteUrl, 'git@github.com:BufferCoreSystem/BufferCore.git');
  assert.equal(state.dirty, false);
});

test('sync refuses to pull a dirty repository by default', () => {
  const { run } = fakeRunner({ status: ' M levels/foundations/test.scss' });
  assert.throws(() => syncRepository('.', { run }), /uncommitted changes/);
});

test('sync performs one authenticated fetch then a local fast-forward-only merge', () => {
  const { run, calls } = fakeRunner({ afterCommit: 'def456' });
  const result = syncRepository('.', { run });
  assert.equal(result.changed, true);
  assert.equal(result.commit, 'def456');
  const fetches = calls.filter((call) => call[0] === 'git' && call[1] === 'fetch');
  assert.equal(fetches.length, 1);
  assert.deepEqual(fetches[0], ['git', 'fetch', '--prune', 'origin']);
  assert.ok(calls.some((call) => call.join(' ') === 'git merge --ff-only origin/main'));
  assert.equal(calls.some((call) => call[1] === 'pull'), false);
});

test('sync can select a configured branch before pulling', () => {
  const { run, calls } = fakeRunner({ branch: 'develop' });
  const result = syncRepository('.', { run, branch: 'main' });
  assert.equal(result.branch, 'main');
  assert.ok(calls.some((call) => call.join(' ') === 'git switch main'));
});

test('repository metadata records both source repos and selected Flavour', () => {
  const metadata = buildRepositoryMetadata({
    core: { remote: 'origin', remoteUrl: 'core.git', branch: 'main', commit: 'aaa' },
    flavours: { remote: 'origin', remoteUrl: 'flavours.git', branch: 'main', commit: 'bbb' },
    flavour: 'lument'
  });
  assert.equal(metadata.source, 'git');
  assert.equal(metadata.core.commit, 'aaa');
  assert.equal(metadata.flavours.commit, 'bbb');
  assert.equal(metadata.flavour, 'lument');
});

test('development plugin manifest allows only the local repository bridge', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.networkAccess.allowedDomains, ['http://localhost:3847']);
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, ['http://localhost:3847']);
});

test('plugin UI separates Baseline and Flavour library workflows with manual fallback', () => {
  const html = fs.readFileSync(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  for (const expected of ['Repository', 'Baseline library', 'Flavour library', 'Pull + build Core', 'Pull + resolve', 'flavourSelect', 'Manual manifest fallback']) {
    assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('repository bridge exposes status, manifest and sync endpoints', () => {
  const source = fs.readFileSync(new URL('../tools/repository-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /req\.url === '\/status'/);
  assert.match(source, /req\.url === '\/manifest'/);
  assert.match(source, /req\.url === '\/sync'/);
  assert.match(source, /repo:sync/);
});

test('development bridge uses Figma-supported localhost URL and is not pinned to IPv4-only loopback', () => {
  const html = fs.readFileSync(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../tools/repository-bridge.mjs', import.meta.url), 'utf8');
  assert.match(html, /const BRIDGE_URL = 'http:\/\/localhost:3847'/);
  assert.match(bridge, /server\.listen\(port, \(\) =>/);
  assert.doesNotMatch(bridge, /server\.listen\(port, '127\.0\.0\.1'/);
  assert.match(bridge, /http:\/\/localhost:\$\{port\}/);
});

test('repository networking runs in the Figma plugin main context rather than the UI iframe', () => {
  const code = fs.readFileSync(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(code, /const REPOSITORY_BRIDGE_URL = 'http:\/\/localhost:3847'/);
  assert.match(code, /message\?\.type === 'bridge-request'/);
  assert.match(code, /await repositoryBridgeRequest\(message\.path, message\.options \|\| \{\}\)/);
  assert.match(code, /type: 'bridge-response'/);
  assert.doesNotMatch(html, /await fetch\(BRIDGE_URL/);
  assert.match(html, /pluginMessage: \{ type: 'bridge-request'/);
  assert.match(html, /message\.type === 'bridge-response'/);
});

test('repository bridge failures are visible in the plugin UI instead of silently collapsing to offline', () => {
  const html = fs.readFileSync(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  assert.match(html, /Could not reach <strong>\$\{BRIDGE_URL\}<\/strong>/);
  assert.match(html, /Repository bridge did not respond at \$\{BRIDGE_URL\}/);
});

test('Core baseline sync does not contact the Flavours repository', () => {
  const source = fs.readFileSync(new URL('../tools/sync-repository.mjs', import.meta.url), 'utf8');
  const guard = source.indexOf('if (flavour) {');
  const sync = source.indexOf('flavours = syncRepository');
  assert.ok(guard >= 0 && sync > guard);
  assert.match(source, /not required for Core baseline/);
});

test('plugin locks a Figma file to one library target instead of layering Baseline and Flavour objects together', () => {
  const source = fs.readFileSync(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /buffercore\.libraryTarget|BUFFERCORE_KEYS\.libraryTarget/);
  assert.match(source, /current && current !== requested/);
  assert.match(source, /Open the matching library file instead of applying/);
});

test('plugin keeps a canonical binding translation registry for future Element and Component rebinding', () => {
  const source = fs.readFileSync(new URL('../plugin/src/code.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildBindingTranslationRegistry/);
  assert.match(source, /bindingTranslationRegistry/);
});
