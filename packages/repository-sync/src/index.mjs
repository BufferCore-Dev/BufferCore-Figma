import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function defaultRunner(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  }).trim();
}

function git(run, repoPath, args, options = {}) {
  return run('git', args, { cwd: repoPath, ...options });
}

export function isGitRepository(repoPath, run = defaultRunner) {
  if (!fs.existsSync(repoPath)) return false;
  try {
    return git(run, repoPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

export function repositoryState(repoPath, { remote = 'origin', run = defaultRunner } = {}) {
  if (!isGitRepository(repoPath, run)) throw new Error(`Not a Git repository: ${repoPath}`);
  const branch = git(run, repoPath, ['branch', '--show-current']);
  const commit = git(run, repoPath, ['rev-parse', 'HEAD']);
  const status = git(run, repoPath, ['status', '--porcelain=v1']);
  let remoteUrl = null;
  try { remoteUrl = git(run, repoPath, ['remote', 'get-url', remote]); } catch {}
  return {
    path: path.resolve(repoPath),
    branch,
    commit,
    remote,
    remoteUrl,
    dirty: Boolean(status.trim()),
    status: status ? status.split(/\r?\n/).filter(Boolean) : []
  };
}

export function syncRepository(repoPath, {
  remote = 'origin',
  branch = null,
  pull = true,
  allowDirty = false,
  run = defaultRunner
} = {}) {
  const before = repositoryState(repoPath, { remote, run });
  if (before.dirty && !allowDirty) {
    throw new Error(`Repository has uncommitted changes and will not be pulled: ${repoPath}`);
  }

  const wantedBranch = branch || before.branch;
  if (!wantedBranch) throw new Error(`Repository is in detached HEAD state: ${repoPath}`);

  if (pull) {
    git(run, repoPath, ['fetch', '--prune', remote]);
    if (before.branch !== wantedBranch) {
      try {
        git(run, repoPath, ['switch', wantedBranch]);
      } catch {
        git(run, repoPath, ['switch', '--track', '-c', wantedBranch, `${remote}/${wantedBranch}`]);
      }
    }
    git(run, repoPath, ['merge', '--ff-only', `${remote}/${wantedBranch}`]);
  } else if (before.branch !== wantedBranch) {
    throw new Error(`Repository is on ${before.branch || 'detached HEAD'}, expected ${wantedBranch}. Pull is disabled.`);
  }

  const after = repositoryState(repoPath, { remote, run });
  return {
    ...after,
    previousCommit: before.commit,
    changed: before.commit !== after.commit,
    pulled: Boolean(pull)
  };
}

export function buildRepositoryMetadata({ core, flavours = null, flavour = null }) {
  return {
    source: 'git',
    core: {
      remote: core.remote,
      remoteUrl: core.remoteUrl,
      branch: core.branch,
      commit: core.commit
    },
    flavours: flavours ? {
      remote: flavours.remote,
      remoteUrl: flavours.remoteUrl,
      branch: flavours.branch,
      commit: flavours.commit
    } : null,
    flavour: flavour || null
  };
}

export function buildLocalWorkspaceMetadata({ core, flavours = null, flavour = null }) {
  return {
    source: 'local-workspace',
    core: { path: core.path, branch: core.branch, commit: core.commit },
    flavours: flavours ? { path: flavours.path, branch: flavours.branch, commit: flavours.commit } : null,
    flavour: flavour || null
  };
}
