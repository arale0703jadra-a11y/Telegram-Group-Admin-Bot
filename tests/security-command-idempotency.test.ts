import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANUAL_ACTION_IDEMPOTENCY_WINDOW_MS,
  PANEL_INTENT_IDEMPOTENCY_WINDOW_MS,
  buildManualSecurityActionIdempotencyKey,
  buildProtectedUserUpdateIdempotencyKey,
  buildSecurityCommandOperationKey,
  buildSecurityConfigIdempotencyKey,
  enqueueManualSecurityAction,
  updateProtectedUser,
  updateSecurityConfig,
} from "../src/services/security-commands.js";

/**
 * Fase 5: las claves de intención deben ser deterministas para solicitudes
 * equivalentes y distintas para intenciones distintas. El cliente falso sólo
 * existe para comprobar que los encoladores reales entregan una clave; la
 * unicidad definitiva la impone el índice `security_commands_operation_key_idx`.
 */

type Row = Record<string, unknown>;
const GROUP_ID = -1001234567890;

interface FakeDb {
  bots: Row[];
  groups: Row[];
  bindings: Row[];
  commands: Row[];
  nextId: number;
}

function project(row: Row, columns: string): Row {
  if (columns.trim() === "*") return { ...row };
  const keys = columns.split(",").map((column) => column.trim()).filter(Boolean);
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function uniqueKeyOf(row: Row): string | null {
  const operationKey = row.operation_key;
  if (typeof operationKey !== "string" || operationKey.length === 0) return null;
  return `${row.group_id}|${row.action}|${operationKey}`;
}

function createFakeClient(db: FakeDb): SupabaseClient {
  const from = (table: string) => {
    const rows = (): Row[] => {
      if (table === "bots") return db.bots;
      if (table === "groups") return db.groups;
      if (table === "group_bot_bindings") return db.bindings;
      if (table === "security_commands") return db.commands;
      throw new Error(`Unexpected table in test fake: ${table}`);
    };
    let mode: "select" | "insert" | "upsert" = "select";
    let values: Row | null = null;
    let columns = "*";
    const filters: Array<[string, unknown]> = [];
    const matching = () =>
      rows().filter((row) => filters.every(([column, value]) => row[column] === value));

    const execute = async () => {
      if (mode === "insert" && values) {
        const row: Row = {
          id: `command-${++db.nextId}`,
          status: "pending",
          result_state: "queued",
          attempts: 0,
          last_error: null,
          execution_started_at: null,
          created_at: new Date(0).toISOString(),
          ...values,
        };
        const key = uniqueKeyOf(row);
        if (key && db.commands.some((existing) => uniqueKeyOf(existing) === key)) {
          return {
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "security_commands_operation_key_idx"',
            },
          };
        }
        db.commands.push(row);
        return { data: project(row, columns), error: null };
      }
      if (mode === "upsert" && values) {
        const conflictKeys = Object.keys(values);
        const existing = rows().find((row) =>
          conflictKeys.every((key) => row[key] === values?.[key]),
        );
        if (existing) Object.assign(existing, values);
        else rows().push({ ...values });
        return { data: null, error: null };
      }
      return { data: matching().map((row) => project(row, columns)), error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select(next = "*") {
        columns = next;
        return api;
      },
      insert(next: Row) {
        mode = "insert";
        values = next;
        return api;
      },
      upsert(next: Row) {
        mode = "upsert";
        values = next;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return api;
      },
      async maybeSingle() {
        const found = matching();
        return {
          data: found[0] ? project(found[0], columns) : null,
          error: null,
        };
      },
      async single() {
        return execute();
      },
      async then(resolve: (value: unknown) => unknown) {
        return resolve(await execute());
      },
    };

    return api;
  };

  return { from } as unknown as SupabaseClient;
}

function createDb(): FakeDb {
  return {
    bots: [{ id: "bot-cerbero", name: "Cerbero", type: "security" }],
    groups: [],
    bindings: [],
    commands: [],
    nextId: 0,
  };
}

test("equivalent manual actions produce the same idempotency key", () => {
  const first = buildManualSecurityActionIdempotencyKey(
    {
      groupId: GROUP_ID,
      userId: 42,
      action: "BAN_USER",
      payload: { reason: "spam", duration_minutes: 30, requester_name: "Admin" },
    },
    { now: () => 1_000, windowMs: 10_000 },
  );
  const second = buildManualSecurityActionIdempotencyKey(
    {
      groupId: GROUP_ID,
      userId: 42,
      action: "BAN_USER",
      payload: { duration_minutes: 30, reason: "spam", requester_name: "Otro" },
    },
    { now: () => 1_500, windowMs: 10_000 },
  );

  assert.equal(first, second);
  assert.match(first, /^manual_security_action:0:/);
});

test("different intents produce different idempotency keys", () => {
  const base = {
    groupId: GROUP_ID,
    userId: 42,
    action: "BAN_USER" as const,
    payload: { reason: "spam" },
  };
  const options = { now: () => 1_000, windowMs: 10_000 };
  const reference = buildManualSecurityActionIdempotencyKey(base, options);

  assert.notEqual(
    reference,
    buildManualSecurityActionIdempotencyKey({ ...base, userId: 43 }, options),
  );
  assert.notEqual(
    reference,
    buildManualSecurityActionIdempotencyKey({ ...base, action: "MUTE_USER" }, options),
  );
  assert.notEqual(
    reference,
    buildManualSecurityActionIdempotencyKey(
      { ...base, payload: { reason: "spam-2" } },
      options,
    ),
  );
  assert.notEqual(
    reference,
    buildManualSecurityActionIdempotencyKey(
      { ...base, targetMessageId: 7 },
      options,
    ),
  );
});

test("the deduplication window prevents a permanent collision", () => {
  const input = {
    groupId: GROUP_ID,
    userId: 42,
    action: "MUTE_USER" as const,
    payload: { duration_minutes: 30 },
  };
  const options = { windowMs: MANUAL_ACTION_IDEMPOTENCY_WINDOW_MS };
  const first = buildManualSecurityActionIdempotencyKey(input, {
    ...options,
    now: () => 1_000,
  });
  const nextWindow = buildManualSecurityActionIdempotencyKey(input, {
    ...options,
    now: () => 1_000 + MANUAL_ACTION_IDEMPOTENCY_WINDOW_MS,
  });

  assert.notEqual(first, nextWindow);
});

test("configuration updates deduplicate only their logical changes", () => {
  const options = { now: () => 5_000, windowMs: PANEL_INTENT_IDEMPOTENCY_WINDOW_MS };
  const first = buildSecurityConfigIdempotencyKey(
    GROUP_ID,
    { anti_links: false, media_limit: 8 },
    options,
  );
  const reordered = buildSecurityConfigIdempotencyKey(
    GROUP_ID,
    { media_limit: 8, anti_links: false },
    options,
  );
  const differentValue = buildSecurityConfigIdempotencyKey(
    GROUP_ID,
    { anti_links: true, media_limit: 8 },
    options,
  );
  const differentGroup = buildSecurityConfigIdempotencyKey(
    -100999,
    { anti_links: false, media_limit: 8 },
    options,
  );

  assert.equal(first, reordered);
  assert.notEqual(first, differentValue);
  assert.notEqual(first, differentGroup);
});

test("protected-user updates distinguish enable from disable", () => {
  const options = { now: () => 5_000 };
  const enable = buildProtectedUserUpdateIdempotencyKey(
    { groupId: GROUP_ID, userId: 42, enabled: true },
    options,
  );
  const enableAgain = buildProtectedUserUpdateIdempotencyKey(
    { groupId: GROUP_ID, userId: 42, enabled: true },
    options,
  );
  const disable = buildProtectedUserUpdateIdempotencyKey(
    { groupId: GROUP_ID, userId: 42, enabled: false },
    options,
  );

  assert.equal(enable, enableAgain);
  assert.notEqual(enable, disable);
});

test("cosmetic payload fields do not change the operation key", () => {
  const base = {
    groupId: GROUP_ID,
    action: "UPDATE_PROTECTED_USER" as const,
    targetUserId: 42,
    idempotencyKey: "panel-intent",
  };
  const first = buildSecurityCommandOperationKey({
    ...base,
    payload: { enabled: true, username: "ayer" },
  });
  const second = buildSecurityCommandOperationKey({
    ...base,
    payload: { enabled: true, username: "hoy", requester_name: "Admin" },
  });

  assert.equal(first, second);
});

test("manual actions reach the queue with a deterministic operation key", async () => {
  const db = createDb();
  const client = createFakeClient(db);
  const options = { client, now: () => 1_000 };

  await enqueueManualSecurityAction(
    GROUP_ID,
    42,
    "MUTE_USER",
    { duration_minutes: 30, reason: "spam" },
    options,
  );
  const [first] = db.commands;
  assert.equal(typeof first.operation_key, "string");
  assert.equal(first.target_user_id, 42);

  // Segundo clic equivalente dentro de la ventana: se deduplica.
  await enqueueManualSecurityAction(
    GROUP_ID,
    42,
    "MUTE_USER",
    { duration_minutes: 30, reason: "spam" },
    options,
  );
  assert.equal(db.commands.length, 1);

  // Fuera de la ventana: es una intención nueva.
  await enqueueManualSecurityAction(
    GROUP_ID,
    42,
    "MUTE_USER",
    { duration_minutes: 30, reason: "spam" },
    { client, now: () => 1_000 + MANUAL_ACTION_IDEMPOTENCY_WINDOW_MS },
  );
  assert.equal(db.commands.length, 2);
  assert.notEqual(db.commands[0].operation_key, db.commands[1].operation_key);
});

test("configuration and protected-user updates reach the queue with an operation key", async () => {
  const db = createDb();
  const client = createFakeClient(db);
  const options = { client, now: () => 2_000 };

  await updateSecurityConfig(GROUP_ID, { anti_links: false }, undefined, options);
  await updateProtectedUser(GROUP_ID, 42, true, "usuario", options);

  assert.equal(db.commands.length, 2);
  assert.equal(db.commands[0].action, "UPDATE_SECURITY_CONFIG");
  assert.equal(db.commands[1].action, "UPDATE_PROTECTED_USER");
  for (const command of db.commands) {
    assert.equal(typeof command.operation_key, "string");
    assert.equal((command.operation_key as string).length, 64);
  }
});
