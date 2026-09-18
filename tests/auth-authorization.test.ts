import assert from "node:assert/strict";
import test from "node:test";
import { getAdministrableGroups } from "../src/utils/groups.js";
import { checkUserAdminOf, isUserAdmin } from "../src/utils/permissions.js";

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
    senderChat,
    api: {
      getChatMember: async (groupId: number, userId: number) =>
        members[`${groupId}:${userId}`] ?? members[String(userId)] ?? { status: "member" },
    },
  } as never;
}

const knownGroups = [
  { id: -1001, title: "Grupo principal" },
  { id: -1002, title: "Grupo secundario" },
];

test("BOT owner and non-owner group admins can access their registered groups", async () => {
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
