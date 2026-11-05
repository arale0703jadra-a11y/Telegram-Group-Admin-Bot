import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  AutomaticMessageAction,
  buildAutomaticMessagePanel,
  buildAutomaticMessageHistoryPanel,
  buildCleanupSettingsPanel,
  CleanupAction,
  buildMainPanel,
  ModAction,
} from "../src/menus/panels.js";
import { cleanRecentMessages } from "../src/moderation/actions.js";
import { resolveAutomaticMessageGroupId } from "../src/menus/actions.js";
import { flushStorage, getGroupData, saveGroupData } from "../src/storage/index.js";
import type { MyContext } from "../src/types.js";

function buttonCallbacks(panel: ReturnType<typeof buildMainPanel>): Array<string | undefined> {
  return panel.keyboard.inline_keyboard.flat().map((button) =>
    "callback_data" in button ? button.callback_data : undefined
  );
}

test("cleanup panel exposes service-message auto-delete and quick purge actions", () => {
  const panel = buildCleanupSettingsPanel({
    autoDeleteServiceMessages: true,
  });
  const callbacks = buttonCallbacks(panel);

  assert.match(panel.text, /mensajes de servicio.*eliminan automáticamente/u);
  assert.match(panel.text, /ZEUS haya registrado/u);
  assert.ok(callbacks.includes(CleanupAction.toggle));
  for (const count of [10, 25, 50, 100]) {
    assert.ok(callbacks.includes(ModAction.cleanup(count)));
  }
});

test("cleanup panel reflects a disabled service-message deletion setting", () => {
  const panel = buildCleanupSettingsPanel({
    autoDeleteServiceMessages: false,
  });
  assert.equal(
    panel.keyboard.inline_keyboard[0]?.[0]?.text.includes("desactivada"),
    true,
  );
});

test("main menu restores verified users and recurring-message buttons", () => {
  const panel = buildMainPanel("Grupo de prueba");
  const buttons = panel.keyboard.inline_keyboard.flat();
  const callbacks = buttonCallbacks(panel);

  assert.ok(buttons.some((button) => button.text.includes("Verificadas")));
  assert.ok(buttons.some((button) => button.text.includes("Mensajes Recurrentes")));
  assert.ok(callbacks.includes("fa:verified"));
  assert.ok(callbacks.includes(AutomaticMessageAction.home));
});

test("recurring-message panel exposes configuration, schedule, toggle, and send-now", () => {
  const groupId = -1001234567890;
  const panel = buildAutomaticMessagePanel({
    enabled: false,
    message: "Aviso periódico",
    intervalMinutes: 60,
    status: "sent",
    nextRunAt: "2030-01-02T03:04:05.000Z",
    lastSentAt: "2030-01-01T03:04:05.000Z",
    attemptCount: 2,
  }, "Grupo de prueba", undefined, groupId);
  const callbacks = buttonCallbacks(panel);

  assert.match(panel.text, /Aviso periódico/u);
  assert.match(panel.text, /Grupo ID: `-1001234567890`/u);
  assert.match(panel.text, /Estado: \*⏸️ Pausado\*/u);
  assert.match(panel.text, /Intentos: 2/u);
  for (const action of [
    AutomaticMessageAction.configure(groupId),
    AutomaticMessageAction.interval(groupId),
    AutomaticMessageAction.toggle(groupId),
    AutomaticMessageAction.sendNow(groupId),
    AutomaticMessageAction.history(groupId),
    AutomaticMessageAction.deleteConfirm(groupId),
  ]) {
    assert.ok(callbacks.includes(action));
  }

  const errorPanel = buildAutomaticMessagePanel(
    {
      enabled: true,
      message: "Aviso",
      status: "pending",
      lastError: "bad *request*",
    },
    "Grupo de prueba",
    "Error: bad *request*",
    groupId,
  );
  assert.match(errorPanel.text, /Estado: \*🟡 Pendiente\*/u);
  assert.match(errorPanel.text, /Último error: bad \\\*request\\\*/u);
  assert.match(errorPanel.text, /Error: bad \\\*request\\\*/u);
});

test("recurring-message history and deletion confirmation stay bound to the same group", () => {
  const groupId = -1001234567890;
  const historyPanel = buildAutomaticMessageHistoryPanel({
    enabled: false,
    message: "Aviso",
    history: [
      { at: "2030-01-01T03:04:05.000Z", status: "sent", messageId: 5 },
      {
        at: "2030-01-02T03:04:05.000Z",
        status: "error",
        error: "bad *request*",
      },
    ],
  }, "Grupo de prueba", groupId);
  const historyCallbacks = buttonCallbacks(historyPanel);
  assert.match(historyPanel.text, /✅ Enviado/u);
  assert.match(historyPanel.text, /bad \\\*request\\\*/u);
  assert.ok(historyCallbacks.includes(AutomaticMessageAction.homeForGroup(groupId)));

  const confirmPanel = buildAutomaticMessagePanel(
    { enabled: false, message: "Aviso" },
    "Grupo de prueba",
    undefined,
    groupId,
    true,
  );
  const confirmCallbacks = buttonCallbacks(confirmPanel);
  assert.ok(confirmCallbacks.includes(AutomaticMessageAction.delete(groupId)));
  assert.ok(confirmCallbacks.includes(AutomaticMessageAction.homeForGroup(groupId)));
});

test("recurring-message callback uses its encoded group rather than the current selection", () => {
  assert.equal(
    resolveAutomaticMessageGroupId(-1002222222222, "am:toggle:-1001111111111"),
    -1001111111111,
  );
  assert.equal(
    resolveAutomaticMessageGroupId(-1002222222222, "am:toggle"),
    -1002222222222,
  );
  assert.equal(
    resolveAutomaticMessageGroupId(-1002222222222, "am:toggle:"),
    null,
  );
});

test("manual purge counts per-message failures instead of reporting full success", async () => {
  const groupId = -Math.floor(Date.now()) - 31;
  const file = resolve(process.cwd(), "data", "storage", `${groupId}.json`);
  const attemptedMessageIds: number[] = [];
  try {
    const data = await getGroupData(groupId);
    data.recentMessages = [101, 102, 103];
    await saveGroupData(groupId, data);
    await flushStorage();

    const ctx = {
      api: {
        deleteMessage: async (_chatId: number, messageId: number) => {
          attemptedMessageIds.push(messageId);
          if (messageId === 102) throw new Error("message cannot be deleted");
          return true;
        },
      },
    } as unknown as MyContext;

    const result = await cleanRecentMessages(ctx, groupId, 3);

    assert.deepEqual(attemptedMessageIds, [101, 102, 103]);
    assert.deepEqual(result, { attempted: 3, deleted: 2, failed: 1 });
  } finally {
    await flushStorage();
    if (existsSync(file)) unlinkSync(file);
  }
});

test("main menu does not expose unfinished rules or generic configuration buttons", () => {
  const callbacks = buttonCallbacks(buildMainPanel());
  assert.ok(!callbacks.includes("menu:sub:reglas"));
  assert.ok(!callbacks.includes("menu:sub:config"));
});
