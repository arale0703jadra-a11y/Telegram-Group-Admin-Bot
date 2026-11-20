import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Message, MessageEntity, User } from "@grammyjs/types";
import type { MyContext } from "../src/types.js";

const originalCwd = process.cwd();
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalOwnerId = process.env.OWNER_ID;
const originalLinkWhitelist = process.env.LINK_WHITELIST;
const originalBlockMentions = process.env.LINK_FILTER_BLOCK_MENTIONS;

// Aislamiento determinista y sin red: sin SUPABASE_*,
// getVerifiedUserPermissions() devuelve undefined sin llamar a ningún
// servicio externo; sin OWNER_ID/LINK_WHITELIST las políticas quedan en
// sus valores por defecto.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.OWNER_ID;
delete process.env.LINK_WHITELIST;
delete process.env.LINK_FILTER_BLOCK_MENTIONS;

const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-link-policy-"));
process.chdir(testDataDirectory);

after(async () => {
  await flushStorage();
  process.chdir(originalCwd);
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
  if (originalOwnerId === undefined) delete process.env.OWNER_ID;
  else process.env.OWNER_ID = originalOwnerId;
  if (originalLinkWhitelist === undefined) delete process.env.LINK_WHITELIST;
  else process.env.LINK_WHITELIST = originalLinkWhitelist;
  if (originalBlockMentions === undefined) delete process.env.LINK_FILTER_BLOCK_MENTIONS;
  else process.env.LINK_FILTER_BLOCK_MENTIONS = originalBlockMentions;
  await rm(testDataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

const { inspectLinks, linkFilter } = await import("../src/filters/link-filter.js");
const { getScannableMessageContent } = await import(
  "../src/filters/message-content.js"
);
const { containsUrl } = await import("../src/utils/message-content.js");
const { flushStorage, getGroupData, saveGroupData } = await import(
  "../src/storage/index.js"
);
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");

const BOT_ID = 930000002;
const MEMBER_ID = 930000001;

function user(id: number, firstName: string, username?: string): User {
  return {
    id,
    is_bot: false,
    first_name: firstName,
    ...(username ? { username } : {}),
  };
}

interface RunOptions {
  chatId: number;
  messageId: number;
  text?: string;
  caption?: string;
  entities?: MessageEntity[];
  captionEntities?: MessageEntity[];
  edited?: boolean;
  canDelete?: boolean;
  userId?: number;
}

interface RunResult {
  chatId: number;
  messageId: number;
  userId: number;
  deleted: number[];
  nextCalls: number;
  context: MyContext;
}

function createContext(options: RunOptions): RunResult {
  const userId = options.userId ?? MEMBER_ID;
  const chat = { id: options.chatId, type: "supergroup" as const, title: "Test" };
  const sender = user(userId, "Member", "member_nick");
  const message = {
    message_id: options.messageId,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: sender,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.caption === undefined ? {} : { caption: options.caption }),
    ...(options.entities ? { entities: options.entities } : {}),
    ...(options.captionEntities
      ? { caption_entities: options.captionEntities }
      : {}),
  };
  const deleted: number[] = [];
  const canDelete = options.canDelete ?? true;
  const flow: RunResult = {
    chatId: options.chatId,
    messageId: options.messageId,
    userId,
    deleted,
    nextCalls: 0,
    context: undefined as unknown as MyContext,
  };
  flow.context = {
    update: options.edited
      ? { update_id: options.messageId, edited_message: message }
      : { update_id: options.messageId, message },
    msg: message,
    chat,
    from: sender,
    me: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
    api: {
      getChatMember: async (_chatId: number, memberUserId: number) =>
        memberUserId === BOT_ID
          ? {
              status: "administrator",
              user: { id: BOT_ID, is_bot: true, first_name: "ZEUS" },
              can_delete_messages: canDelete,
              can_restrict_members: true,
            }
          : {
              status: "member",
              user: user(memberUserId, "Member"),
              is_protected: false,
            },
      deleteMessage: async (_chatId: number, messageId: number) => {
        deleted.push(messageId);
        return true;
      },
      sendMessage: async () => ({ message_id: 1 }),
    },
  } as unknown as MyContext;
  return flow;
}

async function run(options: RunOptions): Promise<RunResult> {
  resetSecurityCaches();
  const flow = createContext(options);
  await linkFilter.middleware()(flow.context, async () => {
    flow.nextCalls += 1;
  });
  return flow;
}

async function eventsFor(chatId: number) {
  const data = await getGroupData(chatId);
  return data.events.filter((event) => event.type === "ANTISPAM");
}

async function warningsFor(chatId: number, userId = MEMBER_ID) {
  const data = await getGroupData(chatId);
  return data.warnings[String(userId)] ?? [];
}

test("normal URLs and conventional domains are detected as external links", () => {
  for (const text of [
    "https://example.com/path",
    "www.example.com",
    "example.com",
    "mira bit.ly/abc123 ahora",
    "http://sub.domain.example.org/ruta",
  ]) {
    const result = inspectLinks(text, [], { whitelist: [] });
    assert.equal(result.hasLink, true, text);
    assert.equal(result.hasUnauthorizedLink, true, text);
    assert.equal(result.hasExternalLink, true, text);
    assert.ok(result.kinds.includes("externo"), text);
  }
});

test("one-click Telegram invites are classified as invitations", () => {
  for (const text of [
    "https://t.me/+AbCdEf12345",
    "https://telegram.me/joinchat/AAAAAE-example",
    "https://telegram.dog/+xyzXYZ789",
  ]) {
    const result = inspectLinks(text, [], { whitelist: [] });
    assert.equal(result.hasInvite, true, text);
    assert.equal(result.hasUnauthorizedInvite, true, text);
    assert.ok(result.kinds.includes("invitacion"), text);
  }
});

test("private Telegram chat links stay unauthorized even with a broad whitelist", () => {
  const result = inspectLinks("entra por https://t.me/c/1234567890/42", [], {
    whitelist: ["t.me"],
  });
  assert.equal(result.hasPrivateTelegramLink, true);
  assert.equal(result.hasUnauthorizedLink, true);
  assert.equal(result.hasUnauthorizedInvite, true);
  assert.ok(result.kinds.includes("privado-telegram"));
});

test("disguised links using hxxps, bracketed or spaced dots are detected", () => {
  const samples: Array<{ text: string; invite: boolean }> = [
    { text: "hxxps://evil[.]example/phish", invite: false },
    { text: "hxxp://malicious.example/step1", invite: false },
    { text: "entra en evil(.)com/promo", invite: false },
    { text: "visita example . com ahora", invite: false },
    { text: "t[.]me/+AbCdEf123", invite: true },
    { text: "pega-tu-info en example{.}example/track", invite: false },
    { text: "abre example dot com/ruta", invite: false },
  ];
  for (const sample of samples) {
    const result = inspectLinks(sample.text, [], { whitelist: [] });
    assert.equal(result.hasUnauthorizedLink, true, sample.text);
    assert.equal(result.hasUnauthorizedInvite, sample.invite, sample.text);
  }
});

test("invisible and control characters cannot hide a link", () => {
  const zeroWidth =
    "visita evil" + String.fromCharCode(0x200b) + ".com/promo";
  const control = "abre exa" + String.fromCharCode(0x0) + "mple.com/ahora";
  const hiddenInvite =
    "https://t" + String.fromCharCode(0x200d) + ".me/+AbCd123";

  assert.equal(
    inspectLinks(zeroWidth, [], { whitelist: [] }).hasUnauthorizedLink,
    true,
  );
  assert.equal(
    inspectLinks(control, [], { whitelist: [] }).hasUnauthorizedLink,
    true,
  );
  assert.equal(
    inspectLinks(hiddenInvite, [], { whitelist: [] }).hasUnauthorizedInvite,
    true,
  );
});

test("homoglyphs that imitate a Latin Telegram host are normalized", () => {
  // `т` (U+0442) sustituye a la `t` de t.me: se sigue reconociendo como
  // invitación de un clic y se clasifica como tal.
  const invite = String.fromCharCode(0x0442) + ".me/+AbCd123";
  const inviteResult = inspectLinks(invite, [], { whitelist: [] });
  assert.equal(inviteResult.hasUnauthorizedInvite, true);
  assert.ok(inviteResult.kinds.includes("invitacion"));

  // `а` (U+0430) dentro de una etiqueta se convierte en `a` latina: el host
  // resultante es exactamente el de la whitelist, no un homoglifo distinto.
  const insideLabel = "b" + String.fromCharCode(0x0430) + "d.com";
  assert.equal(
    inspectLinks(insideLabel, [], { whitelist: ["bad.com"] })
      .hasUnauthorizedLink,
    false,
    "la letra cirílica se normaliza a la latina equivalente",
  );

  // Si la letra cirílica rompe el dominio, el enlace sigue bloqueado como
  // enlace externo: la clasificación cambia pero no hay evasión.
  const brokenHost = "t" + String.fromCharCode(0x0435) + ".me/+AbCd123";
  const brokenResult = inspectLinks(brokenHost, [], { whitelist: [] });
  assert.equal(brokenResult.hasUnauthorizedLink, true);
  assert.equal(brokenResult.hasUnauthorizedInvite, false);

  // Otra letra imitadora: `а` (U+0430) en lugar de la `a` latina.
  const lookalike =
    "https://b" + String.fromCharCode(0x0430) + "d.example/phish";
  assert.equal(
    inspectLinks(lookalike, [], { whitelist: [] }).hasUnauthorizedLink,
    true,
  );
});

test("URLs inside captions are detected together with caption entities", () => {
  const captionText = "mira este pack https://example.com/promo";
  const captioned = {
    message_id: 71,
    date: 1,
    chat: { id: -10071, type: "supergroup", title: "grupo" },
    caption: captionText,
    caption_entities: [{ type: "url" as const, offset: 15, length: 25 }],
  } as Message;

  const content = getScannableMessageContent(captioned);
  assert.equal(content.text, captionText);
  assert.equal(
    inspectLinks(content.text, content.entities, { whitelist: [] })
      .hasUnauthorizedLink,
    true,
  );
  assert.equal(containsUrl(captioned), true);
});

test("links hidden in Telegram entities are detected without a visible URL", () => {
  const hidden = inspectLinks(
    "haz clic en el texto",
    [
      {
        type: "text_link" as const,
        offset: 8,
        length: 4,
        url: "https://secret.example/track?id=7",
      },
    ],
    { whitelist: [] },
  );
  assert.equal(hidden.hasLink, true);
  assert.equal(hidden.hasUnauthorizedLink, true);

  const entityUrl = inspectLinks(
    "visita https://example.com/ahora",
    [{ type: "url" as const, offset: 7, length: 25 }],
    { whitelist: [] },
  );
  assert.equal(entityUrl.hasUnauthorizedLink, true);
});

test("ordinary messages without links are not flagged", () => {
  for (const text of [
    "hola a todos, ¿cómo estáis?",
    "jajaja buenísimo",
    "nos vemos mañana por la tarde",
  ]) {
    const result = inspectLinks(text, [], { whitelist: [] });
    assert.equal(result.hasLink, false, text);
    assert.equal(result.hasUnauthorizedLink, false, text);
  }
});

test("file names without a domain or URL are never treated as links", () => {
  for (const name of [
    "informe.pdf",
    "foto.jpg",
    "archivo.zip",
    "documento.docx",
    "video.mp4",
  ]) {
    const result = inspectLinks(name, [], { whitelist: [] });
    assert.equal(result.hasLink, false, name);
    assert.equal(result.hasUnauthorizedLink, false, name);

    const message = {
      message_id: 11,
      date: 1,
      chat: { id: -10072, type: "supergroup", title: "grupo" },
      text: "el archivo " + name + " está listo",
    } as Message;
    assert.equal(containsUrl(message), false, name);
  }
});

test("real domains and links carrying a path or scheme are still detected", () => {
  const samples = [
    "example.com",
    "bit.ly/abc",
    "www.evil.example",
    "https://malware.zip",
    "descarga evil.example/paquete.zip",
    "doc.example.com/informe.pdf",
  ];
  for (const sample of samples) {
    const result = inspectLinks(sample, [], { whitelist: [] });
    assert.equal(result.hasUnauthorizedLink, true, sample);
  }
  assert.equal(
    inspectLinks("informe final v2.doc", [], { whitelist: [] }).hasLink,
    false,
    "un archivo suelto sin dominio ni ruta no es un enlace",
  );
});

test("an allowed message cannot be edited later to smuggle a link", async () => {
  const chatId = -940010001;
  const clean = await run({
    chatId,
    messageId: 900001,
    text: "todo en orden, seguimos con el tema",
  });
  assert.equal(clean.nextCalls, 1, "el mensaje limpio continúa la cadena");
  assert.equal(clean.deleted.length, 0);
  assert.equal((await eventsFor(chatId)).length, 0);

  const edited = await run({
    chatId,
    messageId: 900001,
    text: "ahora sí: https://example.com/promo",
    edited: true,
  });
  assert.deepEqual(edited.deleted, [900001]);
  assert.equal(edited.nextCalls, 0, "el enlace sancionado corta la cadena");

  const events = await eventsFor(chatId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.result, "ok");
  assert.equal(events[0]?.detail?.includes("editado=true"), true);
  assert.equal(events[0]?.targetId, MEMBER_ID);
});

test("ordinary group conversations continue through the chain untouched", async () => {
  const chatId = -940010002;
  const flow = await run({
    chatId,
    messageId: 900002,
    text: "hola a todos, ¿cómo estáis?",
  });
  assert.equal(flow.nextCalls, 1);
  assert.equal(flow.deleted.length, 0);
  assert.equal((await eventsFor(chatId)).length, 0);
  assert.equal((await warningsFor(chatId)).length, 0);
});

test("promotional wording without any URL is not a link violation", async () => {
  const chatId = -940010003;
  const flow = await run({
    chatId,
    messageId: 900003,
    text: "vendo zapatos baratos, escríbeme al privado por favor",
  });
  assert.equal(flow.nextCalls, 1, "la política de enlaces no la valora el texto comercial");
  assert.equal(flow.deleted.length, 0);
  assert.equal((await eventsFor(chatId)).length, 0);
  assert.equal((await warningsFor(chatId)).length, 0);
});

test("promotional text carrying an external link is classified in the audit", async () => {
  const chatId = -940010004;
  const flow = await run({
    chatId,
    messageId: 900004,
    text: "vendo zapatos, entra en https://tienda.example/zapatos",
  });
  assert.deepEqual(flow.deleted, [900004]);

  const events = await eventsFor(chatId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.result, "ok");
  assert.equal(events[0]?.detail?.includes("delete=true"), true);
  assert.equal(events[0]?.detail?.includes("tipos=externo"), true);
  assert.equal(events[0]?.detail?.includes("editado=false"), true);
});

test("a normal member is deleted and warned, never banned for a link alone", async () => {
  const chatId = -940010005;
  const userId = 930000011;
  const flow = await run({
    chatId,
    messageId: 900005,
    text: "entra por https://example.com/afiliado",
    userId,
  });
  assert.deepEqual(flow.deleted, [900005]);

  const warnings = await warningsFor(chatId, userId);
  assert.equal(warnings.length, 1);
  assert.equal(
    (warnings[0]?.reason ?? "").includes("Enlace no autorizado"),
    true,
  );

  const data = await getGroupData(chatId);
  assert.equal(
    Object.keys(data.bannedUsers).length,
    0,
    "compartir un enlace no banea automáticamente",
  );
  assert.equal(data.mutedUsers[String(userId)] === undefined, true);

  const events = await eventsFor(chatId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.targetId, userId);
  assert.equal(events[0]?.result, "ok");
});

test("identical repeated content is neither sanctioned nor logged twice", async () => {
  const chatId = -940010006;
  const first = await run({
    chatId,
    messageId: 900006,
    text: "mira https://example.com/repetido",
  });
  assert.deepEqual(first.deleted, [900006]);

  const repeated = await run({
    chatId,
    messageId: 900006,
    text: "mira https://example.com/repetido",
    edited: true,
  });
  assert.equal(
    repeated.deleted.length,
    0,
    "el mismo contenido no se sanciona dos veces",
  );

  assert.equal((await eventsFor(chatId)).length, 1, "un solo registro");
  assert.equal((await warningsFor(chatId)).length, 1, "una sola advertencia");
});

test("a deletion failure is audited as an error together with its reason", async () => {
  const chatId = -940010007;
  const flow = await run({
    chatId,
    messageId: 900007,
    text: "repite https://example.com/sin-permisos",
    canDelete: false,
  });
  assert.equal(
    flow.deleted.length,
    0,
    "sin permiso no se intenta la eliminación",
  );

  const events = await eventsFor(chatId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.result, "error");
  assert.equal(events[0]?.detail?.includes("delete=false"), true);
  assert.equal(events[0]?.detail?.includes("deleteError="), true);
  assert.equal(events[0]?.detail?.includes("warning=true"), true);
  assert.equal((await warningsFor(chatId)).length, 1);
});

test("link policy configuration stays isolated per group", async () => {
  const openChatId = -940010008;
  const closedChatId = -940010009;

  const openData = await getGroupData(openChatId);
  openData.antiSpam.blockLinks = false;
  openData.antiSpam.blockInvites = false;
  await saveGroupData(openChatId, openData);

  const openFlow = await run({
    chatId: openChatId,
    messageId: 900008,
    text: "comparto https://example.com/permitido",
  });
  assert.equal(
    openFlow.deleted.length,
    0,
    "el grupo que apagó la política no sanciona",
  );
  assert.equal(openFlow.nextCalls, 1);
  assert.equal((await eventsFor(openChatId)).length, 0);

  const closedFlow = await run({
    chatId: closedChatId,
    messageId: 900009,
    text: "comparto https://example.com/permitido",
  });
  assert.deepEqual(
    closedFlow.deleted,
    [900009],
    "el otro grupo conserva la protección por defecto",
  );
  assert.equal((await eventsFor(closedChatId)).length, 1);
});

test("disabling the anti-spam master switch does not disable link protection", async () => {
  const chatId = -940010011;
  const data = await getGroupData(chatId);
  data.antiSpam.enabled = false;
  await saveGroupData(chatId, data);

  const flow = await run({
    chatId,
    messageId: 900011,
    text: "con anti-spam apagado https://example.com/activo",
  });
  assert.deepEqual(
    flow.deleted,
    [900011],
    "la política de enlaces sigue activa sin el interruptor maestro",
  );
  assert.equal((await eventsFor(chatId)).length, 1);
});

test("explicitly turning both link switches off releases the link policy", async () => {
  const chatId = -940010012;
  const data = await getGroupData(chatId);
  data.antiSpam.enabled = true;
  data.antiSpam.blockLinks = false;
  data.antiSpam.blockInvites = false;
  await saveGroupData(chatId, data);

  const flow = await run({
    chatId,
    messageId: 900012,
    text: "politica desactivada https://example.com/libre",
  });
  assert.equal(
    flow.deleted.length,
    0,
    "solo se libera con la desactivación explícita del grupo",
  );
  assert.equal(flow.nextCalls, 1);
  assert.equal((await eventsFor(chatId)).length, 0);
});

test("private Telegram chat links are blocked and classified by the policy", async () => {
  const chatId = -940010013;
  const flow = await run({
    chatId,
    messageId: 900013,
    text: "entra por https://t.me/c/1234567890/42",
  });
  assert.deepEqual(flow.deleted, [900013]);

  const events = await eventsFor(chatId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.detail?.includes("privado=true"), true);
  assert.equal(events[0]?.detail?.includes("tipos=privado-telegram"), true);
});

test("explicit exemptions are applied and audited, never silent", async () => {
  const chatId = -940010014;
  const data = await getGroupData(chatId);
  data.trustedUsers[String(MEMBER_ID)] = true;
  await saveGroupData(chatId, data);

  const flow = await run({
    chatId,
    messageId: 900014,
    text: "enlace de confianza https://example.com/autorizado",
  });
  assert.equal(flow.deleted.length, 0, "la excepción evita la sanción");
  assert.equal(flow.nextCalls, 1);

  const events = await eventsFor(chatId);
  assert.equal(events.length, 1, "la excepción queda registrada");
  assert.equal(events[0]?.result, "rejected");
  assert.equal(
    events[0]?.detail?.includes("exenta=sancion_automatica"),
    true,
  );
  assert.equal((await warningsFor(chatId)).length, 0);
});
