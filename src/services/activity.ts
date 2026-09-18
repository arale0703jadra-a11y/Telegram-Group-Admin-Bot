import type { ActivityMessage, GroupData } from "../storage/types.js";

export interface ActivityUserCount {
  userId: number;
  name: string;
  username?: string;
  count: number;
}

export interface ActivityStats {
  totalMessages: number;
  activeUsers: number;
  messagesToday: number;
  messagesLast7Days: number;
  messagesPrevious7Days: number;
  messagesLast30Days: number;
  messagesPrevious30Days: number;
  byDay7: Array<{ label: string; count: number }>;
  byDay30: Array<{ label: string; count: number }>;
  byHour: Array<{ hour: number; count: number }>;
  topUsers: ActivityUserCount[];
}

const DAY_SECONDS = 24 * 60 * 60;

function utcDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function displayName(message: ActivityMessage): string {
  if (message.name) return message.name;
  const name = [message.firstName, message.lastName].filter(Boolean).join(" ");
  return name || `ID ${message.userId}`;
}

function countInRange(
  messages: ActivityMessage[],
  start: number,
  end: number,
): number {
  return messages.filter(
    (message) => message.timestamp >= start && message.timestamp < end,
  ).length;
}

function buildDays(
  messages: ActivityMessage[],
  days: number,
  now: number,
): Array<{ label: string; count: number }> {
  const todayStart = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
  const result: Array<{ label: string; count: number }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const start = todayStart - offset * DAY_SECONDS;
    result.push({
      label: utcDay(start),
      count: countInRange(messages, start, start + DAY_SECONDS),
    });
  }
  return result;
}

export function calculateActivity(
  data: GroupData,
  groupId?: number,
  now = Math.floor(Date.now() / 1000),
): ActivityStats {
  const messages = data.activityMessages.filter(
    (message) => groupId === undefined || message.groupId === groupId,
  );
  const todayStart = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
  const last7Start = todayStart - 6 * DAY_SECONDS;
  const previous7Start = todayStart - 13 * DAY_SECONDS;
  const last30Start = todayStart - 29 * DAY_SECONDS;
  const previous30Start = todayStart - 59 * DAY_SECONDS;
  const users = new Map<number, ActivityUserCount>();

  for (const message of messages) {
    const current = users.get(message.userId);
    if (current) {
      current.count += 1;
    } else {
      users.set(message.userId, {
        userId: message.userId,
        name: displayName(message),
        username: message.username,
        count: 1,
      });
    }
  }

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const message of messages) {
    const hour = new Date(message.timestamp * 1000).getUTCHours();
    byHour[hour].count += 1;
  }

  return {
    totalMessages: messages.length,
    activeUsers: users.size,
    messagesToday: countInRange(messages, todayStart, todayStart + DAY_SECONDS),
    messagesLast7Days: countInRange(messages, last7Start, todayStart + DAY_SECONDS),
    messagesPrevious7Days: countInRange(messages, previous7Start, last7Start),
    messagesLast30Days: countInRange(messages, last30Start, todayStart + DAY_SECONDS),
    messagesPrevious30Days: countInRange(messages, previous30Start, last30Start),
    byDay7: buildDays(messages, 7, now),
    byDay30: buildDays(messages, 30, now),
    byHour,
    topUsers: [...users.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 10),
  };
}
