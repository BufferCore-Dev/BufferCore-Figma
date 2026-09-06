#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncRepository, buildRepositoryMetadata } from '../packages/repository-sync/src/index.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const figmaRoot = path.resolve(scriptDir, '..');
const systemRoot = path.resolve(figmaRoot, '..');
const engineRoot = path.resolve(systemRoot, 'BufferCore-Engine');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const noPull = process.argv.includes('--no-pull');
const allowDirty = process.argv.includes('--allow-dirty');
const corePath = path.resolve(arg('--core', path.resolve(systemRoot, 'BufferCore')));
const flavoursPath = path.resolve(arg('--flavours', path.resolve(systemRoot, 'BufferCore-Flavours')));
const coreRemote = arg('--core-remote', 'origin');
const flavoursRemote = arg('--flavours-remote', 'origin');
const coreBranch = arg('--core-branch');
const flavoursBranch = arg('--flavours-branch');
const flavour = arg('--flavour');

function npmInvocation(args, env = process.env) {
  if (env.npm_execpath) {
    return { command: process.execPath, args: [env.npm_execpath, ...args] };
  }
  if (process.platform === 'win32') {
    return { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] };
  }
  return { command: 'npm', args };
}

function runNpm(cwd, args, env = process.env) {
  const invocation = npmInvocation(args, env);
  execFileSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: 'inherit'
  });
}

try {
  console.log('');
  console.log('BufferCore repository sync');
  console.log('────────────────────────────────');

  const core = syncRepository(corePath, {
    remote: coreRemote,
    branch: coreBranch,
    pull: !noPull,
    allowDirty
  });
  console.log(`Core                    : ${core.branch} @ ${core.commit.slice(0, 10)}${core.changed ? ' (updated)' : ''}`);

  let flavours = null;
  if (fs.existsSync(flavoursPath)) {
    flavours = syncRepository(flavoursPath, {
      remote: flavoursRemote,
      branch: flavoursBranch,
      pull: !noPull,
      allowDirty
    });
    console.log(`Flavours                : ${flavours.branch} @ ${flavours.commit.slice(0, 10)}${flavours.changed ? ' (updated)' : ''}`);
  } else if (flavour) {
    throw new Error(`Flavour repository not found: ${flavoursPath}`);
  }

  const metadata = buildRepositoryMetadata({ core, flavours, flavour });
  const metadataDir = path.join(figmaRoot, 'generated', 'sync');
  const metadataPath = path.join(metadataDir, 'repository.json');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  const engineArgs = ['run', 'core:build', '--', '--core', corePath];
  if (flavours) engineArgs.push('--flavours-root', flavoursPath);
  if (flavour) engineArgs.push('--flavour', flavour);

  console.log('');
  console.log('Building resolved BufferCore state…');
  runNpm(engineRoot, engineArgs, {
    ...process.env,
    BUFFERCORE_REPOSITORY_METADATA_PATH: metadataPath
  });

  console.log('Building Figma state…');
  runNpm(figmaRoot, ['run', 'figma:build', '--', '--engine', engineRoot]);

  const manifestPath = path.join(figmaRoot, 'generated', 'figma', 'buffercore.figma.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Figma manifest was not generated.');

  console.log('');
  console.log('Repository sync complete');
  console.log(`Manifest                : ${path.relative(figmaRoot, manifestPath).split(path.sep).join('/')}`);
  console.log(`Flavour                 : ${flavour || 'Core baseline'}`);
  console.log('');
} catch (error) {
  console.error('');
  console.error('BufferCore repository sync failed');
  console.error(error?.message || String(error));
  console.error('');
  process.exitCode = 1;
}
