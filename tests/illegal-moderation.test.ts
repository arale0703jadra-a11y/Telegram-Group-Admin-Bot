import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { MyContext } from "../src/types.js";

const originalCwd = process.cwd();
const testDataDirectory = await mkdtemp(join(tmpdir(), "zeus-illegal-moderation-"));
process.chdir(testDataDirectory);
after(async () => {
  await flushStorage();
  process.chdir(originalCwd);
  await rm(testDataDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

const { illegalModeration } = await import("../src/filters/illegal-moderation.js");
const { flushStorage, getGroupData } = await import("../src/storage/index.js");
const { resetSecurityCaches } = await import("../src/utils/member-cache.js");

function createContext(options: {
  groupId: number;
  messageId: number;
  text?: string;
  caption?: string;
  edited?: boolean;
  deleteFails?: boolean;
  banFails?: boolean;
}): {
  context: MyContext;
  deleted: number[];
  banned: number[];
  notices: number[];
  nextCalls: number;
} {
  const user = { id: 920000001, is_bot: false, first_name: "Member" };
  const chat = { id: options.groupId, type: "supergroup" as const, title: "Test" };
  const message = {
    message_id: options.messageId,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: user,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.caption === undefined ? {} : { caption: options.caption }),
  };
  const deleted: number[] = [];
  const banned: number[] = [];
  const notices: number[] = [];
  let nextCalls = 0;
  const context = {
    update: options.edited
      ? { update_id: options.messageId, edited_message: message }
      : { update_id: options.messageId, message },
    msg: message,
    message,
    chat,
    from: user,
    me: { id: 920000002, is_bot: true, first_name: "ZEUS" },
    api: {
      getChatMember: async (_chatId: number, userId: number) =>
        userId === 920000002
          ? {
              status: "administrator",
              user: { id: userId, is_bot: true, first_name: "ZEUS" },
              can_delete_messages: true,
              can_restrict_members: true,
            }
          : {
              status: "member",
              user: { id: userId, is_bot: false, first_name: "Member" },
            },
      deleteMessage: async (_chatId: number, messageId: number) => {
        if (options.deleteFails) throw new Error("Telegram delete failed");
        deleted.push(messageId);
        return true;
      },
      banChatMember: async (_chatId: number, userId: number) => {
        if (options.banFails) throw new Error("Telegram ban failed");
        banned.push(userId);
        return true;
      },
      getChatAdministrators: async () => [
        {
          status: "administrator",
          user: { id: 920000003, is_bot: false, first_name: "Admin" },
        },
      ],
      sendMessage: async (userId: number) => {
        notices.push(userId);
        return { message_id: notices.length };
      },
    },
  } as unknown as MyContext;
  return {
    context,
    deleted,
    banned,
    notices,
    get nextCalls() { return nextCalls; },
    set nextCalls(value: number) { nextCalls = value; },
  };
}

async function run(context: MyContext): Promise<void> {
  await illegalModeration.middleware()(context, async () => undefined);
}

test("high-risk offers are removed, optionally banned, and audited without message text", async () => {
  resetSecurityCaches();
  const groupId = -920000101;
  const flow = createContext({
    groupId,
    messageId: 101,
    text: "vendo material infantil ilegal",
  });

  await run(flow.context);
  const data = await getGroupData(groupId);
  const event = data.events.find((entry) => entry.type === "ILLEGAL");
  assert.deepEqual(flow.deleted, [101]);
  assert.deepEqual(flow.banned, [920000001]);
  assert.deepEqual(flow.notices, [920000003]);
  assert.ok(event?.detail?.includes("risk=high"));
  assert.ok(event?.detail?.includes("intent=sale"));
  assert.ok(event?.detail?.includes("messageId=101"));
  assert.ok(!JSON.stringify(data.events).includes("vendo material"));

  await flushStorage();
  const file = resolve(testDataDirectory, "data", "storage", `${groupId}.json`);
  assert.equal(existsSync(file), true);
  assert.ok(!readFileSync(file, "utf8").includes("vendo material"));
});

test("edited captions are inspected and identical updates are deduplicated", async () => {
  resetSecurityCaches();
  const groupId = -920000102;
  const flow = createContext({
    groupId,
    messageId: 102,
    text: "Hola, ¿cómo están?",
  });
  await run(flow.context);

  const edited = createContext({
    groupId,
    messageId: 102,
    caption: "vendo material infantil ilegal",
    edited: true,
  });
  await run(edited.context);
  await run(edited.context);
  assert.deepEqual(edited.deleted, [102]);

  const data = await getGroupData(groupId);
  assert.equal(data.events.filter((entry) => entry.type === "ILLEGAL").length, 1);
});

test("concurrent duplicate updates only execute one moderation action", async () => {
  resetSecurityCaches();
  const groupId = -920000106;
  const first = createContext({
    groupId,
    messageId: 106,
    text: "vendo material infantil ilegal",
  });
  const duplicate = createContext({
    groupId,
    messageId: 106,
    text: "vendo material infantil ilegal",
  });

  await Promise.all([run(first.context), run(duplicate.context)]);

  assert.equal(first.deleted.length + duplicate.deleted.length, 1);
  const data = await getGroupData(groupId);
  assert.equal(data.events.filter((entry) => entry.type === "ILLEGAL").length, 1);
});

test("Telegram action failures are logged and admins are alerted without blocking middleware", async () => {
  resetSecurityCaches();
  const groupId = -920000103;
  const flow = createContext({
    groupId,
    messageId: 103,
    text: "vendo material infantil ilegal",
    deleteFails: true,
    banFails: true,
  });
  let continued = false;

  await illegalModeration.middleware()(flow.context, async () => {
    continued = true;
  });

  const data = await getGroupData(groupId);
  const event = data.events.find((entry) => entry.type === "ILLEGAL");
  assert.equal(continued, true);
  assert.deepEqual(flow.notices, [920000003]);
  assert.ok(event?.detail?.includes("delete=false"));
  assert.ok(event?.detail?.includes("ban=false"));
  assert.equal(event?.result, "error");
});

test("informational reports do not trigger deletion or banning", async () => {
  resetSecurityCaches();
  const groupId = -920000104;
  const flow = createContext({
    groupId,
    messageId: 104,
    caption: "denuncio una oferta ilegal para que los administradores la revisen",
  });

  await run(flow.context);
  assert.deepEqual(flow.deleted, []);
  assert.deepEqual(flow.banned, []);
});

test("repeated coded references raise a review alert but never cause an automatic ban", async () => {
  resetSecurityCaches();
  const groupId = -920000105;
  const first = createContext({
    groupId,
    messageId: 105,
    text: "sepe",
  });
  const second = createContext({
    groupId,
    messageId: 106,
    text: "sepe",
  });

  await run(first.context);
  await run(second.context);

  assert.deepEqual(first.deleted, []);
  assert.deepEqual(second.deleted, []);
  assert.deepEqual(first.banned, []);
  assert.deepEqual(second.banned, []);
  assert.deepEqual(second.notices, [920000003]);
  const data = await getGroupData(groupId);
  const events = data.events.filter((entry) => entry.type === "ILLEGAL");
  assert.equal(events.length, 2);
  assert.ok(events[1]?.detail?.includes("risk=medium"));
  assert.ok(events[1]?.detail?.includes("repeated-user-behavior"));
});
