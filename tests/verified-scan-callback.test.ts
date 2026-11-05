import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import { moderationActions } from "../src/menus/actions.js";
import {
  buildVerifiedModelsPanel,
  buildVerifiedTagCandidatesPanel,
} from "../src/menus/panels.js";
import { listVerifiedTagReviews } from "../src/services/verified-tag-reviews.js";
import { getVerifiedUsers, type VerifiedUser } from "../src/services/verified-users.js";
import type { MyContext } from "../src/types.js";
import { buttonCallbackData } from "./helpers.js";

process.env.SUPABASE_URL = "https://verified-scan-callback.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const GROUP_ID = -1006665554441;
const PANEL_CHAT_ID = 9876543210;
const ACTOR_ID = 424242;

const reviewRows: Array<Record<string, unknown>> = [];
const verifiedRows: VerifiedUser[] = [];
let reviewWriteError: Record<string, unknown> | undefined;

const realFetch = globalThis.fetch;

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

  if (route === "system_owner" && method === "GET") {
    const owner = { owner_user_id: ACTOR_ID };
    return response(objectResponse ? owner : [owner]);
  }

  if (route === "verified_users" && method === "GET") {
    const rows = verifiedRows.filter((row) => {
        const record = row as unknown as Record<string, unknown>;
        for (const [key, expression] of url.searchParams.entries()) {
          if (key === "select" || key === "order" || key === "limit") continue;
          const separator = expression.indexOf(".");
          const operator = expression.slice(0, separator);
          const value = expression.slice(separator + 1);
          if (operator === "eq" && String(record[key]) !== value) return false;
          if (operator === "is" && value === "null" && record[key] != null) return false;
        }
        return true;
      });
    const range = headers.get("range") ?? "0-999";
    const [rangeStart, rangeEnd] = range.split("-").map(Number);
    const visible = rows.slice(rangeStart ?? 0, (rangeEnd ?? rows.length - 1) + 1);
    return new Response(JSON.stringify(visible), {
      status: 206,
      headers: {
        "content-type": "application/json",
        "content-range": visible.length
          ? `${rangeStart ?? 0}-${(rangeStart ?? 0) + visible.length - 1}/${rows.length}`
          : `*/${rows.length}`,
      },
    });
  }

  if (route === "verified_member_tag_reviews") {
    if (method === "GET") {
      return response(
        reviewRows.filter((row) => {
          for (const [key, expression] of url.searchParams.entries()) {
            if (key === "select" || key === "order" || key === "limit") continue;
            const separator = expression.indexOf(".");
            const operator = expression.slice(0, separator);
            const value = expression.slice(separator + 1);
            if (operator === "eq" && String(row[key]) !== value) return false;
            if (operator === "is" && value === "null" && row[key] != null) return false;
          }
          return true;
        }),
      );
    }
    if (method === "POST") {
      if (reviewWriteError) {
        return response(reviewWriteError, 404);
      }
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
    return response([]);
  }
  return response({ message: `Unexpected mock route ${route}` }, 404);
};

test.after(() => {
  globalThis.fetch = realFetch;
});

test.beforeEach(() => {
  reviewRows.length = 0;
  verifiedRows.length = 0;
  reviewWriteError = undefined;
});

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

function createScanContext(input: {
  groupId: number;
  admins: ChatMember[] | Error;
  userId?: number;
  callbackData?: string;
  beforeAdminList?: () => Promise<void>;
}): { ctx: MyContext; replies: string[]; answers: string[] } {
  const userId = input.userId ?? ACTOR_ID;
  const actor = { id: userId, is_bot: false, first_name: "PanelAdmin" };
  const replies: string[] = [];
  const answers: string[] = [];
  const api = {
    getChatMember: async (): Promise<ChatMember> =>
      ({
        status: "administrator",
        user: actor,
        is_anonymous: false,
        can_restrict_members: true,
      }) as ChatMember,
    getChatAdministrators: async () => {
      await input.beforeAdminList?.();
      if (input.admins instanceof Error) throw input.admins;
      return input.admins as Awaited<ReturnType<Api["getChatAdministrators"]>>;
    },
  };
  const ctx = {
    update: {
      callback_query: {
        id: "cb-1",
        chat_instance: "ci",
        from: actor,
        data: input.callbackData ?? "vu:scan_now",
      },
    },
    callbackQuery: {
      id: "cb-1",
      chat_instance: "ci",
      from: actor,
      data: input.callbackData ?? "vu:scan_now",
    },
    chat: { id: PANEL_CHAT_ID, type: "private", first_name: "PanelAdmin" },
    from: actor,
    session: {
      group: {},
      user: {
        selectedGroupId: input.groupId,
        selectedGroupTitle: "Mount Olympus 🔥 Group",
      },
    },
    api,
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1, date: 0, chat: ctx.chat, text };
    },
    answerCallbackQuery: async (argument?: string | { text?: string }) => {
      answers.push(
        typeof argument === "string" ? argument : (argument?.text ?? ""),
      );
      return true;
    },
  };
  return { ctx: ctx as unknown as MyContext, replies, answers };
}

async function withCapturedLogs(action: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    await action();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return captured;
}

test("legacy direct approval callbacks cannot verify without a session-bound confirmation", async () => {
  reviewRows.push({
    group_id: GROUP_ID,
    user_id: 9001,
    username: "candidate",
    display_name: "Candidate",
    observed_tag: "Verificada",
    status: "pending",
    first_seen_at: new Date(0).toISOString(),
    last_seen_at: new Date(0).toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    review_claim_token: null,
    review_claim_expires_at: null,
    review_claim_previous_status: null,
  });
  const { ctx, answers } = createScanContext({
    groupId: GROUP_ID,
    admins: [],
    callbackData: "vu:apply:approve:9001",
  });

  await moderationActions.middleware()(ctx, async () => {});

  assert.ok(answers.some((answer) => /confirmación expiró|no pertenece/u.test(answer)));
  assert.equal(verifiedRows.length, 0);
  assert.equal(reviewRows[0]?.status, "pending");
});

test("el panel de gestión permite iniciar sincronización manual sin conferir verificación", () => {
  const panel = buildVerifiedModelsPanel(
    [],
    0,
    "Mount Olympus 🔥 Group",
    ["Verificada"],
    true,
  );
  const callbacks = panel.keyboard.inline_keyboard.flat().map(buttonCallbackData);
  assert.ok(callbacks.includes("vu:scan_now"));
  assert.ok(callbacks.includes("vu:candidates:0"));
});

test("fa:verified abre la lista real y no vuelve al panel de entrada", async () => {
  const { ctx, replies } = createScanContext({
    groupId: GROUP_ID,
    admins: [],
    callbackData: "fa:verified",
  });
  await moderationActions.middleware()(ctx, async () => {});

  assert.ok(replies.some((text) => /Cargando la página solicitada/u.test(text)));
  const finalPanel = replies.at(-1) ?? "";
  assert.match(finalPanel, /GESTIÓN DE VERIFICADAS/u);
  assert.match(finalPanel, /Registros activos: 0/u);
  assert.doesNotMatch(finalPanel, /Abre «Verificadas» para consultar/u);
});

test("vu:scan_now ejecuta el escaneo, registra candidatas y no duplica al repetir", async () => {
  const { ctx, replies, answers } = createScanContext({
    groupId: GROUP_ID,
    admins: [makeAdmin(9001, "Verificada")],
  });
  const middleware = moderationActions.middleware();

  const logs = await withCapturedLogs(async () => {
    await middleware(ctx, async () => {});
  });

  assert.equal(answers[0], "Iniciando escaneo...");
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Escaneo completado: 1 usuarios observados/);
  assert.match(replies[0], /1 candidatas nuevas/);
  assert.ok(
    logs.some(
      (line) =>
        line.includes(`[VERIFIED_MARKER_SCAN] groupId=${GROUP_ID} ok=true`) &&
        line.includes("etapa=completado"),
    ),
    "el escaneo exitoso debe registrarse con su detalle técnico",
  );

  const reviews = await listVerifiedTagReviews(GROUP_ID);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.status, "pending");
  assert.equal(reviews[0]?.user_id, 9001);
  assert.equal(
    reviews[0]?.observed_tag,
    "Verificada (escaneo de título/perfil/actividad reciente)",
  );

  const candidatesPanel = buildVerifiedTagCandidatesPanel(
    reviews,
    0,
    "Mount Olympus 🔥 Group",
  );
  assert.match(candidatesPanel.text, /User9001/);
  assert.match(candidatesPanel.text, /Verificada/);

  const verifiedPanel = buildVerifiedModelsPanel(
    await getVerifiedUsers(GROUP_ID),
    0,
    "Mount Olympus 🔥 Group",
    ["Verificada"],
    true,
  );
  assert.match(verifiedPanel.text, /Aún no hay usuarias verificadas en este grupo/);

  replies.length = 0;
  await withCapturedLogs(async () => {
    await middleware(ctx, async () => {});
  });
  assert.match(replies[0], /0 candidatas nuevas/);
  assert.equal((await listVerifiedTagReviews(GROUP_ID)).length, 1);
});

test("sincronizaciones manuales simultáneas del mismo grupo se deduplican", async () => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { ctx, replies } = createScanContext({
    groupId: GROUP_ID,
    admins: [makeAdmin(9001, "Verificada")],
    beforeAdminList: async () => {
      markStarted();
      await wait;
    },
  });
  const middleware = moderationActions.middleware();
  const firstScan = withCapturedLogs(async () => {
    await middleware(ctx, async () => {});
  });
  await started;
  await middleware(ctx, async () => {});

  assert.ok(replies.some((reply) => /Ya hay una sincronización en curso/u.test(reply)));
  release();
  await firstScan;
  assert.equal((await listVerifiedTagReviews(GROUP_ID)).length, 1);
});

test("un fallo de la base de datos responde con mensaje claro y conserva registros", async () => {
  reviewRows.push({
    group_id: GROUP_ID,
    user_id: 9100,
    username: "user_9100",
    display_name: "User9100",
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
  const snapshot = structuredClone(reviewRows);
  reviewWriteError = {
    code: "PGRST205",
    message:
      "Could not find the table 'public.verified_member_tag_reviews' in the schema cache",
    details: null,
    hint: null,
  };
  const { ctx, replies } = createScanContext({
    groupId: GROUP_ID,
    admins: [makeAdmin(9100, "Verificada"), makeAdmin(9101, "Verificada")],
  });

  const logs = await withCapturedLogs(async () => {
    await moderationActions.middleware()(ctx, async () => {});
  });

  assert.match(replies[0], /Aplica la migración pendiente/);
  assert.ok(
    logs.some(
      (line) =>
        line.includes(`[VERIFIED_MARKER_SCAN] groupId=${GROUP_ID} ok=false`) &&
        line.includes("etapa=candidate_registration motivo=missing_table"),
    ),
    "el fallo debe registrarse con etapa y motivo reales",
  );
  assert.deepEqual(reviewRows, snapshot, "los registros previos se conservan");
  assert.equal(verifiedRows.length, 0);
});

test("si Telegram no deja listar administradores se informa el problema de permisos", async () => {
  const { ctx, replies } = createScanContext({
    groupId: GROUP_ID,
    admins: Object.assign(new Error("Forbidden"), {
      error_code: 403,
      description: "Forbidden: bot is not a member of the supergroup",
    }),
  });

  const logs = await withCapturedLogs(async () => {
    await moderationActions.middleware()(ctx, async () => {});
  });

  assert.match(replies[0], /Telegram no permitió consultar los administradores/);
  assert.ok(
    logs.some(
      (line) =>
        line.includes(`groupId=${GROUP_ID} ok=false`) &&
        line.includes("etapa=admin_lookup permisoDenegado=true"),
    ),
  );
  assert.equal(reviewRows.length, 0);
});
