import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Importing the worker pulls in the db module (opens SQLite at load); point it at
// a throwaway file first, then dynamic-import to guarantee ordering.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ac-wk-')), 'test.sqlite');
const { envChangedFromDiff, significantDiffLines } = await import('../src/worker.js');

test('envChangedFromDiff ignores run scratch + caches, flags real tooling changes', () => {
  // Routine per-run churn under /work and per-user caches must NOT count.
  const noise = ['C /work', 'C /work/repos/o/r', 'A /work/run.log', 'C /root/.cache', 'C /tmp/x'].join(
    '\n',
  );
  assert.equal(envChangedFromDiff(noise), false);
  assert.equal(envChangedFromDiff(''), false);

  // Installing tooling / self-update touches significant paths.
  assert.equal(envChangedFromDiff('C /usr/local/lib/node_modules/foo'), true);
  assert.equal(envChangedFromDiff('A /var/lib/dpkg/info/pkg.list'), true);
  assert.equal(envChangedFromDiff('A /root/.local/bin/tool'), true);
});

test('significantDiffLines returns a stable (sorted) subset for signatures', () => {
  const diff = ['C /work', 'A /usr/bin/b', 'A /usr/bin/a', 'C /root/.cache'].join('\n');
  assert.deepEqual(significantDiffLines(diff), ['A /usr/bin/a', 'A /usr/bin/b']);
});
