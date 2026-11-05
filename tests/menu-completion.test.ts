import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { InlineKeyboard } from "grammy";
import type { MyContext } from "../src/types.js";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-menu-completion-"));
process.chdir(testDataDirectory);
after(async () => {
  process.chdir(originalCwd);
  await rm(testDataDirectory, { recursive: true, force: true });
});

const OWNER = 900000051;
process.env.OWNER_ID = String(OWNER);
process.env.ALEXIITA_TELEGRAM_ID = "900000052";
process.env.SUPABASE_URL = "https://menu-completion.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

globalThis.fetch = (async () =>
  new Response(JSON.stringify([{ owner_user_id: OWNER }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { buildSubmenuPanel, buildPermissionsInfoPanel } = await import(
  "../src/menus/panels.js"
);
const { menuNavigation, parseMenuAction } = await import("../src/menus/index.js");

function callbackDataOf(panel: { keyboard: InlineKeyboard }): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) =>
      "callback_data" in button && typeof button.callback_data === "string"
        ? button.callback_data
        : "",
    );
}

function createCallbackCtx(data: string): {
  ctx: MyContext;
  answers: string[];
  edits: string[];
} {
  const chat = { id: OWNER, type: "private" as const };
  const answers: string[] = [];
  const edits: string[] = [];
  const callbackQuery = {
    id: "cb-test",
    data,
    chat_instance: "ci-test",
    message: { message_id: 7, chat, date: 0, text: "panel" },
  };
  const ctx = {
    update: { update_id: 1, callback_query: callbackQuery },
    callbackQuery,
    chat,
    from: { id: OWNER, is_bot: false, first_name: "User" },
    me: { id: 1, is_bot: true, username: "zeus_test", first_name: "ZEUS" },
    session: {
      user: {
        selectedGroupId: -910099,
        selectedGroupTitle: "Grupo de prueba",
        persistenceVersion: 0,
      },
    },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text ?? "");
      return true;
    },
    reply: async (text: string) => {
      edits.push(text);
      return { message_id: 8 };
    },
    api: {
      editMessageText: async (
        _chatId: number,
        _messageId: number,
        text: string,
      ) => {
        edits.push(text);
        return true;
      },
      sendMessage: async (_userId: number, text: string) => {
        edits.push(text);
        return { message_id: 9 };
      },
      deleteMessage: async () => true,
      getMe: async () => ({
        id: 1,
        is_bot: true,
        username: "zeus_test",
        first_name: "ZEUS",
      }),
      getChatMember: async (_chatId: number | string, userId: number) => ({
        status: userId === OWNER ? "administrator" : "member",
        user: { id: userId, is_bot: userId === 1, first_name: "User" },
      }),
      getChat: async () => chat,
    },
  } as unknown as MyContext;
  return { ctx, answers, edits };
}

test("ningún submenú declara botones sin callback ni en desarrollo", () => {
  const sections = ["antispam", "inactividad", "limpieza", "filtros", "usuarios"];
  for (const section of sections) {
    const panel = buildSubmenuPanel(section);
    assert.ok(panel, `el submenú ${section} debe existir`);
    const callbacks = callbackDataOf(panel);
    assert.ok(callbacks.length > 0, `${section} debe tener botones`);
    assert.ok(
      callbacks.every((cb) => cb.length > 0),
      `${section}: todos los botones deben tener callback`,
    );
    const development = callbacks.filter((cb) =>
      cb.startsWith("menu:action:"),
    );
    assert.deepEqual(
      development,
      [],
      `${section}: ningún botón puede quedar en "en desarrollo"`,
    );
  }
});

test("el menú de ayuda expone Ver comandos y Sobre permisos reales", () => {
  const callbacks = callbackDataOf(buildSubmenuPanel("ayuda")!);
  assert.ok(callbacks.includes("menu:commands:0"), "Ver comandos cableado");
  assert.ok(
    callbacks.includes("menu:action:ayuda:permisos"),
    "Sobre permisos cableado",
  );
});

test("el panel Sobre permisos explica el modelo real de autorización", () => {
  const panel = buildPermissionsInfoPanel();
  assert.match(panel.text, /no concede por sí solo/u);
  assert.match(panel.text, /Verificadas/u);
  assert.match(panel.text, /un solo uso/u);
  assert.ok(panel.keyboard.inline_keyboard.length > 0);
});

test("router: menu:action:ayuda:permisos renderiza el panel de permisos", async () => {
  assert.deepEqual(parseMenuAction("menu:action:ayuda:permisos"), {
    kind: "action",
    section: "ayuda",
    item: "permisos",
  });
  const { ctx, answers, edits } = createCallbackCtx(
    "menu:action:ayuda:permisos",
  );
  await menuNavigation.middleware()(ctx, async () => undefined);
  assert.equal(answers.length, 1);
  assert.ok(
    edits.length === 1 && edits[0]?.includes("SOBRE PERMISOS"),
    `esperaba panel de permisos; edits=${edits.map((e) => e.slice(0, 30)).join(" | ")}`,
  );
  assert.ok(!edits.some((t) => t.includes("en desarrollo")));
});

test("router: menu:action:ayuda:comandos abre la lista real de comandos", async () => {
  const { ctx, answers, edits } = createCallbackCtx(
    "menu:action:ayuda:comandos",
  );
  await menuNavigation.middleware()(ctx, async () => undefined);
  assert.equal(answers.length, 1);
  assert.equal(edits.length, 1);
  assert.ok(!edits[0]?.includes("en desarrollo"));
});

test("botón obsoleto de sección real navega a su panel real", async () => {
  const { ctx, answers, edits } = createCallbackCtx(
    "menu:action:antispam:activar",
  );
  await menuNavigation.middleware()(ctx, async () => undefined);
  assert.ok(
    answers.some((a) => a.includes("integrada")),
    `answers=${JSON.stringify(answers)}`,
  );
  assert.ok(
    edits.some((t) => t.includes("ANTI-SPAM")),
    `debía abrir el panel real de anti-spam; edits=${edits.map((e) => e.slice(0, 30)).join(" | ")}`,
  );
  assert.ok(!edits.some((t) => t.includes("en desarrollo")));
});

test("sección desconocida conserva el aviso honesto de desarrollo", async () => {
  const { ctx, answers, edits } = createCallbackCtx("menu:action:zzz:qqq");
  await menuNavigation.middleware()(ctx, async () => undefined);
  assert.ok(answers.some((a) => a.includes("en desarrollo")));
  assert.equal(edits.length, 0, "no se finge ningún panel");
});

