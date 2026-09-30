const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareReports,
  formatComparison,
  harnessDifferences,
  parseReport,
} = require('./sync-fuzz-compare');

test('parses the report between its markers in Karma output', () => {
  const output =
    'FAILED\n  Failed: SYNC_FUZZ_REPORT_START{"time-loss:task":["all:1","tasks:2"]}' +
    'SYNC_FUZZ_REPORT_END\n    at <Jasmine>';
  assert.deepEqual(parseReport(output), { 'time-loss:task': ['all:1', 'tasks:2'] });
});

test('reads a missing report as undefined', () => {
  assert.equal(parseReport('Executed 0 of 0 DISCONNECTED'), undefined);
});

test('lists seeds that newly show a signature, and fixed ones', () => {
  const base = { a: ['all:1', 'all:2'], b: ['tasks:3'] };
  const head = { a: ['all:2', 'all:4'], c: ['noReorder:5'] };
  assert.deepEqual(compareReports(base, head), {
    newFailures: [
      { signature: 'a', seeds: ['all:4'] },
      { signature: 'c', seeds: ['noReorder:5'] },
    ],
    fixed: [
      { signature: 'a', seeds: ['all:1'] },
      { signature: 'b', seeds: ['tasks:3'] },
    ],
  });
});

test('a count that stays equal but moves seeds is still a new failure', () => {
  const { newFailures } = compareReports({ a: ['all:1'] }, { a: ['all:2'] });
  assert.deepEqual(newFailures, [{ signature: 'a', seeds: ['all:2'] }]);
});

test('formats both sections', () => {
  const text = formatComparison(
    { newFailures: [{ signature: 'a', seeds: ['all:4'] }], fixed: [] },
    'working tree vs origin/master',
  );
  assert.equal(
    text,
    [
      'Sync fuzz signatures: working tree vs origin/master',
      'Newly failing (1)',
      '  a: all:4',
      'No longer failing (0)',
    ].join('\n'),
  );
});

test('names harness files that change what the base run detects', () => {
  const dir = 'src/app/op-log/testing/integration/sync-fuzz';
  assert.deepEqual(
    harnessDifferences([
      `${dir}/sync-fuzz-runner.ts`,
      `${dir}/sync-fuzz-profiles.ts`,
      `${dir}/sync-fuzz-signature-report.benchmark.ts`,
      `${dir}/sync-fuzz-pinned.integration.spec.ts`,
      `${dir}/sync-fuzz-seeds.benchmark.ts`,
      `${dir}/sync-fuzz-pinned-traces.json`,
      `${dir}/fake-super-sync-server.ts`,
    ]),
    [`${dir}/sync-fuzz-runner.ts`, `${dir}/fake-super-sync-server.ts`],
  );
});
