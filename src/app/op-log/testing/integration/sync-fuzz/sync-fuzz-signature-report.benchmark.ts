import { SyncFuzzHarness } from './sync-fuzz-harness';
import { FUZZ_PROFILES } from './sync-fuzz-profiles';
import { runFuzz } from './sync-fuzz-runner';
import { keepKarmaAlive } from './sync-fuzz-shrink';

/**
 * Every failure signature of a fixed seed sweep, with the seeds that show it,
 * pinned or not. `tools/sync-fuzz-compare.js` runs it on a branch and on its
 * base and fails on a seed that newly shows a signature; the random sweep in
 * sync-fuzz-seeds.benchmark.ts cannot see that, since a pin explains every
 * seed with its primary signature. Runs only when named, like the other
 * `*.benchmark.ts` files.
 *
 * The seeds are the ones #10382 measured with, so reports stay comparable.
 * The report leaves Karma as the failure message (console output is not
 * captured), between the markers the tool parses.
 */
const FIRST_SEED = 20725000;
const SEED_COUNT = 30;
const STEPS = 30;

const REPORT_START = 'SYNC_FUZZ_REPORT_START';
const REPORT_END = 'SYNC_FUZZ_REPORT_END';

describe('sync fuzz signature report', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  it('reports every signature with its seeds', async () => {
    const seedsBySignature: Record<string, string[]> = {};
    for (const [profile, weights] of Object.entries(FUZZ_PROFILES)) {
      for (let seed = FIRST_SEED; seed < FIRST_SEED + SEED_COUNT; seed++) {
        keepKarmaAlive(seed);
        const { failures } = await runFuzz({ seed, stepCount: STEPS, weights });
        for (const signature of new Set(failures.map((f) => f.signature))) {
          (seedsBySignature[signature] ??= []).push(`${profile}:${seed}`);
        }
      }
    }
    fail(`${REPORT_START}${JSON.stringify(seedsBySignature)}${REPORT_END}`);
  }, 3_600_000);
});
