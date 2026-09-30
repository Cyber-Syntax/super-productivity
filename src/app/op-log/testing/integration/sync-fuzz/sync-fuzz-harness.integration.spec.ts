import { TestBed } from '@angular/core/testing';
import { DEFAULT_TASK, Task } from '../../../../features/tasks/task.model';
import { WorkContextType } from '../../../../features/work-context/work-context.model';
import { addNote } from '../../../../features/note/store/note.actions';
import { Note } from '../../../../features/note/note.model';
import { EMPTY_SIMPLE_COUNTER } from '../../../../features/simple-counter/simple-counter.const';
import { TaskSharedActions } from '../../../../root-store/meta/task-shared.actions';
import { VectorClock } from '../../../core/operation.types';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import {
  DeviceView,
  executeIntent,
  generateIntent,
  isUiPossible,
} from './sync-fuzz-actions';
import { FuzzDevice, SyncFuzzHarness } from './sync-fuzz-harness';
import { comparable, createRandom, runFuzz } from './sync-fuzz-runner';

const addTask = (
  id: string,
  title: string,
): ReturnType<typeof TaskSharedActions.addTask> =>
  TaskSharedActions.addTask({
    task: { ...DEFAULT_TASK, id, title, projectId: 'INBOX_PROJECT', created: Date.now() },
    workContextId: 'INBOX_PROJECT',
    workContextType: WorkContextType.PROJECT,
    isAddToBacklog: false,
    isAddToBottom: false,
  });

const taskTitle = async (
  harness: SyncFuzzHarness,
  device: FuzzDevice,
  id: string,
): Promise<string | undefined> =>
  harness.as(device, async () => {
    const tasks = (await harness.state())['tasks'] as { entities: Record<string, Task> };
    return tasks.entities[id]?.title;
  });

describe('SyncFuzzHarness: two devices on one injector', () => {
  let harness: SyncFuzzHarness;
  let a: FuzzDevice;
  let b: FuzzDevice;

  beforeEach(async () => {
    harness = await SyncFuzzHarness.create();
    a = await harness.addDevice('A');
    b = await harness.addDevice('B');
  }, 60_000);

  afterEach(() => SyncFuzzHarness.dispose());

  it('keeps each device’s store, op log, clock and cursor apart', async () => {
    await harness.as(a, async () => {
      await harness.dispatch(addTask('t1', 'from A'));
      await harness.dispatch(
        addNote({
          note: {
            id: 'n1',
            projectId: 'INBOX_PROJECT',
            isPinnedToToday: false,
            content: 'note A',
            created: Date.now(),
            modified: Date.now(),
          },
        }),
      );
    });
    expect(await taskTitle(harness, a, 't1')).toBe('from A');
    expect(await taskTitle(harness, b, 't1')).toBeUndefined();
    expect(await harness.pendingOpCount(a)).toBe(2);
    expect(await harness.pendingOpCount(b)).toBe(0);

    expect(await harness.sync(a)).toBe(true);
    expect(harness.server.rows.length).toBe(2);
    expect(await harness.sync(b)).toBe(true);
    expect(await taskTitle(harness, b, 't1')).toBe('from A');
    expect(await harness.pendingOpCount(b)).toBe(0);

    await harness.as(b, () =>
      harness.dispatch(
        TaskSharedActions.updateTask({
          task: { id: 't1', changes: { title: 'from B' } },
        }),
      ),
    );
    expect(await taskTitle(harness, a, 't1')).toBe('from A');
    expect(await harness.sync(b)).toBe(true);
    expect(await harness.sync(a)).toBe(true);
    expect(await taskTitle(harness, a, 't1')).toBe('from B');

    const clocks: (VectorClock | null)[] = [];
    for (const device of [a, b]) {
      clocks.push(
        await harness.as(device, () =>
          TestBed.inject(OperationLogStoreService).getVectorClock(),
        ),
      );
    }
    expect(clocks[0]).toEqual({ fuzzDevA: 2, fuzzDevB: 1 });
    expect(clocks[1]).toEqual({ fuzzDevA: 2, fuzzDevB: 1 });
    expect(await a.client.getLastServerSeq()).toBe(3);
    expect(await b.client.getLastServerSeq()).toBe(3);
    expect(comparable(await harness.syncedState(a))).toEqual(
      comparable(await harness.syncedState(b)),
    );
    expect(harness.events).toEqual([]);
  }, 60_000);

  it('tells two devices apart when one has not synced', async () => {
    // Guards the state comparison above against a vacuous pass.
    await harness.as(a, () => harness.dispatch(addTask('t1', 'only A')));
    expect(comparable(await harness.syncedState(a))).not.toEqual(
      comparable(await harness.syncedState(b)),
    );
  }, 60_000);

  it('stops a harness that a newer harness replaced', async () => {
    await SyncFuzzHarness.create();
    await expectAsync(harness.as(a, async () => undefined)).toBeRejectedWithError(
      /stale harness/,
    );
  }, 60_000);

  it('reopens a done task that a device tracks, as starting it does in the app', async () => {
    await harness.as(a, async () => {
      await harness.dispatch(addTask('t1', 'task'));
      await executeIntent(harness, ['doneTask', 't1', true]);
      await executeIntent(harness, ['track', 't1', 2000]);
    });
    expect(await harness.sync(a)).toBe(true);
    expect(await harness.sync(b)).toBe(true);
    for (const device of [a, b]) {
      const t1 = await harness.as(device, async () => {
        const tasks = (await harness.state())['tasks'] as {
          entities: Record<string, Task>;
        };
        return tasks.entities['t1'];
      });
      expect({ isDone: t1?.isDone, timeSpent: t1?.timeSpent })
        .withContext(device.name)
        .toEqual({ isDone: false, timeSpent: 2000 });
    }
  }, 60_000);
});

describe('SyncFuzzHarness: negative control', () => {
  afterEach(() => SyncFuzzHarness.dispose());

  it('the oracles report device B reusing device A’s database', async () => {
    // The setup trace alone converges...
    expect((await runFuzz({ steps: [] })).failures).toEqual([]);

    // ...until the per-device database isolation breaks: B's op log is A's.
    // B then skips the ops A already applied in that database.
    const addDevice = SyncFuzzHarness.prototype.addDevice;
    let first: FuzzDevice | undefined;
    spyOn(SyncFuzzHarness.prototype, 'addDevice').and.callFake(async function (
      this: SyncFuzzHarness,
      name: string,
    ): Promise<FuzzDevice> {
      const device = await addDevice.call(this, name);
      first ??= device;
      return name === 'B' ? { ...device, db: first.db } : device;
    });

    const { failures } = await runFuzz({ steps: [] });

    expect(failures.some((f) => f.signature.startsWith('divergence:')))
      .withContext(JSON.stringify(failures))
      .toBeTrue();
  }, 60_000);
});

describe('sync fuzz generator', () => {
  const note = (id: string, projectId: string | null): Note => ({
    id,
    projectId,
    isPinnedToToday: !projectId,
    content: id,
    created: 0,
    modified: 0,
  });
  const view: DeviceView = {
    tasks: [],
    notes: [note('nP', 'INBOX_PROJECT'), note('nT', null)],
    projectNoteIds: ['nP'],
    todayNoteIds: ['nT'],
    habits: [
      { ...EMPTY_SIMPLE_COUNTER, id: 'hOn', isEnabled: true },
      { ...EMPTY_SIMPLE_COUNTER, id: 'hOff', isEnabled: false },
    ],
    timeTracking: { project: {}, tag: {} },
  };

  it('emits only steps the UI offers', () => {
    const random = createRandom(7);
    let id = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 3_000; i++) {
      const intent = generateIntent(random, view, [], `L${i}`, (p) => `${p}${++id}`);
      if (!intent) continue;
      expect(isUiPossible(intent, view)).withContext(JSON.stringify(intent)).toBeTrue();
      if (intent[0] === 'editNote' || intent[0] === 'countHabit') {
        seen.add(intent.slice(0, intent[0] === 'editNote' ? 3 : 2).join(' '));
      }
    }
    // Pin toggles only on the project note, counts only on the enabled habit.
    expect([...seen].sort()).toEqual([
      'countHabit hOn',
      'editNote nP content',
      'editNote nP isLock',
      'editNote nP isPinnedToToday',
      'editNote nT content',
      'editNote nT isLock',
    ]);
    expect(isUiPossible(['editNote', 'nT', 'isPinnedToToday', false], view)).toBeFalse();
    expect(isUiPossible(['countHabit', 'hOff'], view)).toBeFalse();
  });
});
