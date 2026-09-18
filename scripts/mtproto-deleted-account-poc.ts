import "dotenv/config";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = readIntegerEnv("MT_PROTO_API_ID");
const apiHash = readRequiredEnv("MT_PROTO_API_HASH");
const botToken = readRequiredEnv("BOT_TOKEN");
const chatReference = readRequiredEnv("MT_PROTO_CHAT_ID");

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readIntegerEnv(name: string): number {
  const value = readRequiredEnv(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

type ParticipantKind =
  | "creator"
  | "administrator"
  | "member"
  | "left"
  | "banned"
  | "unknown";

function participantKind(
  participant: Api.TypeChannelParticipant,
): ParticipantKind {
  switch (participant.className) {
    case "ChannelParticipantCreator":
      return "creator";
    case "ChannelParticipantAdmin":
      return "administrator";
    case "ChannelParticipant":
    case "ChannelParticipantSelf":
      return "member";
    case "ChannelParticipantLeft":
      return "left";
    case "ChannelParticipantBanned":
      return "banned";
    default:
      return "unknown";
  }
}

async function run(): Promise<void> {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    console.log("Authenticating MTProto client with bot credentials...");
    await client.start({
      botAuthToken: botToken,
      onError: (error) => {
        console.error("MTProto authentication error:", error.message);
      },
    });
    console.log("MTProto authentication succeeded.");

    const channel = await client.getInputEntity(chatReference);
    if (!("channelId" in channel)) {
      throw new Error("MT_PROTO_CHAT_ID did not resolve to a channel or supergroup");
    }

    console.log("Calling channels.getParticipants (read-only)...");
    const result = await client.invoke(
      new Api.channels.GetParticipants({
        channel,
        filter: new Api.ChannelParticipantsRecent(),
        offset: 0,
        limit: 10_000,
        hash: bigInt(0),
      }),
    );

    if (!(result instanceof Api.channels.ChannelParticipants)) {
      console.log("Telegram returned channels.ChannelParticipantsNotModified.");
      console.log("Participants: 0");
      console.log("Users: 0");
      console.log("Deleted users (User.deleted=true): 0");
      return;
    }

    const usersById = new Map<string, Api.User>();
    for (const user of result.users) {
      if (user instanceof Api.User) {
        usersById.set(user.id.toString(), user);
      }
    }

    const counts = {
      creator: 0,
      administrator: 0,
      member: 0,
      left: 0,
      banned: 0,
      unknown: 0,
    };
    const deletedUsers: Array<{
      id: string;
      participantType: string;
      role: string;
      isBot: boolean;
    }> = [];

    for (const participant of result.participants) {
      const role = participantKind(participant);
      counts[role]++;

      const userId =
        "userId" in participant ? participant.userId.toString() : undefined;
      const user = userId ? usersById.get(userId) : undefined;
      if (userId !== undefined && user?.deleted === true) {
        deletedUsers.push({
          id: userId,
          participantType: participant.className,
          role,
          isBot: user.bot === true,
        });
      }
    }

    console.log(`Participants: ${result.participants.length}`);
    console.log(`Users: ${result.users.length}`);
    console.log(`creator: ${counts.creator}`);
    console.log(`administrator: ${counts.administrator}`);
    console.log(`member: ${counts.member}`);
    console.log(`left: ${counts.left}`);
    console.log(`banned: ${counts.banned}`);
    console.log(`unknown: ${counts.unknown}`);
    console.log(`Deleted users (User.deleted=true): ${deletedUsers.length}`);

    for (const deletedUser of deletedUsers) {
      console.log(
        `deleted user id=${deletedUser.id} participant=${deletedUser.participantType} ` +
          `role=${deletedUser.role} bot=${deletedUser.isBot}`,
      );
    }
  } finally {
    await client.disconnect();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("MTProto POC failed:", message);
  process.exitCode = 1;
});
