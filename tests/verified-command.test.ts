import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickVerifiedActivationConfirmPanel,
  buildQuickVerifiedRevokeConfirmPanel,
  buildMainPanel,
  type Panel,
} from "../src/menus/panels.js";
import {
  parseQuickVerifiedCommand,
  verifiedCommand,
} from "../src/commands/verified.js";
import { privateInput } from "../src/commands/private-input.js";
import type { MyContext } from "../src/types.js";

function callbacks(panel: Panel): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : undefined))
    .filter((value): value is string => typeof value === "string");
}

test("quick verified command accepts exact identities and explicit supported actions", () => {
  assert.deepEqual(parseQuickVerifiedCommand("@Alexiita_Babyy"), {
    target: "@Alexiita_Babyy",
  });
  assert.deepEqual(parseQuickVerifiedCommand("123456 activar"), {
    target: "123456",
    action: "activate",
  });
  assert.deepEqual(parseQuickVerifiedCommand("@sample free"), {
    target: "@sample",
    action: "free",
  });
  assert.deepEqual(parseQuickVerifiedCommand("123456 revocar"), {
    target: "123456",
    action: "revoke",
  });
});

test("quick verified command rejects ambiguous or unsupported syntax", () => {
  for (const input of [
    "",
    "Sample Name",
    "@sample renovar",
    "@sample free now",
    "123456 @other",
  ]) {
    assert.equal(parseQuickVerifiedCommand(input), undefined, input);
  }
});

test("private input forwards slash commands to later command handlers", async () => {
  let continued = false;
  const context = {
    update: { message: { text: "/verificada @sample" } },
    chat: { type: "private" },
    from: { id: 123 },
    message: { text: "/verificada @sample" },
    session: { user: { pendingAction: undefined } },
  } as unknown as MyContext;

  await privateInput.middleware()(context, async () => {
    continued = true;
  });

  assert.equal(continued, true);
});

test("/verificadas is registered independently of the activation flow", async () => {
  const message = {
    message_id: 1,
    text: "/verificadas",
    entities: [{ type: "bot_command", offset: 0, length: 12 }],
  };
  const context = {
    update: { update_id: 1, message },
    message,
    chat: { id: -1001, type: "group" },
    from: { id: 123 },
    me: { username: "zeusbot" },
  } as unknown as MyContext;
  let continued = false;

  await verifiedCommand.middleware()(context, async () => {
    continued = true;
  });

  assert.equal(continued, false);
});

test("quick verified confirmation callbacks bind the operation to the selected group", () => {
  const activation = buildQuickVerifiedActivationConfirmPanel({
    groupId: -1001,
    userId: 123,
    displayName: "Sample User",
    reactivate: true,
  });
  const revoke = buildQuickVerifiedRevokeConfirmPanel({
    groupId: -1001,
    userId: 123,
    displayName: "Sample User",
  });
  assert.ok(callbacks(activation).includes("vu:quick-activate:-1001:123:reactivate"));
  assert.ok(callbacks(revoke).includes("vu:quick-revoke:-1001:123"));
});

test("Limpieza is no longer a main-menu destination", () => {
  const panel = buildMainPanel("Test group");
  assert.doesNotMatch(panel.text, /Limpieza/);
  assert.ok(
    callbacks(panel).every((callback) => !callback.includes(":limpieza")),
  );
});
