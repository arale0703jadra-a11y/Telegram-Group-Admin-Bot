import assert from "node:assert/strict";
import test from "node:test";
import type { UserPanelState } from "../src/types.js";
import {
  assertSessionPayloadWritable,
  MAX_SESSION_PAYLOAD_BYTES,
  UserSessionPersistenceError,
} from "../src/services/user-session-storage.js";

process.env.SUPABASE_URL = "https://session-validation.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

let writeErrorCode: string | undefined;
let lastWritePayload: Record<string, unknown> | undefined;

globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = input instanceof Request ? input.url : String(input);
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.includes("zeus_read_user_session")) return json([], 200);
  if (url.includes("zeus_write_user_session")) {
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as {
          p_payload?: Record<string, unknown>;
        };
        lastWritePayload = parsed.p_payload;
      } catch {
        lastWritePayload = undefined;
      }
    }
    if (writeErrorCode !== undefined) {
      return json(
        { code: writeErrorCode, message: "rejected by database check" },
        400,
      );
    }
    return json([{ version: 1 }], 200);
  }
  return json({ code: "08006", message: "database unavailable" }, 503);
}) as typeof fetch;

const { SupabaseUserSessionStorage } = await import(
  "../src/services/user-session-storage.js"
);

test("el validador acepta exactamente las cinco claves permitidas", () => {
  assertSessionPayloadWritable({});
  assertSessionPayloadWritable({
    selectedGroupId: -100123,
    selectedGroupTitle: "Grupo",
    selectedVerifiedSearch: "ana",
    pendingAction: { kind: "automaticMessage", groupId: -100123 },
    verifiedConfirmation: { groupId: -100123 },
  });
});

test("claves no permitidas se rechazan como invalid_data sin llamar a Supabase", () => {
  assert.throws(
    () => assertSessionPayloadWritable({ unexpectedKey: "value" }),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.operation === "write" &&
      error.reason === "invalid_data",
  );
  // persistenceVersion vive solo en memoria: jamás debe viajar a la BD.
  assert.throws(
    () =>
      assertSessionPayloadWritable({
        selectedGroupId: -100123,
        persistenceVersion: 7,
      }),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.reason === "invalid_data",
  );
});

test("payload superior a 16 KB se rechaza como invalid_data", () => {
  const oversized = {
    selectedGroupTitle: "x".repeat(MAX_SESSION_PAYLOAD_BYTES + 1),
  };
  assert.throws(
    () => assertSessionPayloadWritable(oversized),
    (error: unknown) =>
      error instanceof UserSessionPersistenceError &&
      error.operation === "write" &&
      error.reason === "invalid_data",
  );
  // En el límite exacto se acepta.
  const atLimit = {
    selectedGroupTitle:
      "y".repeat(MAX_SESSION_PAYLOAD_BYTES - JSON.stringify({ selectedGroupTitle: "" }).length),
  };
  assert.equal(
    Buffer.byteLength(JSON.stringify(atLimit), "utf8"),
    MAX_SESSION_PAYLOAD_BYTES,
  );
  assertSessionPayloadWritable(atLimit);
});

test("propiedades desconocidas jamás llegan a la RPC: solo viaja la lista blanca", async () => {
  const storage = new SupabaseUserSessionStorage();
  // Estado sintético con un campo al margen de la lista blanca: la
  // serialización debe construir un payload solo con las claves permitidas.
  const synthetic = {
    persistenceVersion: 1,
    pendingAction: { kind: "automaticMessage", groupId: -100456 },
    forgedExtraField: "no-whitelisted",
  } as unknown as UserPanelState;
  lastWritePayload = undefined;
  await storage.write("user:900000501", synthetic);
  assert.ok(lastWritePayload, "la escritura envió un payload");
  assert.deepEqual(
    Object.keys(lastWritePayload ?? {}).sort(),
    ["pendingAction"],
    "solo la clave permitida viaja a Supabase",
  );
  assert.equal(
    "forgedExtraField" in (lastWritePayload ?? {}),
    false,
    "la propiedad desconocida no se persiste",
  );
  assert.equal(
    "persistenceVersion" in (lastWritePayload ?? {}),
    false,
    "la versión vive solo en memoria",
  );
});

test("error 22023 devuelto por la base de datos se clasifica como invalid_data", async () => {
  writeErrorCode = "22023";
  try {
    const storage = new SupabaseUserSessionStorage();
    const state: UserPanelState = {
      persistenceVersion: 1,
      pendingAction: { kind: "automaticMessage", groupId: -100789 },
    };
    await assert.rejects(
      () => storage.write("user:900000502", state),
      (error: unknown) =>
        error instanceof UserSessionPersistenceError &&
        error.operation === "write" &&
        error.reason === "invalid_data" &&
        error.databaseCode === "22023",
    );
  } finally {
    writeErrorCode = undefined;
  }
});
