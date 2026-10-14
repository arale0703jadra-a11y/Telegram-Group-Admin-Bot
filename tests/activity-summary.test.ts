import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  handleActivitySummary,
  isActivityPanelAction,
  presentActivityPanel,
} from "../src/menus/activity-summary.js";
import { parseMenuAction } from "../src/menus/index.js";
import {
  buildActivityPanel,
  buildActivityUnavailablePanel,
  MenuAction,
} from "../src/menus/panels.js";
import { calculateActivity } from "../src/services/activity.js";
import { FileStore } from "../src/storage/file.js";
import { initialGroupData } from "../src/storage/initial.js";

function createOptions(
  overrides: Partial<Parameters<typeof handleActivitySummary>[0]> = {},
) {
  const calls: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ text: string }> = [];
  const options: Parameters<typeof handleActivitySummary>[0] = {
    groupId: -100,
    groupTitle: "Grupo de prueba",
    authorize: async () => true,
    answerCallback: async (message) => {
      calls.push(message ? "deny" : "answer");
    },
    recordUser: async () => {
      calls.push("record");
    },
    loadGroupData: async () => {
      calls.push("load");
      return initialGroupData();
    },
    presentPanel: async (panel) => {
      calls.push("present");
      panels.push(panel);
      return true;
    },
    sendError: async () => {
      calls.push("send-error");
    },
    logError: (message) => {
      errors.push(message);
    },
    ...overrides,
  };
  return { options, calls, errors, panels };
}

test("the exact activity summary callback routes to its handler", () => {
  const callbackData = MenuAction.action("actividad", "resumen");
  const action = parseMenuAction(callbackData);
  assert.deepEqual(action, {
    kind: "action",
    section: "actividad",
    item: "resumen",
  });
  assert.equal(action && isActivityPanelAction(action), true);
  const refreshAction = parseMenuAction(
    MenuAction.action("actividad", "actualizar"),
  );
  assert.equal(refreshAction && isActivityPanelAction(refreshAction), true);
  assert.equal(
    isActivityPanelAction({
      kind: "action",
      section: "config",
      item: "resumen",
    }),
    false,
  );
});

test("an authorized administrator receives an empty activity summary", async () => {
  const { options, calls, panels } = createOptions();
  await handleActivitySummary(options);

  assert.deepEqual(calls, ["answer", "record", "load", "present"]);
  assert.match(panels[0]?.text ?? "", /Mensajes registrados: 0/);
  assert.match(panels[0]?.text ?? "", /Usuarios activos: 0/);
  assert.match(panels[0]?.text ?? "", /Sin actividad registrada\./);
  assert.match(panels[0]?.text ?? "", /máximo 10.000 mensajes por grupo/);
  assert.match(panels[0]?.text ?? "", /No representan el historial completo/);
});

test("a group with no activity file is a valid empty activity summary", async () => {
  const originalDirectory = process.cwd();
  const testDirectory = mkdtempSync(join(tmpdir(), "zeus-empty-activity-"));
  try {
    process.chdir(testDirectory);
    const fileStore = new FileStore();
    const { options, panels } = createOptions({
      loadGroupData: () => fileStore.loadGroupStrict(-100),
    });
    await handleActivitySummary(options);

    assert.match(panels[0]?.text ?? "", /Mensajes registrados: 0/);
    assert.match(panels[0]?.text ?? "", /Usuarios activos: 0/);
  } finally {
    process.chdir(originalDirectory);
    rmSync(resolve(testDirectory), { recursive: true, force: true });
  }
});

test("an unauthorized user is denied without loading or presenting activity", async () => {
  const { options, calls, panels } = createOptions({
    authorize: async () => false,
  });
  await handleActivitySummary(options);

  assert.deepEqual(calls, ["deny"]);
  assert.equal(panels.length, 0);
});

test("a recordObservedUser failure is logged and does not block the summary", async () => {
  const { options, calls, errors, panels } = createOptions({
    recordUser: async () => {
      calls.push("record");
      throw new Error("local record failed");
    },
  });
  await handleActivitySummary(options);

  assert.deepEqual(calls, ["answer", "record", "load", "present"]);
  assert.equal(errors.length, 1);
  assert.equal(panels.length, 1);
});

test("the callback is acknowledged once before loading activity", async () => {
  let answerCount = 0;
  const { options, calls } = createOptions({
    answerCallback: async () => {
      answerCount += 1;
      calls.push("answer");
    },
  });
  await handleActivitySummary(options);

  assert.equal(answerCount, 1);
  assert.ok(calls.indexOf("answer") < calls.indexOf("load"));
});

test("a failed callback acknowledgement is logged without retrying", async () => {
  let answerCount = 0;
  const { options, calls, errors, panels } = createOptions({
    answerCallback: async () => {
      answerCount += 1;
      calls.push("answer");
      throw new Error("callback expired");
    },
  });
  await handleActivitySummary(options);

  assert.equal(answerCount, 1);
  assert.ok(errors.some((message) => message.includes("confirmar el callback")));
  assert.equal(panels.length, 1);
});

test("activity summary only counts messages from the selected group", async () => {
  const data = initialGroupData();
  data.activityMessages.push(
    {
      messageId: 1,
      groupId: -100,
      userId: 10,
      timestamp: 1_700_000_000,
    },
    {
      messageId: 2,
      groupId: -200,
      userId: 20,
      timestamp: 1_700_000_000,
    },
  );
  const { options, panels } = createOptions({
    loadGroupData: async () => data,
  });
  await handleActivitySummary(options);

  assert.match(panels[0]?.text ?? "", /Mensajes registrados: 1/);
  assert.match(panels[0]?.text ?? "", /Usuarios activos: 1/);
});

test("the unavailable activity panel does not present zero-valued statistics", () => {
  const panel = buildActivityUnavailablePanel("Grupo de prueba");
  assert.match(panel.text, /Datos de actividad no disponibles/);
  assert.match(panel.text, /No se muestran estadísticas/);
  assert.doesNotMatch(panel.text, /Mensajes registrados: 0/);
  assert.ok(
    panel.keyboard.inline_keyboard.flat().some(
      (button) =>
        button.callback_data ===
        MenuAction.action("actividad", "actualizar"),
    ),
  );
});

test("panel fallback sends a new message only when editing fails", async () => {
  let replyCount = 0;
  const panel = buildActivityPanel(calculateActivity(initialGroupData()));
  await presentActivityPanel(panel, {
    edit: async () => true,
    reply: async () => {
      replyCount += 1;
    },
    logError: () => assert.fail("successful edit should not log"),
  });
  assert.equal(replyCount, 0);

  await presentActivityPanel(panel, {
    edit: async () => {
      throw new Error("edit failed");
    },
    reply: async () => {
      replyCount += 1;
    },
    logError: () => undefined,
  });
  assert.equal(replyCount, 1);
});

test("panel presentation controls and logs failure of both edit and fallback", async () => {
  const errors: string[] = [];
  let replyCount = 0;
  const panel = buildActivityPanel(calculateActivity(initialGroupData()));
  await assert.doesNotReject(
    presentActivityPanel(panel, {
      edit: async () => {
        throw new Error("edit failed");
      },
      reply: async () => {
        replyCount += 1;
        throw new Error("reply failed");
      },
      logError: (message) => errors.push(message),
    }),
  );
  assert.equal(replyCount, 1);
  assert.deepEqual(errors, [
    "No se pudo editar el panel existente.",
    "No se pudo enviar el panel como mensaje nuevo.",
  ]);
});

test("a failed data read presents an unavailable state instead of a zero summary", async () => {
  const { options, calls, errors, panels } = createOptions({
    loadGroupData: async () => {
      throw new Error("read failed");
    },
  });
  await handleActivitySummary(options);

  assert.ok(calls.includes("present"));
  assert.ok(!calls.includes("send-error"));
  assert.equal(errors.length, 1);
  assert.match(panels[0]?.text ?? "", /Datos de actividad no disponibles/);
  assert.doesNotMatch(panels[0]?.text ?? "", /Mensajes registrados: 0/);
});

test("a failed error-panel presentation falls back to a clear private message", async () => {
  const { options, calls } = createOptions({
    loadGroupData: async () => {
      throw new Error("read failed");
    },
    presentPanel: async () => false,
  });
  await handleActivitySummary(options);

  assert.ok(calls.includes("send-error"));
});

test("corrupt group JSON is backed up, not overwritten by fallback writes, and not shown as zero activity", async () => {
  const originalDirectory = process.cwd();
  const testDirectory = mkdtempSync(join(tmpdir(), "zeus-activity-read-"));
  const corruptContents = '{"activityMessages":';
  try {
    process.chdir(testDirectory);
    const storageDirectory = join(testDirectory, "data", "storage");
    mkdirSync(storageDirectory, { recursive: true });
    const groupFile = join(storageDirectory, "-100.json");
    writeFileSync(groupFile, corruptContents, "utf8");

    const fileStore = new FileStore();
    const fallbackData = await fileStore.loadGroup(-100);
    fallbackData.activityMessages.push({
      messageId: 1,
      groupId: -100,
      userId: 10,
      timestamp: 1_700_000_000,
    });
    await fileStore.saveGroup(-100, fallbackData);
    await fileStore.flushForced();

    assert.equal(readFileSync(groupFile, "utf8"), corruptContents);
    assert.ok(
      readdirSync(storageDirectory).some((name) =>
        name.startsWith("-100.json.corrupt-"),
      ),
    );

    const { options, panels, errors } = createOptions({
      loadGroupData: () => fileStore.loadGroupStrict(-100),
    });
    await handleActivitySummary(options);

    assert.match(panels[0]?.text ?? "", /Datos de actividad no disponibles/);
    assert.doesNotMatch(panels[0]?.text ?? "", /Mensajes registrados: 0/);
    assert.equal(errors.length, 1);
  } finally {
    process.chdir(originalDirectory);
    rmSync(resolve(testDirectory), { recursive: true, force: true });
  }
});
