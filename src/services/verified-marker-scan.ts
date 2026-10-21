import type { GroupData } from "../storage/types.js";
import { findConfiguredVerifiedMarker } from "./verified-marker-detection.js";
import {
  getVerifiedUserRecord,
} from "./verified-users.js";
import {
  getVerifiedTagReview,
  recordVerifiedTagObservation,
} from "./verified-tag-reviews.js";

const RECENT_ACTIVITY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export interface VerifiedMarkerScanResult {
  scanned: number;
  newCandidates: number;
}

export async function scanObservedVerifiedMarkers(
  groupId: number,
  data: GroupData,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedMarkerScanResult> {
  const activityCutoff = now - RECENT_ACTIVITY_WINDOW_SECONDS;
  const recentUsers = new Map<
    number,
    { username?: string; displayName: string; markerFields: string[] }
  >();

  for (const user of Object.values(data.indexedUsers)) {
    const activeStatus =
      user.status === "creator" ||
      user.status === "administrator" ||
      user.status === "member" ||
      user.status === "restricted";
    const recentlySeen =
      typeof user.lastSeen === "number" && user.lastSeen >= activityCutoff;
    if (!activeStatus && !recentlySeen) continue;
    recentUsers.set(user.id, {
      username: user.username || undefined,
      displayName:
        user.displayName ?? user.name ??
        [user.firstName, user.lastName].filter(Boolean).join(" "),
      markerFields: [
        user.firstName ?? "",
        user.lastName ?? "",
        user.name ?? "",
        user.displayName ?? "",
        user.username ?? "",
      ],
    });
  }

  for (const message of data.activityMessages) {
    if (message.timestamp < activityCutoff) continue;
    const existing = recentUsers.get(message.userId);
    const displayName =
      [message.firstName, message.lastName].filter(Boolean).join(" ") ||
      message.name ||
      existing?.displayName ||
      "";
    recentUsers.set(message.userId, {
      username: message.username ?? existing?.username,
      displayName,
      markerFields: [
        message.firstName ?? "",
        message.lastName ?? "",
        message.name ?? "",
        message.username ?? "",
        ...(existing?.markerFields ?? []),
      ],
    });
  }

  let newCandidates = 0;
  for (const [userId, user] of recentUsers) {
    const marker = findConfiguredVerifiedMarker(
      user.markerFields,
      data.verifiedMemberTags,
    );
    if (!marker) continue;

    const existing = await getVerifiedUserRecord(groupId, userId);
    if (existing?.verified && existing.revoked_at === null) continue;

    const priorReview = await getVerifiedTagReview(groupId, userId);
    if (priorReview?.status === "rejected" || priorReview?.status === "approving") {
      continue;
    }
    if (!priorReview || priorReview.status !== "pending") {
      newCandidates++;
    }
    await recordVerifiedTagObservation({
      groupId,
      userId,
      username: user.username,
      displayName: user.displayName,
      observedTag: `${marker} (escaneo de perfil/actividad reciente)`,
      status: "pending",
    });
  }

  return { scanned: recentUsers.size, newCandidates };
}
