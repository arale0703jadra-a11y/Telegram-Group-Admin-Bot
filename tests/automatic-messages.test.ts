import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { AutomaticMessageScheduler } from "../src/services/automatic-messages.js";
import { initialGroupData } from "../src/storage/initial.js";
import type { GroupData } from "../src/storage/types.js";

const NOW = Date.UTC(2026, 10, 4, 12);

function automaticConfig(
  overrides: Partial<NonNullable<GroupData["automaticMessage"]>> = {},
): NonNullable<GroupData["automaticMessage"]> {
  return {
    enabled: true,
    message: "Aviso recurrente",
    intervalMinutes: 60,
    nextRunAt: new Date(NOW + 60 * 60_000).toISOString(),
    ...overrides,
  };
}

function harness(
  groups: number[],
  entries: Map<number, GroupData>,
  apiOverrides: Partial<Api> = {},
) {
  const sent: Array<{ chatId: number; text: string }> = [];
  const errors: string[] = [];
  const api = {
    async sendMessage(chatId: number, text: string) {
      sent.push({ chatId, text });
      return { message_id: sent.length } as never;
    },
    async deleteMessage() {
      return true;
    },
    ...apiOverrides,
  } as unknown as Api;
  const scheduler = new AutomaticMessageScheduler({
    getGroups: () => groups.map((id) => ({ id })),
    async getGroupData(chatId) {
      const data = entries.get(chatId);
      if (!data) throw new Error(`Unknown group ${chatId}`);
      return structuredClone(data);
    },
    async saveGroupData(chatId, data) {
      entries.set(chatId, structuredClone(data));
    },
    now: () => NOW,
    logError(message) {
      errors.push(message);
    },
    logWarning(message) {
      errors.push(message);
    },
  });
  return { scheduler, api, sent, errors };
}

function groupData(message: NonNullable<GroupData["automaticMessage"]>): GroupData {
  return { ...initialGroupData(), automaticMessage: message };
}

async function waitForStartup(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("scheduler sends an overdue message only to its configured group and persists success", async () => {
  const entries = new Map<number, GroupData>([
    [-1001, groupData(automaticConfig({
      message: "Mensaje del grupo 1",
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
    [-1002, groupData(automaticConfig({
      message: "Mensaje del grupo 2",
      nextRunAt: new Date(NOW + 60 * 60_000).toISOString(),
    }))],
  ]);
  const { scheduler, api, sent } = harness([-1001, -1002], entries);
  scheduler.start(api);
  await waitForStartup();
  const due = entries.get(-1001)!.automaticMessage!;
  due.nextRunAt = new Date(NOW - 1).toISOString();
  entries.set(-1001, groupData(due));
  await scheduler.processDueNow();

  assert.deepEqual(sent, [{ chatId: -1001, text: "Mensaje del grupo 1" }]);
  const saved = entries.get(-1001)!.automaticMessage!;
  assert.equal(saved.status, "sent");
  assert.equal(saved.attemptCount, 1);
  assert.equal(saved.lastMessageId, 1);
  assert.equal(saved.lastSentAt, new Date(NOW).toISOString());
  assert.equal(saved.nextRunAt, new Date(NOW + 60 * 60_000).toISOString());
  scheduler.stop();
});

test("startup rebases overdue and in-flight work instead of replaying it", async () => {
  const entries = new Map<number, GroupData>([
    [-1003, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 60 * 60_000).toISOString(),
    }))],
    [-1004, groupData(automaticConfig({
      status: "sending",
      nextRunAt: new Date(NOW - 60 * 60_000).toISOString(),
    }))],
  ]);
  const { scheduler, api, sent } = harness([-1003, -1004], entries);
  scheduler.start(api);
  await waitForStartup();

  assert.deepEqual(sent, []);
  assert.equal(
    entries.get(-1003)!.automaticMessage!.nextRunAt,
    new Date(NOW + 60 * 60_000).toISOString(),
  );
  assert.equal(entries.get(-1003)!.automaticMessage!.status, "pending");
  assert.equal(entries.get(-1004)!.automaticMessage!.status, "unknown");
  assert.match(entries.get(-1004)!.automaticMessage!.lastError ?? "", /reinició/u);
  scheduler.stop();
});

test("deleting a recurrence is persisted and cannot race an active send", async () => {
  const entries = new Map<number, GroupData>([
    [-1015, groupData(automaticConfig())],
  ]);
  let markSendStarted!: () => void;
  let finishSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    markSendStarted = resolve;
  });
  const sendGate = new Promise<void>((resolve) => {
    finishSend = resolve;
  });
  const { scheduler, api } = harness([-1015], entries, {
    async sendMessage() {
      markSendStarted();
      await sendGate;
      return { message_id: 7 } as never;
    },
  });
  scheduler.start(api);
  await waitForStartup();

  const sending = scheduler.sendNow(-1015);
  await sendStarted;
  assert.deepEqual(await scheduler.deleteConfig(-1015), {
    ok: false,
    reason: "sending",
  });
  finishSend();
  assert.deepEqual(await sending, { ok: true });

  assert.deepEqual(await scheduler.deleteConfig(-1015), { ok: true });
  assert.equal(entries.get(-1015)!.automaticMessage, undefined);
  assert.deepEqual(await scheduler.deleteConfig(-1015), {
    ok: false,
    reason: "missing",
  });
  scheduler.stop();
});

test("overlapping scheduler cycles cannot send the same message twice", async () => {
  const entries = new Map<number, GroupData>([
    [-1005, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  let releaseSend!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const { scheduler, api, sent } = harness([-1005], entries, {
    async sendMessage(chatId: number, text: string) {
      sent.push({ chatId, text });
      await blocked;
      return { message_id: 55 } as never;
    },
  });
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1005)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();

  const first = scheduler.processDueNow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await scheduler.processDueNow();
  releaseSend();
  await first;

  assert.equal(sent.length, 1);
  scheduler.stop();
});

test("403 errors are persisted and disable automatic retries", async () => {
  const entries = new Map<number, GroupData>([
    [-1006, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  let sendAttempts = 0;
  const { scheduler, api } = harness([-1006], entries, {
    async sendMessage() {
      sendAttempts += 1;
      throw Object.assign(new Error("Forbidden: bot was kicked"), {
        error_code: 403,
        description: "Forbidden: bot was kicked",
      });
    },
  });
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1006)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();
  await scheduler.processDueNow();

  const saved = entries.get(-1006)!.automaticMessage!;
  assert.equal(sendAttempts, 1);
  assert.equal(saved.enabled, false);
  assert.equal(saved.status, "error");
  assert.match(saved.lastError ?? "", /403/u);
  assert.equal(saved.nextRunAt, undefined);
  scheduler.stop();
});

test("400 format errors are persisted as permanent failures", async () => {
  const entries = new Map<number, GroupData>([
    [-1011, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  const { scheduler, api } = harness([-1011], entries, {
    async sendMessage() {
      throw Object.assign(new Error("Bad Request: can't parse entities"), {
        error_code: 400,
        description: "Bad Request: can't parse entities",
      });
    },
  });
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1011)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();

  const saved = entries.get(-1011)!.automaticMessage!;
  assert.equal(saved.enabled, false);
  assert.equal(saved.status, "error");
  assert.match(saved.lastError ?? "", /400/u);
  assert.equal(saved.nextRunAt, undefined);
  scheduler.stop();
});

test("429 errors defer the next attempt by retry_after without a rapid retry loop", async () => {
  const entries = new Map<number, GroupData>([
    [-1007, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  let sendAttempts = 0;
  const { scheduler, api } = harness([-1007], entries, {
    async sendMessage() {
      sendAttempts += 1;
      throw Object.assign(new Error("Too Many Requests"), {
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 90 },
      });
    },
  });
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1007)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();
  await scheduler.processDueNow();

  const saved = entries.get(-1007)!.automaticMessage!;
  assert.equal(sendAttempts, 1);
  assert.equal(saved.status, "pending");
  assert.equal(saved.nextRunAt, new Date(NOW + 90_000).toISOString());
  assert.match(saved.lastError ?? "", /429/u);
  scheduler.stop();
});

test("ambiguous network errors are recorded and not retried before the next interval", async () => {
  const entries = new Map<number, GroupData>([
    [-1012, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  let sendAttempts = 0;
  const { scheduler, api } = harness([-1012], entries, {
    async sendMessage() {
      sendAttempts += 1;
      throw new Error("Network timeout while reading Telegram response");
    },
  });
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1012)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();
  await scheduler.processDueNow();

  const saved = entries.get(-1012)!.automaticMessage!;
  assert.equal(sendAttempts, 1);
  assert.equal(saved.status, "unknown");
  assert.match(saved.lastError ?? "", /Network timeout/u);
  assert.equal(saved.nextRunAt, new Date(NOW + 60 * 60_000).toISOString());
  scheduler.stop();
});

test("invalid empty messages fail closed without contacting Telegram", async () => {
  const entries = new Map<number, GroupData>([
    [-1008, groupData(automaticConfig({
      message: "   ",
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  const { scheduler, api, sent } = harness([-1008], entries);
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1008)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();

  const saved = entries.get(-1008)!.automaticMessage!;
  assert.deepEqual(sent, []);
  assert.equal(saved.enabled, false);
  assert.equal(saved.status, "error");
  assert.match(saved.lastError ?? "", /vacío/u);
  scheduler.stop();
});

test("a group storage error is isolated and does not prevent other groups from sending", async () => {
  const entries = new Map<number, GroupData>([
    [-1010, groupData(automaticConfig({
      nextRunAt: new Date(NOW - 1).toISOString(),
    }))],
  ]);
  const { scheduler, api, sent, errors } = harness([-1009, -1010], entries);
  scheduler.start(api);
  await waitForStartup();
  entries.get(-1010)!.automaticMessage!.nextRunAt = new Date(NOW - 1).toISOString();
  await scheduler.processDueNow();

  assert.deepEqual(sent.map((entry) => entry.chatId), [-1010]);
  assert.ok(errors.some((message) => message.includes("groupId=-1009")));
  scheduler.stop();
});
