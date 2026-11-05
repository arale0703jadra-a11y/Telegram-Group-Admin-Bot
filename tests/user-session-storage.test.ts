import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import {
  SupabaseUserSessionStorage,
  USER_SESSION_TIMEOUT_MS,
  UserSessionPersistenceError,
} from "../src/services/user-session-storage.js";
import type { PendingAction, UserPanelState } from "../src/types.js";

interface StoredSession {
  payload: Record<string, unknown>;
  version: number;
  expiresAt: number;
  pendingActionExpiresAt: number | null;
}

class FakeSessionDatabase {
  readonly rows = new Map<string, StoredSession>();
  readonly warnings: string[] = [];
  now = Date.parse("2026-01-01T00:00:00.000Z");
  error: { code: string; message: string; status: number } | undefined;
  hang = false;

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.hang) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }

    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    if (this.error) {
      return this.response(
        { code: this.error.code, message: this.error.message },
        this.error.status,
      );
    }

    const requestBody = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    const key = String(requestBody.p_session_key);

    if (url.pathname.endsWith("/zeus_read_user_session")) {
      const row = this.rows.get(key);
      if (row && row.expiresAt <= this.now) {
        this.rows.delete(key);
        return this.response([]);
      }
      return this.response(row
        ? [{
            payload: row.payload,
            version: row.version,
            expires_at: new Date(row.expiresAt).toISOString(),
            pending_action_expires_at: row.pendingActionExpiresAt === null
              ? null
              : new Date(row.pendingActionExpiresAt).toISOString(),
          }]
        : []);
    }

    if (url.pathname.endsWith("/zeus_write_user_session")) {
      const payload = requestBody.p_payload as Record<string, unknown>;
      const expectedVersion = Number(requestBody.p_expected_version);
      const previous = this.rows.get(key);
      const expired = previous !== undefined && previous.expiresAt <= this.now;
      if (
        previous &&
        !expired &&
        previous.version !== expectedVersion
      ) {
        return this.response({
          code: "40001",
          message: "ZEUS user session version conflict",
        }, 400);
      }
      if (!previous && expectedVersion !== 0 || expired && expectedVersion !== 0) {
        return this.response({
          code: "40001",
          message: "ZEUS user session version conflict",
        }, 400);
      }

      const previousAction = previous?.payload.pendingAction;
      const nextAction = payload.pendingAction;
      const pendingActionExpiresAt = nextAction === undefined
        ? null
        : previous && JSON.stringify(previousAction) === JSON.stringify(nextAction)
          ? previous.pendingActionExpiresAt
          : this.now + Number(requestBody.p_pending_ttl_seconds) * 1_000;
      const version = previous && !expired ? previous.version + 1 : 1;
      this.rows.set(key, {
        payload,
        version,
        expiresAt: this.now + Number(requestBody.p_session_ttl_seconds) * 1_000,
        pendingActionExpiresAt,
      });
      return this.response([{ version }]);
    }

    if (url.pathname.endsWith("/zeus_delete_user_session")) {
      this.rows.delete(key);
      return this.response(null);
    }

    return this.response({ message: "Unexpected RPC" }, 404);
  };

  private response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

function createStorage(
  database: FakeSessionDatabase,
  timeoutMs = 1_000,
): SupabaseUserSessionStorage {
  const client = createClient("https://supabase.invalid", "test-service-role-key", {
    global: { fetch: database.fetch },
  });
  return new SupabaseUserSessionStorage(
    () => database.now,
    (message) => database.warnings.push(message),
    () => client,
    timeoutMs,
  );
}

test("persists and restores pending actions across storage instances without read-only writes", async () => {
  const database = new FakeSessionDatabase();
  const firstProcess = createStorage(database);
  const state: UserPanelState = {
    persistenceVersion: 0,
    selectedGroupId: -100,
    selectedGroupTitle: "Grupo",
    pendingAction: { kind: "automaticMessage", groupId: -100 },
  };

  await firstProcess.write("user:123", state);
  assert.equal(state.persistenceVersion, 1);

  const restartedProcess = createStorage(database);
  const restored = await restartedProcess.read("user:123");
  assert.equal(restored?.selectedGroupId, -100);
  assert.deepEqual(restored?.pendingAction, {
    kind: "automaticMessage",
    groupId: -100,
  });
  await restartedProcess.write("user:123", restored!);
  assert.equal(database.rows.get("user:123")?.version, 1);
});

test("keeps user sessions isolated and expires pending actions without extending their TTL", async () => {
  const database = new FakeSessionDatabase();
  const storage = createStorage(database);
  await storage.write("user:101", {
    persistenceVersion: 0,
    selectedGroupId: -101,
    pendingAction: { kind: "search", groupId: -101 },
  });
  await storage.write("user:202", {
    persistenceVersion: 0,
    selectedGroupId: -202,
    pendingAction: { kind: "search", groupId: -202 },
  });

  assert.equal((await storage.read("user:101"))?.selectedGroupId, -101);
  assert.equal((await storage.read("user:202"))?.selectedGroupId, -202);

  const pendingExpiresAt = database.rows.get("user:101")?.pendingActionExpiresAt;
  database.now += 14 * 60 * 1_000;
  const state = await storage.read("user:101");
  assert.ok(state);
  state.selectedGroupTitle = "Actualizado";
  await storage.write("user:101", state);
  assert.equal(
    database.rows.get("user:101")?.pendingActionExpiresAt,
    pendingExpiresAt,
  );

  database.now += 2 * 60 * 1_000;
  assert.equal((await storage.read("user:101"))?.pendingAction, undefined);
  const secondUserState = await storage.read("user:202");
  assert.equal(secondUserState?.selectedGroupId, -202);
  assert.equal(secondUserState?.pendingAction, undefined);
});

test("drops malformed pending actions and surfaces their validation warning", async () => {
  const database = new FakeSessionDatabase();
  database.rows.set("user:303", {
    payload: { pendingAction: { kind: "unknown", groupId: -303 } },
    version: 1,
    expiresAt: database.now + 60_000,
    pendingActionExpiresAt: database.now + 60_000,
  });

  const state = await createStorage(database).read("user:303");
  assert.equal(state?.pendingAction, undefined);
  assert.equal(database.warnings.length, 1);
});

test("reports Supabase errors and aborts timed-out requests", async () => {
  const unavailable = new FakeSessionDatabase();
  unavailable.error = {
    code: "08006",
    message: "connection failed",
    status: 503,
  };
  await assert.rejects(
    createStorage(unavailable).read("user:404"),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.reason === "unavailable",
  );

  const slow = new FakeSessionDatabase();
  slow.hang = true;
  await assert.rejects(
    createStorage(slow, 10).read("user:405"),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.reason === "timeout",
  );
  assert.equal(USER_SESSION_TIMEOUT_MS, 5_000);
});

test("rejects stale concurrent writes with compare-and-swap versions", async () => {
  const database = new FakeSessionDatabase();
  const storage = createStorage(database);
  await storage.write("user:505", {
    persistenceVersion: 0,
    selectedGroupId: -505,
  });
  const stale = await storage.read("user:505");
  const current = await storage.read("user:505");
  assert.ok(stale && current);

  current.selectedGroupTitle = "Nuevo estado";
  await storage.write("user:505", current);
  stale.selectedGroupTitle = "Estado atrasado";
  await assert.rejects(
    storage.write("user:505", stale),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.reason === "conflict",
  );
  assert.equal(database.rows.get("user:505")?.payload.selectedGroupTitle, "Nuevo estado");
});

test("encrypts verification confirmation tokens and supports every pending-action kind", async () => {
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key-not-a-production-secret";
  try {
    const database = new FakeSessionDatabase();
    const storage = createStorage(database);
    const confirmationToken = "0123456789abcdefab";
    await storage.write("user:606", {
      persistenceVersion: 0,
      verifiedConfirmation: {
        groupId: -606,
        userId: 607,
        actorUserId: 606,
        operation: "activate",
        token: confirmationToken,
        expiresAt: database.now + 60_000,
      },
    });
    const persisted = JSON.stringify(database.rows.get("user:606")?.payload);
    assert.ok(persisted.includes("enc:v1:"));
    assert.equal(persisted.includes(confirmationToken), false);
    assert.equal(
      (await storage.read("user:606"))?.verifiedConfirmation?.token,
      confirmationToken,
    );

    const actions: PendingAction[] = [
      { kind: "search", groupId: -1, messageId: 1 },
      { kind: "promotionTest", groupId: -1 },
      { kind: "automaticMessage", groupId: -1 },
      { kind: "verifiedMarkers", groupId: -1 },
      { kind: "verifiedSearch", groupId: -1 },
      { kind: "verifiedManualAdd", groupId: -1 },
      { kind: "filterAdd", groupId: -1, messageId: 1 },
      { kind: "illegalAdd", groupId: -1, messageId: 1 },
      { kind: "illegalDelete", groupId: -1, index: 0, page: 0 },
      { kind: "filterDelete", groupId: -1, index: 0, page: 0 },
      { kind: "pick", action: "ban", groupId: -1 },
      { kind: "muteMinutes", userId: 7, groupId: -1 },
      { kind: "muteReason", userId: 7, groupId: -1, minutes: 5 },
      { kind: "warnReason", userId: 7, groupId: -1 },
      { kind: "banReason", userId: 7, groupId: -1 },
      { kind: "unbanId", groupId: -1 },
      { kind: "recoveryKey" },
    ];

    for (const [index, pendingAction] of actions.entries()) {
      const key = `user:${700 + index}`;
      await storage.write(key, { persistenceVersion: 0, pendingAction });
      assert.deepEqual((await storage.read(key))?.pendingAction, pendingAction);
    }

    const contaminatedState = JSON.parse(JSON.stringify({
      persistenceVersion: 0,
      pendingAction: { kind: "recoveryKey", recoveryCode: "must-not-persist" },
    })) as UserPanelState;
    await storage.write("user:799", contaminatedState);
    assert.equal(
      JSON.stringify(database.rows.get("user:799")?.payload).includes("must-not-persist"),
      false,
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    }
  }
});
