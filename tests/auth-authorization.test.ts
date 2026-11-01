import assert from "node:assert/strict";
import test from "node:test";
import { getAdministrableGroups } from "../src/utils/groups.js";
import {
  checkUserAdminOf,
  isAdministrableGroupType,
  isUserAdmin,
} from "../src/utils/permissions.js";

type MockMember = {
  status: "creator" | "administrator" | "member";
};

function context(
  from: { id: number } | undefined,
  members: Record<string, MockMember>,
  senderChat?: { id: number; type: "group" | "channel" },
) {
  return {
    from,
    chat: { id: -1001, type: "supergroup" },
    me: { id: 99 },
    senderChat,
    api: {
      getChatMember: async (groupId: number, userId: number) =>
        userId === 99
          ? { status: "administrator", can_manage_chat: true }
          : members[`${groupId}:${userId}`] ?? members[String(userId)] ?? { status: "member" },
      getChat: async (groupId: number) => ({
        type: "supergroup",
        title: groupId === -1001 ? "Grupo principal" : "Grupo secundario",
      }),
    },
  } as never;
}

const knownGroups = [
  { id: -1001, title: "Grupo principal" },
  { id: -1002, title: "Grupo secundario" },
];

test("registered group access is based on current Telegram administrator status", async () => {
  const owner = context({ id: 10 }, {
    "-1001:10": { status: "creator" },
    "-1002:10": { status: "member" },
  });
  const groupAdmin = context({ id: 20 }, {
    "-1001:20": { status: "administrator" },
    "-1002:20": { status: "member" },
  });

  assert.deepEqual(await getAdministrableGroups(owner, knownGroups), [knownGroups[0]]);
  assert.deepEqual(await getAdministrableGroups(groupAdmin, knownGroups), [knownGroups[0]]);
});

test("second group admin can access multiple groups while a normal user cannot", async () => {
  const admin = context({ id: 30 }, {
    "30": { status: "administrator" },
  });
  const normal = context({ id: 40 }, {
    "40": { status: "member" },
  });
  const unknown = context({ id: 50 }, {});

  assert.deepEqual(await getAdministrableGroups(admin, knownGroups), [knownGroups[0], knownGroups[1]]);
  assert.deepEqual(await getAdministrableGroups(normal, knownGroups), []);
  assert.deepEqual(await getAdministrableGroups(unknown, knownGroups), []);
});

test("private authorization uses the real Telegram user id", async () => {
  const ctx = context({ id: 20 }, {
    "20": { status: "administrator" },
  });

  assert.equal((await checkUserAdminOf(ctx, -1001, 20)).isAdmin, true);
});

test("sender_chat is never treated as a personal administrator identity", async () => {
  const senderOnly = context(undefined, {
    "999": { status: "administrator" },
  }, { id: -1001, type: "channel" });
  const realUser = context({ id: 20 }, {
    "20": { status: "administrator" },
  }, { id: -1001, type: "channel" });

  assert.equal(await isUserAdmin(senderOnly), false);
  assert.equal((await checkUserAdminOf(senderOnly, -1001)).isAdmin, false);
  assert.equal(await isUserAdmin(realUser), true);
});

test("a channel context never qualifies as the private panel context", () => {
  const channelContext = context(undefined, {}, { id: -1001, type: "channel" }) as {
    chat: { type: string };
  };

  assert.notEqual(channelContext.chat.type, "private");
});

test("only group and supergroup types are part of ZEUS inventory", () => {
  assert.equal(isAdministrableGroupType("group"), true);
  assert.equal(isAdministrableGroupType("supergroup"), true);
  assert.equal(isAdministrableGroupType("channel"), false);
  assert.equal(isAdministrableGroupType("private"), false);
});

test("the selector excludes non-admin bots and refreshes the group title", async () => {
  const ctx = context({ id: 10 }, {
    "-1001:10": { status: "administrator" },
  }) as unknown as {
    api: {
      getChatMember: (groupId: number, userId: number) => Promise<MockMember>;
      getChat: (groupId: number) => Promise<{
        type: "supergroup";
        title: string;
      }>;
    };
  };
  let botStatus: "administrator" | "member" = "member";
  ctx.api.getChatMember = async (_groupId: number, userId: number) => {
    if (userId === 99) return { status: botStatus };
    return { status: "administrator" };
  };
  ctx.api.getChat = async () => ({ type: "supergroup", title: "Título actual" });

  assert.deepEqual(await getAdministrableGroups(ctx as never, knownGroups), []);
  botStatus = "administrator";
  assert.deepEqual(await getAdministrableGroups(ctx as never, knownGroups), [
    { id: -1001, title: "Título actual" },
    { id: -1002, title: "Título actual" },
  ]);
});

test("the selector fails closed when chat type cannot be verified", async () => {
  const ctx = context({ id: 10 }, {
    "-1001:10": { status: "administrator" },
  }) as unknown as {
    api: {
      getChatMember: (groupId: number, userId: number) => Promise<MockMember>;
      getChat: (groupId: number) => Promise<never>;
    };
  };
  ctx.api.getChatMember = async (_groupId: number, userId: number) =>
    userId === 99 ? { status: "administrator" } : { status: "administrator" };
  ctx.api.getChat = async () => {
    throw new Error("Telegram unavailable");
  };

  assert.deepEqual(await getAdministrableGroups(ctx as never, knownGroups), []);
});
