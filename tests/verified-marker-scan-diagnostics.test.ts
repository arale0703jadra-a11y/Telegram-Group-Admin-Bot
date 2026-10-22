import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import {
  classifyVerifiedStoreFailure,
  describeVerifiedMarkerScanError,
  runVerifiedMarkerScan,
  scanObservedVerifiedMarkers,
  sanitizeScanDetail,
  VerifiedMarkerAdminLookupError,
  VerifiedMarkerScanError,
} from "../src/services/verified-marker-scan.js";
import { initialGroupData } from "../src/storage/initial.js";
import type { GroupData } from "../src/storage/types.js";
import {
  DEFAULT_VERIFIED_PERMISSIONS,
  type VerifiedUser,
} from "../src/services/verified-users.js";
import { buildVerifiedTagCandidatesPanel } from "../src/menus/panels.js";
import { listVerifiedTagReviews } from "../src/services/verified-tag-reviews.js";
import { buttonCallbackData } from "./helpers.js";

const GROUP_ID = -1008887776661;

const verifiedRows: VerifiedUser[] = [];
const reviewRows: Array<Record<string, unknown>> = [];
const auditRows = new Map<string, Record<string, unknown>>();
let reviewReadError: Record<string, unknown> | undefined;
let reviewWriteError: Record<string, unknown> | undefined;

const realFetch = globalThis.fetch;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MISSING_TABLE_ERROR = {
  code: "PGRST205",
  message:
    "Could not find the table 'public.verified_member_tag_reviews' in the schema cache",
  details: null,
  hint: null,
};

function matches(row: Record<string, unknown>, url: URL): boolean {
  for (const [key, expression] of url.searchParams.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "on_conflict") {
      continue;
    }
    const separator = expression.indexOf(".");
    const operator = expression.slice(0, separator);
    const value = expression.slice(separator + 1);
    if (operator === "eq" && String(row[key]) !== value) return false;
    if (operator === "is" && value === "null" && row[key] != null) return false;
  }
  return true;
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const bodyText =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request && input.body
        ? await input.clone().text()
        : "";
  const response = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const objectResponse = headers.get("accept")?.includes("vnd.pgrst.object") ?? false;
  const route = url.pathname.split("/").pop();

  if (route === "verified_users" && method === "GET") {
    return response(
      verifiedRows.filter((row) => matches(row as unknown as Record<string, unknown>, url)),
    );
  }

  if (route === "verified_member_tag_reviews") {
    if (method === "GET") {
      if (reviewReadError) return response(reviewReadError, 404);
      return response(reviewRows.filter((row) => matches(row, url)));
    }
    if (method === "POST") {
      if (reviewWriteError) return response(reviewWriteError, 404);
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      const existingIndex = reviewRows.findIndex(
        (row) => row.group_id === body.group_id && row.user_id === body.user_id,
      );
      const row = {
        ...(existingIndex >= 0 ? reviewRows[existingIndex] : {}),
        ...body,
      };
      if (existingIndex >= 0) reviewRows[existingIndex] = row;
      else reviewRows.push(row);
      return response(objectResponse ? row : [row]);
    }
  }

  if (route === "verified_member_tag_audit" && method === "POST") {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const key = String(body.event_key);
    if (!auditRows.has(key)) auditRows.set(key, body);
    return response([]);
  }
  return response({ message: `Unexpected mock route ${route}` }, 404);
};


test.before(() => {
  // La primera prueba verifica el comportamiento sin configuración de Supabase;
  // las posteriores habilitan un entorno simulado.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test.after(() => {
  globalThis.fetch = realFetch;
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
});

test.beforeEach(() => {
  verifiedRows.length = 0;
  reviewRows.length = 0;
  auditRows.clear();
  reviewReadError = undefined;
  reviewWriteError = undefined;
});

function enableSupabaseMock(): void {
  process.env.SUPABASE_URL = "https://verified-scan.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
}

function scanData(): GroupData {
  const data = initialGroupData();
  data.verifiedMemberTags = ["Verificada"];
  return data;
}

function makeAdmin(userId: number, customTitle?: string): ChatMember {
  return {
    status: "administrator",
    user: {
      id: userId,
      is_bot: false,
      first_name: `User${userId}`,
      username: `user_${userId}`,
    },
    ...(customTitle !== undefined ? { custom_title: customTitle } : {}),
  } as ChatMember;
}

function mockAdminListApi(
  members: ChatMember[] | Error,
): Pick<Api, "getChatAdministrators"> {
  return {
    getChatAdministrators: async () => {
      if (members instanceof Error) throw members;
      return members as Awaited<ReturnType<Api["getChatAdministrators"]>>;
    },
  };
}

function activeVerifiedRecord(groupId: number, userId: number): VerifiedUser {
  return {
    id: `verified-${groupId}-${userId}`,
    group_id: groupId,
    user_id: userId,
    username: `user_${userId}`,
    display_name: `User${userId}`,
    verified: true,
    permissions: { ...DEFAULT_VERIFIED_PERMISSIONS },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    created_by: 100,
    revoked_at: null,
  };
}

test("el escaneo sin configuración de Supabase informa etapa y motivo reales", async () => {
  const data = scanData();
  const api = mockAdminListApi([makeAdmin(501, "Verificada")]);

  await assert.rejects(
    scanObservedVerifiedMarkers(api, GROUP_ID, data),
    (error: unknown) =>
      error instanceof VerifiedMarkerScanError &&
      error.stage === "verified_record_lookup" &&
      error.reason === "missing_configuration",
  );

  const outcome = await runVerifiedMarkerScan({ api, groupId: GROUP_ID, data });
  assert.equal(outcome.ok, false);
  assert.match(outcome.userMessage, /configuración de la base de datos de ZEUS/);
  assert.match(outcome.detail, /etapa=verified_record_lookup motivo=missing_configuration/);
});

test("una tabla de candidatas ausente se clasifica como migración pendiente", async () => {
  enableSupabaseMock();
  const data = scanData();
  const api = mockAdminListApi([makeAdmin(501, "Verificada")]);
  reviewReadError = { ...MISSING_TABLE_ERROR };

  await assert.rejects(
    scanObservedVerifiedMarkers(api, GROUP_ID, data),
    (error: unknown) =>
      error instanceof VerifiedMarkerScanError &&
      error.stage === "review_lookup" &&
      error.reason === "missing_table",
  );

  const outcome = await runVerifiedMarkerScan({ api, groupId: GROUP_ID, data });
  assert.equal(outcome.ok, false);
  assert.match(outcome.userMessage, /Aplica la migración pendiente/);
  assert.match(outcome.detail, /etapa=review_lookup motivo=missing_table/);
  assert.equal(reviewRows.length, 0);
  assert.equal(verifiedRows.length, 0);
});

test("un fallo al registrar una candidata no toca el registro de verificadas", async () => {
  enableSupabaseMock();
  const data = scanData();
  const api = mockAdminListApi([makeAdmin(501, "Verificada")]);
  reviewWriteError = { ...MISSING_TABLE_ERROR };

  await assert.rejects(
    scanObservedVerifiedMarkers(api, GROUP_ID, data),
    (error: unknown) =>
      error instanceof VerifiedMarkerScanError &&
      error.stage === "candidate_registration" &&
      error.reason === "missing_table",
  );

  assert.equal(reviewRows.length, 0);
  assert.equal(verifiedRows.length, 0);
  assert.equal(auditRows.size, 0);
});

test("los registros anteriores se conservan si el escaneo falla a mitad", async () => {
  enableSupabaseMock();
  const data = scanData();
  reviewRows.push({
    group_id: GROUP_ID,
    user_id: 501,
    username: "user_501",
    display_name: "User501",
    observed_tag: "Verificada (previo)",
    status: "pending",
    first_seen_at: new Date(0).toISOString(),
    last_seen_at: new Date(0).toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    review_claim_token: null,
    review_claim_expires_at: null,
    review_claim_previous_status: null,
  });
  verifiedRows.push(activeVerifiedRecord(GROUP_ID, 502));
  const reviewSnapshot = structuredClone(reviewRows);
  const verifiedSnapshot = structuredClone(verifiedRows);
  const api = mockAdminListApi([
    makeAdmin(501, "Verificada"),
    makeAdmin(502, "Verificada"),
    makeAdmin(503, "Verificada"),
  ]);
  reviewWriteError = { ...MISSING_TABLE_ERROR };

  await assert.rejects(
    scanObservedVerifiedMarkers(api, GROUP_ID, data),
    (error: unknown) =>
      error instanceof VerifiedMarkerScanError &&
      error.stage === "candidate_registration",
  );

  assert.deepEqual(reviewRows, reviewSnapshot);
  assert.deepEqual(verifiedRows, verifiedSnapshot);
});

test("la clasificación de fallos cubre configuración, tabla, red y error desconocido", () => {
  assert.equal(
    classifyVerifiedStoreFailure(
      new Error("Faltan credenciales de Supabase para verificadas."),
    ),
    "missing_configuration",
  );
  assert.equal(classifyVerifiedStoreFailure({ ...MISSING_TABLE_ERROR }), "missing_table");
  assert.equal(
    classifyVerifiedStoreFailure({ code: "42P01", message: "relation does not exist" }),
    "missing_table",
  );
  assert.equal(classifyVerifiedStoreFailure(new TypeError("fetch failed")), "network");
  assert.equal(
    classifyVerifiedStoreFailure({ code: "ECONNRESET", message: "socket hang up" }),
    "network",
  );
  assert.equal(classifyVerifiedStoreFailure(new Error("algo inesperado")), "unknown");
});

test("el detalle de diagnóstico nunca incluye tokens ni claves", () => {
  const token = "123456789:AAHdqTcCHMvMPFrcPP1q3V4XqQZQpLzZxYw";
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const error = new VerifiedMarkerScanError("candidate_registration", "unknown", {
    cause: new Error(`fallo con ${token} y ${jwt}`),
  });

  const detail = describeVerifiedMarkerScanError(error);

  assert.ok(!detail.includes(token), "el token de bot no debe aparecer");
  assert.ok(!detail.includes(jwt), "el JWT no debe aparecer");
  assert.match(detail, /etapa=candidate_registration motivo=unknown/);
  assert.match(detail, /\[REDACTADO\]/);
  assert.equal(sanitizeScanDetail(`x ${token}`), "x [REDACTADO]");
});

test("un fallo de Telegram al listar administradores conserva su mensaje específico", async () => {
  enableSupabaseMock();
  const data = scanData();
  const api = mockAdminListApi(
    Object.assign(new Error("Forbidden: bot is not a member"), {
      error_code: 403,
      description: "Forbidden: bot is not a member of the supergroup",
    }),
  );

  await assert.rejects(
    scanObservedVerifiedMarkers(api, GROUP_ID, data),
    (error: unknown) =>
      error instanceof VerifiedMarkerAdminLookupError && error.permissionDenied,
  );

  const outcome = await runVerifiedMarkerScan({ api, groupId: GROUP_ID, data });
  assert.equal(outcome.ok, false);
  assert.match(outcome.userMessage, /Telegram no permitió consultar los administradores/);
  assert.match(outcome.detail, /etapa=admin_lookup permisoDenegado=true/);
});

test("administradoras sin título o con título no coincidente no generan candidatas", async () => {
  enableSupabaseMock();
  const data = scanData();
  const api = mockAdminListApi([
    makeAdmin(510),
    makeAdmin(511, "Vendedora"),
    makeAdmin(512, "VIP"),
  ]);

  const outcome = await runVerifiedMarkerScan({ api, groupId: GROUP_ID, data });

  assert.equal(outcome.ok, true);
  assert.match(outcome.userMessage, /0 candidatas nuevas/);
  assert.equal(reviewRows.length, 0);
  assert.equal(verifiedRows.length, 0);
});

test("reconoce títulos con mayúsculas y espacios, sin duplicar y mostrando el resultado", async () => {
  enableSupabaseMock();
  const data = scanData();
  const api = mockAdminListApi([makeAdmin(520, "   VERIFICADA   ")]);

  const first = await runVerifiedMarkerScan({ api, groupId: GROUP_ID, data });
  const second = await runVerifiedMarkerScan({ api, groupId: GROUP_ID, data });

  assert.equal(first.ok, true);
  assert.match(first.userMessage, /1 candidatas nuevas/);
  assert.match(second.userMessage, /0 candidatas nuevas/);
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0]?.status, "pending");
  assert.equal(
    reviewRows[0]?.observed_tag,
    "Verificada (escaneo de título/perfil/actividad reciente)",
  );
  assert.equal(verifiedRows.length, 0, "una coincidencia no crea verificación activa");

  const reviews = await listVerifiedTagReviews(GROUP_ID);
  const panel = buildVerifiedTagCandidatesPanel(reviews, 0, "Mount Olympus 🔥 Group");
  assert.match(panel.text, /User520/);
  assert.match(panel.text, /pending/);
  assert.ok(
    panel.keyboard.inline_keyboard
      .flat()
      .some((button) => buttonCallbackData(button) === "vu:apply:approve:520"),
  );
});

