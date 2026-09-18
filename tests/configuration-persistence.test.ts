import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { flushStorage, getGroupData, saveGroupData } from "../src/storage/index.js";

test("group configuration persists independently across groups", async () => {
  const groupA = -900000001;
  const groupB = -900000002;
  const files = [groupA, groupB].map((id) =>
    resolve(process.cwd(), "data", "storage", `${id}.json`),
  );
  try {
    const dataA = await getGroupData(groupA);
    const dataB = await getGroupData(groupB);
    dataA.antiSpam.enabled = false;
    dataA.antiSpam.blockLinks = false;
    dataA.antiSpam.detectAutomatedBehavior = false;
    dataA.newUsers.enabled = true;
    dataA.promotion.recurrenceMuteMinutes = [60, 240];
    dataA.illegalContent.enabled = false;
    dataA.antiSpam.maxMentionsPerMessage = 12;
    await saveGroupData(groupA, dataA);
    await saveGroupData(groupB, dataB);
    await flushStorage();

    const restoredA = await getGroupData(groupA);
    const restoredB = await getGroupData(groupB);
    assert.equal(restoredA.antiSpam.enabled, false);
    assert.equal(restoredA.antiSpam.blockLinks, false);
    assert.equal(restoredA.antiSpam.detectAutomatedBehavior, false);
    assert.equal(restoredA.newUsers.enabled, true);
    assert.deepEqual(restoredA.promotion.recurrenceMuteMinutes, [60, 240]);
    assert.equal(restoredA.illegalContent.enabled, false);
    assert.equal(restoredA.antiSpam.maxMentionsPerMessage, 12);
    assert.equal(restoredB.antiSpam.enabled, true);
    assert.equal(restoredB.newUsers.enabled, false);
    assert.deepEqual(restoredB.promotion.recurrenceMuteMinutes, [15, 60, 240, 1440]);
  } finally {
    for (const file of files) {
      if (existsSync(file)) unlinkSync(file);
    }
  }
});
