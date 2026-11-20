import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STALE_PROCESSING_RECONCILED_ERROR,
  isRetrySafeSecurityAction,
  isStaleProcessingRow,
  listStaleSecurityCommands,
  reconcileStaleSecurityCommands,
  requeueSecurityCommand,
  type SecurityCommandRow,
} from "../src/services/security-commands.js";
import {
  MAX_SECURITY_COMMAND_RETRY_DEPTH,
  MUTE_MIN_REMAINING_MS,
  SECURITY_COMMAND_RETRY_SUFFIX,
  classifySecurityCommandEvidence,
  evaluateSecurityCommandReplayPolicy,
} from "../src/services/security-command-recovery.js";
import type { GroupMembership } from "../src/security/group-authority.js";

/**
 * Pruebas de CABLEADO y de la política pura de ZEUS.
 *
 * Este archivo no demuestra ninguna garantía de PostgreSQL: la atomicidad real
 * (bloqueo de fila, índice único, carrera con `claim_security_command`) sólo se
 * valida contra un PostgreSQL real en
 * `tests/security-command-requeue-postgres.test.ts`. Aquí se comprueba que ZEUS
 * aplica las reglas correctas antes de invocar la RPC y que interpreta bien sus
 * resultados.
 */

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const EXPIRED_LEASE = "2026-01-01T00:09:00.000Z";
const VALID_LEASE = "2026-01-01T00:11:00.000Z";
const GROUP_ID = -1001234567890;
const OTHER_GROUP_ID = -1009999999999;
const ACTOR_ID = 5550001;
const COMMAND_ID = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

interface FakeError {
  code?: string;
  message: string;
}

const CREATOR: GroupMembership = { status: "creator" };
const RESTRICTING_ADMIN: GroupMembership = {
  status: "administrator",
  permissions: { can_restrict_members: true, can_change_info: true },
};
const READ_ONLY_ADMIN: GroupMembership = {
  status: "administrator",
  permissions: { can_restrict_members: false, can_change_info: false },
};
const MEMBER: GroupMembership = { status: "member" };

interface RpcResult {
  outcome: string;
  [key: string]: unknown;
}

interface FakeState {
  rows: Row[];
  inserted: number;
  rpcCalls: Array<Record<string, unknown>>;
  rpcResult?: RpcResult;
  rpcError?: FakeError;
  beforeRpc?: () => Promise<void>;
}

function project(row: Row, columns: string): Row {
  if (columns.trim() === "*") return { ...row };
  const keys = columns
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function createFakeClient(state: FakeState): SupabaseClient {
  const from = (table: string) => {
    if (table !== "security_commands") {
      throw new Error(`Unexpected table in test fake: ${table}`);
    }
    let columns = "*";
    const filters: Array<[string, unknown]> = [];

    const matching = () =>
      state.rows.filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select(next = "*") {
        columns = next;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return api;
      },
      async maybeSingle() {
        const found = matching();
        if (found.length > 1) {
          return {
            data: null,
            error: { code: "PGRST116", message: "multiple rows" } as FakeError,
          };
        }
        return {
          data: found[0] ? project(found[0], columns) : null,
          error: null,
        };
      },
    };

    return api;
  };

  /**
   * Emulación mínima del contrato de `zeus_requeue_security_command`.
   *
   * Sólo reproduce la parte observable por ZEUS (neutralizar + insertar +
   * detectar la copia existente) para probar el mapeo de resultados. NO
   * reproduce bloqueos, transacciones ni el índice único.
   */
  const rpc = async (name: string, args: Record<string, unknown>) => {
    assert.equal(name, "zeus_requeue_security_command");
    state.rpcCalls.push(args);
    if (state.rpcError) return { data: null, error: state.rpcError };
    if (state.beforeRpc) await state.beforeRpc();
    if (state.rpcResult) return { data: [state.rpcResult], error: null };

    const row = state.rows.find(
      (candidate) =>
        candidate.id === args.p_command_id &&
        candidate.group_id === args.p_group_id,
    );
    if (!row) {
      return {
        data: [
          {
            outcome: "not_found",
            original_command_id: null,
            retry_command_id: null,
            original_status: null,
            original_result_state: null,
            original_execution_started_at: null,
            original_attempts: null,
            retry_operation_key: null,
            detail: null,
          } satisfies RpcResult,
        ],
        error: null,
      };
    }

    const retryKey = `${String(row.operation_key ?? "")}${SECURITY_COMMAND_RETRY_SUFFIX}`;
    const existing = state.rows.find(
      (candidate) =>
        candidate.group_id === row.group_id &&
        candidate.action === row.action &&
        candidate.operation_key === retryKey,
    );
    if (existing) {
      return {
        data: [
          {
            outcome: "already_retried",
            original_command_id: row.id,
            retry_command_id: existing.id,
            original_status: row.status,
            original_result_state: row.result_state,
            original_execution_started_at: null,
            original_attempts: row.attempts,
            retry_operation_key: null,
            detail: String(existing.id),
          } satisfies RpcResult,
        ],
        error: null,
      };
    }

    row.result_state = "unknown";
    row.processing_instance_id = null;
    row.processing_token = null;
    row.processing_at = null;
    row.lease_expires_at = null;

    const retryId = `33333333-3333-4333-8333-${String(++state.inserted).padStart(12, "0")}`;
    state.rows.push({
      ...row,
      id: retryId,
      status: "pending",
      result_state: "queued",
      created_at: new Date(NOW).toISOString(),
      executed_at: null,
      processing_instance_id: null,
      processing_token: null,
      lease_expires_at: null,
      processing_at: null,
      execution_started_at: null,
      attempts: 0,
      last_error: null,
      responsible_bot: null,
      cancelled_at: null,
      operation_key: retryKey,
    });

    return {
      data: [
        {
          outcome: "requeued",
          original_command_id: row.id,
          retry_command_id: retryId,
          original_status: "processing",
          original_result_state: "processing",
          original_execution_started_at: null,
          original_attempts: row.attempts,
          retry_operation_key: retryKey,
          detail: retryId,
        } satisfies RpcResult,
      ],
      error: null,
    };
  };

  return { from, rpc } as unknown as SupabaseClient;
}

/**
 * Cliente m�nimo para `reconcileStaleSecurityCommands`: soporta select con
 * filtros y update masivo. Ignora `.or()` (la staleness ya se filtra en ZEUS),
 * por lo que esta prueba valida la pol�tica de reconciliaci�n, no el SQL.
 */
function createReconcileClient(
  rows: Row[],
  hooks: { afterSelect?: () => void } = {},
): SupabaseClient {
  const from = (table: string) => {
    if (table !== "security_commands") {
      throw new Error(`Unexpected table in test fake: ${table}`);
    }
    let mode: "select" | "update" = "select";
    let values: Row = {};
    let columns = "*";
    let orderBy: { column: string; ascending: boolean } | null = null;
    let maxRows: number | null = null;
    const filters: Array<[string, unknown]> = [];
    const matching = () =>
      rows.filter((row) => filters.every(([column, value]) => row[column] === value));
    // Emula filtrar -> ordenar -> recortar, como el SQL real. Sin esto la prueba
    // de E1 (cabeza de linea) no seria significativa: el .limit(100) se ignora
    // y cualquier orden de lectura pasaria la asercion.
    const applyOrder = (found: Row[]) => {
      if (!orderBy) return found;
      const { column, ascending } = orderBy;
      return [...found].sort((left, right) => {
        const a = String(left[column] ?? "");
        const b = String(right[column] ?? "");
        return ascending ? a.localeCompare(b) : b.localeCompare(a);
      });
    };

    const execute = async () => {
      if (mode === "update") {
        const found = matching();
        for (const row of found) Object.assign(row, values);
        return { data: found.map((row) => project(row, columns)), error: null };
      }
      const ordered = applyOrder(matching());
      const data = (maxRows === null ? ordered : ordered.slice(0, maxRows)).map((row) =>
        project(row, columns),
      );
      // Simula un cambio concurrente (p. ej. CERBERO marcando el inicio) entre
      // la lectura y la escritura posterior.
      hooks.afterSelect?.();
      return { data, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select(next = "*") {
        columns = next;
        return api;
      },
      update(next: Row) {
        mode = "update";
        values = next;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return api;
      },
      or() {
        return api;
      },
      is(column: string, value: unknown) {
        filters.push([column, value]);
        return api;
      },
      order(column: string, options: { ascending?: boolean } = {}) {
        orderBy = { column, ascending: options.ascending !== false };
        return api;
      },
      limit(count: number) {
        maxRows = count;
        return api;
      },
      async then(resolve: (value: unknown) => unknown) {
        return resolve(await execute());
      },
    };

    return api;
  };

  return { from } as unknown as SupabaseClient;
}

function makeState(...rows: Row[]): FakeState {
  return { rows, inserted: 0, rpcCalls: [] };
}

function staleCommand(overrides: Partial<SecurityCommandRow> = {}): Row {
  return {
    id: COMMAND_ID,
    group_id: GROUP_ID,
    action: "BAN_USER",
    target_user_id: 4242,
    target_message_id: 7,
    payload: {
      requester_id: 99,
      requester_name: "Admin",
      reason: "spam",
    },
    status: "processing",
    created_at: "2026-01-01T00:00:00.000Z",
    executed_at: null,
    processing_instance_id: "cerbero-primary",
    processing_token: "3f1f0000-0000-4000-8000-000000000000",
    lease_expires_at: EXPIRED_LEASE,
    processing_at: "2026-01-01T00:08:30.000Z",
    execution_started_at: null,
    attempts: 1,
    last_error: null,
    responsible_bot: "Cerbero",
    cancelled_at: null,
    operation_key: "op-key-1",
    result_state: "processing",
    ...overrides,
  } as Row;
}

function options(
  state: FakeState,
  overrides: Record<string, unknown> = {},
): Parameters<typeof requeueSecurityCommand>[1] {
  return {
    groupId: GROUP_ID,
    actorId: ACTOR_ID,
    reason: "revisión manual del operador",
    acknowledgeLaterHumanDecisions: true,
    groupMembership: CREATOR,
    isPanelUser: async () => true,
    client: createFakeClient(state),
    now: () => NOW,
    ...overrides,
  } as Parameters<typeof requeueSecurityCommand>[1];
}

test("an unknown order id is reported as not_found and writes nothing", async () => {
  const state = makeState();
  const client = createFakeClient(state);

  assert.deepEqual(
    await requeueSecurityCommand("99999999-9999-4999-8999-999999999999", {
      ...options(state),
      client,
    }),
    { ok: false, reason: "not_found" },
  );
  assert.equal(state.rows.length, 0);
  assert.deepEqual(state.rpcCalls, []);
});

test("malformed identifiers are refused before touching the database", async () => {
  const state = makeState(staleCommand());
  const client = createFakeClient(state);

  for (const commandId of ["", "   ", "cmd-original", "not-a-uuid"]) {
    assert.deepEqual(
      await requeueSecurityCommand(commandId, { ...options(state), client }),
      { ok: false, reason: "invalid_request" },
    );
  }
  assert.deepEqual(
    await requeueSecurityCommand(COMMAND_ID, {
      ...options(state),
      client,
      groupId: 0,
    }),
    { ok: false, reason: "invalid_request" },
  );
  assert.deepEqual(state.rpcCalls, []);
  assert.equal(state.rows[0].result_state, "processing");
});

test("orders that are not processing are refused", async () => {
  for (const status of ["completed", "failed", "cancelled", "pending"] as const) {
    const state = makeState(
      staleCommand({
        status,
        result_state: status === "pending" ? "queued" : status,
      }),
    );
    const result = await requeueSecurityCommand(COMMAND_ID, options(state));
    assert.deepEqual(result, {
      ok: false,
      reason: "not_processing",
      detail: status,
    });
    assert.equal(state.rows.length, 1);
    assert.deepEqual(state.rpcCalls, []);
  }
});

test("orders whose lease is still valid are refused", async () => {
  const state = makeState(staleCommand({ lease_expires_at: VALID_LEASE }));
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, { ok: false, reason: "not_stale" });
  assert.equal(state.rows.length, 1);
});

test("an expired lease creates one new pending order and neutralizes the original", async () => {
  const original = staleCommand();
  const state = makeState(original);
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.retriedFrom : "", COMMAND_ID);
  assert.equal(state.rows.length, 2);

  const retry = state.rows[1];
  assert.equal(retry.status, "pending");
  assert.equal(retry.result_state, "queued");
  assert.equal(retry.group_id, GROUP_ID);
  assert.equal(retry.action, "BAN_USER");
  assert.equal(retry.target_user_id, 4242);
  assert.equal(retry.target_message_id, 7);
  assert.equal(retry.operation_key, "op-key-1#retry");
  assert.deepEqual(retry.payload, original.payload);
  assert.equal(retry.attempts, 0);
  assert.equal(retry.processing_instance_id, null);
  assert.equal(retry.processing_token, null);
  assert.equal(retry.lease_expires_at, null);
  assert.equal(retry.processing_at, null);
  assert.equal(retry.responsible_bot, null);
  assert.equal(retry.last_error, null);
  assert.equal(retry.execution_started_at, null);
});

test("the original order is neutralized so CERBERO can no longer claim it", async () => {
  const state = makeState(staleCommand());
  await requeueSecurityCommand(COMMAND_ID, options(state));

  const original = state.rows[0];
  // Mismo estado que produce la recuperación de CERBERO 011 cuando no puede
  // demostrar que la ejecución no comenzó: result_state='unknown' y sin lease.
  assert.equal(original.result_state, "unknown");
  assert.equal(original.processing_instance_id, null);
  assert.equal(original.processing_token, null);
  assert.equal(original.processing_at, null);
  assert.equal(original.lease_expires_at, null);
  // claim_security_command exige result_state='processing': ya no la reclama.
  assert.notEqual(original.result_state, "processing");
  // mark_command_execution_started exige token/instancia: devolverá false.
  assert.equal(original.processing_token, null);
});

test("non-idempotent actions are refused instead of replayed", async () => {
  for (const action of [
    "WARN_USER",
    "UNWARN_USER",
    "UNWARN_ALL",
    "DELETE_MESSAGE",
    "CLEAN_MESSAGES",
  ] as const) {
    const state = makeState(staleCommand({ action }));
    const result = await requeueSecurityCommand(COMMAND_ID, options(state));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : "", "not_retryable");
    assert.equal(result.ok === false ? result.detail : "", action);
    assert.equal(state.rows.length, 1);
    assert.deepEqual(state.rpcCalls, []);
  }
});


test("the retry allow-list excludes KICK_USER and keeps only replayable actions", async () => {
  for (const action of [
    "MUTE_USER",
    "UNMUTE_USER",
    "BAN_USER",
    "UNBAN_USER",
    "UPDATE_SECURITY_CONFIG",
    "UPDATE_PROTECTED_USER",
  ] as const) {
    assert.equal(isRetrySafeSecurityAction(action), true, action);
  }

  // KICK_USER = ban + unban(only_if_banned): una repetición puede desbanear a
  // un usuario baneado después por una persona.
  for (const action of [
    "KICK_USER",
    "WARN_USER",
    "UNWARN_USER",
    "UNWARN_ALL",
    "DELETE_MESSAGE",
    "CLEAN_MESSAGES",
  ] as const) {
    assert.equal(isRetrySafeSecurityAction(action), false, action);
  }

  const kick = makeState(staleCommand({ action: "KICK_USER" }));
  const result = await requeueSecurityCommand(COMMAND_ID, options(kick));
  assert.deepEqual(result, {
    ok: false,
    reason: "not_retryable",
    detail: "KICK_USER",
  });
  assert.deepEqual(kick.rpcCalls, []);
});

test("orders without an operation key cannot be deduplicated and are refused", async () => {
  const state = makeState(staleCommand({ operation_key: null }));
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, { ok: false, reason: "missing_operation_key" });
  assert.equal(state.rows.length, 1);
});

test("a second requeue of the same order is reported as already_retried", async () => {
  const state = makeState(staleCommand());
  const client = createFakeClient(state);
  const shared = { ...options(state), client };

  const first = await requeueSecurityCommand(COMMAND_ID, shared);
  const second = await requeueSecurityCommand(COMMAND_ID, shared);

  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("the first requeue must succeed");
  assert.deepEqual(second, {
    ok: false,
    reason: "already_retried",
    detail: first.commandId,
  });
  assert.equal(state.rows.length, 2);
  assert.equal(
    state.rows.filter((row) => row.operation_key === "op-key-1#retry").length,
    1,
  );
});

test("two operators racing produce exactly one retry (wiring emulation)", async () => {
  const state = makeState(staleCommand());
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Ambos pasan la política antes de que ninguna RPC escriba.
  state.beforeRpc = () => gate;
  const operatorA = createFakeClient(state);
  const operatorB = createFakeClient(state);

  const pending = Promise.all([
    requeueSecurityCommand(COMMAND_ID, { ...options(state), client: operatorA }),
    requeueSecurityCommand(COMMAND_ID, { ...options(state), client: operatorB }),
  ]);
  release();
  const [first, second] = await pending;

  const winner = first.ok ? first : second;
  const loser = first.ok ? second : first;
  if (!winner.ok || loser.ok) {
    throw new Error("a racing requeue must produce exactly one winner");
  }
  assert.equal(loser.reason, "already_retried");
  assert.equal(loser.detail, winner.commandId);
  assert.equal(state.rows.length, 2);
  // La serialización real vive en el FOR UPDATE de la migración 021 y se prueba
  // contra PostgreSQL en el archivo de integración.
});

test("stale detection honours the lease and the grace window", () => {
  const processing = (lease: string | null, startedAt: string | null) => ({
    status: "processing" as const,
    lease_expires_at: lease,
    processing_at: startedAt,
  });

  assert.equal(isStaleProcessingRow(processing(VALID_LEASE, null), NOW), false);
  assert.equal(isStaleProcessingRow(processing(EXPIRED_LEASE, null), NOW), true);
  assert.equal(
    isStaleProcessingRow(
      processing(null, new Date(NOW - 60_000).toISOString()),
      NOW,
    ),
    false,
  );
  assert.equal(
    isStaleProcessingRow(
      processing(null, new Date(NOW - 6 * 60_000).toISOString()),
      NOW,
    ),
    true,
  );
  assert.equal(isStaleProcessingRow(processing(null, null), NOW), false);
  assert.equal(
    isStaleProcessingRow(
      {
        status: "completed",
        lease_expires_at: EXPIRED_LEASE,
        processing_at: null,
      },
      NOW,
    ),
    false,
  );
});

test("retry chains are capped so a crash loop cannot replay forever", async () => {
  const keyAtCap = `op-key-1${"#retry".repeat(MAX_SECURITY_COMMAND_RETRY_DEPTH)}`;
  const capped = makeState(staleCommand({ operation_key: keyAtCap }));
  const refused = await requeueSecurityCommand(COMMAND_ID, options(capped));
  assert.deepEqual(refused, {
    ok: false,
    reason: "retry_limit_reached",
    detail: keyAtCap,
    requiresHumanReview: true,
  });
  assert.equal(capped.rows.length, 1);

  const belowCap = `op-key-1${"#retry".repeat(MAX_SECURITY_COMMAND_RETRY_DEPTH - 1)}`;
  const allowed = makeState(staleCommand({ operation_key: belowCap }));
  const retried = await requeueSecurityCommand(COMMAND_ID, options(allowed));
  assert.equal(retried.ok, true);
  assert.equal(allowed.rows[1].operation_key, `${belowCap}#retry`);
});

test("unexpected database errors are not reported as a successful retry", async () => {
  const state = makeState(staleCommand());
  state.rpcError = {
    code: "42501",
    message: "permission denied for function zeus_requeue_security_command",
  };

  const failure = await requeueSecurityCommand(COMMAND_ID, options(state)).then(
    () => null,
    (error: unknown) => error as FakeError,
  );

  assert.equal(failure?.code, "42501");
  assert.equal(state.rows.length, 1);
});


test("an order with execution evidence is never requeued, even with confirmation", async () => {
  const state = makeState(
    staleCommand({ execution_started_at: "2026-01-01T00:09:10.000Z" }),
  );
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, {
    ok: false,
    reason: "execution_may_have_started",
    detail: "2026-01-01T00:09:10.000Z",
    requiresHumanReview: true,
  });
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.rpcCalls, []);
});

test("evidence wins over a still-valid lease: the order is reported for human review", () => {
  const decision = evaluateSecurityCommandReplayPolicy({
    action: "BAN_USER",
    payload: {},
    status: "processing",
    resultState: "processing",
    executionStartedAt: "2026-01-01T00:09:10.000Z",
    leaseExpiresAt: VALID_LEASE,
    processingAt: null,
    attempts: 1,
    operationKey: "op-key-1",
    acknowledged: true,
    now: NOW,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "execution_may_have_started");
  assert.equal(decision.requiresHumanReview, true);
});

test("a reconciled order with unknown outcome requires explicit confirmation", async () => {
  const withoutAck = makeState(
    staleCommand({
      result_state: "unknown",
      lease_expires_at: null,
      processing_at: null,
    }),
  );
  const refused = await requeueSecurityCommand(
    COMMAND_ID,
    options(withoutAck, { acknowledgeLaterHumanDecisions: false }),
  );
  // C9: `unknown` sin confirmación usa el mismo motivo que la RPC 021
  // (`confirmation_required`). Sigue siendo un rechazo: no se escribe nada.
  assert.deepEqual(refused, {
    ok: false,
    reason: "confirmation_required",
    detail:
      "BAN_USER: result_state=unknown (resultado no confirmado) y la repetición puede revertir decisiones humanas posteriores",
    requiresHumanReview: true,
  });
  assert.deepEqual(withoutAck.rpcCalls, []);

  const withAck = makeState(
    staleCommand({
      result_state: "unknown",
      lease_expires_at: null,
      processing_at: null,
    }),
  );
  const allowed = await requeueSecurityCommand(COMMAND_ID, options(withAck));
  assert.equal(allowed.ok, true);
});

test("a reconciled order with execution evidence is refused outright", async () => {
  const state = makeState(
    staleCommand({
      result_state: "unknown",
      lease_expires_at: null,
      processing_at: null,
      execution_started_at: "2026-01-01T00:09:10.000Z",
    }),
  );
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "execution_may_have_started");
  assert.equal(result.ok === false ? result.requiresHumanReview : false, true);
});

test("replaying a state change requires explicit acknowledgement", async () => {
  for (const action of [
    "BAN_USER",
    "UNBAN_USER",
    "UNMUTE_USER",
    "UPDATE_SECURITY_CONFIG",
    "UPDATE_PROTECTED_USER",
  ] as const) {
    const state = makeState(staleCommand({ action }));
    const result = await requeueSecurityCommand(
      COMMAND_ID,
      options(state, { acknowledgeLaterHumanDecisions: false }),
    );
    assert.equal(result.ok, false, action);
    assert.equal(
      result.ok === false ? result.reason : "",
      "confirmation_required",
      action,
    );
    assert.deepEqual(state.rpcCalls, [], action);
  }
});

test("an expired or imminent mute deadline is refused instead of becoming permanent", async () => {
  const nowSeconds = Math.floor(NOW / 1000);
  for (const untilDate of [
    nowSeconds - 3600,
    nowSeconds,
    nowSeconds + 10,
    nowSeconds + 30,
  ]) {
    const state = makeState(
      staleCommand({
        action: "MUTE_USER",
        payload: { duration_minutes: 30, until_date: untilDate },
      }),
    );
    const result = await requeueSecurityCommand(COMMAND_ID, options(state));
    assert.equal(result.ok, false, `until_date=${untilDate}`);
    assert.equal(
      result.ok === false ? result.reason : "",
      "temporal_window_expired",
      `until_date=${untilDate}`,
    );
    assert.deepEqual(state.rpcCalls, []);
  }
});

test("the mute boundary is inclusive at MUTE_MIN_REMAINING_MS", () => {
  const base = {
    action: "MUTE_USER",
    status: "processing",
    resultState: "processing",
    executionStartedAt: null,
    leaseExpiresAt: EXPIRED_LEASE,
    processingAt: null,
    attempts: 1,
    operationKey: "op-key-1",
    acknowledged: true,
    now: NOW,
  } as const;

  // Exactamente 30 s restantes: Telegram lo convertiría en permanente.
  const atBoundary = evaluateSecurityCommandReplayPolicy({
    ...base,
    payload: { duration_minutes: 30, until_date: (NOW + MUTE_MIN_REMAINING_MS) / 1000 },
  });
  assert.equal(atBoundary.allowed, false);
  assert.equal(atBoundary.reason, "temporal_window_expired");

  // Un milisegundo por encima del umbral: la ventana sigue siendo reutilizable.
  const justAbove = evaluateSecurityCommandReplayPolicy({
    ...base,
    payload: {
      duration_minutes: 30,
      until_date: (NOW + MUTE_MIN_REMAINING_MS + 1) / 1000,
    },
  });
  assert.equal(justAbove.allowed, true);

  // El caso que antes se descartaba: +31 s no es un rechazo.
  const thirtyOneSeconds = evaluateSecurityCommandReplayPolicy({
    ...base,
    payload: { duration_minutes: 30, until_date: Math.floor(NOW / 1000) + 31 },
  });
  assert.equal(thirtyOneSeconds.allowed, true);
});

test("a mute whose window is still valid can be replayed with acknowledgement", async () => {
  const state = makeState(
    staleCommand({
      action: "MUTE_USER",
      payload: { duration_minutes: 30, until_date: Math.floor(NOW / 1000) + 600 },
    }),
  );
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.equal(result.ok, true);
  assert.equal(state.rows[1].action, "MUTE_USER");
  const retryPayload = state.rows[1].payload as Record<string, unknown>;
  assert.equal(retryPayload.until_date, Math.floor(NOW / 1000) + 600);
  // La repetición conserva la expiración original: no prolonga la sanción.
  assert.deepEqual(state.rows[1].payload, state.rows[0].payload);
});

test("a non-numeric mute deadline is refused", () => {
  const decision = evaluateSecurityCommandReplayPolicy({
    action: "MUTE_USER",
    payload: { until_date: "mañana" as unknown as number },
    status: "processing",
    resultState: "processing",
    executionStartedAt: null,
    leaseExpiresAt: EXPIRED_LEASE,
    processingAt: null,
    attempts: 1,
    operationKey: "op-key-1",
    acknowledged: true,
    now: NOW,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "temporal_window_expired");
});

test("orders that exhausted CERBERO attempts require human review", async () => {
  const state = makeState(staleCommand({ attempts: 5 }));
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, {
    ok: false,
    reason: "attempts_exhausted",
    detail: "5",
    requiresHumanReview: true,
  });
  assert.deepEqual(state.rpcCalls, []);
});


test("the requeue is refused for operators outside the panel identity allow-list", async () => {
  const state = makeState(staleCommand());
  const result = await requeueSecurityCommand(
    COMMAND_ID,
    options(state, { isPanelUser: async () => false }),
  );

  assert.deepEqual(result, { ok: false, reason: "unauthorized_operator" });
  assert.deepEqual(state.rpcCalls, []);
  assert.equal(state.rows[0].result_state, "processing");
});

test("a failed identity lookup denies the operation instead of falling back", async () => {
  const state = makeState(staleCommand());
  const result = await requeueSecurityCommand(
    COMMAND_ID,
    options(state, {
      isPanelUser: async () => {
        throw new Error("supabase unavailable");
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "unauthorized_operator");
});

test("group authority is required and checked per action", async () => {
  for (const membership of [MEMBER, undefined]) {
    const state = makeState(staleCommand());
    const result = await requeueSecurityCommand(
      COMMAND_ID,
      options(state, { groupMembership: membership }),
    );
    assert.deepEqual(result, { ok: false, reason: "unauthorized_group" });
    assert.deepEqual(state.rpcCalls, []);
  }

  const readOnlyBan = makeState(staleCommand({ action: "BAN_USER" }));
  const deniedBan = await requeueSecurityCommand(
    COMMAND_ID,
    options(readOnlyBan, { groupMembership: READ_ONLY_ADMIN }),
  );
  assert.deepEqual(deniedBan, {
    ok: false,
    reason: "unauthorized_group",
    detail: "BAN_USER",
  });
  assert.deepEqual(readOnlyBan.rpcCalls, []);

  const readOnlyConfig = makeState(
    staleCommand({ action: "UPDATE_SECURITY_CONFIG" }),
  );
  const deniedConfig = await requeueSecurityCommand(
    COMMAND_ID,
    options(readOnlyConfig, { groupMembership: READ_ONLY_ADMIN }),
  );
  assert.deepEqual(deniedConfig, {
    ok: false,
    reason: "unauthorized_group",
    detail: "UPDATE_SECURITY_CONFIG",
  });

  const allowedBan = makeState(staleCommand({ action: "BAN_USER" }));
  const grantedBan = await requeueSecurityCommand(
    COMMAND_ID,
    options(allowedBan, { groupMembership: RESTRICTING_ADMIN }),
  );
  assert.equal(grantedBan.ok, true);

  const allowedConfig = makeState(
    staleCommand({ action: "UPDATE_SECURITY_CONFIG" }),
  );
  const grantedConfig = await requeueSecurityCommand(
    COMMAND_ID,
    options(allowedConfig, { groupMembership: RESTRICTING_ADMIN }),
  );
  assert.equal(grantedConfig.ok, true);
});

test("an order from another group is invisible from this group's context", async () => {
  const state = makeState(staleCommand());
  const result = await requeueSecurityCommand(
    COMMAND_ID,
    options(state, { groupId: OTHER_GROUP_ID }),
  );

  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.deepEqual(state.rpcCalls, []);
  assert.equal(state.rows[0].result_state, "processing");
});

test("the audit reason is mandatory", async () => {
  const state = makeState(staleCommand());
  for (const reason of ["", "   "]) {
    const result = await requeueSecurityCommand(
      COMMAND_ID,
      options(state, { reason }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "invalid_request",
      detail: "reason_required",
    });
  }
  assert.deepEqual(state.rpcCalls, []);
});


test("the RPC receives actor, group, reason and the explicit acknowledgement", async () => {
  const state = makeState(staleCommand());
  await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.equal(state.rpcCalls.length, 1);
  const call = state.rpcCalls[0];
  assert.equal(call.p_command_id, COMMAND_ID);
  assert.equal(call.p_group_id, GROUP_ID);
  assert.equal(call.p_actor_id, ACTOR_ID);
  assert.equal(call.p_reason, "revisión manual del operador");
  assert.equal(call.p_acknowledged, true);
  // ZEUS no escribe la auditoría por su cuenta: vive en la transacción del RPC
  // (migración 021), de modo que sólo existe si existe el reintento.
});

test("a missing atomic RPC fails closed instead of falling back to a non-transactional insert", async () => {
  const state = makeState(staleCommand());
  state.rpcError = {
    code: "PGRST202",
    message: "Could not find the function public.zeus_requeue_security_command",
  };

  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, { ok: false, reason: "requeue_rpc_unavailable" });
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].result_state, "processing");
});

test("RPC refusals are mapped to the same closed reason set", async () => {
  const base: RpcResult = {
    outcome: "not_stale",
    original_command_id: COMMAND_ID,
    retry_command_id: null,
    original_status: "processing",
    original_result_state: "processing",
    original_execution_started_at: null,
    original_attempts: 1,
    retry_operation_key: null,
    detail: null,
  };

  for (const outcome of [
    "not_stale",
    "not_processing",
    "not_retryable",
    "missing_operation_key",
    "temporal_window_expired",
    "group_not_eligible",
    "concurrent_change",
  ]) {
    const state = makeState(staleCommand());
    state.rpcResult = { ...base, outcome };
    const result = await requeueSecurityCommand(COMMAND_ID, options(state));
    assert.equal(result.ok, false, outcome);
    assert.equal(result.ok === false ? result.reason : "", outcome);
  }
});

test("an unknown RPC outcome is refused as unexpected, never as success", async () => {
  // Hallazgo B3: antes se hacía `row.outcome as SecurityCommandRequeueRefusalReason`,
  // de modo que un outcome nuevo de la RPC entraba en el conjunto cerrado sin
  // validarse. Ahora se rechaza con revisión humana.
  const state = makeState(staleCommand());
  state.rpcResult = {
    outcome: "outcome_de_una_rpc_mas_nueva",
    original_command_id: COMMAND_ID,
    retry_command_id: null,
    detail: "detalle desconocido",
  };

  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "unexpected_rpc_outcome");
  assert.equal(result.ok === false ? result.requiresHumanReview : false, true);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].result_state, "processing");
});

test("an already retried order reported by the RPC keeps the winner id", async () => {
  const state = makeState(staleCommand());
  state.rpcResult = {
    outcome: "already_retried",
    original_command_id: COMMAND_ID,
    retry_command_id: "22222222-2222-4222-8222-222222222222",
    original_status: "processing",
    original_result_state: "unknown",
    original_execution_started_at: null,
    original_attempts: 1,
    retry_operation_key: null,
    detail: "22222222-2222-4222-8222-222222222222",
  };

  const result = await requeueSecurityCommand(COMMAND_ID, options(state));
  assert.deepEqual(result, {
    ok: false,
    reason: "already_retried",
    detail: "22222222-2222-4222-8222-222222222222",
  });
});

test("evidence classification separates every state required by the design", () => {
  assert.equal(
    classifySecurityCommandEvidence({ status: "completed" }),
    "completed",
  );
  assert.equal(classifySecurityCommandEvidence({ status: "failed" }), "failed");
  assert.equal(
    classifySecurityCommandEvidence({ status: "cancelled" }),
    "cancelled",
  );
  assert.equal(
    classifySecurityCommandEvidence({
      status: "processing",
      result_state: "processing",
      execution_started_at: "2026-01-01T00:09:10.000Z",
    }),
    "maybe_started",
  );
  assert.equal(
    classifySecurityCommandEvidence({
      status: "processing",
      result_state: "unknown",
      execution_started_at: null,
    }),
    "reconciled_unknown",
  );
  assert.equal(
    classifySecurityCommandEvidence({
      status: "processing",
      result_state: "processing",
      execution_started_at: null,
    }),
    "never_started",
  );
});

test("the retry stays claimable under CERBERO's claim contract", async () => {
  const state = makeState(staleCommand());
  await requeueSecurityCommand(COMMAND_ID, options(state));

  const retry = state.rows[1];
  assert.equal(retry.status, "pending");
  assert.equal(retry.group_id, GROUP_ID);
  assert.notEqual(retry.id, COMMAND_ID);
  assert.equal(typeof retry.operation_key, "string");
  for (const column of [
    "processing_instance_id",
    "processing_token",
    "processing_at",
    "lease_expires_at",
    "execution_started_at",
    "responsible_bot",
    "executed_at",
  ]) {
    assert.equal(retry[column], null, `${column} must stay free for CERBERO`);
  }
});

test("reconciliation never touches an order with execution evidence", async () => {
  const stale = staleCommand();
  const withEvidence = staleCommand({
    id: "44444444-4444-4444-8444-444444444444",
    operation_key: "op-key-2",
    execution_started_at: "2026-01-01T00:09:30.000Z",
  });
  const rows: Row[] = [stale, withEvidence];

  const result = await reconcileStaleSecurityCommands({
    client: createReconcileClient(rows),
    now: () => NOW,
  });

  assert.deepEqual(result.commandIds, [COMMAND_ID]);
  assert.equal(rows[0].result_state, "unknown");
  assert.equal(rows[1].result_state, "processing");
  assert.equal(rows[1].execution_started_at, "2026-01-01T00:09:30.000Z");
});

test("requeueing an order just reconciled as unknown still requires confirmation", async () => {
  const stale = staleCommand();
  const rows: Row[] = [stale];
  await reconcileStaleSecurityCommands({
    client: createReconcileClient(rows),
    now: () => NOW,
  });

  const state: FakeState = { rows, inserted: 0, rpcCalls: [] };
  const result = await requeueSecurityCommand(
    COMMAND_ID,
    options(state, { acknowledgeLaterHumanDecisions: false }),
  );

  assert.equal(result.ok, false);
  // C9: mismo motivo que la RPC 021 (`confirmation_required`), sin convertirlo
  // en autorización; el aviso de revisión humana se conserva.
  assert.equal(
    result.ok === false ? result.reason : "",
    "confirmation_required",
  );
  assert.equal(result.ok === false ? result.requiresHumanReview : false, true);
  assert.deepEqual(state.rpcCalls, []);
});

test("an order with result_state=queued is refused with the reason the SQL returns", async () => {
  const state = makeState(staleCommand({ result_state: "queued" }));
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  // Paridad con `021`: `result_state not in ('processing','unknown')` produce
  // `unsupported_result_state`. Un `queued` no es evidencia de nada y no se
  // reencola por esta vía.
  assert.deepEqual(result, {
    ok: false,
    reason: "unsupported_result_state",
    detail: "queued",
    requiresHumanReview: true,
  });
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.rpcCalls, []);
});

test("an order without result_state is refused instead of being replayed", async () => {
  const state = makeState(staleCommand({ result_state: null }));
  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, {
    ok: false,
    reason: "unsupported_result_state",
    detail: "null",
    requiresHumanReview: true,
  });
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.rpcCalls, []);
});

test("a stale order without explicit acknowledgement never reaches the RPC", async () => {
  const state = makeState(staleCommand());
  const result = await requeueSecurityCommand(
    COMMAND_ID,
    options(state, { acknowledgeLaterHumanDecisions: false }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "confirmation_required");
  assert.deepEqual(state.rpcCalls, []);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].result_state, "processing");
});

test("reconciliation never overwrites an order whose execution started during the read", async () => {
  const row = staleCommand();
  const rows: Row[] = [row];
  const result = await reconcileStaleSecurityCommands({
    client: createReconcileClient(rows, {
      afterSelect: () => {
        // CERBERO marca el inicio justo después de que ZEUS leyó la fila: el
        // UPDATE debe quedar bloqueado por `execution_started_at IS NULL`.
        row.execution_started_at = "2026-01-01T00:09:59.000Z";
      },
    }),
    now: () => NOW,
  });

  assert.equal(result.matched, 1);
  assert.equal(result.reconciled, 0);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.commandIds, []);
  assert.equal(row.result_state, "processing");
  assert.equal(row.execution_started_at, "2026-01-01T00:09:59.000Z");
});

test("100+ órdenes unknown antiguas no ocultan órdenes stale nuevas (E1)", async () => {
  // Fase 4C / E1 (bloqueo de cabeza de línea). La consulta filtraba sólo por
  // `status='processing'` y ordenaba por `created_at ASC` ANTES de aplicar
  // `.limit(100)`. Una orden reconciliada conserva `status='processing'` con
  // `result_state='unknown'`, y por ser la más antigua ocupaba los primeros
  // puestos del lote: con 100 órdenes así, las órdenes nuevas no se examinaban
  // nunca y el ciclo se contabilizaba como `unchanged`, sin señal alguna.
  const alreadyReconciled: Row[] = [];
  for (let index = 0; index < 120; index += 1) {
    alreadyReconciled.push(
      staleCommand({
        id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
        operation_key: `op-key-unknown-${index}`,
        created_at: new Date(
          Date.parse("2025-01-01T00:00:00.000Z") + index * 60_000,
        ).toISOString(),
        result_state: "unknown",
        last_error: STALE_PROCESSING_RECONCILED_ERROR,
        processing_instance_id: null,
        processing_token: null,
        processing_at: null,
        lease_expires_at: null,
      }),
    );
  }
  const fresh: Row[] = [
    staleCommand({
      id: "66666666-6666-4666-8666-000000000001",
      operation_key: "op-key-fresh-1",
    }),
    staleCommand({
      id: "66666666-6666-4666-8666-000000000002",
      operation_key: "op-key-fresh-2",
    }),
    staleCommand({
      id: "66666666-6666-4666-8666-000000000003",
      operation_key: "op-key-fresh-3",
    }),
  ];
  const rows: Row[] = [...alreadyReconciled, ...fresh];

  const result = await reconcileStaleSecurityCommands({
    client: createReconcileClient(rows),
    now: () => NOW,
  });

  assert.equal(result.matched, 3);
  assert.equal(result.reconciled, 3);
  assert.equal(result.unchanged, 0);
  assert.deepEqual(
    result.commandIds,
    fresh.map((row) => row.id),
  );

  // Las ya reconciliadas no se reescriben: la prueba no debe "arreglarlas".
  for (const row of alreadyReconciled) {
    assert.equal(row.result_state, "unknown");
    assert.equal(row.last_error, STALE_PROCESSING_RECONCILED_ERROR);
    assert.equal(row.execution_started_at, null);
  }
  // Las nuevas sí se detectan y se preservan para revisión humana.
  for (const row of fresh) {
    assert.equal(row.result_state, "unknown");
    assert.equal(row.last_error, STALE_PROCESSING_RECONCILED_ERROR);
  }

  // Segundo ciclo: ya no queda nada por reconciliar. Sin el filtro en SQL, las
  // 120 filas `unknown` seguirían llenando el lote en cada ciclo (ceguera
  // permanente) y este ciclo volvería a informar `matched: 100`.
  const second = await reconcileStaleSecurityCommands({
    client: createReconcileClient(rows),
    now: () => NOW,
  });
  assert.equal(second.matched, 0);
  assert.equal(second.reconciled, 0);
  assert.equal(second.unchanged, 0);
  assert.deepEqual(second.commandIds, []);
});

test("el listado stale no inventa una vista de órdenes unknown (P-1)", async () => {
  // Documenta el límite real: una orden ya neutralizada (lease y processing_at
  // NULL) no es "stale" para la política, así que el listado no la devuelve. La
  // vista dedicada de `unknown` es la recomendación P-1 y todavía no existe; si
  // alguien la implementa, esta prueba debe cambiar a propósito.
  const reconciledId = "88888888-8888-4888-8888-888888888888";
  const rows: Row[] = [
    staleCommand({
      id: reconciledId,
      operation_key: "op-key-unknown-listed",
      result_state: "unknown",
      last_error: STALE_PROCESSING_RECONCILED_ERROR,
      processing_at: null,
      lease_expires_at: null,
    }),
    staleCommand({
      id: "99999999-9999-4999-8999-999999999999",
      operation_key: "op-key-stale-listed",
    }),
  ];

  const listed = await listStaleSecurityCommands({
    client: createReconcileClient(rows),
    now: () => NOW,
  });

  assert.deepEqual(
    listed.map((row) => row.id),
    ["99999999-9999-4999-8999-999999999999"],
  );
});

test("una violación de unicidad sin reintento ganador no se informa como already_retried (E5)", async () => {
  // Fase 4C / E5. `23505` sólo dice "alguna restricción única falló". Antes se
  // traducía siempre a `already_retried`, aunque la colisión pudiera venir de
  // otra restricción y no existiera ninguna fila `<clave>#retry`: el operador
  // creía que la orden ya estaba reencolada y la orden quedaba sin reintento
  // ni aviso.
  const state = makeState(staleCommand());
  state.rpcError = {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "security_commands_requeue_guard_idx"',
  };

  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, {
    ok: false,
    reason: "unexpected_rpc_outcome",
    detail: "unique_violation_without_winner",
    requiresHumanReview: true,
  });
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].result_state, "processing");
});

test("una violación del índice de idempotencia con ganador sí es already_retried (E5)", async () => {
  const winnerId = "77777777-7777-4777-8777-777777777777";
  const state = makeState(
    staleCommand(),
    staleCommand({
      id: winnerId,
      operation_key: "op-key-1#retry",
      status: "pending",
      result_state: "queued",
    }),
  );
  state.rpcError = {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "security_commands_operation_key_idx"',
  };

  const result = await requeueSecurityCommand(COMMAND_ID, options(state));

  assert.deepEqual(result, {
    ok: false,
    reason: "already_retried",
    detail: winnerId,
  });
});

