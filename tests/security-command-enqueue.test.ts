import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureCerberoBinding } from "../src/services/security-commands.js";

const GROUP_ID = -1001234567890;
const BOT_ID = "cerbero-bot-id";

type RecordedUpsert = {
  table: string;
  values: Record<string, unknown>;
  options: Record<string, unknown>;
};

interface FakeState {
  upserts: RecordedUpsert[];
  groupError?: { code: string; message: string };
  bindingError?: { code: string; message: string };
}

/**
 * Cliente Supabase simulado y deliberadamente mínimo. NO reproduce PostgreSQL:
 * sólo fija el contrato de las llamadas (tabla, valores y opciones del upsert)
 * que `ensureCerberoBinding` debe emitir. La semántica real de DO NOTHING se
 * valida contra PostgreSQL, no con este mock.
 */
function createFakeClient(state: FakeState): SupabaseClient {
  const from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select(_columns = "*") {
        return api;
      },
      eq(_column: string, _value: unknown) {
        return api;
      },
      async maybeSingle() {
        if (table === "bots") {
          return { data: { id: BOT_ID }, error: null };
        }
        return { data: null, error: null };
      },
      async upsert(
        values: Record<string, unknown>,
        options: Record<string, unknown> = {},
      ) {
        state.upserts.push({ table, values, options });
        if (table === "groups" && state.groupError) {
          return { data: null, error: state.groupError };
        }
        if (table === "group_bot_bindings" && state.bindingError) {
          return { data: null, error: state.bindingError };
        }
        return { data: null, error: null };
      },
    };
    return api;
  };

  return { from } as unknown as SupabaseClient;
}

function newState(overrides: Partial<FakeState> = {}): FakeState {
  return { upserts: [], ...overrides };
}

test("un grupo nuevo se inserta con active=true y solicita ignoreDuplicates: true", async () => {
  const state = newState();
  await ensureCerberoBinding(GROUP_ID, { client: createFakeClient(state) });

  const groupUpsert = state.upserts.find((entry) => entry.table === "groups");
  assert.ok(groupUpsert, "el upsert de groups no se ejecutó");
  assert.deepEqual(groupUpsert.values, { chat_id: GROUP_ID, active: true });
  assert.equal(groupUpsert.options.ignoreDuplicates, true);
});

test("el conflicto de chat_id utiliza onConflict: 'chat_id'", async () => {
  const state = newState();
  await ensureCerberoBinding(GROUP_ID, { client: createFakeClient(state) });

  const groupUpsert = state.upserts.find((entry) => entry.table === "groups");
  assert.equal(groupUpsert?.options.onConflict, "chat_id");
});

test("el binding de CERBERO se sigue creando con la misma forma", async () => {
  const state = newState();
  await ensureCerberoBinding(GROUP_ID, { client: createFakeClient(state) });

  const bindingUpsert = state.upserts.find(
    (entry) => entry.table === "group_bot_bindings",
  );
  assert.ok(bindingUpsert, "el upsert del binding no se ejecutó");
  assert.deepEqual(bindingUpsert.values, {
    group_id: GROUP_ID,
    bot_id: BOT_ID,
    enabled: true,
    permissions: {},
  });
  assert.equal(bindingUpsert.options.onConflict, "group_id,bot_id");
});

test("los errores reales del upsert de groups se propagan", async () => {
  const groupError = { code: "42501", message: "permission denied" };
  const state = newState({ groupError });

  await assert.rejects(
    ensureCerberoBinding(GROUP_ID, { client: createFakeClient(state) }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "42501",
  );
});

test("la estrategia no es merge: el upsert de groups no usa ignoreDuplicates=false", async () => {
  const state = newState();
  await ensureCerberoBinding(GROUP_ID, { client: createFakeClient(state) });

  const groupUpsert = state.upserts.find((entry) => entry.table === "groups");
  assert.notEqual(
    groupUpsert?.options.ignoreDuplicates,
    false,
    "ignoreDuplicates=false implica merge-duplicates y reactivaría el grupo",
  );
});

test("no se altera el comportamiento anterior: bot→grupo→binding y sin escribir security_commands", async () => {
  const state = newState();
  await ensureCerberoBinding(GROUP_ID, { client: createFakeClient(state) });

  assert.deepEqual(
    state.upserts.map((entry) => entry.table),
    ["groups", "group_bot_bindings"],
  );
  assert.ok(
    !state.upserts.some((entry) => entry.table === "security_commands"),
    "ensureCerberoBinding no debe escribir en security_commands",
  );
});