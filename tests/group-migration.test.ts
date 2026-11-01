import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatMemberAdministrator } from "@grammyjs/types";
import { FileStore } from "../src/storage/file.js";
import {
  getMigratedGroupIds,
  processGroupMigration,
  type GroupMigrationDependencies,
} from "../src/services/group-migration.js";

const botMember: ChatMemberAdministrator = {
  status: "administrator",
  user: { id: 9, is_bot: true, first_name: "ZEUS" },
  can_be_edited: false,
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_send_welcome_messages: false,
};

test("migration service messages map old and new chat identifiers in both directions", () => {
  assert.deepEqual(
    getMigratedGroupIds(-1001, { migrate_to_chat_id: -1002 }),
    { oldChatId: -1001, newChatId: -1002 },
  );
  assert.deepEqual(
    getMigratedGroupIds(-1002, { migrate_from_chat_id: -1001 }),
    { oldChatId: -1001, newChatId: -1002 },
  );
  assert.equal(getMigratedGroupIds(-1001, {}), undefined);
});

function dependencies(calls: string[], storageMoved = true): GroupMigrationDependencies {
  return {
    migrateRegisteredGroup: (oldId, newId, title, capabilities) => {
      calls.push(`migrate:${oldId}:${newId}:${title}:${capabilities.canManageChat}`);
    },
    unregisterGroup: (chatId) => calls.push(`unregister:${chatId}`),
    moveGroupStorage: async (oldId, newId) => {
      calls.push(`storage:${oldId}:${newId}`);
      return storageMoved;
    },
  };
}

test("migration verifies the new ID and migrates an administrator group", async () => {
  const calls: string[] = [];
  const result = await processGroupMigration(
    {
      getChatMember: async () => botMember,
      getChat: async () => {
        throw new Error("offline; keep the service-message title");
      },
    },
    -1001,
    -1002,
    9,
    "Migrated supergroup",
    dependencies(calls),
  );

  assert.deepEqual(result, { registered: true, storageMoved: true });
  assert.deepEqual(calls, [
    "storage:-1001:-1002",
    "migrate:-1001:-1002:Migrated supergroup:true",
  ]);
});

test("migration removes the old inventory entry when the bot is only a member", async () => {
  const calls: string[] = [];
  const result = await processGroupMigration(
    {
      getChatMember: async () => ({ status: "member", user: botMember.user }),
      getChat: async () => {
        throw new Error("must not query a non-administrable chat");
      },
    },
    -2001,
    -2002,
    9,
    "Migrated",
    dependencies(calls),
  );

  assert.deepEqual(result, { registered: false, storageMoved: false });
  assert.deepEqual(calls, ["unregister:-2001"]);
});

test("migration API failure fails closed and leaves group data untouched", async () => {
  const calls: string[] = [];
  const result = await processGroupMigration(
    {
      getChatMember: async () => {
        throw new Error("API unavailable");
      },
      getChat: async () => {
        throw new Error("must not query after membership failure");
      },
    },
    -3001,
    -3002,
    9,
    "Migrated",
    dependencies(calls),
  );

  assert.deepEqual(result, { registered: false, storageMoved: false });
  assert.deepEqual(calls, ["unregister:-3001"]);
});

test("storage migration moves data if destination is absent and never overwrites an existing destination", async () => {
  const previousDirectory = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "zeus-group-storage-migration-"));
  try {
    process.chdir(directory);
    const store = new FileStore();
    const oldData = await store.loadGroup(-4001);
    oldData.warnLimit = 9;
    await store.saveGroup(-4001, oldData);
    await store.flushForced();

    assert.equal(await store.moveGroupData(-4001, -4002), true);
    assert.equal(existsSync(join(directory, "data", "storage", "-4001.json")), false);
    const movedStore = new FileStore();
    assert.equal((await movedStore.loadGroup(-4002)).warnLimit, 9);

    const destinationData = await movedStore.loadGroup(-4003);
    destinationData.warnLimit = 12;
    await movedStore.saveGroup(-4003, destinationData);
    await movedStore.flushForced();
    const otherOldData = await movedStore.loadGroup(-4004);
    otherOldData.warnLimit = 15;
    await movedStore.saveGroup(-4004, otherOldData);
    await movedStore.flushForced();

    assert.equal(await movedStore.moveGroupData(-4004, -4003), false);
    const verifyStore = new FileStore();
    assert.equal((await verifyStore.loadGroup(-4003)).warnLimit, 12);
    assert.equal((await verifyStore.loadGroup(-4004)).warnLimit, 15);
    assert.equal(
      readFileSync(join(directory, "data", "storage", "-4004.json"), "utf8")
        .includes('"warnLimit": 15'),
      true,
    );
  } finally {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrating corrupt group storage preserves it and keeps writes blocked", async () => {
  const previousDirectory = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "zeus-corrupt-group-migration-"));
  const invalidJson = "{corrupt";
  const originalError = console.error;
  console.error = () => undefined;
  try {
    process.chdir(directory);
    const sourcePath = join(directory, "data", "storage", "-5001.json");
    const targetPath = join(directory, "data", "storage", "-5002.json");
    const store = new FileStore();
    mkdirSync(join(directory, "data", "storage"), { recursive: true });
    writeFileSync(sourcePath, invalidJson, "utf8");
    await store.loadGroup(-5001);

    assert.equal(await store.moveGroupData(-5001, -5002), false);
    assert.equal(readFileSync(targetPath, "utf8"), invalidJson);
    await assert.rejects(store.saveGroup(-5002, await store.loadGroup(-5002)));
  } finally {
    console.error = originalError;
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
});
