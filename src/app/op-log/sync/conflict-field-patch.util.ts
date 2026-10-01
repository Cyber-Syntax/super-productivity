/**
 * Field-level LWW resolutions (direction A of
 * docs/sync-and-op-log/lww-field-level-resolution.md, #10379, #10260).
 *
 * An update-vs-update conflict resolves as ONE `'patch'` LWW Update built only
 * from both sides' ops: every field one side wrote keeps that side's value, a
 * field both sides wrote takes the LWW planner's winner's value
 * (`synthesizeMergedChanges`). This generalizes SPAP-14's disjoint merge to
 * overlapping fields. Released clients since v18.15.0 apply `'patch'` as a
 * merge (`updateOne`), so no marker, wire key or schema bump is needed.
 *
 * No Angular, no I/O.
 */

import { deepEqual, extractActionPayload } from '@sp/sync-core';
import { ActionType, isLwwUpdatePayload, OpType } from '../core/operation.types';
import type { EntityConflict, Operation, VectorClock } from '../core/operation.types';
import type { EntityType } from '../core/operation.types';
import { RECREATE_FALLBACK } from '../core/recreate-fallback.const';
import { mergeVectorClocks } from '../../core/util/vector-clock';
import { isMultiEntityOperation } from '../util/get-op-entity-ids.util';
import {
  isAdditiveTimeOp,
  isDisjointMergeEligible,
  isOpaqueChangeOp,
  mergeChangedFields,
  NOISE_FIELDS,
  sideNonNoiseKeys,
  SYNC_TIME_SPENT_FIELDS,
  synthesizeMergedChanges,
} from './conflict-disjoint-merge.util';

/**
 * Fields whose clear a v18.15.0–v18.21.x receiver would drop from a patch
 * (it ignores `clearedFields`), leaving a reminder that fires (#10393,
 * decision 3). A resolution that clears one of them keeps the whole-entity
 * path, unless today's disjoint merge already patched it.
 */
const REMINDER_FIELDS: readonly string[] = [
  'reminderId',
  'remindAt',
  'dueWithTime',
  'deadlineRemindAt',
];

const isSyncTimeSpentOp = (op: Operation): boolean =>
  op.actionType === ActionType.TIME_TRACKING_SYNC_TIME_SPENT;

/** The ops whose fields the patch carries: a time delta never is one. */
const fieldOps = (ops: Operation[]): Operation[] =>
  ops.filter((op) => !isSyncTimeSpentOp(op));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True for an op whose payload states its change as `{ id, changes }`. Some
 * readable actions carry a flat entity instead, e.g. `moveToOtherProject`'s
 * full PRE-move task: read as fields, it would write the old `projectId` (and
 * `subTasks`) back. Today's disjoint merge never overlaps with such a
 * snapshot, but a patch of overlapping fields or of a rejected edit must not
 * take its values.
 */
const isChangesShapedOp = (
  op: Operation,
  payloadKey: string,
  entityId: string,
): boolean => {
  const entity = extractActionPayload(op.payload)?.[payloadKey];
  return isRecord(entity) && entity['id'] === entityId && isRecord(entity['changes']);
};

export interface FieldPatchSides {
  localOps: Operation[];
  remoteOps: Operation[];
  payloadKey: string;
  entityId: string;
}

/**
 * True iff the conflict can resolve as a field patch. Unlike
 * `isDisjointMergeEligible`, both sides may write the same field.
 *
 * - No multi-entity op and no DELETE on either side (whole-entity paths).
 * - No opaque op (habit counts, `planTasksForToday`, LWW resolution rows):
 *   their change cannot be read as fields (#10393 decisions 5 and 6).
 * - Both sides wrote a real (non-noise) field; a noise-only side is left to
 *   whole-entity LWW, which loses nothing real.
 * - Time stays out of the patch: a local `syncTimeSpent` delta is kept and
 *   rebased instead (`keptLocalTimeDeltas`). A remote delta, `removeTimeSpent`
 *   (clamps, so it does not commute), or a delta beside an absolute write of
 *   the time fields refuses the patch.
 * - A patch that clears a reminder field of an overlapping conflict refuses
 *   (`REMINDER_FIELDS`); the caller passes the winner for that check.
 */
export const isFieldPatchEligible = (
  sides: FieldPatchSides,
  winner: 'local' | 'remote',
): boolean => {
  const { localOps, remoteOps, payloadKey, entityId } = sides;
  const allOps = [...localOps, ...remoteOps];
  if (allOps.some((op) => isMultiEntityOperation(op) || op.opType === OpType.Delete)) {
    return false;
  }
  if (
    allOps.some((op) => op.actionType === ActionType.TASK_REMOVE_TIME_SPENT) ||
    remoteOps.some(isSyncTimeSpentOp)
  ) {
    return false;
  }
  const local = sideNonNoiseKeys(localOps, payloadKey, entityId);
  const remote = sideNonNoiseKeys(remoteOps, payloadKey, entityId);
  if (!local || !remote || local.absolute.size === 0 || remote.absolute.size === 0) {
    return false;
  }
  if (
    local.additive.size > 0 &&
    SYNC_TIME_SPENT_FIELDS.some(
      (field) => local.absolute.has(field) || remote.absolute.has(field),
    )
  ) {
    return false;
  }
  if (isDisjointMergeEligible(sides)) {
    return true;
  }
  if (!fieldOps(allOps).every((op) => isChangesShapedOp(op, payloadKey, entityId))) {
    return false;
  }
  const changes = buildFieldPatchChanges(sides, winner);
  return !REMINDER_FIELDS.some(
    (field) => field in changes && changes[field] === undefined,
  );
};

/**
 * One side's fields, op by op in order. A task done toggle also carries the
 * `doneOn` its reducer derives, as the op converter does for replay
 * (`addReplaySafeDoneFields`): the op's timestamp when it sets `isDone`
 * without one, a clear when it unsets it. A patch applies fields, not
 * reducers, so without this the resolving device and a restart would differ.
 */
const sideChanges = (
  ops: Operation[],
  payloadKey: string,
  entityId: string,
): Record<string, unknown> => {
  const changes: Record<string, unknown> = {};
  for (const op of fieldOps(ops)) {
    const opChanges = mergeChangedFields([op], payloadKey, entityId);
    if (
      op.actionType === ActionType.TASK_SHARED_UPDATE &&
      'isDone' in opChanges &&
      !('doneOn' in opChanges)
    ) {
      opChanges['doneOn'] =
        opChanges['isDone'] === true && Number.isFinite(op.timestamp)
          ? op.timestamp
          : undefined;
    }
    Object.assign(changes, opChanges);
  }
  return changes;
};

/** The non-noise fields a side writes, deltas aside. */
const realFields = (ops: Operation[], payloadKey: string, entityId: string): string[] =>
  Object.keys(sideChanges(ops, payloadKey, entityId)).filter(
    (field) => !NOISE_FIELDS.has(field),
  );

/**
 * The patch's field/value map: both sides' fields, the winner's value where
 * both wrote one. Deltas are skipped; a restored clear keeps its key with the
 * value `undefined` (the caller lists it in `clearedFields`).
 */
export const buildFieldPatchChanges = (
  { localOps, remoteOps, payloadKey, entityId }: FieldPatchSides,
  winner: 'local' | 'remote',
): Record<string, unknown> =>
  synthesizeMergedChanges(
    sideChanges(localOps, payloadKey, entityId),
    sideChanges(remoteOps, payloadKey, entityId),
    winner,
  );

/**
 * True when a patch would only echo the winner: the remote side won and wrote
 * every real field the local side wrote. The plain remote-win path applies
 * the same values without a new op, which could otherwise beat another
 * device's pending edit in a later conflict. A local time delta still needs
 * the patch path, which keeps it (the plain path rejects it, #10408).
 */
export const isRemoteWinEcho = (
  { localOps, remoteOps, payloadKey, entityId }: FieldPatchSides,
  winner: 'local' | 'remote',
): boolean => {
  if (winner !== 'remote' || localOps.some(isSyncTimeSpentOp)) return false;
  const remote = new Set(realFields(remoteOps, payloadKey, entityId));
  return realFields(localOps, payloadKey, entityId).every((field) => remote.has(field));
};

/**
 * One conflict per entity: detection emits one conflict per remote op, all
 * sharing the entity's pending local ops. Two resolvers with staggered
 * batches must build a patch from the SAME two sides, so an entity's
 * conflicts are resolved together (ops deduplicated by id, in their order).
 */
export const aggregateEntityConflict = (conflicts: EntityConflict[]): EntityConflict => {
  const unique = (ops: Operation[]): Operation[] => [
    ...new Map(ops.map((op) => [op.id, op])).values(),
  ];
  return {
    ...conflicts[0],
    localOps: unique(conflicts.flatMap((conflict) => conflict.localOps)),
    remoteOps: unique(conflicts.flatMap((conflict) => conflict.remoteOps)),
  };
};

/**
 * The local `syncTimeSpent` deltas of patched conflicts. They are not
 * rejected: rejecting one and re-sending a copy would add the time twice on
 * restart, since replay is status-blind. Instead they stay pending and move
 * past the remote sides' clocks in place (`rebasePendingLocalOps`, with the
 * patch after them), so each uploads once and replays once.
 */
export const keptLocalTimeDeltas = (
  conflicts: EntityConflict[],
): { opIds: Set<string>; clockToDominate: VectorClock } => {
  const opIds = new Set<string>();
  let clockToDominate: VectorClock = {};
  for (const { localOps, remoteOps } of conflicts) {
    const deltas = localOps.filter(isSyncTimeSpentOp);
    if (deltas.length === 0) continue;
    deltas.forEach((op) => opIds.add(op.id));
    for (const op of remoteOps) {
      clockToDominate = mergeVectorClocks(clockToDominate, op.vectorClock);
    }
  }
  return { opIds, clockToDominate };
};

/**
 * Moves the pending kept deltas past the remote sides' clocks in place (id,
 * seq and payload stay), together with the patches written after them, so
 * each patch still dominates the deltas it follows. Runs after the patches
 * are durable: a crash before it leaves the deltas pending with their old
 * clocks, which the server rejects into the ordinary rejection paths. A delta
 * that is no longer pending (a no-pending crossing's retained op) already
 * uploaded and stays as it is.
 */
export const rebaseKeptTimeDeltas = async (
  store: {
    getOpById: (
      opId: string,
    ) => Promise<{ source: string; syncedAt?: number; rejectedAt?: number } | undefined>;
    rebasePendingLocalOps: (
      opIds: readonly string[],
      clockToDominate: VectorClock,
    ) => Promise<unknown>;
  },
  kept: { opIds: Set<string>; clockToDominate: VectorClock },
  patchOpIds: string[],
): Promise<void> => {
  const pendingDeltaIds: string[] = [];
  for (const opId of kept.opIds) {
    const entry = await store.getOpById(opId);
    if (
      entry?.source === 'local' &&
      entry.syncedAt === undefined &&
      entry.rejectedAt === undefined
    ) {
      pendingDeltaIds.push(opId);
    }
  }
  if (pendingDeltaIds.length > 0) {
    await store.rebasePendingLocalOps(
      [...pendingDeltaIds, ...patchOpIds],
      kept.clockToDominate,
    );
  }
};

/**
 * `SupersededOperationResolverService`: the fields a server-rejected group of
 * one entity's local ops wrote, when a patch can carry all of them, else
 * undefined (whole-entity snapshot as before). The resolver re-emits exactly
 * these fields from current state, so a rejected edit no longer overwrites
 * fields it never touched on every other device (#10379).
 *
 * Only readable single-entity field updates of a type with a
 * RECREATE_FALLBACK qualify: no delete, no opaque op (which includes LWW
 * resolution rows, decision 5) and no additive time op, whose value must not
 * become an absolute patch here.
 */
export const supersededPatchFields = (
  ops: Operation[],
  entityType: EntityType,
  payloadKey: string,
  entityId: string,
): string[] | undefined => {
  if (
    !RECREATE_FALLBACK[entityType] ||
    ops.length === 0 ||
    ops.some(
      (op) =>
        op.opType !== OpType.Update ||
        isMultiEntityOperation(op) ||
        isAdditiveTimeOp(op) ||
        isOpaqueChangeOp(op, payloadKey, entityId) ||
        !isChangesShapedOp(op, payloadKey, entityId),
    )
  ) {
    return undefined;
  }
  const written = mergeChangedFields(ops, payloadKey, entityId);
  // As on the conflict path: a reminder clear keeps the whole-entity snapshot
  // (v18.15.0–v18.21.x ignore `clearedFields`, decision 3), and a done toggle
  // carries the `doneOn` its reducer derived (`sideChanges`).
  if (REMINDER_FIELDS.some((field) => field in written && written[field] === undefined)) {
    return undefined;
  }
  const fields = Object.keys(written);
  return 'isDone' in written && !('doneOn' in written) ? [...fields, 'doneOn'] : fields;
};

/**
 * #10260 on a later round: pending readable edits that lost to a remote LWW
 * resolution row (a patch or snapshot another device built). The row is
 * opaque here (no re-merge, #10393 decision 5), so the plain remote-win path
 * rejects the local ops and their fields stay on this device only; a replace
 * row used to hide that by overwriting them.
 *
 * Returns the fields to re-emit, read from state AFTER the row applied: those
 * still holding the local ops' values survived the row and must upload; the
 * row overwrote the others, and re-sending those would only echo it. Undefined
 * when nothing survived or the local side is not readable
 * (`supersededPatchFields`). A time delta keeps the plain path (#10408), and
 * opaque winners such as habit counts stay whole-entity (decision 6).
 */
export const survivingLocalFields = (
  conflict: EntityConflict,
  entityState: Record<string, unknown>,
  payloadKey: string,
): Record<string, unknown> | undefined => {
  const { localOps, remoteOps, entityType, entityId } = conflict;
  const readable = localOps.filter((op) => !isAdditiveTimeOp(op));
  if (
    !remoteOps.every((op) => isLwwUpdatePayload(op.payload)) ||
    !supersededPatchFields(readable, entityType, payloadKey, entityId)
  ) {
    return undefined;
  }
  const written = mergeChangedFields(readable, payloadKey, entityId);
  const surviving = Object.keys(written).filter(
    (field) => !NOISE_FIELDS.has(field) && deepEqual(entityState[field], written[field]),
  );
  if (surviving.length === 0) return undefined;
  // A surviving done toggle carries its derived `doneOn` (`sideChanges`).
  const fields = surviving.includes('isDone') ? [...surviving, 'doneOn'] : surviving;
  return Object.fromEntries(fields.map((field) => [field, entityState[field]]));
};

/**
 * One `survivingLocalFields` patch per entity whose losing local ops are all
 * pending (a no-pending crossing's retained ops already uploaded).
 */
export const buildSurvivingFieldPatches = async (
  resolutions: { conflict: EntityConflict; winner: 'local' | 'remote' }[],
  pendingOpIds: Set<string>,
  deps: {
    getState: (entityType: EntityType, entityId: string) => Promise<unknown>;
    payloadKeyFor: (entityType: EntityType) => string;
    createPatch: (conflict: EntityConflict, fields: Record<string, unknown>) => Operation;
  },
): Promise<Operation[]> => {
  const patches: Operation[] = [];
  const seen = new Set<string>();
  for (const { conflict, winner } of resolutions) {
    const key = `${conflict.entityType}:${conflict.entityId}`;
    if (
      winner !== 'remote' ||
      seen.has(key) ||
      !conflict.localOps.every((op) => pendingOpIds.has(op.id))
    ) {
      continue;
    }
    seen.add(key);
    const state = await deps.getState(conflict.entityType, conflict.entityId);
    const fields =
      state !== null && typeof state === 'object'
        ? survivingLocalFields(
            conflict,
            state as Record<string, unknown>,
            deps.payloadKeyFor(conflict.entityType),
          )
        : undefined;
    if (fields) patches.push(deps.createPatch(conflict, fields));
  }
  return patches;
};
