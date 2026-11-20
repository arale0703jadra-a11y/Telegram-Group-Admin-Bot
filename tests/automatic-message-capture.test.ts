import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { MyContext } from "../src/types.js";

process.env.OWNER_ID = "900000101";
process.env.ALEXIITA_TELEGRAM_ID = "900000102";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000103";
process.env.SUPABASE_URL = "https://sessions-test.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

globalThis.fetch = (async () =>
  new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { privateInput } = await import("../src/commands/private-input.js");
const { moderationActions } = await import("../src/menus/actions.js");
const { flushStorage, getGroupData, saveGroupData } = await import("../src/storage/index.js");

const OWNER_ID = 900000101;

type Pending = MyContext["session"]["user"]["pendingAction"];

function mediaContext(options: {
  message: Record<string, unknown>;
  pending?: Pending;
  fromId?: number;
  memberStatus?: string;
}) {
  const fromId = options.fromId ?? OWNER_ID;
  const user = { id: fromId, is_bot: false, first_name: "Admin" };
  const message = {
    message_id: 1,
    date: 1,
    from: user,
    chat: { id: fromId, type: "private" as const },
    ...options.message,
  };
  const replies: string[] = [];
  const ctx = {
    update: { update_id: 1, message },
    message,
    chat: message.chat,
    from: user,
    me: { id: 900000999, is_bot: true, first_name: "ZEUS" },
    session: {
      user: {
        pendingAction: options.pending,
        selectedGroupId: -100900101,
        selectedGroupTitle: "Grupo Prueba",
      },
      group: {},
    },
    api: {
      getChatMember: async () => ({ status: options.memberStatus ?? "administrator" }),
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    },
  } as unknown as MyContext;
  return { ctx, replies };
}

async function moderationCallback(options: {
  data: string;
  pending?: Pending;
  selectedGroupId?: number;
  memberStatus?: string;
}) {
  const user = { id: OWNER_ID, is_bot: false, first_name: "Admin" };
  const answers: string[] = [];
  const editCalls: string[] = [];
  const ctx = {
    update: {
      update_id: 1,
      callback_query: {
        id: "cb",
        from: user,
        data: options.data,
        message: { message_id: 5, chat: { id: OWNER_ID, type: "private" } },
      },
    },
    callbackQuery: {
      id: "cb",
      from: user,
      data: options.data,
      message: { message_id: 5, chat: { id: OWNER_ID, type: "private" } },
    },
    chat: { id: OWNER_ID, type: "private" as const },
    from: user,
    me: { id: 900000999, is_bot: true, first_name: "ZEUS" },
    session: {
      user: {
        selectedGroupId: options.selectedGroupId ?? -100900101,
        selectedGroupTitle: "Grupo Prueba",
        pendingAction: options.pending,
      },
      group: {},
    },
    api: {
      getChatMember: async () => ({ status: options.memberStatus ?? "administrator" }),
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        editCalls.push(text);
        return { message_id: 5 } as never;
      },
    },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text ?? "");
      return true;
    },
  } as unknown as MyContext;
  await moderationActions.middleware()(ctx, async () => undefined);
  return { ctx, answers, editCalls };
}

test("captura una fotografía con caption y entidades para vista previa", async () => {
  const { ctx, replies } = mediaContext({
    message: {
      photo: [
        { file_id: "small", file_unique_id: "u1", width: 100, height: 100 },
        { file_id: "large-file-id", file_unique_id: "u2", width: 400, height: 400 },
      ],
      caption: "Mi foto",
      caption_entities: [{ type: "bold", offset: 0, length: 7 }],
    },
    pending: { kind: "automaticMessage", groupId: -100900101 },
  });
  await privateInput.middleware()(ctx, async () => undefined);
  const pending = ctx.session.user.pendingAction;
  assert.ok(pending && pending.kind === "automaticMessageMedia");
  if (pending?.kind === "automaticMessageMedia") {
    assert.equal(pending.groupId, -100900101);
    assert.equal(pending.draft.type, "photo");
    assert.equal(pending.draft.fileId, "large-file-id");
    assert.equal(pending.draft.caption, "Mi foto");
    assert.deepEqual(pending.draft.captionEntities, [{ type: "bold", offset: 0, length: 7 }]);
  }
  assert.ok(replies.some((r) => r.includes("VISTA PREVIA")));
});

test("captura un vídeo sin caption", async () => {
  const { ctx } = mediaContext({
    message: {
      video: { file_id: "video-file-id", file_unique_id: "vu", width: 640, height: 480, duration: 10 },
    },
    pending: { kind: "automaticMessage", groupId: -100900101 },
  });
  await privateInput.middleware()(ctx, async () => undefined);
  const pending = ctx.session.user.pendingAction;
  assert.ok(pending && pending.kind === "automaticMessageMedia");
  if (pending?.kind === "automaticMessageMedia") {
    assert.equal(pending.draft.type, "video");
    assert.equal(pending.draft.fileId, "video-file-id");
    assert.equal(pending.draft.caption, undefined);
    assert.equal(pending.draft.captionEntities, undefined);
  }
});

test("captura una fotografía sin caption", async () => {
  const { ctx } = mediaContext({
    message: {
      photo: [{ file_id: "only-id", file_unique_id: "u1", width: 100, height: 100 }],
    },
    pending: { kind: "automaticMessage", groupId: -100900101 },
  });
  await privateInput.middleware()(ctx, async () => undefined);
  const pending = ctx.session.user.pendingAction;
  assert.ok(pending && pending.kind === "automaticMessageMedia");
  if (pending?.kind === "automaticMessageMedia") {
    assert.equal(pending.draft.type, "photo");
    assert.equal(pending.draft.fileId, "only-id");
    assert.equal(pending.draft.caption, undefined);
  }
});

test("rechaza contenido de un usuario no autorizado", async () => {
  const { ctx, replies } = mediaContext({
    message: {
      photo: [{ file_id: "x", file_unique_id: "u1", width: 1, height: 1 }],
    },
    pending: { kind: "automaticMessage", groupId: -100900101 },
    fromId: 424242,
  });
  await privateInput.middleware()(ctx, async () => undefined);
  assert.equal(ctx.session.user.pendingAction, undefined);
  assert.ok(replies.some((r) => r.includes("No autorizado")));
});

test("rechaza contenido si el usuario dejó de ser administrador del grupo", async () => {
  const { ctx, replies } = mediaContext({
    message: {
      video: { file_id: "v", file_unique_id: "vu", width: 1, height: 1, duration: 1 },
    },
    pending: { kind: "automaticMessage", groupId: -100900202 },
    memberStatus: "member",
  });
  await privateInput.middleware()(ctx, async () => undefined);
  assert.equal(ctx.session.user.pendingAction, undefined);
  assert.ok(replies.some((r) => r.includes("Ya no eres administrador")));
});

test("guardar una vista previa persiste la configuración multimedia", async () => {
  const groupId = -Math.floor(Date.now()) - 2001;
  const file = resolve(process.cwd(), "data", "storage", `${groupId}.json`);
  try {
    const seeded = await getGroupData(groupId);
    seeded.automaticMessage = { enabled: false, message: "Texto previo", intervalMinutes: 60 };
    await saveGroupData(groupId, seeded);
    await flushStorage();

    const { ctx } = await moderationCallback({
      data: `am:save:${groupId}`,
      selectedGroupId: groupId,
      pending: {
        kind: "automaticMessageMedia",
        groupId,
        draft: { type: "photo", fileId: "PHOTO_SAVED", caption: "Guardada" },
      },
    });

    assert.equal(ctx.session.user.pendingAction, undefined);
    const saved = (await getGroupData(groupId)).automaticMessage;
    assert.ok(saved);
    assert.equal(saved.type, "photo");
    assert.equal(saved.fileId, "PHOTO_SAVED");
    assert.equal(saved.caption, "Guardada");
    assert.equal(saved.message, undefined);
  } finally {
    await flushStorage();
    if (existsSync(file)) unlinkSync(file);
  }
});

test("cancelar la vista previa limpia el pendiente sin guardar", async () => {
  const groupId = -Math.floor(Date.now()) - 2002;
  const { ctx, answers } = await moderationCallback({
    data: `am:preview-cancel:${groupId}`,
    selectedGroupId: groupId,
    pending: {
      kind: "automaticMessageMedia",
      groupId,
      draft: { type: "video", fileId: "V" },
    },
  });
  assert.equal(ctx.session.user.pendingAction, undefined);
  assert.ok(answers.some((a) => a.includes("cancelada")));
});

test("no guarda una vista previa cuyo grupo no coincide con el callback", async () => {
  const groupA = -Math.floor(Date.now()) - 3001;
  const groupB = -Math.floor(Date.now()) - 3002;
  const file = resolve(process.cwd(), "data", "storage", `${groupB}.json`);
  try {
    const { ctx, answers } = await moderationCallback({
      data: `am:save:${groupB}`,
      selectedGroupId: groupB,
      pending: {
        kind: "automaticMessageMedia",
        groupId: groupA,
        draft: { type: "photo", fileId: "WRONG" },
      },
    });
    assert.equal(ctx.session.user.pendingAction?.kind, "automaticMessageMedia");
    assert.equal((await getGroupData(groupB)).automaticMessage, undefined);
    assert.ok(answers.some((a) => a.includes("ya no es válida")));
  } finally {
    await flushStorage();
    if (existsSync(file)) unlinkSync(file);
  }
});