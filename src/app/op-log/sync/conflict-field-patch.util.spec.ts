import {
  aggregateEntityConflict,
  buildFieldPatchChanges,
  buildSurvivingFieldPatches,
  isFieldPatchEligible,
  isRemoteWinEcho,
  keptLocalTimeDeltas,
  rebaseKeptTimeDeltas,
  supersededPatchFields,
  survivingLocalFields,
} from './conflict-field-patch.util';
import {
  ActionType,
  EntityConflict,
  EntityType,
  OpType,
  Operation,
} from '../core/operation.types';

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op-1',
  actionType: '[Task Shared] updateTask' as ActionType,
  opType: OpType.Update,
  entityType: 'TASK' as EntityType,
  entityId: 'task-1',
  payload: { actionPayload: { task: { id: 'task-1', changes: {} } }, entityChanges: [] },
  clientId: 'A',
  vectorClock: { A: 1 },
  timestamp: 1000,
  schemaVersion: 1,
  ...over,
});

const edit = (
  changes: Record<string, unknown>,
  over: Partial<Operation> = {},
): Operation =>
  op({
    payload: {
      actionPayload: { task: { id: 'task-1', changes } },
      entityChanges: [],
    },
    ...over,
  });

const delta = (over: Partial<Operation> = {}): Operation =>
  op({
    id: 'delta',
    actionType: ActionType.TIME_TRACKING_SYNC_TIME_SPENT,
    payload: {
      actionPayload: { taskId: 'task-1', date: '2026-01-01', duration: 1000 },
      entityChanges: [],
    },
    ...over,
  });

const sides = (
  localOps: Operation[],
  remoteOps: Operation[],
): {
  localOps: Operation[];
  remoteOps: Operation[];
  payloadKey: string;
  entityId: string;
} => ({
  localOps,
  remoteOps,
  payloadKey: 'task',
  entityId: 'task-1',
});

describe('conflict-field-patch.util', () => {
  describe('isFieldPatchEligible', () => {
    it('admits disjoint and overlapping readable edits', () => {
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a' })], [edit({ notes: 'n' })]),
          'local',
        ),
      ).toBeTrue();
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a', isDone: true })], [edit({ title: 'b' })]),
          'remote',
        ),
      ).toBeTrue();
    });

    it('refuses deletes, multi-entity and opaque ops', () => {
      const remote = [edit({ title: 'b' })];
      expect(
        isFieldPatchEligible(sides([op({ opType: OpType.Delete })], remote), 'local'),
      ).toBeFalse();
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a' }, { entityIds: ['task-1', 'task-2'] })], remote),
          'local',
        ),
      ).toBeFalse();
      const opaque = op({
        payload: { actionPayload: { taskId: 'task-1', x: 1 }, entityChanges: [] },
      });
      expect(isFieldPatchEligible(sides([opaque], remote), 'local')).toBeFalse();
    });

    it("refuses an overlap with a flat-snapshot op such as moveToOtherProject's", () => {
      // Its payload is the full PRE-move task: read as fields it would write
      // the old projectId back.
      const move = (projectId: string): Operation =>
        op({
          actionType: '[Task Shared] moveToOtherProject' as ActionType,
          payload: {
            actionPayload: {
              task: { id: 'task-1', projectId, title: 't', subTasks: [] },
              targetProjectId: 'P-new',
            },
            entityChanges: [],
          },
        });
      expect(
        isFieldPatchEligible(sides([move('P1')], [move('P1')]), 'local'),
      ).toBeFalse();
      expect(
        supersededPatchFields([move('P1')], 'TASK' as EntityType, 'task', 'task-1'),
      ).toBeUndefined();
    });

    it('refuses a side that changed only noise fields', () => {
      expect(
        isFieldPatchEligible(
          sides([edit({ modified: 5 })], [edit({ title: 'b', modified: 6 })]),
          'remote',
        ),
      ).toBeFalse();
    });

    it('admits a local time delta beside readable edits, but not a remote one', () => {
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a' }), delta()], [edit({ title: 'b' })]),
          'remote',
        ),
      ).toBeTrue();
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a' })], [edit({ title: 'b' }), delta()]),
          'remote',
        ),
      ).toBeFalse();
    });

    it('refuses a delta beside an absolute time write, and removeTimeSpent', () => {
      const day = '2026-01-01';
      const absolute = edit({ timeSpentOnDay: { [day]: 5 }, timeSpent: 5 });
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a' }), delta()], [edit({ title: 'b' }), absolute]),
          'remote',
        ),
      ).toBeFalse();
      const remove = op({ actionType: ActionType.TASK_REMOVE_TIME_SPENT });
      expect(
        isFieldPatchEligible(
          sides([edit({ title: 'a' }), remove], [edit({ title: 'b' })]),
          'remote',
        ),
      ).toBeFalse();
    });

    it('refuses an overlapping patch that clears a reminder field', () => {
      const clear = edit({ title: 'a', reminderId: undefined });
      expect(
        isFieldPatchEligible(sides([clear], [edit({ title: 'b' })]), 'local'),
      ).toBeFalse();
      // The other side's value wins the shared field: nothing is cleared.
      expect(
        isFieldPatchEligible(
          sides(
            [edit({ title: 'a', dueWithTime: undefined })],
            [edit({ dueWithTime: 5 })],
          ),
          'remote',
        ),
      ).toBeTrue();
      // Today's disjoint merge already patched a clear: unchanged.
      expect(
        isFieldPatchEligible(sides([clear], [edit({ notes: 'n' })]), 'local'),
      ).toBeTrue();
    });
  });

  describe('buildFieldPatchChanges', () => {
    it("unions both sides, the winner's value for a shared field, and skips deltas", () => {
      const local = [edit({ title: 'a', isDone: true }), delta()];
      const remote = [edit({ title: 'b' }), edit({ notes: 'n' })];
      // A done toggle carries the doneOn its reducer derives (the op's time).
      expect(buildFieldPatchChanges(sides(local, remote), 'remote')).toEqual({
        title: 'b',
        isDone: true,
        doneOn: 1000,
        notes: 'n',
      });
      expect(buildFieldPatchChanges(sides(local, remote), 'local')).toEqual({
        title: 'a',
        isDone: true,
        doneOn: 1000,
        notes: 'n',
      });
    });

    it('is identical on both devices when each names the same winning side', () => {
      const x = [edit({ title: 'x', notes: 'x' }, { clientId: 'X' })];
      const y = [edit({ title: 'y', isDone: true }, { clientId: 'Y' })];
      expect(buildFieldPatchChanges(sides(x, y), 'remote')).toEqual(
        buildFieldPatchChanges(sides(y, x), 'local'),
      );
    });
  });

  describe('aggregateEntityConflict', () => {
    it("joins an entity's conflicts, deduplicating ops by id", () => {
      const local = edit({ title: 'a' }, { id: 'l' });
      const r1 = edit({ title: 'b' }, { id: 'r1' });
      const r2 = edit({ notes: 'n' }, { id: 'r2' });
      const conflict = (remoteOps: Operation[]): EntityConflict => ({
        entityType: 'TASK' as EntityType,
        entityId: 'task-1',
        localOps: [local],
        remoteOps,
        suggestedResolution: 'manual',
      });
      const joined = aggregateEntityConflict([conflict([r1]), conflict([r2])]);
      expect(joined.localOps).toEqual([local]);
      expect(joined.remoteOps).toEqual([r1, r2]);
    });
  });

  describe('keptLocalTimeDeltas / rebaseKeptTimeDeltas', () => {
    const conflict: EntityConflict = {
      entityType: 'TASK' as EntityType,
      entityId: 'task-1',
      localOps: [edit({ title: 'a' }, { id: 'l' }), delta({ id: 'd' })],
      remoteOps: [
        edit({ title: 'b' }, { id: 'r1', vectorClock: { B: 1 } }),
        edit({ notes: 'n' }, { id: 'r2', vectorClock: { B: 2, C: 1 } }),
      ],
      suggestedResolution: 'manual',
    };

    it('keeps only the local deltas and dominates every remote op', () => {
      const kept = keptLocalTimeDeltas([conflict]);
      expect([...kept.opIds]).toEqual(['d']);
      expect(kept.clockToDominate).toEqual({ B: 2, C: 1 });
    });

    it('rebases the pending deltas with the patches after them', async () => {
      const store = {
        getOpById: jasmine
          .createSpy('getOpById')
          .and.resolveTo({ source: 'local' } as { source: string }),
        rebasePendingLocalOps: jasmine.createSpy('rebase').and.resolveTo([]),
      };
      await rebaseKeptTimeDeltas(store, keptLocalTimeDeltas([conflict]), ['patch']);
      expect(store.rebasePendingLocalOps).toHaveBeenCalledWith(['d', 'patch'], {
        B: 2,
        C: 1,
      });
    });

    it('leaves an already-uploaded delta and the patches alone', async () => {
      const store = {
        getOpById: jasmine.createSpy('getOpById').and.resolveTo({
          source: 'local',
          syncedAt: 1,
        } as {
          source: string;
          syncedAt?: number;
        }),
        rebasePendingLocalOps: jasmine.createSpy('rebase').and.resolveTo([]),
      };
      await rebaseKeptTimeDeltas(store, keptLocalTimeDeltas([conflict]), ['patch']);
      expect(store.rebasePendingLocalOps).not.toHaveBeenCalled();
    });
  });

  describe('supersededPatchFields', () => {
    it('lists the fields of readable single-entity edits', () => {
      expect(
        supersededPatchFields(
          [edit({ title: 'a' }), edit({ isDone: true, modified: 3 })],
          'TASK' as EntityType,
          'task',
          'task-1',
        ),
      ).toEqual(['title', 'isDone', 'modified', 'doneOn']);
    });

    it('keeps the whole entity for a reminder clear, as the conflict path does', () => {
      for (const field of ['dueWithTime', 'remindAt', 'reminderId', 'deadlineRemindAt']) {
        expect(
          supersededPatchFields(
            [edit({ title: 'a', [field]: undefined })],
            'TASK' as EntityType,
            'task',
            'task-1',
          ),
        )
          .withContext(field)
          .toBeUndefined();
      }
      expect(
        supersededPatchFields(
          [edit({ dueWithTime: 5 })],
          'TASK' as EntityType,
          'task',
          'task-1',
        ),
      ).toEqual(['dueWithTime']);
    });

    it('keeps the whole entity for deltas, opaque ops, LWW rows and types without a fallback', () => {
      const lwwRow = op({
        actionType: '[TASK] LWW Update' as ActionType,
        payload: {
          actionPayload: { id: 'task-1', title: 'a' },
          entityChanges: [],
          lwwUpdateMode: 'patch',
        },
      });
      for (const ops of [[delta()], [lwwRow], [op({ opType: OpType.Delete })]]) {
        expect(supersededPatchFields(ops, 'TASK' as EntityType, 'task', 'task-1'))
          .withContext(ops[0].actionType)
          .toBeUndefined();
      }
      expect(
        supersededPatchFields(
          [edit({ content: 'x' })],
          'NOTE' as EntityType,
          'note',
          'task-1',
        ),
      ).toBeUndefined();
    });
  });
  describe('done normalization', () => {
    it('clears doneOn beside an undone toggle, as the task reducer does', () => {
      const changes = buildFieldPatchChanges(
        sides([edit({ isDone: false })], [edit({ title: 'b' })]),
        'remote',
      );
      expect('doneOn' in changes).toBeTrue();
      expect(changes['doneOn']).toBeUndefined();
    });

    it('keeps a doneOn the op carried', () => {
      expect(
        buildFieldPatchChanges(
          sides([edit({ isDone: true, doneOn: 7 })], [edit({ title: 'b' })]),
          'remote',
        )['doneOn'],
      ).toBe(7);
    });
  });

  describe('isRemoteWinEcho', () => {
    it('is true when the winning remote side wrote every local field', () => {
      const s = sides([edit({ notes: 'a' })], [edit({ notes: 'b', title: 't' })]);
      expect(isRemoteWinEcho(s, 'remote')).toBeTrue();
      expect(isRemoteWinEcho(s, 'local')).toBeFalse();
    });

    it('is false when a local field survives or a local delta must be kept', () => {
      expect(
        isRemoteWinEcho(
          sides([edit({ notes: 'a', isDone: true })], [edit({ notes: 'b' })]),
          'remote',
        ),
      ).toBeFalse();
      expect(
        isRemoteWinEcho(
          sides([edit({ notes: 'a' }), delta()], [edit({ notes: 'b' })]),
          'remote',
        ),
      ).toBeFalse();
    });
  });

  describe('survivingLocalFields / buildSurvivingFieldPatches', () => {
    const lwwRow = op({
      id: 'row',
      actionType: '[TASK] LWW Update' as ActionType,
      payload: {
        actionPayload: { id: 'task-1', title: 'row' },
        entityChanges: [],
        lwwUpdateMode: 'patch',
      },
    });
    const conflictOf = (
      localOps: Operation[],
      remoteOps: Operation[],
    ): EntityConflict => ({
      entityType: 'TASK' as EntityType,
      entityId: 'task-1',
      localOps,
      remoteOps,
      suggestedResolution: 'manual',
    });

    it('re-emits only the local fields the winning row left in state', () => {
      const local = edit({ title: 'mine', isDone: true }, { id: 'l' });
      expect(
        survivingLocalFields(
          conflictOf([local], [lwwRow]),
          { id: 'task-1', title: 'row', isDone: true, doneOn: 5 },
          'task',
        ),
      ).toEqual({ isDone: true, doneOn: 5 });
    });

    it('re-emits nothing when the row overwrote every local field', () => {
      const local = edit({ title: 'mine' }, { id: 'l' });
      expect(
        survivingLocalFields(conflictOf([local], [lwwRow]), { title: 'row' }, 'task'),
      ).toBeUndefined();
    });

    it('leaves readable and opaque winners to their own paths', () => {
      const local = edit({ isDone: true }, { id: 'l' });
      const state = { isDone: true };
      expect(
        survivingLocalFields(conflictOf([local], [edit({ title: 'x' })]), state, 'task'),
      ).toBeUndefined();
      const count = op({
        actionType: '[SimpleCounter] Set SimpleCounter Counter Today' as ActionType,
        payload: { actionPayload: { id: 'task-1', newVal: 3 }, entityChanges: [] },
      });
      expect(
        survivingLocalFields(conflictOf([local], [count]), state, 'task'),
      ).toBeUndefined();
    });

    it('builds one patch per entity, only for remote wins whose local ops are pending', async () => {
      const local = edit({ isDone: true }, { id: 'l' });
      const conflict = conflictOf([local], [lwwRow]);
      const createPatch = jasmine
        .createSpy('createPatch')
        .and.callFake((_c: EntityConflict, fields: Record<string, unknown>) =>
          op({ id: 'patch', payload: fields }),
        );
      const deps = {
        getState: async (): Promise<unknown> => ({ isDone: true }),
        payloadKeyFor: (): string => 'task',
        createPatch,
      };
      const patches = await buildSurvivingFieldPatches(
        [
          { conflict, winner: 'remote' },
          { conflict, winner: 'remote' },
        ],
        new Set(['l']),
        deps,
      );
      expect(patches.length).toBe(1);
      expect(createPatch).toHaveBeenCalledWith(conflict, {
        isDone: true,
        doneOn: undefined,
      });
      expect(
        await buildSurvivingFieldPatches(
          [{ conflict, winner: 'local' }],
          new Set(['l']),
          deps,
        ),
      ).toEqual([]);
      expect(
        await buildSurvivingFieldPatches(
          [{ conflict, winner: 'remote' }],
          new Set(),
          deps,
        ),
      ).toEqual([]);
    });
  });
});
