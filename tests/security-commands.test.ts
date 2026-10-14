import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSecurityCommandOperationKey,
  getSecurityCommandResultState,
} from "../src/services/security-commands.js";

test("security operation keys are stable for equivalent requests", () => {
  const first = buildSecurityCommandOperationKey({
    groupId: -100,
    action: "BAN_USER",
    targetUserId: 42,
    targetMessageId: 7,
    idempotencyKey: "telegram-update-123",
    payload: { reason: "spam", duration_minutes: 30, warn_action: "mute" },
  });
  const second = buildSecurityCommandOperationKey({
    groupId: -100,
    action: "BAN_USER",
    targetUserId: 42,
    targetMessageId: 7,
    idempotencyKey: "telegram-update-123",
    payload: { warn_action: "mute", duration_minutes: 30, reason: "spam" },
  });

  assert.equal(first, second);
});

test("security operation keys change when the logical command changes", () => {
  const first = buildSecurityCommandOperationKey({
    groupId: -100,
    action: "BAN_USER",
    targetUserId: 42,
    targetMessageId: 7,
    idempotencyKey: "telegram-update-123",
    payload: { reason: "spam" },
  });
  const second = buildSecurityCommandOperationKey({
    groupId: -100,
    action: "BAN_USER",
    targetUserId: 42,
    targetMessageId: 7,
    idempotencyKey: "telegram-update-123",
    payload: { reason: "spam-2" },
  });

  assert.notEqual(first, second);
});

test("separate updates with otherwise identical commands remain independent", () => {
  const first = buildSecurityCommandOperationKey({
    groupId: -100,
    action: "BAN_USER",
    targetUserId: 42,
    idempotencyKey: "telegram-update-123",
  });
  const second = buildSecurityCommandOperationKey({
    groupId: -100,
    action: "BAN_USER",
    targetUserId: 42,
    idempotencyKey: "telegram-update-124",
  });

  assert.notEqual(first, second);
});

test("timed actions keep the same key when generated expiry changes between retries", async () => {
  const input = {
    groupId: -100,
    action: "MUTE_USER" as const,
    targetUserId: 42,
    idempotencyKey: "telegram-update-123",
    payload: { duration_minutes: 30 },
  };
  const first = buildSecurityCommandOperationKey(input);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = buildSecurityCommandOperationKey(input);

  assert.equal(first, second);
});

test("commands without a source idempotency key do not deduplicate by semantic hash", () => {
  assert.equal(
    buildSecurityCommandOperationKey({
      groupId: -100,
      action: "BAN_USER",
      targetUserId: 42,
    }),
    undefined,
  );
});

test("command result states convert pending or expired lease states without pretending a final answer exists", () => {
  assert.equal(getSecurityCommandResultState({ status: "pending" }), "queued");
  assert.equal(getSecurityCommandResultState({ result_state: "queued" }), "queued");
  assert.equal(getSecurityCommandResultState({ result_state: "unknown" }), "unknown");
  assert.equal(
    getSecurityCommandResultState({ status: "processing", lease_expires_at: new Date(Date.now() + 60_000).toISOString() }),
    "processing",
  );
  assert.equal(
    getSecurityCommandResultState({ status: "processing", lease_expires_at: new Date(Date.now() - 60_000).toISOString() }),
    "unknown",
  );
  assert.equal(getSecurityCommandResultState({ status: "completed" }), "completed");
  assert.equal(getSecurityCommandResultState({ result_state: "failed" }), "failed");
  assert.equal(getSecurityCommandResultState({ status: "cancelled" }), "cancelled");
});
