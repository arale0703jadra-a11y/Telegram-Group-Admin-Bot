import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteGroupCommand,
  getZeusCommandName,
} from "../src/commands/delete-group-command.js";
import { COMMAND_DEFINITIONS, COMMAND_NAMES } from "../src/commands/definitions.js";
import {
  cleanModerationReason,
  findExactObservedUsername,
  parseMuteDuration,
} from "../src/commands/moderation.js";
import {
  buildCommandListPanel,
  buildMainPanel,
  MenuAction,
} from "../src/menus/panels.js";
import { parseMenuAction } from "../src/menus/index.js";
import type { MyContext } from "../src/types.js";
import type { VerifiedUser } from "../src/services/verified-users.js";
import { buildVerifiedRecordsPanel } from "../src/menus/panels.js";

test("mute duration accepts bounded minute, hour, and day formats only", () => {
  assert.equal(parseMuteDuration("30"), 30);
  assert.equal(parseMuteDuration("30m"), 30);
  assert.equal(parseMuteDuration("2h"), 120);
  assert.equal(parseMuteDuration("3d"), 4320);
  assert.equal(parseMuteDuration("527040"), 527040);
  for (const invalid of ["0", "-1", "1.5h", "1w", "527041m", "999999999999999999d"]) {
    assert.equal(parseMuteDuration(invalid), undefined, invalid);
  }
});

test("moderation reasons remove control characters and redact token-like secrets", () => {
  const reason = cleanModerationReason(
    `fraud\u0000 123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO ` +
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1234567890",
  );
  assert.equal(reason, "fraud [redactado] [redactado]");
});

test("username resolution requires one exact previously observed identity", () => {
  const observed = [
    { id: 101, username: "Known_User" },
    { id: 102, username: "AnotherUser" },
  ];
  assert.equal(findExactObservedUsername(observed, "@known_user"), 101);
  assert.equal(findExactObservedUsername(observed, "@known"), undefined);
  assert.equal(findExactObservedUsername(observed, "@unknown_user"), undefined);
  assert.equal(
    findExactObservedUsername([...observed, { id: 103, username: "known_user" }], "@known_user"),
    undefined,
  );
});

test("command metadata includes supported moderation and verification commands only", () => {
  assert.ok(COMMAND_NAMES.has("ban"));
  assert.ok(COMMAND_NAMES.has("mute"));
  assert.ok(COMMAND_NAMES.has("desmute"));
  assert.ok(COMMAND_NAMES.has("unmute"));
  assert.ok(COMMAND_NAMES.has("unban"));
  assert.ok(COMMAND_NAMES.has("verificada"));
  assert.ok(COMMAND_NAMES.has("verificadas"));
  assert.ok(COMMAND_NAMES.has("admin"));
  assert.ok(COMMAND_NAMES.has("zeus-recuperar"));
  assert.ok(!COMMAND_NAMES.has("warn"));
  const unmute = COMMAND_DEFINITIONS.find((item) => item.command === "/desmute");
  assert.deepEqual(unmute?.aliases, ["/unmute"]);
});

test("group command detection requires a Telegram command entity and respects bot addressing", () => {
  const makeMessage = (text: string, commandLength: number) =>
    ({
      text,
      entities: [{ type: "bot_command", offset: 0, length: commandLength }],
    }) as NonNullable<MyContext["message"]>;
  assert.equal(getZeusCommandName(makeMessage("/ban@ZeusBot 123", 12), "zeusbot"), "ban");
  assert.equal(getZeusCommandName(makeMessage("/ban@OtherBot 123", 12), "zeusbot"), undefined);
  assert.equal(getZeusCommandName(makeMessage("/notregistered", 14), "zeusbot"), undefined);
  assert.equal(
    getZeusCommandName(
      { text: "/ban", entities: [] } as unknown as NonNullable<MyContext["message"]>,
      "zeusbot",
    ),
    undefined,
  );
});

test("group command deletion starts without waiting and never blocks the handler", async () => {
  let releaseDelete: ((result: boolean) => void) | undefined;
  let deletionStarted = false;
  let nextCalled = false;
  const message = {
    message_id: 50,
    text: "/ban 123456",
    entities: [{ type: "bot_command", offset: 0, length: 4 }],
  };
  const context = {
    update: { update_id: 1, message },
    message,
    chat: { id: -1001, type: "supergroup" },
    me: { username: "zeusbot" },
    api: {
      deleteMessage: () => {
        deletionStarted = true;
        return new Promise<boolean>((resolve) => {
          releaseDelete = resolve;
        });
      },
    },
  } as unknown as MyContext;

  await deleteGroupCommand.middleware()(context, async () => {
    nextCalled = true;
  });
  assert.equal(deletionStarted, true);
  assert.equal(nextCalled, true);
  releaseDelete?.(true);
});

test("failed command deletion does not interrupt execution and private commands are preserved", async () => {
  const message = {
    message_id: 51,
    text: "/mute 123456 30m",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  };
  let nextCalled = false;
  let deleteCalls = 0;
  const context = {
    update: { update_id: 2, message },
    message,
    chat: { id: -1001, type: "group" },
    me: { username: "zeusbot" },
    api: {
      deleteMessage: async () => {
        deleteCalls++;
        throw new Error("telegram unavailable");
      },
    },
  } as unknown as MyContext;
  await deleteGroupCommand.middleware()(context, async () => {
    nextCalled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, true);
  assert.equal(deleteCalls, 1);

  const privateContext = {
    ...context,
    update: { update_id: 3, message },
    chat: { id: 700, type: "private" },
  } as unknown as MyContext;
  await deleteGroupCommand.middleware()(privateContext, async () => {});
  assert.equal(deleteCalls, 1);
});

test("command list pages are reachable and include the actual syntax and access requirements", () => {
  const first = buildCommandListPanel(0, "Test group");
  const callbacks = first.keyboard.inline_keyboard.flat().map((button) =>
    "callback_data" in button ? button.callback_data : undefined,
  );
  assert.match(first.text, /📚 Lista de comandos — Moderación/u);
  assert.match(first.text, /\/ban/u);
  assert.match(first.text, /Permisos:/u);
  assert.ok(callbacks.includes(MenuAction.commands(1)));
  assert.ok(callbacks.includes(MenuAction.main));
  assert.deepEqual(parseMenuAction(MenuAction.commands(1)), {
    kind: "commands",
    page: 1,
  });
  assert.equal(parseMenuAction("menu:commands:-1"), undefined);
  assert.match(buildCommandListPanel(2).text, /\/verificada <ID\|@usuario>/u);
});

test("main panel exposes moderation, verified users, activity, and command-list entry points", () => {
  const panel = buildMainPanel("Test group");
  const buttons = panel.keyboard.inline_keyboard.flat();
  const callbacks = buttons.map((button) =>
    "callback_data" in button ? button.callback_data : undefined,
  );
  assert.match(panel.text, /CERBERO no está comprobado \(estado desconocido\)/u);
  assert.ok(buttons.some((button) => /Moderación/u.test(button.text)));
  assert.ok(buttons.some((button) => /Verificadas/u.test(button.text)));
  assert.ok(buttons.some((button) => /Actividad/u.test(button.text)));
  assert.ok(callbacks.includes("fa:verified"));
  assert.ok(callbacks.includes(MenuAction.commands(0)));
});

test("verified record list classifies status without changing records and paginates", () => {
  const base: VerifiedUser = {
    id: "row",
    group_id: -1001,
    user_id: 1,
    username: null,
    display_name: "Test User",
    verified: true,
    permissions: {
      can_post: false,
      can_send_media: false,
      can_send_links: false,
      bypass_antispam: false,
      bypass_promotion_filter: false,
      bypass_illegal_filter: false,
      bypass_automatic_deletion: false,
    },
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    created_by: 2,
    revoked_at: null,
    valid_until: "2026-10-28T00:00:00.000Z",
  };
  const records = [
    { ...base, user_id: 1, display_name: "Active" },
    { ...base, user_id: 2, display_name: "Expired", valid_until: "2026-10-26T00:00:00.000Z" },
    { ...base, user_id: 3, display_name: "Legacy", valid_until: null },
    { ...base, user_id: 4, display_name: "Revoked", revoked_at: "2026-10-01T00:00:00.000Z" },
  ];
  const snapshot = structuredClone(records);
  const panel = buildVerifiedRecordsPanel(records, 0, "Test group", new Date("2026-10-27T00:00:00.000Z"));
  assert.match(panel.text, /Active.*vigente/u);
  assert.match(panel.text, /Expired.*vencida/u);
  assert.match(panel.text, /Legacy.*vigente \(sin fecha; legado\)/u);
  assert.match(panel.text, /Revoked.*revocada/u);
  assert.deepEqual(records, snapshot);

  const paged = buildVerifiedRecordsPanel(
    Array.from({ length: 10 }, (_, index) => ({ ...base, user_id: index + 1 })),
    0,
    "Test group",
  );
  assert.ok(
    paged.keyboard.inline_keyboard.flat().some(
      (button) => "callback_data" in button && button.callback_data === "vu:list:1",
    ),
  );
});
