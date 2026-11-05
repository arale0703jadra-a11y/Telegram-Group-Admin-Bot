import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { MiddlewareFn } from "grammy";
import type { MyContext } from "../src/types.js";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-menu-entry-"));
process.chdir(testDataDirectory);
after(async () => {
  process.chdir(originalCwd);
  await rm(testDataDirectory, { recursive: true, force: true });
});

process.env.OWNER_ID = "900000041";
process.env.ALEXIITA_TELEGRAM_ID = "900000042";
process.env.SUPABASE_URL = "https://menu-entry.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const OWNER = 900000041;
const BOT_ID = 900000040;
const GROUP_ID = -910090;

/**
 * Regresión de la causa raíz de "/menu no responde":
 * antes de la migración 019 la lectura de sesión fallaba (PGRST202) y el
 * fail-closed abortaba el update ANTES del handler; la agrupación limitó el
 * aviso a uno por incidente; tras restaurar la persistencia el flujo completo
 * debe responder. Ejercita el middleware de sesión REAL más la cadena de
 * middlewares previos al registro de comandos, no sólo el handler aislado.
 */
type ReadMode = "empty" | "fail" | "corrupt";
let readMode: ReadMode = "empty";
const writeBodies: string[] = [];
const fetchLog: string[] = [];

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = input instanceof Request ? input.url : String(input);
  fetchLog.push(url);
  if (url.includes("system_owner")) {
    return json([{ owner_user_id: OWNER }], 200);
  }
  if (url.includes("zeus_read_user_session")) {
    if (readMode === "fail") {
      return json({ code: "08006", message: "database unavailable" }, 503);
    }
    if (readMode === "corrupt") {
      // Fila existente con payload no-objeto: DEBE tratarse como error,
      // nunca como sesión vacía válida.
      return json(
        [
          {
            payload: 12345,
            version: 1,
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            pending_action_expires_at: null,
          },
        ],
        200,
      );
    }
    return json([], 200); // sesión nueva / expirada en servidor
  }
  if (url.includes("zeus_write_user_session")) {
    if (typeof init?.body === "string") writeBodies.push(init.body);
    return json([{ version: 1 }], 200);
  }
  return json({ code: "08006", message: "database unavailable" }, 503);
}) as typeof fetch;

const { sessionMiddleware, resetSessionPersistenceAlerts } = await import(
  "../src/middleware/session.js"
);
const { menuCommand } = await import("../src/commands/menu.js");
const { cleanServiceMessages } = await import(
  "../src/commands/clean-service-messages.js"
);
const { illegalModeration } = await import("../src/filters/illegal-moderation.js");
const { deleteGroupCommand } = await import(
  "../src/commands/delete-group-command.js"
);
const { deletedAccounts } = await import("../src/filters/deleted-accounts.js");
const { adminGuardian } = await import("../src/security/admin-guardian.js");
const { botAdditionGuard } = await import(
  "../src/filters/bot-addition-guard.js"
);
const { verifiedMarkerDetection } = await import(
  "../src/filters/verified-marker-detection.js"
);
const { profileChecker } = await import("../src/filters/profile-checker.js");
const { adminImpersonation } = await import(
  "../src/filters/admin-impersonation.js"
);
const { antiRaid } = await import("../src/filters/anti-raid.js");
const { emergencyLockdown } = await import(
  "../src/filters/emergency-lockdown.js"
);
const { newMemberQuarantine } = await import(
  "../src/filters/new-member-quarantine.js"
);
const { linkFilter } = await import("../src/filters/link-filter.js");
const { antiSpam } = await import("../src/filters/anti-spam.js");
const { promotionModeration } = await import("../src/filters/moderation.js");
const { registerGroup, markUserAsAdmin } = await import(
  "../src/services/group-registry.js"
);
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");
const { UserSessionPersistenceError } = await import(
  "../src/services/user-session-storage.js"
);

type ChainEntry =
  | MiddlewareFn<MyContext>
  | { middleware: () => MiddlewareFn<MyContext> };

/**
 * Orden REAL de bot.ts entre bot.use(cleanServiceMessages) y
 * registerCommands(bot). Cualquier middleware que no llame a next() en un
 * mensaje privado mataría /menu en silencio. Los middlewares exclusivos de
 * chat_member / my_chat_member / new_chat_members se omiten porque su filtro
 * no matchea texto (paso automático); el handler grande de bot.ts (L229)
 * está verificado en código con next() en chats privados.
 */
const PRE_MENU_CHAIN = [
  cleanServiceMessages,
  sessionMiddleware,
  illegalModeration,
  deleteGroupCommand,
  deletedAccounts,
  adminGuardian,
  botAdditionGuard,
  verifiedMarkerDetection,
  profileChecker,
  adminImpersonation,
  antiRaid,
  emergencyLockdown,
  newMemberQuarantine,
  linkFilter,
  antiSpam,
  promotionModeration,
];

/**
 * Cadena REAL de bot.ts: sessionMiddleware envuelve con su `next()` a todos
 * los middlewares y al handler de /menu (registerCommands está DESPUÉS de
 * session en bot.ts, dentro de la misma cadena). grammY ejecuta finish() al
 * deshacer la cadena, es decir, DESPUÉS de que el handler fija la sesión.
 * Cualquier middleware que no llame a next() en privado mataría /menu.
 */
const MENU_CHAIN: ChainEntry[] = [
  ...PRE_MENU_CHAIN,
  menuCommand,
] as ChainEntry[];

async function runFullMenuFlow(ctx: MyContext): Promise<void> {
  const dispatch = async (index: number): Promise<void> => {
    if (index === MENU_CHAIN.length) return;
    const entry = MENU_CHAIN[index]!;
    // sessionMiddleware es una MiddlewareFn plana; el resto son Composer.
    const middleware =
      typeof entry === "function"
        ? entry
        : (entry as { middleware: () => MiddlewareFn<MyContext> }).middleware();
    await middleware(ctx, () => dispatch(index + 1));
  };
  await dispatch(0);
}

interface EntryHarness {
  ctx: MyContext;
  replies: Array<{ text: string; hasKeyboard: boolean }>;
}

function createPrivateMenuCtx(): EntryHarness {
  const chat = { id: OWNER, type: "private" as const };
  const message = {
    message_id: 1,
    date: 0,
    text: "/menu",
    entities: [{ type: "bot_command" as const, offset: 0, length: 5 }],
    from: { id: OWNER, is_bot: false, first_name: "User" },
    chat,
  };
  const replies: EntryHarness["replies"] = [];
  const ctx = {
    update: { update_id: 1, message },
    message,
    chat,
    from: { id: OWNER, is_bot: false, first_name: "User" },
    me: {
      id: BOT_ID,
      is_bot: true,
      username: "zeus_test",
      first_name: "ZEUS",
    },
    reply: async (text: string, other?: { reply_markup?: unknown }) => {
      replies.push({ text, hasKeyboard: Boolean(other?.reply_markup) });
      return { message_id: 300 + replies.length };
    },
    deleteMessage: async () => true,
    api: {
      sendMessage: async (_userId: number, text: string) => {
        replies.push({ text, hasKeyboard: true });
        return { message_id: 400 };
      },
      deleteMessage: async () => true,
      getMe: async () => ({
        id: BOT_ID,
        is_bot: true,
        first_name: "ZEUS",
        username: "zeus_test",
      }),
      getChatMember: async (
        _chatId: number | string,
        userId: number,
      ): Promise<ChatMember> => {
        if (userId === BOT_ID) {
          return {
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
            can_manage_chat: true,
            can_delete_messages: true,
            can_restrict_members: true,
            can_promote_members: false,
            can_invite_users: true,
            can_pin_messages: false,
            can_manage_topics: false,
          } as ChatMember;
        }
        return {
          status: userId === OWNER ? "administrator" : "member",
          user: { id: userId, is_bot: false, first_name: "User" },
        } as ChatMember;
      },
      getChat: async () => ({
        id: GROUP_ID,
        type: "supergroup",
        title: "Grupo Entrada",
      }),
    },
  } as unknown as MyContext;
  return { ctx, replies };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    lines.push(`ERROR ${args.map(String).join(" ")}`);
  };
  console.info = (...args: unknown[]) => {
    lines.push(`INFO ${args.map(String).join(" ")}`);
  };
  console.warn = (...args: unknown[]) => {
    lines.push(`WARN ${args.map(String).join(" ")}`);
  };
  return {
    lines,
    restore: () => {
      console.error = originalError;
      console.info = originalInfo;
      console.warn = originalWarn;
    },
  };
}

test("sin grupos administrables /menu responde (nunca queda en silencio)", async () => {
  resetSecurityCaches();
  resetSessionPersistenceAlerts();
  readMode = "empty";
  const { ctx, replies } = createPrivateMenuCtx();
  await runFullMenuFlow(ctx);
  assert.equal(replies.length, 1, "siempre debe responder algo");
  assert.match(replies[0]?.text ?? "", /ningún grupo administrable/u);
});

test("cadena real de middlewares: /menu privado llega al handler y persiste la sesión", async () => {
  resetSecurityCaches();
  resetSessionPersistenceAlerts();
  readMode = "empty";
  writeBodies.length = 0;
  fetchLog.length = 0;
  registerGroup(GROUP_ID, "Grupo Entrada");
  markUserAsAdmin(GROUP_ID, OWNER);

  const { ctx, replies } = createPrivateMenuCtx();
  await runFullMenuFlow(ctx);

  assert.equal(replies.length, 1, "una única respuesta de panel");
  assert.match(
    replies[0]?.text ?? "",
    /PANEL DE ADMINISTRACIÓN/u,
    "el handler de /menu debe ejecutarse tras toda la cadena",
  );
  assert.equal(replies[0]?.hasKeyboard, true, "el teclado debe adjuntarse");
  assert.ok(
    writeBodies.some((body) => body.includes("user:900000041")),
    "la sesión del usuario debe persistirse tras seleccionar grupo",
  );
});

test("fallo de Supabase: fail-closed, un solo aviso agrupado y recuperación completa", async () => {
  resetSecurityCaches();
  resetSessionPersistenceAlerts();
  readMode = "fail";
  writeBodies.length = 0;
  const logs = captureLogs();
  try {
    // Intento1: lectura caída -> aviso único, handler NO ejecutado y el
    // update se aborta (fail-closed se propaga, igual que en producción).
    const first = createPrivateMenuCtx();
    await assert.rejects(
      () => runFullMenuFlow(first.ctx),
      (error: unknown) =>
        error instanceof UserSessionPersistenceError &&
        error.operation === "read" &&
        error.reason === "unavailable",
      "fail-closed: la excepción de persistencia debe propagarse",
    );
    assert.equal(first.replies.length, 1);
    assert.match(first.replies[0]?.text ?? "", /No se pudo guardar o recuperar/u);
    assert.ok(
      !first.replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN")),
      "fail-closed: sin panel ante error real de Supabase",
    );
    assert.equal(writeBodies.length, 0, "sin escrituras durante el fallo");

    // Intento2: fallo equivalente -> agrupado, sin segundo aviso.
    const second = createPrivateMenuCtx();
    await assert.rejects(
      () => runFullMenuFlow(second.ctx),
      (error: unknown) =>
        error instanceof UserSessionPersistenceError &&
        error.reason === "unavailable",
    );
    assert.equal(second.replies.length, 0, "agrupación: cero tormenta de avisos");
    assert.ok(
      logs.lines.some((line) => line.includes("occurrence=2")),
      "el segundo fallo debe quedar registrado en logs",
    );

    // Recuperación: persistencia vuelve -> panel + aviso único de recuperación.
    readMode = "empty";
    const third = createPrivateMenuCtx();
    await runFullMenuFlow(third.ctx);
    const texts = third.replies.map((r) => r.text);
    assert.ok(
      texts.some((t) => t.includes("PANEL DE ADMINISTRACIÓN")),
      "tras la recuperación /menu debe responder el panel",
    );
    assert.ok(
      texts.some((t) => /se ha restaurado/u.test(t)),
      "debe emitirse el aviso único de recuperación",
    );
    assert.ok(
      logs.lines.some((line) => line.includes("Persistencia restaurada")),
      "la recuperación debe quedar en logs",
    );
    assert.ok(writeBodies.length > 0, "la sesión debe persistirse al recuperar");
  } finally {
    logs.restore();
  }
});

test("sesión corrupta se trata como error, nunca como sesión vacía válida", async () => {
  resetSecurityCaches();
  resetSessionPersistenceAlerts();
  readMode = "corrupt";
  writeBodies.length = 0;
  const logs = captureLogs();
  try {
    const { ctx, replies } = createPrivateMenuCtx();
    await assert.rejects(
      () => runFullMenuFlow(ctx),
      (error: unknown) =>
        error instanceof UserSessionPersistenceError &&
        error.operation === "read" &&
        error.reason === "invalid_data",
      "datos corruptos deben rechazarse como invalid_data",
    );
    assert.equal(replies.length, 1, "respuesta única de error");
    assert.match(replies[0]?.text ?? "", /No se pudo guardar o recuperar/u);
    assert.ok(
      !replies.some((r) => r.text.includes("PANEL DE ADMINISTRACIÓN")),
      "datos corruptos no deben abrir el panel",
    );
    assert.equal(writeBodies.length, 0, "sin escritura sobre sesión corrupta");
    assert.ok(
      logs.lines.some((line) => line.includes("invalid_data")),
      "el motivo invalid_data debe registrarse",
    );
  } finally {
    logs.restore();
    readMode = "empty";
  }
});
