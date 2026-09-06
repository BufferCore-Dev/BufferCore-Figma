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
    if (args[0] === 'pull') { if (afterCommit) currentCommit = afterCommit; return ''; }
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

test('sync uses fetch plus fast-forward-only pull', () => {
  const { run, calls } = fakeRunner({ afterCommit: 'def456' });
  const result = syncRepository('.', { run });
  assert.equal(result.changed, true);
  assert.equal(result.commit, 'def456');
  assert.ok(calls.some((call) => call.join(' ') === 'git fetch --prune origin'));
  assert.ok(calls.some((call) => call.join(' ') === 'git pull --ff-only origin main'));
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
  assert.deepEqual(manifest.networkAccess.allowedDomains, ['none']);
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, ['http://127.0.0.1:3847']);
});

test('plugin UI exposes repository pull, branch, commit and Flavour controls with manual fallback', () => {
  const html = fs.readFileSync(new URL('../plugin/src/ui.html', import.meta.url), 'utf8');
  for (const expected of ['Repository', 'Core branch', 'Core commit', 'Flavours branch', 'Pull + build', 'flavourSelect', 'Manual manifest fallback']) {
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
