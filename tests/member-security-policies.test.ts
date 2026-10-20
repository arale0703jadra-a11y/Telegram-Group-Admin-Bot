import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@grammyjs/types";
import {
  containsEmergencyMedia,
  containsMention,
  containsUrl,
} from "../src/utils/message-content.js";
import {
  isWithinNewMemberQuarantine,
  NEW_MEMBER_QUARANTINE_MS,
} from "../src/filters/new-member-quarantine.js";
import { assessAdminChange } from "../src/security/admin-guardian.js";

const now = Date.now();

test("new-member quarantine lasts exactly 48 hours from the recorded join time", () => {
  assert.equal(NEW_MEMBER_QUARANTINE_MS, 48 * 60 * 60 * 1000);
  const joinedAt = Math.floor(now / 1000);
  const joinTimeMs = joinedAt * 1000;
  assert.equal(
    isWithinNewMemberQuarantine(
      joinedAt,
      joinTimeMs + NEW_MEMBER_QUARANTINE_MS - 1,
    ),
    true,
  );
  assert.equal(
    isWithinNewMemberQuarantine(
      joinedAt,
      joinTimeMs + NEW_MEMBER_QUARANTINE_MS,
    ),
    false,
  );
  assert.equal(isWithinNewMemberQuarantine(undefined, now), false);
});

test("quarantine content checks include text, captions, Telegram entities and media", () => {
  const urlMessage = {
    message_id: 1,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "test" },
    text: "visita https://example.com",
  } as Message;
  const bareDomainMessage = {
    message_id: 3,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "test" },
    text: "visita example.com/catalogo",
  } as Message;
  const captionMention = {
    message_id: 2,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "test" },
    caption: "hola",
    caption_entities: [{ type: "text_mention", offset: 0, length: 4, user: {
      id: 42,
      is_bot: false,
      first_name: "Ana",
    } }],
    photo: [{ file_id: "file", file_unique_id: "unique", width: 1, height: 1 }],
  } as Message;

  assert.equal(containsUrl(urlMessage), true);
  assert.equal(containsUrl(bareDomainMessage), true);
  assert.equal(containsMention(captionMention), true);
  assert.equal(containsEmergencyMedia(captionMention), true);
});

test("admin guardian flags unauthorized promotion and suspicious privilege escalation", () => {
  assert.equal(
    assessAdminChange({
      oldStatus: "member",
      newStatus: "administrator",
      actorId: 10,
      targetId: 20,
      actorAuthorized: false,
    }).suspicious,
    true,
  );
  assert.equal(
    assessAdminChange({
      oldStatus: "administrator",
      newStatus: "administrator",
      actorId: 10,
      targetId: 20,
      actorAuthorized: true,
      oldPermissions: { can_promote_members: false },
      newPermissions: { can_promote_members: true },
    }).suspicious,
    true,
  );
  assert.equal(
    assessAdminChange({
      oldStatus: "member",
      newStatus: "administrator",
      actorId: 10,
      targetId: 20,
      actorAuthorized: true,
    }).suspicious,
    false,
  );
});
