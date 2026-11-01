import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeVerifiedConfirmation,
  createVerifiedConfirmation,
} from "../src/services/verified-confirmations.js";
import type { MyContext } from "../src/types.js";

function context(
  userId = 123,
  session = {
    group: {} as MyContext["session"]["group"],
    user: {},
  } as MyContext["session"],
): MyContext {
  return {
    from: { id: userId },
    session,
  } as unknown as MyContext;
}

test("verified confirmations bind actor, group, subject, operation, and single use", () => {
  const ctx = context();
  const token = createVerifiedConfirmation(
    ctx,
    -100123,
    456,
    "candidate-approve",
  );

  assert.equal(consumeVerifiedConfirmation(ctx, {
    groupId: -100124,
    userId: 456,
    operation: "candidate-approve",
    token,
  }), false);
  assert.equal(consumeVerifiedConfirmation(ctx, {
    groupId: -100123,
    userId: 457,
    operation: "candidate-approve",
    token,
  }), false);
  assert.equal(consumeVerifiedConfirmation(ctx, {
    groupId: -100123,
    userId: 456,
    operation: "candidate-reject",
    token,
  }), false);

  assert.equal(consumeVerifiedConfirmation(ctx, {
    groupId: -100123,
    userId: 456,
    operation: "candidate-approve",
    token,
  }), true);
  assert.equal(consumeVerifiedConfirmation(ctx, {
    groupId: -100123,
    userId: 456,
    operation: "candidate-approve",
    token,
  }), false);
});

test("verified confirmations cannot be used by another actor or after expiry", () => {
  const ctx = context();
  const token = createVerifiedConfirmation(ctx, -100123, 456, "revoke");

  const otherActor = context(789, ctx.session);
  assert.equal(consumeVerifiedConfirmation(otherActor, {
    groupId: -100123,
    userId: 456,
    operation: "revoke",
    token,
  }), false);

  if (!ctx.session.user.verifiedConfirmation) {
    assert.fail("confirmation should remain available after an actor mismatch");
  }
  ctx.session.user.verifiedConfirmation.expiresAt = Date.now() - 1;
  assert.equal(consumeVerifiedConfirmation(ctx, {
    groupId: -100123,
    userId: 456,
    operation: "revoke",
    token,
  }), false);
  assert.equal(ctx.session.user.verifiedConfirmation, undefined);
});
