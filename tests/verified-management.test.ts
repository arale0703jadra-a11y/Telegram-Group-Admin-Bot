import assert from "node:assert/strict";
import test from "node:test";
import { buildVerifiedModelsPanel, FilterAction } from "../src/menus/panels.js";
import {
  DEFAULT_VERIFIED_PERMISSIONS,
  type VerifiedUser,
} from "../src/services/verified-users.js";
import { hasVerifiedCustomTitle } from "../src/services/verified-title-sync.js";
import { buttonCallbackData } from "./helpers.js";

function verifiedUser(userId: number): VerifiedUser {
  return {
    id: `verified-${userId}`,
    group_id: -100123,
    user_id: userId,
    username: `user${userId}`,
    display_name: `User ${userId}`,
    verified: true,
    permissions: { ...DEFAULT_VERIFIED_PERMISSIONS },
    created_at: "2026-01-02T03:04:00.000Z",
    updated_at: "2026-01-02T03:04:00.000Z",
    created_by: 123,
    revoked_at: null,
  };
}

test("custom title detection is trimmed and case-insensitive", () => {
  assert.equal(hasVerifiedCustomTitle("Verificada"), true);
  assert.equal(hasVerifiedCustomTitle(" verificada "), true);
  assert.equal(hasVerifiedCustomTitle("Verificado"), false);
  assert.equal(hasVerifiedCustomTitle(undefined), false);
});

test("verified management panel displays private actions for the listed IDs", () => {
  const panel = buildVerifiedModelsPanel(
    [verifiedUser(456)],
    0,
    "Test group",
    ["Verificada", "#verified"],
    true,
  );
  const callbacks = panel.keyboard.inline_keyboard.flat().map(buttonCallbackData);

  assert.match(panel.text, /User 456 — ID 456/);
  assert.match(panel.text, /Detección de marcas: activa/);
  assert.match(panel.text, /Marcas configuradas: Verificada, #verified/);
  assert.ok(callbacks.includes(FilterAction.verifiedMute(456)));
  assert.ok(callbacks.includes(FilterAction.verifiedBan(456)));
  assert.ok(callbacks.includes(FilterAction.verifiedRevoke(456)));
  assert.ok(callbacks.includes("cfg:verified_tags_toggle"));
  assert.ok(callbacks.includes("vu:edit"));
});

test("verified management panel paginates action buttons", () => {
  const users = Array.from({ length: 11 }, (_, index) => verifiedUser(500 + index));
  const panel = buildVerifiedModelsPanel(users, 1, "Test group");
  const callbacks = panel.keyboard.inline_keyboard.flat().map(buttonCallbackData);

  assert.match(panel.text, /Página 2 de 3/);
  assert.equal(
    callbacks.filter((callback) => callback?.startsWith("fa:verified_mute:")).length,
    5,
  );
  assert.ok(callbacks.includes(FilterAction.verifiedList(0)));
  assert.ok(callbacks.includes(FilterAction.verifiedList(2)));
});
