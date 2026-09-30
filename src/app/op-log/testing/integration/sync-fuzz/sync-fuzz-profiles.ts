import { DEFAULT_WEIGHTS, IntentWeights } from './sync-fuzz-actions';

/**
 * Intent mixes of the random-seed runs. `noReorder` leaves out the reorder
 * wedge, a stop that masks every later failure on the stopped device; `tasks`
 * concentrates on task edits crossing tracked time.
 */
export const FUZZ_PROFILES: Record<string, IntentWeights> = {
  all: DEFAULT_WEIGHTS,
  noReorder: DEFAULT_WEIGHTS.filter(
    ([kind]) => kind !== 'reorderNotes' && kind !== 'reorderHabits',
  ),
  tasks: [
    ['renameTask', 3],
    ['editTaskNotes', 2],
    ['track', 4],
    ['doneTask', 1],
  ],
};
