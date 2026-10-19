import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import { OWNER_ID } from "../src/config.js";
import { isAuthorizedBotAdder } from "../src/filters/bot-addition-guard.js";

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

test("allows bots added by group administrators, creator, or configured owner", () => {
  assert.equal(isAuthorizedBotAdder(123, chatMember("administrator")), true);
  assert.equal(isAuthorizedBotAdder(123, chatMember("creator")), true);
  if (OWNER_ID !== undefined) {
    assert.equal(isAuthorizedBotAdder(OWNER_ID, chatMember("member")), true);
  }
});

test("does not authorize bots added by ordinary members or unverifiable users", () => {
  assert.equal(isAuthorizedBotAdder(123, chatMember("member")), false);
  assert.equal(isAuthorizedBotAdder(123, chatMember("restricted")), false);
  assert.equal(isAuthorizedBotAdder(123, undefined), false);
});
