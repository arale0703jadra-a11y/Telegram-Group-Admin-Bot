import type { Api } from "grammy";
import { getAllKnownGroups } from "./group-registry.js";
import { getGroupData, saveGroupData } from "../storage/index.js";
import type {
  AutomaticMessageAttempt,
  AutomaticMessageConfig,
  GroupData,
} from "../storage/types.js";

const MIN_DELAY_MS = 1_000;
const STORAGE_RETRY_DELAY_MS = 60_000;
const MAX_INTERVAL_MINUTES = 525_600;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const TELEGRAM_TEXT_LIMIT = 4_096;

type SendResult = { ok: true } | { ok: false; error: unknown };
type DeleteConfigResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "sending" };

export interface AutomaticMessageSchedulerDependencies {
  getGroups: () => Array<{ id: number }>;
  getGroupData: (chatId: number) => Promise<GroupData>;
  saveGroupData: (chatId: number, data: GroupData) => Promise<void>;
  now: () => number;
  logError: (message: string, error?: unknown) => void;
  logWarning: (message: string, error?: unknown) => void;
}

const DEFAULT_DEPENDENCIES: AutomaticMessageSchedulerDependencies = {
  getGroups: getAllKnownGroups,
  getGroupData,
  saveGroupData,
  now: Date.now,
  logError: (message, error) => console.error(message, error),
  logWarning: (message, error) => console.warn(message, error),
};

interface TelegramFailure {
  code?: number;
  description: string;
  retryAfter?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function telegramFailure(error: unknown): TelegramFailure {
  if (!isRecord(error)) {
    return { description: error instanceof Error ? error.message : "Error desconocido." };
  }
  const code = typeof error.error_code === "number" &&
      Number.isSafeInteger(error.error_code)
    ? error.error_code
    : undefined;
  const description = typeof error.description === "string"
    ? error.description
    : error instanceof Error
      ? error.message
      : "Error de Telegram o de red.";
  const parameters = isRecord(error.parameters) ? error.parameters : undefined;
  const retryAfter = parameters &&
      typeof parameters.retry_after === "number" &&
      Number.isSafeInteger(parameters.retry_after) &&
      parameters.retry_after > 0
    ? Math.min(parameters.retry_after, MAX_RETRY_AFTER_SECONDS)
    : undefined;
  return { code, description: description.slice(0, 400), retryAfter };
}

function nextRunAt(now: number, intervalMinutes: number): string {
  return new Date(now + intervalMinutes * 60_000).toISOString();
}

function isValidMessage(config: AutomaticMessageConfig): boolean {
  const message = config.message.trim();
  return message.length > 0 && Array.from(message).length <= TELEGRAM_TEXT_LIMIT;
}

function validInterval(config: AutomaticMessageConfig): number | undefined {
  const interval = config.intervalMinutes;
  return typeof interval === "number" &&
      Number.isSafeInteger(interval) &&
      interval > 0 &&
      interval <= MAX_INTERVAL_MINUTES
    ? interval
    : undefined;
}

export class AutomaticMessageScheduler {
  private api: Api | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private processing = false;
  private readonly inFlight = new Set<number>();
  private readonly runtimeNotBefore = new Map<number, number>();
  private rescheduleQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: AutomaticMessageSchedulerDependencies =
      DEFAULT_DEPENDENCIES,
  ) {}

  start(api: Api): void {
    this.api = api;
    if (this.running) return;
    this.running = true;
    void this.reschedule(true).catch((error: unknown) => {
      this.dependencies.logError("[AUTO MESSAGE] startup scheduling failed.", error);
    });
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

  async sendNow(chatId: number): Promise<SendResult> {
    if (this.inFlight.has(chatId)) {
      return { ok: false, error: new Error("Ya hay un envío en curso.") };
    }
    this.inFlight.add(chatId);
    try {
      const data = await this.dependencies.getGroupData(chatId);
      const config = data.automaticMessage;
      if (!config) {
        return { ok: false, error: new Error("No hay mensaje automático configurado.") };
      }
      if (config.enabled && config.nextRunAt) {
        const due = Date.parse(config.nextRunAt);
        if (Number.isFinite(due) && due > this.dependencies.now()) {
          config.nextRunAt = nextRunAt(this.dependencies.now(), validInterval(config) ?? 60);
        }
      }
      const result = await this.publish(chatId, data, config);
      await this.dependencies.saveGroupData(chatId, data);
      if (!result.ok) {
        this.dependencies.logError(
          `[AUTO MESSAGE] manual send failed groupId=${chatId}.`,
          result.error,
        );
      }
      if (this.running) await this.reschedule();
      return result;
    } catch (error) {
      this.dependencies.logError(
        `[AUTO MESSAGE] manual send could not be completed groupId=${chatId}.`,
        error,
      );
      return { ok: false, error };
    } finally {
      this.inFlight.delete(chatId);
    }
  }

  async deleteConfig(chatId: number): Promise<DeleteConfigResult> {
    if (this.inFlight.has(chatId)) {
      return { ok: false, reason: "sending" };
    }
    this.inFlight.add(chatId);
    try {
      const data = await this.dependencies.getGroupData(chatId);
      if (!data.automaticMessage) {
        return { ok: false, reason: "missing" };
      }
      data.automaticMessage = undefined;
      await this.dependencies.saveGroupData(chatId, data);
      this.runtimeNotBefore.delete(chatId);
      if (this.running) await this.reschedule();
      return { ok: true };
    } finally {
      this.inFlight.delete(chatId);
    }
  }

  async processDueNow(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      for (const group of this.dependencies.getGroups()) {
        if (!this.running) return;
        let retryInterval: number | undefined;
        try {
          const data = await this.dependencies.getGroupData(group.id);
          const config = data.automaticMessage;
          if (!config?.enabled) continue;

          const interval = validInterval(config);
          retryInterval = interval;
          if (!interval) {
            config.enabled = false;
            config.status = "error";
            config.lastError = "El intervalo guardado no es válido; se desactivó el envío.";
            config.nextRunAt = undefined;
            await this.dependencies.saveGroupData(group.id, data);
            this.dependencies.logError(
              `[AUTO MESSAGE] invalid interval disabled groupId=${group.id}.`,
            );
            continue;
          }

          if ((this.runtimeNotBefore.get(group.id) ?? 0) > this.dependencies.now()) {
            continue;
          }
          const due = config.nextRunAt ? Date.parse(config.nextRunAt) : Number.NaN;
          if (Number.isFinite(due) && due > this.dependencies.now()) continue;
          if (this.inFlight.has(group.id)) continue;
          this.inFlight.add(group.id);
          try {
            const result = await this.publish(group.id, data, config);
            if (result.ok) {
              this.runtimeNotBefore.delete(group.id);
            } else {
              this.dependencies.logError(
                `[AUTO MESSAGE] send failed groupId=${group.id}.`,
                result.error,
              );
            }
            await this.dependencies.saveGroupData(group.id, data);
          } finally {
            this.inFlight.delete(group.id);
          }
        } catch (error) {
          if (retryInterval) {
            this.runtimeNotBefore.set(
              group.id,
              this.dependencies.now() + retryInterval * 60_000,
            );
          } else {
            this.runtimeNotBefore.set(
              group.id,
              this.dependencies.now() + STORAGE_RETRY_DELAY_MS,
            );
          }
          this.dependencies.logError(
            `[AUTO MESSAGE] due task failed groupId=${group.id}; processing will continue.`,
            error,
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async reschedule(skipMissedRun = false): Promise<void> {
    const queued = this.rescheduleQueue.then(() =>
      this.rescheduleNow(skipMissedRun),
    );
    this.rescheduleQueue = queued.catch((error: unknown) => {
      this.dependencies.logError("[AUTO MESSAGE] scheduling pass failed.", error);
    });
    await queued;
  }

  private async rescheduleNow(skipMissedRun: boolean): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    let nextAt = Number.POSITIVE_INFINITY;
    let dueFound = false;
    for (const group of this.dependencies.getGroups()) {
      try {
        const data = await this.dependencies.getGroupData(group.id);
        const config = data.automaticMessage;
        if (!config?.enabled) continue;
        const runtimeNotBefore = this.runtimeNotBefore.get(group.id) ?? 0;
        if (runtimeNotBefore > this.dependencies.now()) {
          nextAt = Math.min(nextAt, runtimeNotBefore);
          continue;
        }
        const interval = validInterval(config);
        if (!interval) {
          config.enabled = false;
          config.status = "error";
          config.lastError = "El intervalo guardado no es válido; se desactivó el envío.";
          config.nextRunAt = undefined;
          await this.dependencies.saveGroupData(group.id, data);
          this.dependencies.logError(
            `[AUTO MESSAGE] invalid interval disabled groupId=${group.id}.`,
          );
          continue;
        }

        const due = config.nextRunAt ? Date.parse(config.nextRunAt) : Number.NaN;
        if (!Number.isFinite(due) || due <= this.dependencies.now()) {
          if (skipMissedRun || !Number.isFinite(due)) {
            if (config.status === "sending") {
              config.status = "unknown";
              config.lastError =
                "ZEUS se reinició durante el envío; Telegram no confirmó el resultado.";
              const attempt: AutomaticMessageAttempt = {
                at: config.lastAttemptAt ?? new Date(this.dependencies.now()).toISOString(),
                status: "unknown",
                error: config.lastError,
              };
              config.history = [
                ...(config.history ?? []),
                attempt,
              ].slice(-20);
            } else {
              config.status = "pending";
              config.lastError = undefined;
            }
            config.nextRunAt = nextRunAt(this.dependencies.now(), interval);
            await this.dependencies.saveGroupData(group.id, data);
            nextAt = Math.min(nextAt, Date.parse(config.nextRunAt));
          } else {
            dueFound = true;
          }
        } else {
          nextAt = Math.min(nextAt, due);
        }
      } catch (error) {
        nextAt = Math.min(
          nextAt,
          this.dependencies.now() + STORAGE_RETRY_DELAY_MS,
        );
        this.dependencies.logError(
          `[AUTO MESSAGE] could not inspect schedule groupId=${group.id}; other groups continue.`,
          error,
        );
      }
    }

    if (!this.running) return;
    const delay = dueFound
      ? MIN_DELAY_MS
      : Number.isFinite(nextAt)
        ? Math.min(
            MAX_TIMER_DELAY_MS,
            Math.max(MIN_DELAY_MS, nextAt - this.dependencies.now()),
          )
        : undefined;
    if (delay === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.processDueNow()
        .catch((error: unknown) => {
          this.dependencies.logError("[AUTO MESSAGE] scheduler cycle failed.", error);
        })
        .finally(() => {
          if (this.running) {
            void this.reschedule().catch((error: unknown) => {
              this.dependencies.logError(
                "[AUTO MESSAGE] scheduler could not schedule its next cycle.",
                error,
              );
            });
          }
        });
    }, delay);
  }

  private async publish(
    chatId: number,
    data: GroupData,
    config: AutomaticMessageConfig,
  ): Promise<SendResult> {
    if (!this.api) return { ok: false, error: new Error("Scheduler no iniciado.") };
    if (!isValidMessage(config)) {
      config.status = "error";
      config.lastError = "El mensaje está vacío o supera el límite de Telegram.";
      config.enabled = false;
      config.nextRunAt = undefined;
      return { ok: false, error: new Error(config.lastError) };
    }
    const interval = validInterval(config);
    if (!interval) {
      config.status = "error";
      config.lastError = "El intervalo guardado no es válido.";
      config.enabled = false;
      config.nextRunAt = undefined;
      return { ok: false, error: new Error(config.lastError) };
    }

    const previousMessageId = config.lastMessageId;
    config.status = "sending";
    config.lastAttemptAt = new Date(this.dependencies.now()).toISOString();
    config.attemptCount = (config.attemptCount ?? 0) + 1;
    config.lastError = undefined;
    await this.dependencies.saveGroupData(chatId, data);

    try {
      const sent = await this.api.sendMessage(chatId, config.message);
      const now = this.dependencies.now();
      config.status = "sent";
      config.lastError = undefined;
      config.consecutiveFailures = 0;
      config.lastSentAt = new Date(now).toISOString();
      config.lastMessageId = sent.message_id;
      if (config.enabled) {
        config.nextRunAt = nextRunAt(now, interval);
      }
      const attempt: AutomaticMessageAttempt = {
        at: new Date(now).toISOString(),
        status: "sent",
        messageId: sent.message_id,
      };
      config.history = [
        ...(config.history ?? []),
        attempt,
      ].slice(-20);
      if (previousMessageId !== undefined) {
        try {
          await this.api.deleteMessage(chatId, previousMessageId);
        } catch (error) {
          this.dependencies.logWarning(
            `[AUTO MESSAGE] previous message could not be deleted groupId=${chatId}.`,
            error,
          );
        }
      }
      return { ok: true };
    } catch (error) {
      const failure = telegramFailure(error);
      config.consecutiveFailures = (config.consecutiveFailures ?? 0) + 1;
      config.lastError = failure.code
        ? `Telegram ${failure.code}: ${failure.description}`.slice(0, 500)
        : failure.description.slice(0, 500);
      const historyStatus: AutomaticMessageAttempt["status"] =
        failure.code === 400 || failure.code === 403
        ? "error"
        : "unknown";
      const attempt: AutomaticMessageAttempt = {
        at: new Date(this.dependencies.now()).toISOString(),
        status: historyStatus,
        error: config.lastError,
      };
      config.history = [
        ...(config.history ?? []),
        attempt,
      ].slice(-20);

      if (failure.code === 403 || failure.code === 400) {
        config.status = "error";
        config.enabled = false;
        config.nextRunAt = undefined;
      } else if (failure.code === 429 && failure.retryAfter !== undefined) {
        if (config.consecutiveFailures > MAX_RATE_LIMIT_RETRIES) {
          config.status = "error";
          config.enabled = false;
          config.nextRunAt = undefined;
        } else {
          config.status = "pending";
          config.nextRunAt = new Date(
            this.dependencies.now() + failure.retryAfter * 1_000,
          ).toISOString();
        }
      } else {
        config.status = "unknown";
        config.nextRunAt = nextRunAt(this.dependencies.now(), interval);
      }
      return { ok: false, error };
    }
  }
}

export const automaticMessageScheduler = new AutomaticMessageScheduler();
