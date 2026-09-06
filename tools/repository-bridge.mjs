#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { repositoryState } from '../packages/repository-sync/src/index.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const systemRoot = path.resolve(root, '..');
const corePath = path.resolve(systemRoot, 'BufferCore');
const flavoursPath = path.resolve(systemRoot, 'BufferCore-Flavours');
const manifestPath = path.resolve(root, 'generated', 'figma', 'buffercore.figma.json');
const port = Number(process.env.BUFFERCORE_FIGMA_BRIDGE_PORT || 3847);
let syncing = false;

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

function currentStatus() {
  const manifest = readJson(manifestPath);
  return {
    ok: true,
    syncing,
    core: safeRepoState(corePath),
    flavoursRepository: fs.existsSync(flavoursPath) ? safeRepoState(flavoursPath) : null,
    flavours: listFlavours(),
    manifest: manifest ? {
      schemaVersion: manifest.schemaVersion,
      generatedAt: manifest.generatedAt,
      flavour: manifest.flavour || null,
      repository: manifest.repository || manifest.source?.repository || null,
      variables: Array.isArray(manifest.variables) ? manifest.variables.length : 0,
      styles: Array.isArray(manifest.styles) ? manifest.styles.length : 0
    } : null
  };
}

async function sync(flavour) {
  if (syncing) throw new Error('A repository sync is already running.');
  syncing = true;
  try {
    const args = ['run', 'repo:sync'];
    if (flavour) args.push('--', '--flavour', flavour);
    const invocation = process.env.npm_execpath
      ? { command: process.execPath, args: [process.env.npm_execpath, ...args] }
      : process.platform === 'win32'
        ? { command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
        : { command: 'npm', args };
    const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    const manifest = readJson(manifestPath);
    if (!manifest) throw new Error('Repository sync completed but no Figma manifest was produced.');
    return { ok: true, manifest, stdout, stderr, status: currentStatus() };
  } finally {
    syncing = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method === 'GET' && req.url === '/status') return json(res, 200, currentStatus());
  if (req.method === 'GET' && req.url === '/manifest') {
    const manifest = readJson(manifestPath);
    if (!manifest) return json(res, 404, { ok: false, error: 'No generated Figma manifest exists yet.' });
    return json(res, 200, { ok: true, manifest });
  }
  if (req.method === 'POST' && req.url === '/sync') {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { ok: false, error: 'Invalid JSON request.' }); }
    try {
      return json(res, 200, await sync(body.flavour || null));
    } catch (error) {
      return json(res, 409, { ok: false, error: error?.message || String(error), status: currentStatus() });
    }
  }
  return json(res, 404, { ok: false, error: 'Not found.' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BufferCore Figma repository bridge: http://127.0.0.1:${port}`);
  console.log('Keep this running while using repository sync from the Figma development plugin.');
});
