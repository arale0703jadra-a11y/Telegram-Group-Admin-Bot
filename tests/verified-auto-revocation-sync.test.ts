import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  processAutoRevocationForGroup,
  type AutoRevocationDependencies,
  type AutoRevocationNotification,
  type ExpiredVerifiedUserSummary,
} from "../src/services/verified-users.js";
import {
  markUserVerified,
  unmarkUserVerified,
} from "../src/services/user-registry.js";
import { flushStorage } from "../src/storage/index.js";

const groupId = -100123;
const api = {
  sendMessage: async () => ({} as Awaited<ReturnType<Api["sendMessage"]>>),
} as Pick<Api, "sendMessage">;

function notification(userId: number): AutoRevocationNotification {
  return {
    event_key: `event-${userId}`,
    group_id: groupId,
    user_id: userId,
    username: `user${userId}`,
    display_name: `User ${userId}`,
  };
}

function expiredUser(userId: number): ExpiredVerifiedUserSummary {
  return {
    group_id: groupId,
    user_id: userId,
    username: `user${userId}`,
    display_name: `User ${userId}`,
    valid_until: "2026-01-01T00:00:00.000Z",
  };
}

function dependencies(
  overrides: Partial<AutoRevocationDependencies> = {},
): AutoRevocationDependencies {
  return {
    listExpired: async () => [],
    revokeExpired: async () => undefined,
    listPending: async () => [],
    unmarkLocal: async () => undefined,
    flushLocal: async () => undefined,
    deliverPending: async () => 0,
    ...overrides,
  };
}

test("confirmed automatic revocation syncs local state before announcing", async () => {
  const calls: string[] = [];
  const deps = dependencies({
    listExpired: async () => [expiredUser(41)],
    revokeExpired: async () => {
      calls.push("persist-revocation");
      return notification(41);
    },
    listPending: async () => [notification(41)],
    unmarkLocal: async (_group, userId) => {
      calls.push(`unmark-local:${userId}`);
    },
    flushLocal: async () => {
      calls.push("flush-local");
    },
    deliverPending: async () => {
      calls.push("announce");
      return 1;
    },
  });

  const result = await processAutoRevocationForGroup(groupId, true, api, new Date(), deps);

  assert.deepEqual(calls, ["persist-revocation", "unmark-local:41", "flush-local", "announce"]);
  assert.deepEqual(result, { revoked: 1, announced: 1, errors: 0 });
});

test("automatic revocation clears the actual local ZEUS registry consumed by AFRODITA", async () => {
  const originalDirectory = process.cwd();
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "zeus-auto-revoke-"));
  const isolatedGroupId = -900000321;
  try {
    process.chdir(temporaryDirectory);
    await markUserVerified(isolatedGroupId, 43, "local-user", "Local User");
    await flushStorage();

    const result = await processAutoRevocationForGroup(
      isolatedGroupId,
      true,
      api,
      new Date(),
      dependencies({
        listExpired: async () => [expiredUser(43)],
        revokeExpired: async () => notification(43),
        listPending: async () => [notification(43)],
        unmarkLocal: unmarkUserVerified,
        flushLocal: flushStorage,
        deliverPending: async () => 1,
      }),
    );

    const groupData = JSON.parse(
      await readFile(resolve(temporaryDirectory, "data", "storage", `${isolatedGroupId}.json`), "utf8"),
    ) as {
      promotion: { verifiedUsers: Record<string, boolean> };
      indexedUsers: Record<string, { verified: boolean; zeusRole: string }>;
    };
    assert.deepEqual(result, { revoked: 1, announced: 1, errors: 0 });
    assert.equal(groupData.promotion.verifiedUsers["43"], false);
    assert.equal(groupData.indexedUsers["43"]?.verified, false);
    assert.equal(groupData.indexedUsers["43"]?.zeusRole, "user");
  } finally {
    process.chdir(originalDirectory);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a local write failure preserves remote revocation and withholds announcement until retry", async () => {
  let remoteRevoked = false;
  let localSynchronized = false;
  let flushFailuresRemaining = 1;
  let pending = true;
  let announcements = 0;
  const deps = dependencies({
    listExpired: async () => remoteRevoked ? [] : [expiredUser(42)],
    revokeExpired: async () => {
      remoteRevoked = true;
      return notification(42);
    },
    listPending: async () => pending ? [notification(42)] : [],
    unmarkLocal: async () => undefined,
    flushLocal: async () => {
      if (flushFailuresRemaining > 0) {
        flushFailuresRemaining -= 1;
        throw new Error("local disk unavailable");
      }
      localSynchronized = true;
    },
    deliverPending: async () => {
      announcements += 1;
      pending = false;
      return 1;
    },
  });

  const failed = await processAutoRevocationForGroup(groupId, true, api, new Date(), deps);
  assert.equal(remoteRevoked, true);
  assert.equal(failed.revoked, 1);
  assert.equal(failed.announced, 0);
  assert.equal(failed.errors, 1);
  assert.equal(announcements, 0);

  const retried = await processAutoRevocationForGroup(groupId, true, api, new Date(), deps);
  assert.equal(remoteRevoked, true);
  assert.equal(localSynchronized, true);
  assert.deepEqual(retried, { revoked: 0, announced: 1, errors: 0 });
  assert.equal(announcements, 1);
});

test("a failed user's persistence does not prevent processing subsequent users", async () => {
  const attempted: number[] = [];
  const localAttempts: number[] = [];
  const revokedUsers = new Set<number>();
  let persistenceFailuresRemaining = 1;
  let localFailuresRemaining = 1;
  let announcementCount = 0;
  const deps = dependencies({
    listExpired: async () =>
      [51, 52, 53]
        .filter((userId) => !revokedUsers.has(userId))
        .map(expiredUser),
    revokeExpired: async (_group, userId) => {
      attempted.push(userId);
      if (userId === 51 && persistenceFailuresRemaining > 0) {
        persistenceFailuresRemaining -= 1;
        throw new Error("transient persistence failure");
      }
      revokedUsers.add(userId);
      return notification(userId);
    },
    listPending: async () => [...revokedUsers].map(notification),
    unmarkLocal: async (_group, userId) => {
      localAttempts.push(userId);
      if (userId === 52 && localFailuresRemaining > 0) {
        localFailuresRemaining -= 1;
        throw new Error("temporary local update failure");
      }
    },
    deliverPending: async () => {
      announcementCount += 1;
      return revokedUsers.size;
    },
  });

  const first = await processAutoRevocationForGroup(groupId, true, api, new Date(), deps);

  assert.deepEqual(attempted, [51, 52, 53]);
  assert.deepEqual(localAttempts, [52, 53]);
  assert.deepEqual(first, { revoked: 2, announced: 0, errors: 2 });
  assert.equal(announcementCount, 0);

  localAttempts.length = 0;
  const retry = await processAutoRevocationForGroup(groupId, true, api, new Date(), deps);
  assert.deepEqual(localAttempts.sort(), [51, 52, 53]);
  assert.deepEqual(retry, { revoked: 1, announced: 3, errors: 0 });
  assert.equal(announcementCount, 1);
});

test("disabled automatic revocation does not revoke expired users but retries pending local sync", async () => {
  let revocationCalls = 0;
  const localIds: number[] = [];
  let announcementCalls = 0;
  const deps = dependencies({
    listExpired: async () => [expiredUser(61)],
    revokeExpired: async () => {
      revocationCalls += 1;
      return notification(61);
    },
    listPending: async () => [notification(60)],
    unmarkLocal: async (_group, userId) => {
      localIds.push(userId);
    },
    deliverPending: async () => {
      announcementCalls += 1;
      return 1;
    },
  });

  const result = await processAutoRevocationForGroup(groupId, false, api, new Date(), deps);
  assert.equal(revocationCalls, 0);
  assert.deepEqual(localIds, [60]);
  assert.equal(announcementCalls, 1);
  assert.deepEqual(result, { revoked: 0, announced: 1, errors: 0 });
});
