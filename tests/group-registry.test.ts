import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ChatMember,
  ChatMemberAdministrator,
  ChatMemberBanned,
  ChatMemberLeft,
  ChatMemberMember,
  ChatMemberRestricted,
  User,
} from "@grammyjs/types";
import {
  GroupRegistry,
  getGroupCapabilities,
  reconcileBotMembership,
} from "../src/services/group-registry.js";

const user: User = { id: 1, is_bot: true, first_name: "ZEUS" };

function administrator(
  overrides: Partial<ChatMemberAdministrator> = {},
): ChatMemberAdministrator {
  return {
    status: "administrator",
    user,
    can_be_edited: false,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: false,
    can_restrict_members: true,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
    can_send_welcome_messages: false,
    ...overrides,
  };
}

function member(): ChatMemberMember {
  return { status: "member", user };
}

function restricted(is_member: boolean): ChatMemberRestricted {
  return {
    status: "restricted",
    user,
    is_member,
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_react_to_messages: false,
    can_change_info: false,
    can_invite_users: false,
    can_edit_tag: false,
    can_pin_messages: false,
    can_manage_topics: false,
    until_date: 0,
  };
}

function withRegistry(
  run: (registry: GroupRegistry) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "zeus-group-registry-"));
  try {
    run(new GroupRegistry(join(directory, "data", "groups.json")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("records an administrator, its capabilities, updated title, and only one chat", () => {
  withRegistry((registry) => {
    assert.equal(
      reconcileBotMembership(registry, -1001, "Inicial", member()),
      false,
    );
    assert.deepEqual(registry.getAll(), []);
    assert.equal(
      reconcileBotMembership(registry, -1001, "Inicial", administrator()),
      true,
    );
    registry.markAdmin(-1001, 21);
    reconcileBotMembership(
      registry,
      -1001,
      "Nombre actualizado",
      administrator({ can_delete_messages: false }),
    );

    assert.deepEqual(registry.getAll(), [{
      id: -1001,
      title: "Nombre actualizado",
      capabilities: {
        canManageChat: true,
        canDeleteMessages: false,
        canManageVideoChats: false,
        canRestrictMembers: true,
        canPromoteMembers: false,
        canChangeInfo: false,
        canInviteUsers: true,
        canManageTags: false,
        canPinMessages: false,
        canManageTopics: false,
      },
    }]);
    assert.deepEqual(registry.getUserGroups(21), [{
      id: -1001,
      title: "Nombre actualizado",
    }]);
  });
});

test("member, left, kicked, and restricted states remove the group regardless of is_member", () => {
  withRegistry((registry) => {
    const nonAdminMembers: ChatMember[] = [
      member(),
      { status: "left", user } satisfies ChatMemberLeft,
      { status: "kicked", user, until_date: 0 } satisfies ChatMemberBanned,
      restricted(true),
      restricted(false),
    ];

    for (const [index, botMember] of nonAdminMembers.entries()) {
      const chatId = -2000 - index;
      reconcileBotMembership(registry, chatId, "Grupo", administrator());
      assert.equal(
        reconcileBotMembership(registry, chatId, "Grupo", botMember),
        false,
      );
      assert.deepEqual(registry.getAll().map((group) => group.id), []);
    }
  });
});

test("duplicate membership updates replace metadata without duplicating entries", () => {
  withRegistry((registry) => {
    reconcileBotMembership(registry, -3001, "Grupo", administrator());
    reconcileBotMembership(registry, -3001, "Grupo", administrator());
    assert.equal(registry.getAll().length, 1);
  });
});

test("migration moves the inventory to the new ID and merges admin indexes", () => {
  withRegistry((registry) => {
    reconcileBotMembership(registry, -4001, "Grupo", administrator());
    registry.markAdmin(-4001, 31);
    reconcileBotMembership(registry, -4002, "Supergrupo", administrator());
    registry.markAdmin(-4002, 32);
    registry.migrate(
      -4001,
      -4002,
      "Supergrupo actualizado",
      getGroupCapabilities(administrator({ can_restrict_members: false })),
    );

    assert.deepEqual(registry.getAll().map(({ id, title }) => ({ id, title })), [{
      id: -4002,
      title: "Supergrupo actualizado",
    }]);
    assert.deepEqual(registry.getUserGroups(31), [{
      id: -4002,
      title: "Supergrupo actualizado",
    }]);
    assert.deepEqual(registry.getUserGroups(32), [{
      id: -4002,
      title: "Supergrupo actualizado",
    }]);
  });
});

test("registry recovers after restart and creates a missing registry file", () => {
  const directory = mkdtempSync(join(tmpdir(), "zeus-group-registry-restart-"));
  const file = join(directory, "data", "groups.json");
  try {
    const first = new GroupRegistry(file);
    reconcileBotMembership(first, -5001, "Persistido", administrator());
    const restarted = new GroupRegistry(file);
    assert.equal(restarted.getAll()[0]?.title, "Persistido");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).groups.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt registry is preserved and never overwritten by a later update", () => {
  const directory = mkdtempSync(join(tmpdir(), "zeus-group-registry-corrupt-"));
  const file = join(directory, "groups.json");
  const corruptContents = "{not valid json";
  try {
    writeFileSync(file, corruptContents, "utf8");
    const registry = new GroupRegistry(file);
    reconcileBotMembership(registry, -6001, "En memoria", administrator());
    assert.equal(readFileSync(file, "utf8"), corruptContents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
