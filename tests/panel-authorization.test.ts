import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuthorizedPanelUser,
  isAuthorizedPanelUserId,
} from "../src/security/panel-authorization.js";

test("panel access allows only the current owner and configured secondary identity", () => {
  assert.equal(isAuthorizedPanelUserId(100, 100, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(200, 100, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(90, 100, 90, 200), false);
  assert.equal(isAuthorizedPanelUserId(300, 100, 90, 200), false);
});

test("configured owner is used only before the system owner is bootstrapped", () => {
  assert.equal(isAuthorizedPanelUserId(90, undefined, 90, 200), true);
  assert.equal(isAuthorizedPanelUserId(90, 100, 90, 200), false);
});

test("invalid Telegram ids are never authorized", () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isAuthorizedPanelUserId(id, 100, 90, 200), false);
  }
});

test("owner lookup failures fail closed and are logged without exposing details", async () => {
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...values: unknown[]) => logs.push(values.join(" "));
  try {
    assert.equal(
      await isAuthorizedPanelUser(100, async () => {
        throw new Error("sensitive database detail");
      }),
      false,
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /access=denied/);
  assert.doesNotMatch(logs[0] ?? "", /sensitive database detail/);
});
