// Writes lib/build-info.json (read by /api/log): the last 30 commits and data about this deploy.
// Run by a deploy workflow right before uploading; locally it describes the current checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repoName, GITHUB_RUN_ID: runId, GITHUB_ACTOR: actor } = process.env;

const repo = server && repoName ? `${server}/${repoName}` : git('remote', 'get-url', 'origin').replace(/\.git$/, '');
const commits = git('log', '-30', '--format=%H%x1f%an%x1f%at%x1f%s').split('\n').filter(Boolean).map((line) => {
  const [sha, author, at, subject] = line.split('\x1f');
  return { sha: sha.slice(0, 7), author, at: Number(at) * 1000, subject };
});
const info = {
  deploy: {
    sha: process.env.GITHUB_SHA || git('rev-parse', 'HEAD'),
    at: Date.now(),
    by: actor || 'local',
    repo,
    run: runId ? `${repo}/actions/runs/${runId}` : null,
  },
  commits,
};
fs.writeFileSync(path.join(root, 'lib', 'build-info.json'), `${JSON.stringify(info)}\n`);
console.log(`build-info: ${commits.length} commit, deploy ${info.deploy.sha.slice(0, 7)}`);
