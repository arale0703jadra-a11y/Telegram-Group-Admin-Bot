import type { ChatMember } from "@grammyjs/types";
import {
  getVerifiedUserRecord,
  type VerifiedUser,
} from "./verified-users.js";
import {
  getVerifiedTagReview,
  recordVerifiedTagObservation,
  type VerifiedTagReview,
} from "./verified-tag-reviews.js";

export function isRecognizedVerifiedMemberTag(
  tag: string | undefined,
  recognizedTags: string[],
): boolean {
  if (!tag?.trim()) return false;
  const candidate = tag.trim().toLowerCase();
  return recognizedTags.some(
    (recognized) => recognized.trim().toLowerCase() === candidate,
  );
}

export interface VerifiedTagObservationResult {
  review?: VerifiedTagReview;
  verifiedUser?: VerifiedUser;
  classification:
    | "pending"
    | "matched"
    | "tag_absent"
    | "missing_tag"
    | "revoked_tag"
    | "uncertain"
    | "ignored";
}

export async function observeVerifiedMemberTag(input: {
  groupId: number;
  member: ChatMember;
  recognizedTags: string[];
}): Promise<VerifiedTagObservationResult> {
  const { groupId, member, recognizedTags } = input;
  if (recognizedTags.length === 0) return { classification: "ignored" };
  if (member.status !== "member" && member.status !== "restricted") {
    return { classification: "ignored" };
  }

  const userId = member.user.id;
  const tag = member.tag?.trim() || undefined;
  const recognized = isRecognizedVerifiedMemberTag(tag, recognizedTags);
  const existing = await getVerifiedUserRecord(groupId, userId);
  const active = existing?.verified === true && existing.revoked_at === null;
  const revoked = Boolean(existing && !active);
  const priorReview = await getVerifiedTagReview(groupId, userId);

  let classification: VerifiedTagObservationResult["classification"];
  if (active) {
    classification = recognized ? "matched" : "missing_tag";
  } else if (revoked) {
    if (!recognized) return { classification: "ignored", verifiedUser: existing };
    classification = "revoked_tag";
  } else if (recognized) {
    if (priorReview?.status === "rejected") {
      return { classification: "ignored", review: priorReview };
    }
    classification = "pending";
  } else if (priorReview?.status === "pending") {
    classification = "tag_absent";
  } else {
    return { classification: "ignored" };
  }

  const review = await recordVerifiedTagObservation({
    groupId,
    userId,
    username: member.user.username,
    displayName: [member.user.first_name, member.user.last_name]
      .filter(Boolean)
      .join(" "),
    observedTag: tag ?? null,
    status: classification,
  });
  return { classification, review, verifiedUser: existing };
}
