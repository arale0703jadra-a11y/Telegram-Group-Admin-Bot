import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { buildVerifiedModelsPanel, FilterAction } from "../src/menus/panels.js";
import {
DEFAULT_VERIFIED_PERMISSIONS,
processAutoRevocationForGroup,
type VerifiedUser,
} from "../src/services/verified-users.js";
import { buildManualVerifiedConfirmPanel, VerifiedAction } from "../src/menus/panels.js";
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
  assert.ok(callbacks.includes("vu:add"));
  assert.ok(callbacks.includes("menu:main"));
  assert.ok(!callbacks.includes(FilterAction.home));
});

test("manual verification panel requires explicit confirmation and states expiry is informational", () => {
  const panel = buildManualVerifiedConfirmPanel({
    userId: 456,
    displayName: "Sample Member",
    username: "sample",
    reactivate: true,
    groupTitle: "Test group",
  });
  const buttons = panel.keyboard.inline_keyboard.flat();

  assert.match(panel.text, /vigencia inicial será de 30 días/);
  assert.match(panel.text, /no quitará la verificación ni cambiará permisos o historial/);
  assert.ok(buttons.some(
    (button) => buttonCallbackData(button) === VerifiedAction.manualConfirm(456, true),
  ));
  assert.ok(buttons.some((button) => buttonCallbackData(button) === "vu:manual-cancel"));
});

test("verified management panel exposes the automatic revocation toggle", () => {
  const panel = buildVerifiedModelsPanel(
    [verifiedUser(456)],
    0,
    "Test group",
    ["Verificada"],
    true,
    true,
  );
  const callbacks = panel.keyboard.inline_keyboard.flat().map(buttonCallbackData);

  assert.ok(callbacks.includes("vu:auto-revoke-toggle"));
  assert.match(panel.text, /Revocación automática: activa/);
});

test("expired verification is atomically revoked and its pending announcement is claimed once", async () => {
  process.env.SUPABASE_URL = "https://verified-revocation.test.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  let active = true;
  let notificationStatus = "pending";
  let notificationCreated = false;
  const eventKey = "expired-event-1";
  let sentAnnouncements = 0;
  let autoRevocationCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const route = url.pathname.split("/").pop();
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (route === "verified_users" && method === "GET") {
      return json(active ? [{
        group_id: -100123,
        user_id: 999,
        username: "expired-user",
        display_name: "Expired User",
        valid_until: "2020-01-01T00:00:00.000Z",
      }] : []);
    }
    if (route === "revoke_expired_verified_user") {
      autoRevocationCalls += 1;
      active = false;
      notificationCreated = true;
      return json({
        status: "revoked",
        event_key: eventKey,
        group_id: -100123,
        user_id: 999,
        username: "expired-user",
        display_name: "Expired User",
      });
    }
    if (route === "verified_user_auto_revocation_outbox" && method === "GET") {
      return json(notificationCreated && notificationStatus === "pending" ? [{
        event_key: eventKey,
        group_id: -100123,
        user_id: 999,
        username: "expired-user",
        display_name: "Expired User",
      }] : []);
    }
    if (route === "claim_verified_auto_revocation_notification") {
      if (notificationStatus !== "pending") return json({ status: "not_pending" });
      notificationStatus = "sending";
      return json({
        status: "claimed",
        event_key: eventKey,
        group_id: -100123,
        user_id: 999,
        username: "expired-user",
        display_name: "Expired User",
      });
    }
    if (route === "finish_verified_auto_revocation_notification") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { p_outcome?: string };
      notificationStatus = body.p_outcome ?? "unknown";
      return json(true);
    }
    return new Response(JSON.stringify({ message: "Unexpected route" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const api = {
      sendMessage: async () => {
        sentAnnouncements += 1;
        return {} as Awaited<ReturnType<Api["sendMessage"]>>;
      },
    } as Pick<Api, "sendMessage">;
    const disabledRun = await processAutoRevocationForGroup(
      -100123,
      false,
      api,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    assert.equal(disabledRun.revoked, 0);
    assert.equal(active, true);
    assert.equal(autoRevocationCalls, 0);
    assert.equal(sentAnnouncements, 0);

    const result = await processAutoRevocationForGroup(
      -100123,
      true,
      api,
      new Date("2026-01-02T00:00:00.000Z"),
      {
        unmarkLocal: async () => undefined,
        flushLocal: async () => undefined,
      },
    );
    assert.equal(result.revoked, 1);
    assert.equal(result.announced, 1);
    assert.equal(active, false);
    assert.equal(autoRevocationCalls, 1);
    assert.equal(notificationStatus, "sent");
    assert.equal(sentAnnouncements, 1);

    const secondRun = await processAutoRevocationForGroup(
      -100123,
      true,
      api,
      new Date("2026-01-03T00:00:00.000Z"),
      {
        unmarkLocal: async () => undefined,
        flushLocal: async () => undefined,
      },
    );
    assert.equal(secondRun.revoked, 0);
    assert.equal(secondRun.announced, 0);
    assert.equal(sentAnnouncements, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
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
