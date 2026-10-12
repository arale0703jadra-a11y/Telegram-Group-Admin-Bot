import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import {
  getVerifiedGroupMember,
  resolveVerifiedUserInput,
  VerifiedUserRegistrationError,
} from "../src/services/verified-user-registration.js";
import type { IndexedUser } from "../src/storage/types.js";

const observedUser: IndexedUser = {
  id: 501,
  groupId: -10001,
  username: "observed_user",
  firstName: "Observed",
  name: "Observed User",
  firstSeen: 1,
};

function member(status: ChatMember["status"] = "member"): ChatMember {
  return {
    status,
    user: {
      id: 501,
      is_bot: false,
      first_name: "Observed",
      last_name: "User",
      username: "observed_user",
    },
  } as ChatMember;
}

function mockApi(
  result: ChatMember | Error,
  onCall?: (chatId: number, userId: number) => void,
): Pick<Api, "getChatMember"> {
  return {
    getChatMember: async (chatId: number, userId: number) => {
      onCall?.(chatId, userId);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("resolves an observed @username by exact match and confirms Telegram identity", async () => {
  let requestedId = 0;
  const resolved = await resolveVerifiedUserInput(
    mockApi(member(), (_chatId, userId) => {
      requestedId = userId;
    }),
    -10001,
    "@OBSERVED_USER",
    [observedUser],
  );
  assert.equal(requestedId, observedUser.id);
  assert.equal(resolved.user.id, observedUser.id);
});

test("does not resolve unobserved or partial usernames", async () => {
  await assert.rejects(
    resolveVerifiedUserInput(
      mockApi(member()),
      -10001,
      "@unobserved_user",
      [observedUser],
    ),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "USERNAME_NOT_OBSERVED" &&
      error.message.includes("Telegram user ID"),
  );
  await assert.rejects(
    resolveVerifiedUserInput(
      mockApi(member()),
      -10001,
      "@observed",
      [observedUser],
    ),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "USERNAME_NOT_OBSERVED",
  );
});

test("resolves numeric IDs directly with Telegram and rejects invalid IDs", async () => {
  let requested: [number, number] | undefined;
  const resolved = await resolveVerifiedUserInput(
    mockApi(member(), (chatId, userId) => {
      requested = [chatId, userId];
    }),
    -10002,
    "501",
    [],
  );
  assert.deepEqual(requested, [-10002, 501]);
  assert.equal(resolved.user.id, 501);

  await assert.rejects(
    resolveVerifiedUserInput(mockApi(member()), -10001, "0", []),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "INVALID_USER_ID",
  );
});

test("reports Telegram-confirmed non-members separately from API failures", async () => {
  await assert.rejects(
    getVerifiedGroupMember(mockApi(member("left")), -10001, 501),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "USER_NOT_IN_GROUP",
  );

  await assert.rejects(
    getVerifiedGroupMember(mockApi(new Error("network unavailable")), -10001, 501),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "TELEGRAM_ERROR" &&
      error.cause instanceof Error,
  );
});

test("rejects a Telegram response for a different user ID", async () => {
  const wrongIdentity = {
    ...member(),
    user: { ...member().user, id: 777 },
  } as ChatMember;
  await assert.rejects(
    getVerifiedGroupMember(mockApi(wrongIdentity), -10001, 501),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "IDENTITY_MISMATCH",
  );
});

test("rejects a username if the observed account changed usernames", async () => {
  const changedMember = {
    ...member(),
    user: { ...member().user, username: "different_user" },
  } as ChatMember;
  await assert.rejects(
    resolveVerifiedUserInput(
      mockApi(changedMember),
      -10001,
      "@observed_user",
      [observedUser],
    ),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "USERNAME_CHANGED",
  );
});
