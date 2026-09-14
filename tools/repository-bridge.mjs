#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { repositoryState } from '../packages/repository-sync/src/index.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const systemRoot = path.resolve(root, '..');
const corePath = path.resolve(systemRoot, 'BufferCore');
const flavoursPath = path.resolve(systemRoot, 'BufferCore-Flavours');
const manifestPath = path.resolve(root, 'generated', 'figma', 'buffercore.figma.json');
const masterAssetsPath = path.resolve(root, 'generated', 'figma', 'buffercore.master-figma-assets.json');
const libraryFamilyPath = path.resolve(root, 'generated', 'figma', 'buffercore.library-family.json');
const port = Number(process.env.BUFFERCORE_FIGMA_BRIDGE_PORT || 3847);
let syncing = false;
let sourceMode = process.env.BUFFERCORE_SOURCE_MODE || 'local';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(body);
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function safeRepoState(repoPath) {
  try {
    const state = repositoryState(repoPath);
    return {
      branch: state.branch,
      commit: state.commit,
      remoteUrl: state.remoteUrl,
      dirty: state.dirty,
      status: state.status
    };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

function listFlavours() {
  const base = path.join(flavoursPath, 'flavours');
  if (!fs.existsSync(base)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'flavour.json') {
        try {
          const data = readJson(full) || {};
          found.push({
            id: data.id || path.basename(path.dirname(full)),
            displayName: data.displayName || data.name || data.id || path.basename(path.dirname(full)),
            path: path.relative(base, path.dirname(full)).split(path.sep).join('/')
          });
        } catch {}
      }
    }
  };
  walk(base);
  return found.sort((a, b) => a.displayName.localeCompare(b.displayName));
}


const LIBRARY_FAMILY_LAYERS = ['foundations', 'elements', 'components', 'layout', 'templates', 'pages'];

function emptyLibraryFamily() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    masters: {},
    flavours: {}
  };
}

function readLibraryFamily() {
  const current = readJson(libraryFamilyPath);
  if (!current) return emptyLibraryFamily();
  return {
    schemaVersion: 1,
    updatedAt: current.updatedAt || null,
    masters: current.masters || {},
    flavours: current.flavours || {}
  };
}

function writeLibraryFamily(family) {
  fs.mkdirSync(path.dirname(libraryFamilyPath), { recursive: true });
  family.updatedAt = new Date().toISOString();
  fs.writeFileSync(libraryFamilyPath, JSON.stringify(family, null, 2) + '\n', 'utf8');
}

function registerLibraryLayer(payload) {
  const layer = payload?.layer;
  const role = payload?.role;
  if (!LIBRARY_FAMILY_LAYERS.includes(layer)) throw new Error(`Unknown library family layer: ${layer}`);
  if (!['master', 'flavour'].includes(role)) throw new Error(`Unknown library family role: ${role}`);
  if (role === 'flavour' && !payload?.flavourId) throw new Error('flavourId is required for a Flavour layer registration.');

  const family = readLibraryFamily();
  const clean = {
    schemaVersion: payload.schemaVersion || 1,
    role,
    layer,
    flavourId: role === 'flavour' ? payload.flavourId : null,
    fileName: payload.fileName || null,
    registeredAt: payload.registeredAt || new Date().toISOString(),
    dependencies: Array.isArray(payload.dependencies) ? payload.dependencies : [],
    bindings: payload.bindings || { variables: {}, styles: {} },
    assets: Array.isArray(payload.assets) ? payload.assets : []
  };

  if (role === 'master') {
    family.masters[layer] = clean;
  } else {
    family.flavours[payload.flavourId] ||= {};
    family.flavours[payload.flavourId][layer] = clean;
  }
  writeLibraryFamily(family);
  return clean;
}

function libraryFamilyStatus(flavourId = null) {
  const family = readLibraryFamily();
  const flavour = flavourId ? (family.flavours[flavourId] || {}) : {};
  const layers = {};
  for (const layer of LIBRARY_FAMILY_LAYERS) {
    layers[layer] = {
      master: family.masters[layer] || null,
      flavour: flavour[layer] || null
    };
  }
  return {
    ok: true,
    schemaVersion: family.schemaVersion,
    updatedAt: family.updatedAt,
    flavourId,
    layers
  };
}

function currentStatus() {
  const manifest = readJson(manifestPath);
  return {
    ok: true,
    syncing,
    sourceMode,
    core: safeRepoState(corePath),
    flavoursRepository: fs.existsSync(flavoursPath) ? safeRepoState(flavoursPath) : null,
    flavours: listFlavours(),
    libraryFamily: {
      updatedAt: readLibraryFamily().updatedAt,
      registeredMasterLayers: Object.keys(readLibraryFamily().masters || {}).length,
      registeredFlavours: Object.keys(readLibraryFamily().flavours || {}).length
    },
    manifest: manifest ? {
      schemaVersion: manifest.schemaVersion,
      generatedAt: manifest.generatedAt,
      flavour: manifest.flavour || null,
      repository: manifest.repository || manifest.source?.repository || null,
      variables: Array.isArray(manifest.variables) ? manifest.variables.length : 0,
      styles: Array.isArray(manifest.styles) ? manifest.styles.length : 0,
      library: manifest.library || null
    } : null
  };
}

async function runRepositorySync(flavour, mode) {
  const args = ['run', 'repo:sync', '--', '--source', mode];
  if (flavour) args.push('--flavour', flavour);

  const invocation = process.env.npm_execpath
    ? { command: process.execPath, args: [process.env.npm_execpath, ...args] }
    : process.platform === 'win32'
      ? { command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
      : { command: 'npm', args };

  return execFileAsync(invocation.command, invocation.args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function isGitHubUnavailable(error) {
  const text = [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  return text.includes('account is suspended')
    || text.includes('requested url returned error: 403')
    || text.includes('authentication failed')
    || text.includes('could not read username')
    || text.includes('permission denied');
}

async function sync(flavour, requestedSource = 'local') {
  if (syncing) throw new Error('A repository sync is already running.');
  syncing = true;

  const wantedSource = requestedSource === 'github' ? 'github' : 'local';

  try {
    let result;
    let fallback = null;

    try {
      result = await runRepositorySync(flavour, wantedSource);
      sourceMode = wantedSource;
    } catch (error) {
      if (wantedSource !== 'github' || !isGitHubUnavailable(error)) throw error;

      result = await runRepositorySync(flavour, 'local');
      sourceMode = 'local';
      fallback = {
        from: 'github',
        to: 'local',
        reason: 'GitHub unavailable; built from local workspace instead.'
      };
    }

    const manifest = readJson(manifestPath);
    if (!manifest) throw new Error('Repository sync completed but no Figma manifest was produced.');

    return {
      ok: true,
      manifest,
      stdout: result.stdout,
      stderr: result.stderr,
      fallback,
      status: currentStatus()
    };
  } finally {
    syncing = false;
  }
}

async function runGit(args, cwd = root) {
  const { stdout = '', stderr = '' } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function configuredGitHubAccount() {
  try {
    return execFileSync('git', ['config', '--get', 'credential.https://github.com.username'], {
      cwd: corePath,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch {
    return null;
  }
}

async function githubCredentialStatus() {
  let available = false;
  let version = null;
  let accounts = [];

  try {
    const result = await runGit(['credential-manager', '--version'], corePath);
    available = true;
    version = result.stdout || null;
  } catch {}

  if (available) {
    try {
      const result = await runGit(['credential-manager', 'github', 'list'], corePath);
      accounts = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^\*?\s*/, ''));
    } catch {}
  }

  const configuredAccount = configuredGitHubAccount();
  const authorised = Boolean(
    configuredAccount &&
    accounts.some((account) => account.toLowerCase() === configuredAccount.toLowerCase())
  );

  return { ok: true, available, version, accounts, configuredAccount, authorised };
}

function validateGitHubUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
    throw new Error('Enter a valid GitHub username.');
  }
  return username;
}

async function configureGitHubAccount(username) {
  const repos = [corePath, flavoursPath].filter((repoPath) => fs.existsSync(repoPath));
  for (const repoPath of repos) {
    await runGit(['config', 'credential.https://github.com.username', username], repoPath);
  }
}

async function authenticateGitHub(username, { force = false } = {}) {
  username = validateGitHubUsername(username);

  const args = ['credential-manager', 'github', 'login', '--username', username, '--browser'];
  if (force) args.push('--force');

  try {
    await runGit(args, corePath);
  } catch (error) {
    const details = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
    throw new Error(details || 'GitHub authentication failed.');
  }

  await configureGitHubAccount(username);
  return githubCredentialStatus();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && req.url === '/auth/github') {
    try {
      return json(res, 200, await githubCredentialStatus());
    } catch (error) {
      return json(res, 500, { ok: false, error: error?.message || String(error) });
    }
  }
  if (req.method === 'POST' && req.url === '/auth/github') {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { return json(res, 400, { ok: false, error: 'Invalid JSON request.' }); }

    try {
      return json(res, 200, await authenticateGitHub(body.username, { force: Boolean(body.force) }));
    } catch (error) {
      return json(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  if (req.method === 'GET' && req.url === '/status') return json(res, 200, currentStatus());
  if (req.method === 'GET' && req.url === '/manifest') {
    const manifest = readJson(manifestPath);
    if (!manifest) return json(res, 404, { ok: false, error: 'No generated Figma manifest exists yet.' });
    return json(res, 200, { ok: true, manifest });
  }
  if (req.method === 'GET' && req.url?.startsWith('/library-family/status')) {
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    return json(res, 200, libraryFamilyStatus(requestUrl.searchParams.get('flavour') || null));
  }
  if (req.method === 'POST' && req.url === '/library-family/register') {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let payload = null;
    try { payload = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'Invalid library family registration JSON.' }); }
    try {
      const registered = registerLibraryLayer(payload);
      return json(res, 200, { ok: true, registered, status: libraryFamilyStatus(payload.flavourId || null) });
    } catch (error) {
      return json(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }
  if (req.method === 'GET' && req.url === '/master-assets') {
    const registry = readJson(masterAssetsPath);
    if (!registry) return json(res, 404, { ok: false, error: 'No master Figma asset registry has been registered yet.' });
    return json(res, 200, { ok: true, registry });
  }
  if (req.method === 'POST' && req.url === '/master-assets') {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let registry = null;
    try { registry = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'Invalid master Figma asset registry JSON.' }); }
    if (!Array.isArray(registry.assets)) return json(res, 400, { ok: false, error: 'Master Figma asset registry must contain an assets array.' });
    fs.mkdirSync(path.dirname(masterAssetsPath), { recursive: true });
    fs.writeFileSync(masterAssetsPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    return json(res, 200, { ok: true, count: registry.assets.length, registeredAt: registry.registeredAt || null });
  }
  if (req.method === 'POST' && req.url === '/sync') {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { ok: false, error: 'Invalid JSON request.' }); }
    try {
      return json(res, 200, await sync(body.flavour || null, body.source || 'local'));
    } catch (error) {
      return json(res, 409, { ok: false, error: error?.message || String(error), status: currentStatus() });
    }
  }
  return json(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(port, () => {
  console.log(`BufferCore Figma repository bridge: http://localhost:${port}`);
  console.log('Keep this running while using repository sync from the Figma development plugin.');
});
