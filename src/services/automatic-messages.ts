import type { Api } from "grammy";
import { getAllKnownGroups } from "./group-registry.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import type { AutomaticMessageConfig } from "../storage/types.js";

const MIN_DELAY_MS = 1_000;

export class AutomaticMessageScheduler {
  private api: Api | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly inFlight = new Set<number>();

  start(api: Api): void {
    this.api = api;
    this.running = true;
    void this.reschedule(true);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async refreshGroup(chatId: number): Promise<void> {
    if (!this.running) return;
    await this.reschedule();
    console.log(`[AUTO MESSAGE] schedule refreshed groupId=${chatId}`);
  }

  async sendNow(chatId: number): Promise<{ ok: true } | { ok: false; error: unknown }> {
    if (this.inFlight.has(chatId)) {
      return { ok: false, error: new Error("Ya hay un envío en curso.") };
    }
    const data = await getGroupData(chatId);
    if (!data.automaticMessage) {
      return { ok: false, error: new Error("No hay mensaje automático configurado.") };
    }
    this.inFlight.add(chatId);
    let result: { ok: true } | { ok: false; error: unknown };
    try {
      result = await this.publish(chatId, data.automaticMessage, data.automaticMessage);
    } finally {
      this.inFlight.delete(chatId);
    }
    if (result.ok) {
      await saveGroupData(chatId, data);
      await this.reschedule();
    }
    return result;
  }

  private async reschedule(skipMissedRun = false): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    const dueGroups: Array<{ chatId: number; config: AutomaticMessageConfig }> = [];
    let nextAt = Number.POSITIVE_INFINITY;
    for (const group of getAllKnownGroups()) {
      const data = await getGroupData(group.id);
      const config = data.automaticMessage;
      if (!config?.enabled || !config.intervalMinutes) continue;
      const due = config.nextRunAt ? Date.parse(config.nextRunAt) : Date.now();
      if (due <= Date.now()) {
        if (skipMissedRun) {
          config.nextRunAt = new Date(
            Date.now() + config.intervalMinutes * 60_000,
          ).toISOString();
          await saveGroupData(group.id, data);
          nextAt = Math.min(nextAt, Date.parse(config.nextRunAt));
        } else {
          dueGroups.push({ chatId: group.id, config });
        }
      } else {
        nextAt = Math.min(nextAt, due);
      }
    }

    if (dueGroups.length > 0) {
      this.timer = setTimeout(() => {
        void this.processDueGroups();
      }, MIN_DELAY_MS);
      return;
    }
    if (Number.isFinite(nextAt)) {
      this.timer = setTimeout(
        () => void this.processDueGroups(),
        Math.max(MIN_DELAY_MS, nextAt - Date.now()),
      );
    }
  }

  private async processDueGroups(): Promise<void> {
    if (!this.running) return;
    for (const group of getAllKnownGroups()) {
      const data = await getGroupData(group.id);
      const config = data.automaticMessage;
      if (!config?.enabled || !config.intervalMinutes) continue;
      const due = config.nextRunAt ? Date.parse(config.nextRunAt) : Date.now();
      if (due > Date.now()) continue;
      if (this.inFlight.has(group.id)) continue;
      this.inFlight.add(group.id);
      let result: { ok: true } | { ok: false; error: unknown };
      try {
        result = await this.publish(group.id, config, config);
      } finally {
        this.inFlight.delete(group.id);
      }
      if (!result.ok) {
        console.error(`[AUTO MESSAGE] send failed groupId=${group.id}:`, result.error);
        config.nextRunAt = new Date(
          Date.now() + config.intervalMinutes * 60_000,
        ).toISOString();
      }
      await saveGroupData(group.id, data);
    }
    await this.reschedule();
  }

  private async publish(
    chatId: number,
    config: AutomaticMessageConfig,
    previous: AutomaticMessageConfig,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    if (!this.api) return { ok: false, error: new Error("Scheduler no iniciado.") };
    if (previous.lastMessageId) {
      try {
        await this.api.deleteMessage(chatId, previous.lastMessageId);
      } catch (error) {
        console.warn(`[AUTO MESSAGE] previous message could not be deleted groupId=${chatId}`, error);
      }
    }
    try {
      const sent = await this.api.sendMessage(chatId, config.message);
      const now = new Date();
      config.lastSentAt = now.toISOString();
      config.lastMessageId = sent.message_id;
      if (config.enabled && config.intervalMinutes) {
        config.nextRunAt = new Date(
          now.getTime() + config.intervalMinutes * 60_000,
        ).toISOString();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }
}

export const automaticMessageScheduler = new AutomaticMessageScheduler();
