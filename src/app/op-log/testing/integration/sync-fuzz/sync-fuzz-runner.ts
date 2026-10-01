import { TestBed } from '@angular/core/testing';
import { ArchiveDbAdapter } from '../../../../core/persistence/archive-db-adapter.service';
import { Note } from '../../../../features/note/note.model';
import { Project } from '../../../../features/project/project.model';
import { SimpleCounter } from '../../../../features/simple-counter/simple-counter.model';
import { Task } from '../../../../features/tasks/task.model';
import { compareVectorClocks } from '../../../../core/util/vector-clock';
import { FULL_STATE_OP_TYPES, VectorClock } from '../../../core/operation.types';
import {
  AppStateSnapshot,
  StateSnapshotService,
} from '../../../backup/state-snapshot.service';
import { ValidateStateService } from '../../../validation/validate-state.service';
import { OperationLogStoreService } from '../../../persistence/operation-log-store.service';
import {
  executeIntent,
  FuzzStep,
  FuzzWrite,
  fuzzDay,
  generateIntent,
  Intent,
  IntentWeights,
  isUiPossible,
  REPLACEMENT_INTENTS,
  SETUP_INTENTS,
  viewOf,
} from './sync-fuzz-actions';
import {
  FuzzDevice,
  FuzzEvent,
  FuzzEventKind,
  ImportDialogAnswer,
  SyncFuzzHarness,
} from './sync-fuzz-harness';

/**
 * Runs one trace (generated from a seed, or replayed from a fixture) and
 * checks the oracles. A failure's `signature` classifies it without step
 * numbers or ids, so shrinking can require "the same failure".
 */

export interface FuzzFailure {
  signature: string;
  detail: string;
}

export interface FuzzResult {
  steps: FuzzStep[];
  failures: FuzzFailure[];
  /** Distinct server rejections, as `<errorCode> <actionType>`. */
  rejections: string[];
  ms: number;
  /** With `debug`: server rows, rejections and every device's op log. */
  dump?: string[];
}

export interface FuzzOptions {
  seed?: number;
  steps?: FuzzStep[];
  stepCount?: number;
  /**
   * Intent mix for generated traces (default DEFAULT_WEIGHTS). A mix with a
   * state replacement also answers the SYNC_IMPORT conflict dialog on every
   * step (`k`). Every mix answers the whole-dataset dialog after a stop; see
   * runFuzz's `modelsStopDialog`.
   */
  weights?: IntentWeights;
  debug?: boolean;
}

const DEVICES = ['A', 'B', 'C'];
const SYNC_PROBABILITY = 0.35;
const COMPACT_PROBABILITY = 0.1;
const RESTART_PROBABILITY = 0.1;
const SETTLE_ROUNDS = 6;
/** How often a generated step keeps local data in a dialog (`k`). */
const USE_LOCAL_PROBABILITY = 0.3;
/**
 * Seeds the `k` stream of mixes without a replacement intent: drawing `k`
 * from the main stream would change every trace of those mixes, stop or not.
 */
const DIALOG_STREAM_SALT = 0x5f0d1a10;
/**
 * Full-state ops that only a user's replacement intent creates: the force
 * upload (also the dialog's USE_LOCAL) and the backup import.
 */
const USER_REPLACEMENT_REASONS: Readonly<Record<string, string>> = {
  SYNC_IMPORT: 'FORCE_UPLOAD',
  BACKUP_IMPORT: 'BACKUP_RESTORE',
};
const FAILING_EVENTS: readonly FuzzEventKind[] = [
  'stop',
  'sync-error',
  'sync-halted',
  'full-state',
  'validation',
  'permanent-rejection',
  'dialog',
  'error-snack',
  'dev-error',
];

/** mulberry32, as in replacement-convergence.integration.spec.ts. */
export const createRandom = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One executed intent, with the acting device's vector clock after it. */
interface LedgerEntry {
  intent: Intent;
  writes: FuzzWrite[];
  device: string;
  clientId: string;
  clock: VectorClock;
  /** The device's own counter before the intent: its ops are above it. */
  counterBefore: number;
  /** One of its ops was still unsynced when its device answered USE_REMOTE. */
  discarded?: boolean;
}

/** What the executed intents imply, for the preservation oracles. */
class Ledger {
  readonly created = new Set<string>();
  readonly deleted = new Set<string>();
  readonly archivedEver = new Set<string>();
  readonly tracked = new Map<string, number>();
  readonly writes = new Map<string, unknown[]>();

  constructor(entries: readonly LedgerEntry[]) {
    for (const { intent, writes } of entries) this._note(intent, writes);
  }

  private _note(intent: Intent, writes: FuzzWrite[]): void {
    const [kind, id] = intent;
    if (REPLACEMENT_INTENTS.has(kind)) return;
    const type = /Task|^track$/.test(kind)
      ? 'task'
      : /Note$/.test(kind)
        ? 'note'
        : 'habit';
    const entity = `${type}:${id}`;
    if (kind.startsWith('add')) this.created.add(entity);
    if (kind.startsWith('delete')) this.deleted.add(entity);
    if (kind === 'archiveTask') this.archivedEver.add(entity);
    if (intent[0] === 'track') {
      this.tracked.set(entity, (this.tracked.get(entity) ?? 0) + intent[2]);
    }
    for (const write of writes) {
      const key = `${write.entity}|${write.field}`;
      this.writes.set(key, [...(this.writes.get(key) ?? []), write.value]);
    }
  }
}

/**
 * What the last state replacement on the server (a SYNC_IMPORT or
 * BACKUP_IMPORT) legitimately discards. Every device drops the ops that are
 * not causally after it (CONCURRENT or LESS_THAN by vector clock), by design
 * (AGENTS.md sync rule 7). So the preservation oracles check only the intents
 * whose device clock is at or after the replacement's, on top of the
 * replacement's own content: its entities and tracked time.
 */
interface Replacement {
  clock: VectorClock;
  entities: Set<string>;
  time: Map<string, number>;
}

const lastReplacement = (harness: SyncFuzzHarness): Replacement | undefined => {
  const row = [...harness.server.rows]
    .reverse()
    .find((r) => r.op.opType === 'SYNC_IMPORT' || r.op.opType === 'BACKUP_IMPORT');
  if (!row) return undefined;
  const state = row.op.payload as unknown as Partial<CheckedState>;
  const entities = new Set<string>();
  const time = new Map<string, number>();
  const day = fuzzDay();
  for (const task of [
    ...Object.values(state.task?.entities ?? {}),
    ...Object.values(state.archiveYoung?.task.entities ?? {}),
  ]) {
    if (!task) continue;
    entities.add(`task:${task.id}`);
    time.set(`task:${task.id}`, task.timeSpentOnDay?.[day] ?? 0);
  }
  for (const id of state.note?.ids ?? []) entities.add(`note:${id}`);
  for (const id of state.simpleCounter?.ids ?? []) entities.add(`habit:${id}`);
  return { clock: row.op.vectorClock, entities, time };
};

const isAtOrAfter = (clock: VectorClock, replacement: VectorClock): boolean => {
  const comparison = compareVectorClocks(clock, replacement);
  return comparison === 'GREATER_THAN' || comparison === 'EQUAL';
};

const valueAt = (source: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)[key]
        : undefined,
    source,
  );

/** The differing leaf paths of two JSON-like values, at most `limit`. */
export const diffPaths = (
  a: unknown,
  b: unknown,
  limit = 20,
  path = '',
  found: string[] = [],
): string[] => {
  if (found.length >= limit || Object.is(a, b)) return found;
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      diffPaths(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        limit,
        `${path}.${key}`,
        found,
      );
    }
    return found;
  }
  found.push(path || '.');
  return found;
};

/**
 * The synced state minus what legitimately differs per device:
 * - `modified`: reducers stamp it with the applying device's clock on every
 *   update (task CRUD, lwwUpdateMetaReducer), so it never converges;
 * - `isDataLoaded`: a runtime flag hydration sets on the task slice;
 * - `lastFlush`: write-only archive bookkeeping (ArchiveService), never read;
 * - empty objects, which equal a missing key (an archive flush run locally
 *   leaves `{}` where the remote flush leaves nothing).
 */
export const comparable = (state: unknown): unknown =>
  JSON.parse(JSON.stringify(state), (key, value: unknown) =>
    key === 'modified' ||
    key === 'isDataLoaded' ||
    key === 'lastFlush' ||
    (key !== '' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
      ? undefined
      : value,
  );

const answerOf = (k: FuzzStep['k']): ImportDialogAnswer | undefined =>
  k === 'L' ? 'USE_LOCAL' : k === 'R' ? 'USE_REMOTE' : undefined;

const shortJson = (value: unknown): string => JSON.stringify(value)?.slice(0, 160) ?? '';

/**
 * Classifies a sync event without ids. A multi-entity stop keeps its side and
 * action type but not its entity count, which only follows list lengths.
 */
const eventSignature = (event: FuzzEvent): string => {
  const stop =
    event.kind === 'stop'
      ? /^(SYNC_MULTI_ENTITY_UNSUPPORTED side=\w+ actionType=.+?) entityCount=\d+$/.exec(
          event.detail,
        )
      : null;
  return stop
    ? `stop:${stop[1]}`
    : `${event.kind}:${event.detail
        .replace(/\b[tnhb]\d+\b|fuzzDev\w|\b[BEAI]_[A-Za-z0-9]{6}\b|[0-9a-f-]{36}/g, '*')
        .slice(0, 120)}`;
};

/** Strips the path of ids, indexes and days so it can classify a failure. */
const pathSignature = (path: string): string =>
  path
    .split('.')
    .slice(0, 6)
    .map((part, i, parts) =>
      parts[i - 1] === 'entities' ||
      /^\d+$|^[tnh]\d+$|^fuzzDev|^[BEAI]_[A-Za-z0-9]{6}$|^\d{4}-\d{2}-\d{2}$/.test(part)
        ? '*'
        : part,
    )
    .join('.');

export const runFuzz = async (options: FuzzOptions): Promise<FuzzResult> => {
  const started = performance.now();
  const harness = await SyncFuzzHarness.create();
  const failures: FuzzFailure[] = [];
  const fail = (signature: string, detail: string): void => {
    if (!failures.some((f) => f.signature === signature)) {
      // Wall-clock times and days depend on when the run started; keep them out.
      failures.push({
        signature,
        detail: detail
          .replace(/\b1[5-9]\d{11}\b/g, '<time>')
          .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<day>'),
      });
    }
  };
  const entries: LedgerEntry[] = [];
  const ownClock = async (): Promise<VectorClock> =>
    (await TestBed.inject(OperationLogStoreService).getVectorClock()) ?? {};
  /** Runs the intent on the current device and records it in the ledger. */
  const executeAndNote = async (intent: Intent): Promise<FuzzWrite[] | undefined> => {
    const before = await ownClock();
    const writes = await executeIntent(harness, intent);
    if (!writes) return undefined;
    const device = harness.current!;
    entries.push({
      intent,
      writes,
      device: device.name,
      clientId: device.clientId,
      clock: await ownClock(),
      counterBefore: before[device.clientId] ?? 0,
    });
    return writes;
  };
  /** Per device, the ledger length at its last USE_REMOTE rebuild. */
  const rebuiltAt = new Map<string, number>();
  /**
   * Whether a stop has been answered with USE_LOCAL: its force upload is a
   * user's replacement, so from then on the SYNC_IMPORT dialog it opens on
   * the other devices is answered too, in every mix.
   */
  let hasUserReplacement = false;
  /**
   * Syncs `device`, answering the SYNC_IMPORT conflict dialog with
   * `importAnswer` and the whole-dataset dialog after a stop with
   * `stopAnswer`. USE_REMOTE rebuilds the device from the server's history,
   * discarding its unsynced changes, as both dialogs say: the ledger excuses
   * those intents. USE_LOCAL after a stop force-uploads
   * the device's state, a replacement like the force upload intent's: the
   * oracles excuse what it drops through `lastReplacement`.
   */
  const sync = async (
    device: FuzzDevice,
    importAnswer?: ImportDialogAnswer,
    stopAnswer?: ImportDialogAnswer,
  ): Promise<void> => {
    const before = harness.events.length;
    harness.importDialogAnswer = importAnswer;
    harness.stopDialogAnswer = stopAnswer;
    await harness.sync(device);
    harness.importDialogAnswer = undefined;
    harness.stopDialogAnswer = undefined;
    const answeredLocal = harness.events
      .slice(before)
      .some((e) => e.kind === 'stop-dialog' && e.detail === 'USE_LOCAL');
    if (answeredLocal) hasUserReplacement = true;
    // USE_REMOTE (either dialog) drops exactly the ops the device still had
    // unsynced when it answered (`useRemoteDiscards`): an intent is excused
    // only if one of its ops was among them, so a write the server
    // acknowledged and then lost is still checked. A rebuild resets the
    // device's own counter to what the server knows, so later intents can
    // reuse the counters of discarded ones: only the intents since the
    // device's previous rebuild are matched.
    const discards = harness.useRemoteDiscards;
    harness.useRemoteDiscards = undefined;
    if (!discards) return;
    for (let i = rebuiltAt.get(device.name) ?? 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.device !== device.name || entry.discarded) continue;
      const counter = entry.clock[entry.clientId] ?? 0;
      if (
        discards.some(
          (op) =>
            op.clientId === entry.clientId &&
            op.counter > entry.counterBefore &&
            op.counter <= counter,
        )
      ) {
        entry.discarded = true;
      }
    }
    rebuiltAt.set(device.name, entries.length);
  };
  const devices = new Map<string, FuzzDevice>();
  for (const name of DEVICES) devices.set(name, await harness.addDevice(name));
  const deviceOf = (name: string): FuzzDevice => devices.get(name)!;

  // Setup: A creates the shared entities, then every device joins.
  await harness.as(deviceOf('A'), async () => {
    for (const intent of SETUP_INTENTS) {
      await executeAndNote(intent);
    }
  });
  for (const name of DEVICES) await sync(deviceOf(name));

  // Only a run that can replace state answers the SYNC_IMPORT conflict
  // dialog: a generated mix with a replacement intent, a trace with one, or
  // any run once a stop was answered with USE_LOCAL. Elsewhere the dialog
  // still fails the run, so a full-state op no user intent made keeps the
  // signatures of what it drops. (A backup export alone replaces nothing.)
  const replaces = options.steps
    ? options.steps.some((s) => s.a?.[0] === 'forceUpload' || s.a?.[0] === 'importBackup')
    : (options.weights ?? []).some(([kind]) => REPLACEMENT_INTENTS.has(kind));
  const answersImports = (): boolean => replaces || hasUserReplacement;
  // Which dialogs a run answers, and with what:
  //
  //   run                         | SYNC_IMPORT dialog          | dialog after a stop
  //   ----------------------------|-----------------------------|--------------------
  //   generated, `replace` mix    | step `k`, settle R          | step `k`, settle R
  //   generated, other mixes      | after a stop answered L:    | step `k` (own
  //                               |   step `k`, settle R        |   stream), settle R
  //   replay with a replacement   | step `k`, settle R          | step `k`, settle R
  //   replay with `k` only        | after a stop answered L     | step `k`, settle R
  //   replay without either       | never (fails the run)       | never (stop stays)
  //
  // A run models the whole-dataset dialog after a stop when it is generated,
  // or replays a trace with a replacement or a dialog answer (`k`). Its steps
  // answer with `k`, and settle with the remote data. A trace without either
  // keeps its stops unanswered, as every trace did before the dialog was
  // modeled. The stop stays a failure either way (#10377); what the answer
  // drops is judged in addition.
  const modelsStopDialog = !options.steps || replaces || options.steps.some((s) => s.k);

  const executed: FuzzStep[] = [];
  const runStep = async (step: FuzzStep, intent?: Intent): Promise<void> => {
    harness.tick();
    const device = deviceOf(step.d);
    let applied: Intent | undefined;
    if (intent) {
      await harness.as(device, async () => {
        if (await executeAndNote(intent)) applied = intent;
      });
    }
    if (step.s) {
      const answer = answerOf(step.k);
      await sync(device, answersImports() ? answer : undefined, answer);
    }
    if (step.c) await harness.compact(device);
    if (step.r) await harness.restart(device);
    if (applied || step.s || step.c || step.r) {
      executed.push({
        d: step.d,
        ...(applied ? { a: applied } : {}),
        ...(step.s ? { s: 1 } : {}),
        ...(step.c ? { c: 1 } : {}),
        ...(step.r ? { r: 1 } : {}),
        ...(step.s && step.k ? { k: step.k } : {}),
      });
    }
  };

  if (options.steps) {
    for (const step of options.steps) await runStep(step, step.a);
  } else {
    const random = createRandom(options.seed ?? 1);
    // Mixes without a replacement draw `k` from their own stream and keep it
    // only in a run that answered a stop, so their other traces stay as they
    // were.
    const dialogRandom = replaces
      ? random
      : createRandom((options.seed ?? 1) ^ DIALOG_STREAM_SALT);
    let idCounter = 10;
    const nextId = (prefix: string): string => `${prefix}${++idCounter}`;
    for (let i = 0; i < (options.stepCount ?? 30); i++) {
      const name = DEVICES[Math.floor(random() * DEVICES.length)];
      const intent = await harness.as(deviceOf(name), async () => {
        const archive = await TestBed.inject(ArchiveDbAdapter).loadArchiveYoung();
        const view = viewOf(await harness.state());
        const generated = generateIntent(
          random,
          view,
          archive?.task.ids ?? [],
          `${name}${i}`,
          nextId,
          options.weights,
          [...harness.backups.keys()],
        );
        if (generated && !isUiPossible(generated, view)) {
          throw new Error(
            `SyncFuzz: the generator emitted a step the UI does not offer: ${JSON.stringify(generated)}`,
          );
        }
        return generated;
      });
      await runStep(
        {
          d: name,
          ...(random() < SYNC_PROBABILITY ? { s: 1 } : {}),
          ...(random() < COMPACT_PROBABILITY ? { c: 1 } : {}),
          ...(random() < RESTART_PROBABILITY ? { r: 1 } : {}),
          k: dialogRandom() < USE_LOCAL_PROBABILITY ? 'L' : 'R',
        },
        intent,
      );
    }
  }

  // Settle: every device syncs until a full round moves nothing. In a run
  // that can replace state, a dialog asking about an incoming replacement is
  // answered with the remote data, which ends a run of competing replacements;
  // in a run that models it, so is the dialog after a stop.
  harness.tick();
  const settleStopAnswer: ImportDialogAnswer | undefined = modelsStopDialog
    ? 'USE_REMOTE'
    : undefined;
  const settle = (device: FuzzDevice): Promise<void> =>
    sync(device, answersImports() ? 'USE_REMOTE' : undefined, settleStopAnswer);
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    const seqBefore = harness.server.latestSeq;
    let pending = 0;
    for (const name of DEVICES) {
      await settle(deviceOf(name));
      pending += await harness.pendingOpCount(deviceOf(name));
    }
    if (harness.server.latestSeq === seqBefore && pending === 0) break;
  }
  const observer = await harness.addDevice('F');
  await settle(observer);

  // A generated mix without a replacement keeps `k` only in a run that
  // answered a stop, in a step or in settle: its replay then models the dialog
  // too (`modelsStopDialog`), and every other trace stays as it was.
  if (
    !options.steps &&
    !replaces &&
    !harness.events.some((e) => e.kind === 'stop-dialog')
  ) {
    for (const step of executed) delete step.k;
  }

  const eventsBeforeRestart = harness.events.length;
  // Oracle: no stops or other sync failures.
  for (const event of harness.events) {
    if (!FAILING_EVENTS.includes(event.kind)) continue;
    fail(eventSignature(event), `step ${event.step} ${event.device}: ${event.detail}`);
  }

  // Oracle: nothing pending, no full-state op anywhere but the user's own
  // replacements.
  for (const name of DEVICES) {
    const device = deviceOf(name);
    const pending = await harness.pendingOpCount(device);
    if (pending > 0) fail('pending', `${name} has ${pending} unsynced op(s)`);
    const fullState = await harness.as(device, async () =>
      (await TestBed.inject(OperationLogStoreService).getOpsAfterSeq(0)).filter(
        (e) =>
          FULL_STATE_OP_TYPES.has(e.op.opType) &&
          USER_REPLACEMENT_REASONS[e.op.opType] !== e.op.syncImportReason,
      ),
    );
    for (const entry of fullState) fail(`full-state-op:${entry.op.opType}`, `${name}`);
  }

  // Oracle: each device lists a note in Today exactly when it is pinned.
  const reference = await harness.syncedState(observer);
  for (const name of DEVICES) {
    checkTodayNotes(name, await harness.syncedState(deviceOf(name)), fail);
  }
  checkTodayNotes('fresh', reference, fail);

  // Oracle: convergence of every device with a fresh one.
  for (const name of DEVICES) {
    const state = await harness.syncedState(deviceOf(name));
    for (const diff of diffPaths(comparable(state), comparable(reference))) {
      const path = diff.slice(1).split('.');
      fail(
        `divergence:${pathSignature(diff)}`,
        `${name} vs fresh at ${diff}: ${shortJson(valueAt(state, path))} vs ${shortJson(
          valueAt(reference, path),
        )}`,
      );
    }
  }

  const replacement = lastReplacement(harness);
  checkPreservation(
    reference,
    new Ledger(
      entries.filter(
        (entry) =>
          !entry.discarded &&
          (!replacement || isAtOrAfter(entry.clock, replacement.clock)),
      ),
    ),
    replacement,
    fail,
  );

  // Oracle: a restart (hydration from the device's own database) keeps state.
  for (const name of DEVICES) {
    const before = comparable(await harness.syncedState(deviceOf(name)));
    await harness.restart(deviceOf(name));
    const after = await harness.syncedState(deviceOf(name));
    for (const diff of diffPaths(comparable(after), before)) {
      const path = diff.slice(1).split('.');
      fail(
        `restart-changed:${pathSignature(diff)}`,
        `${name} after vs before restart at ${diff}: ${shortJson(
          valueAt(after, path),
        )} vs ${shortJson(valueAt(before, path))}`,
      );
    }
  }
  for (const event of harness.events.slice(eventsBeforeRestart)) {
    if (FAILING_EVENTS.includes(event.kind)) {
      fail(`restart-${event.kind}:${event.detail.slice(0, 80)}`, `${event.device}`);
    }
  }
  // A REPAIR or failed validation is rare and hard to replay from its
  // signature alone: its failure carries the whole run.
  const needsDump = failures.filter((f) => IS_REPAIR_SIGNATURE.test(f.signature));
  const dump =
    options.debug || needsDump.length > 0
      ? await dumpRun(harness, [...devices.values()])
      : undefined;
  for (const failure of needsDump) {
    failure.detail += ` DUMP ${dump!
      .filter((line) => !SETUP_OP_LINE.test(line))
      .join(' ¦ ')}`;
  }
  return {
    steps: executed,
    failures,
    rejections: [
      ...new Set(harness.server.rejections.map((r) => `${r.errorCode} ${r.actionType}`)),
    ].sort(),
    ms: Math.round(performance.now() - started),
    ...(options.debug ? { dump } : {}),
  };
};

/** Failures whose detail gets the run's dump: a REPAIR op or a failed validation. */
export const IS_REPAIR_SIGNATURE = /REPAIR|^(restart-)?validation:/;
/** Dump lines of device A's setup ops (clock A only, counters 1-9). */
const SETUP_OP_LINE = /\{"fuzzDevA":[1-9]\}/;

const entityOfOp = (op: {
  entityType: string;
  entityId?: string;
  entityIds?: string[];
}): string =>
  `${op.entityType}:${op.entityIds?.length ? op.entityIds.join(',') : op.entityId}`;

/** A compact picture of a run for triage: server log, rejections, op logs. */
const dumpRun = async (
  harness: SyncFuzzHarness,
  devices: FuzzDevice[],
): Promise<string[]> => {
  const lines = harness.server.rows.map(
    ({ serverSeq, op }) =>
      `srv ${serverSeq} ${op.clientId} ${op.actionType} ${entityOfOp(op)} ` +
      `${op.opType}${op.syncImportReason ? ` ${op.syncImportReason}` : ''} ` +
      `${JSON.stringify(op.vectorClock)} ts+${op.timestamp % 1_000_000}`,
  );
  lines.push(...harness.server.rejections.map((r) => `rej ${JSON.stringify(r)}`));
  lines.push(...harness.events.map((e) => `evt ${JSON.stringify(e)}`));
  for (const device of devices) {
    const validation = await harness.as(device, () =>
      TestBed.inject(ValidateStateService).validateState(
        TestBed.inject(StateSnapshotService).getStateSnapshot() as unknown as Record<
          string,
          unknown
        >,
      ),
    );
    if (!validation.isValid) {
      lines.push(
        `${device.name} INVALID ${validation.crossModelError ?? ''} ` +
          shortJson(validation.typiaErrors).slice(0, 400),
      );
    }
    const entries = await harness.as(device, () =>
      TestBed.inject(OperationLogStoreService).getOpsAfterSeq(0),
    );
    for (const { seq, op, source, syncedAt, rejectedAt } of entries) {
      // A full-state payload is the whole state; a REPAIR's summary says what
      // validation found and repaired.
      const payload =
        op.opType === 'REPAIR'
          ? `repairSummary=${JSON.stringify(
              (op.payload as { repairSummary?: unknown } | null)?.repairSummary,
            )?.slice(0, 600)}`
          : shortJson(op.payload);
      lines.push(
        `${device.name} ${seq} ${source} ${op.clientId} ${op.actionType} ${entityOfOp(op)} ` +
          `${rejectedAt ? 'REJECTED' : syncedAt ? 'synced' : 'PENDING'} ` +
          `${JSON.stringify(op.vectorClock)} ${payload}`,
      );
    }
  }
  return lines;
};

interface EntityMap<T> {
  ids: string[];
  entities: Record<string, T | undefined>;
}

/** The slices the preservation oracles read. */
interface CheckedState {
  task: EntityMap<Task>;
  project: EntityMap<Project>;
  note: EntityMap<Note> & { todayOrder: string[] };
  simpleCounter: EntityMap<SimpleCounter>;
  archiveYoung: { task: EntityMap<Task> };
}

/**
 * The Today notes panel renders `note.todayOrder` unfiltered, and the pin
 * toggle reads `isPinnedToToday`, so they must agree on every device. The
 * convergence oracle misses a gap that all devices share.
 */
const checkTodayNotes = (
  device: string,
  snapshot: AppStateSnapshot,
  fail: (signature: string, detail: string) => void,
): void => {
  const { note } = snapshot as unknown as CheckedState;
  const listed = new Set(note.todayOrder);
  for (const id of note.ids) {
    const isPinned = !!note.entities[id]?.isPinnedToToday;
    if (isPinned !== listed.has(id)) {
      fail(
        `today-notes:${isPinned ? 'pinned-not-listed' : 'listed-not-pinned'}`,
        `${device}: ${id} isPinnedToToday=${isPinned}, todayOrder=${shortJson(note.todayOrder)}`,
      );
    }
  }
  for (const id of listed) {
    if (!note.entities[id]) {
      fail('today-notes:listed-missing', `${device}: ${id} is not a note`);
    }
  }
};

const checkPreservation = (
  snapshot: AppStateSnapshot,
  ledger: Ledger,
  replacement: Replacement | undefined,
  fail: (signature: string, detail: string) => void,
): void => {
  const state = snapshot as unknown as CheckedState;
  const tasks = state.task.entities;
  const archived = state.archiveYoung.task.entities;
  const entityOf = (entity: string): Record<string, unknown> | undefined => {
    const [type, id] = entity.split(':');
    const found =
      type === 'task'
        ? (tasks[id] ?? archived[id])
        : type === 'note'
          ? state.note.entities[id]
          : state.simpleCounter.entities[id];
    return found as Record<string, unknown> | undefined;
  };

  for (const entity of new Set([...ledger.created, ...(replacement?.entities ?? [])])) {
    if (!ledger.deleted.has(entity) && !entityOf(entity)) {
      fail(`lost-entity:${entity.split(':')[0]}`, `${entity} was never deleted`);
    }
  }

  const day = fuzzDay();
  const trackedTasks = new Set([
    ...ledger.tracked.keys(),
    ...(replacement?.time.keys() ?? []),
  ]);
  for (const entity of trackedTasks) {
    if (ledger.deleted.has(entity) || ledger.archivedEver.has(entity)) continue;
    const expected =
      (replacement?.time.get(entity) ?? 0) + (ledger.tracked.get(entity) ?? 0);
    if (!ledger.tracked.has(entity) && expected === 0) continue;
    const task = entityOf(entity) as Task | undefined;
    const actual = task?.timeSpentOnDay?.[day] ?? 0;
    if (actual !== expected) {
      fail('time-loss:task', `${entity}: tracked ${expected}, converged ${actual}`);
    }
  }

  for (const [key, values] of ledger.writes) {
    const [entity, field] = key.split('|');
    if (ledger.deleted.has(entity) || ledger.archivedEver.has(entity)) continue;
    const current = entityOf(entity);
    if (!current) continue;
    const actual = valueAt(current, field.split('.'));
    const type = entity.split(':')[0];
    const fieldName = field.split('.')[0];
    if (values.length === 1 && !Object.is(actual, values[0])) {
      fail(
        `field-reverted:${type}.${fieldName}`,
        `${entity}.${field}: only write ${shortJson(values[0])}, converged ${shortJson(actual)}`,
      );
    } else if (!values.some((v) => Object.is(v, actual))) {
      fail(
        `field-unwritten:${type}.${fieldName}`,
        `${entity}.${field}: writes ${shortJson(values)}, converged ${shortJson(actual)}`,
      );
    }
  }

  const lists: [string, unknown][] = [
    ['note.todayOrder', state.note.todayOrder],
    ['project.noteIds', state.project.entities['INBOX_PROJECT']?.noteIds],
    ['project.taskIds', state.project.entities['INBOX_PROJECT']?.taskIds],
    ['simpleCounter.ids', state.simpleCounter.ids],
  ];
  for (const [name, list] of lists) {
    if (Array.isArray(list) && new Set(list).size !== list.length) {
      fail(`duplicate:${name}`, shortJson(list));
    }
  }
};
