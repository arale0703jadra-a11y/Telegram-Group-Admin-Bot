import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import { moderationActions } from "../src/menus/actions.js";
import {
  activateManualVerifiedUser,
  calculateManualVerificationDates,
  DEFAULT_VERIFIED_PERMISSIONS,
  revokeManualVerifiedUser,
} from "../src/services/verified-users.js";
import { isActiveVerifiedRecord } from "../src/services/verified-user-policy.js";
import {
  resolveVerifiedUserInput,
  VerifiedUserRegistrationError,
} from "../src/services/verified-user-registration.js";
import type { MyContext } from "../src/types.js";

process.env.SUPABASE_URL = "https://verified-manual.test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const realFetch = globalThis.fetch;
let rpcResponse: unknown;
let rpcError: Record<string, unknown> | undefined;
const rpcCalls: Array<{ route: string; body: Record<string, unknown> }> = [];

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const route = url.pathname.split("/").pop() ?? "";
  const bodyText =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request && input.body
        ? await input.clone().text()
        : "{}";
  if (route !== "activate_manual_verified_user" && route !== "revoke_manual_verified_user") {
    return new Response(JSON.stringify({ message: `Unexpected route ${route}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  rpcCalls.push({ route, body: JSON.parse(bodyText) as Record<string, unknown> });
  return new Response(
    JSON.stringify(rpcError ?? rpcResponse),
    { status: rpcError ? 400 : 200, headers: { "content-type": "application/json" } },
  );
};

test.after(() => {
  globalThis.fetch = realFetch;
});

test.beforeEach(() => {
  rpcResponse = undefined;
  rpcError = undefined;
  rpcCalls.length = 0;
});

function verifiedRow() {
  return {
    id: "verified-manual-1",
    group_id: -100123,
    user_id: 456,
    username: "sample",
    display_name: "Sample Member",
    verified: true,
    permissions: { ...DEFAULT_VERIFIED_PERMISSIONS },
    created_at: "2026-01-02T03:04:00.000Z",
    updated_at: "2026-01-02T03:04:00.000Z",
    created_by: 123,
    revoked_at: null,
    verification_method: "manual",
    detected_at: null,
    activated_at: "2026-01-02T03:04:00.000Z",
    valid_until: "2026-02-01T03:04:00.000Z",
  };
}

test("manual validity is exactly 30 days and stored as UTC timestamps", () => {
  const dates = calculateManualVerificationDates(
    new Date("2026-03-01T12:00:00.000Z"),
  );
  assert.equal(dates.activatedAt, "2026-03-01T12:00:00.000Z");
  assert.equal(dates.validUntil, "2026-03-31T12:00:00.000Z");
});

test("manual activation sends dates, identity and actor to the atomic audited operation", async () => {
  rpcResponse = { status: "created", user: verifiedRow() };
  const result = await activateManualVerifiedUser({
    groupId: -100123,
    userId: 456,
    username: "sample",
    displayName: "Sample Member",
    actorUserId: 123,
    reactivate: false,
  });

  assert.equal(result.status, "created");
  assert.equal(result.user.valid_until, "2026-02-01T03:04:00.000Z");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]?.route, "activate_manual_verified_user");
  assert.equal(rpcCalls[0]?.body.p_group_id, -100123);
  assert.equal(rpcCalls[0]?.body.p_actor_user_id, 123);
  assert.equal(rpcCalls[0]?.body.p_reactivate, false);
  assert.deepEqual(rpcCalls[0]?.body.p_permissions, DEFAULT_VERIFIED_PERMISSIONS);
  assert.equal(
    Date.parse(String(rpcCalls[0]?.body.p_valid_until)) -
      Date.parse(String(rpcCalls[0]?.body.p_activated_at)),
    30 * 24 * 60 * 60 * 1000,
  );
});

test("database duplicate and stale-reactivation results do not create a second activation", async () => {
  rpcResponse = { status: "already_active" };
  assert.deepEqual(
    await activateManualVerifiedUser({
      groupId: -100123,
      userId: 456,
      actorUserId: 123,
      reactivate: false,
    }),
    { status: "already_active" },
  );

  rpcResponse = { status: "reactivation_required" };
  assert.deepEqual(
    await activateManualVerifiedUser({
      groupId: -100123,
      userId: 456,
      actorUserId: 123,
      reactivate: false,
    }),
    { status: "reactivation_required" },
  );
  assert.equal(rpcCalls.length, 2);
});

test("reactivation is a distinct explicitly requested audited activation", async () => {
  rpcResponse = { status: "reactivated", user: verifiedRow() };
  const result = await activateManualVerifiedUser({
    groupId: -100123,
    userId: 456,
    actorUserId: 123,
    reactivate: true,
  });
  assert.equal(result.status, "reactivated");
  assert.equal(rpcCalls[0]?.body.p_reactivate, true);
});

test("expired verification remains active until the scheduled revocation is persisted", () => {
  assert.equal(
    isActiveVerifiedRecord({
      verified: true,
      revoked_at: null,
      valid_until: "2020-01-01T00:00:00.000Z",
    }),
    true,
  );
});

test("manual revocation records only an explicit active-state transition", async () => {
  rpcResponse = { status: "revoked" };
  assert.equal(
    await revokeManualVerifiedUser({
      groupId: -100123,
      userId: 456,
      actorUserId: 123,
    }),
    true,
  );
  assert.equal(rpcCalls[0]?.route, "revoke_manual_verified_user");

  rpcResponse = { status: "not_active" };
  assert.equal(
    await revokeManualVerifiedUser({
      groupId: -100123,
      userId: 456,
      actorUserId: 123,
    }),
    false,
  );
});

test("invalid identities are rejected before asking Telegram for membership", async () => {
  let telegramCalls = 0;
  await assert.rejects(
    resolveVerifiedUserInput(
      {
        getChatMember: async () => {
          telegramCalls += 1;
          return {
            status: "member",
            user: { id: 456, is_bot: false, first_name: "Sample" },
          } as ChatMember;
        },
      } as Pick<Api, "getChatMember">,
      -100123,
      "not an id or username",
      [],
    ),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "INVALID_INPUT",
  );
  assert.equal(telegramCalls, 0);
});

test("Telegram membership errors are surfaced as registration errors", async () => {
  await assert.rejects(
    resolveVerifiedUserInput(
      {
        getChatMember: async () => {
          throw new Error("network unavailable");
        },
      } as Pick<Api, "getChatMember">,
      -100123,
      "456",
      [],
    ),
    (error: unknown) =>
      error instanceof VerifiedUserRegistrationError &&
      error.code === "TELEGRAM_ERROR",
  );
});

test("non-admins cannot start the manual verification flow", async () => {
  const actor = { id: 423424, is_bot: false, first_name: "NotAdmin" };
  const ctx = {
    update: {
      callback_query: {
        id: "manual-add-unauthorized",
        chat_instance: "test",
        from: actor,
        data: "vu:add",
      },
    },
    callbackQuery: {
      id: "manual-add-unauthorized",
      chat_instance: "test",
      from: actor,
      data: "vu:add",
    },
    chat: { id: 423424, type: "private", first_name: "NotAdmin" },
    from: actor,
    session: {
      group: {},
      user: { selectedGroupId: -100123, selectedGroupTitle: "Group" },
    },
    api: {
      getChatMember: async () => ({
        status: "member",
        user: actor,
      }),
    },
    answerCallbackQuery: async () => true,
    reply: async () => ({ message_id: 1, date: 0 }),
  } as unknown as MyContext;

  await moderationActions.middleware()(ctx, async () => {});
  assert.equal(ctx.session.user.pendingAction, undefined);
});

test("Supabase errors reject manual activation rather than returning success-shaped data", async () => {
  rpcError = { message: "database unavailable", code: "08006" };
  await assert.rejects(
    activateManualVerifiedUser({
      groupId: -100123,
      userId: 456,
      actorUserId: 123,
      reactivate: false,
    }),
  );
});
