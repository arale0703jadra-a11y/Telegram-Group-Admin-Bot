import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import {
  GroupRegistrationError,
  verifyZeusCanAdministerGroup,
} from "../src/services/group-registration.js";

function adminMember(
  overrides: Partial<Extract<ChatMember, { status: "administrator" }>> = {},
): ChatMember {
  return {
    status: "administrator",
    user: { id: 99, is_bot: true, first_name: "ZEUS" },
    can_delete_messages: true,
    can_restrict_members: true,
    ...overrides,
  } as ChatMember;
}

function apiWith(
  result: ChatMember | Error,
  onCall?: (chatId: number, botId: number) => void,
): Pick<Api, "getChatMember"> {
  return {
    getChatMember: async (chatId, botId) => {
      onCall?.(chatId, botId);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("group registration validates Zeus membership in the requested chat", async () => {
  let request: [number, number] | undefined;
  const member = await verifyZeusCanAdministerGroup(
    apiWith(adminMember(), (chatId, botId) => {
      request = [chatId, botId];
    }),
    -100123,
    99,
  );
  assert.deepEqual(request, [-100123, 99]);
  assert.equal(member.status, "administrator");
});

test("group registration refuses Zeus when it is not an administrator", async () => {
  await assert.rejects(
    verifyZeusCanAdministerGroup(
      apiWith({
        status: "member",
        user: { id: 99, is_bot: true, first_name: "ZEUS" },
      } as ChatMember),
      -100123,
      99,
    ),
    (error: unknown) =>
      error instanceof GroupRegistrationError && error.code === "ZEUS_NOT_ADMIN",
  );
});

test("group registration requires delete and restrict permissions", async () => {
  await assert.rejects(
    verifyZeusCanAdministerGroup(
      apiWith(adminMember({ can_delete_messages: true, can_restrict_members: false })),
      -100123,
      99,
    ),
    (error: unknown) =>
      error instanceof GroupRegistrationError &&
      error.code === "MISSING_REQUIRED_PERMISSIONS",
  );
});

test("group registration distinguishes Telegram errors from missing membership", async () => {
  await assert.rejects(
    verifyZeusCanAdministerGroup(apiWith(new Error("network unavailable")), -100123, 99),
    (error: unknown) =>
      error instanceof GroupRegistrationError &&
      error.code === "TELEGRAM_ERROR" &&
      error.cause instanceof Error,
  );
});
