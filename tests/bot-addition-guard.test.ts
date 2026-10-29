import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";

// Variables controladas por el test: no dependen de .env ni de servicios reales.
process.env.OWNER_ID = "900000031";
process.env.ALEXIITA_TELEGRAM_ID = "900000032";
process.env.SYSTEM_OWNER_BOOTSTRAP_ID = "900000033";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_dummy-key";

const { isAuthorizedBotAdder } = await import(
  "../src/filters/bot-addition-guard.js"
);

const OWNER = 900000031;
const ALEXIITA = 900000032;
const BOOTSTRAP = 900000033;
const CONFIGURED_ADMINS = [OWNER, ALEXIITA, BOOTSTRAP];

function chatMember(status: ChatMember["status"]): ChatMember {
  return {
    status,
    user: {
      id: 123,
      is_bot: false,
      first_name: "Test",
    },
    ...(status === "restricted"
      ? {
          is_member: true,
          can_send_messages: true,
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false,
          can_manage_topics: false,
          until_date: 0,
        }
      : {}),
  } as ChatMember;
}

test("allows bots added by group administrators or creator", () => {
  assert.equal(isAuthorizedBotAdder(123, chatMember("administrator")), true);
  assert.equal(isAuthorizedBotAdder(123, chatMember("creator")), true);
});

test("los tres administradores configurados reciben el mismo tratamiento", () => {
  for (const adminId of CONFIGURED_ADMINS) {
    assert.equal(
      isAuthorizedBotAdder(adminId, chatMember("member")),
      true,
      `la cuenta configurada ${adminId} debe poder añadir bots sin ser admin del grupo`,
    );
    assert.equal(isAuthorizedBotAdder(adminId, chatMember("restricted")), true);
    // La pertenencia al grupo debe ser verificable también para las tres:
    // sin registro de miembro, el filtro deniega de forma uniforme.
    assert.equal(isAuthorizedBotAdder(adminId, undefined), false);
  }
});

test("una cuenta externa no autorizada no puede añadir bots", () => {
  assert.equal(isAuthorizedBotAdder(900999999, chatMember("member")), false);
  assert.equal(isAuthorizedBotAdder(900999999, chatMember("restricted")), false);
  assert.equal(isAuthorizedBotAdder(900999999, undefined), false);
});

test("does not authorize bots added by ordinary members or unverifiable users", () => {
  assert.equal(isAuthorizedBotAdder(123, chatMember("member")), false);
  assert.equal(isAuthorizedBotAdder(123, chatMember("restricted")), false);
  assert.equal(isAuthorizedBotAdder(123, undefined), false);
});

test("ID inválidos nunca autorizados como cuentas configuradas", () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isAuthorizedBotAdder(id, chatMember("member")), false);
  }
});
