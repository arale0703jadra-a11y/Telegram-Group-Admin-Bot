import type { Api } from "grammy";
import {
  addVerifiedUser,
  getVerifiedUserRecord,
  invalidateVerifiedUserCache,
  revokeVerifiedUser,
} from "./verified-users.js";
import {
  decideVerifiedTagReview,
  getVerifiedTagReview,
  withVerifiedTagReviewLock,
} from "./verified-tag-reviews.js";
import { getVerifiedGroupMember } from "./verified-user-registration.js";
import { markUserVerified, unmarkUserVerified } from "./user-registry.js";

export async function approveVerifiedMarkerCandidate(input: {
  api: Pick<Api, "getChatMember">;
  groupId: number;
  userId: number;
  actorUserId: number;
  authorize: () => Promise<boolean>;
}): Promise<void> {
  await withVerifiedTagReviewLock(input.groupId, input.userId, async () => {
    if (!(await input.authorize())) {
      throw new Error("Ya no tienes permisos de administrador para este grupo.");
    }
    const review = await getVerifiedTagReview(input.groupId, input.userId);
    if (!review || review.status !== "pending") {
      throw new Error("La candidata ya no está pendiente de revisión.");
    }

    const member = await getVerifiedGroupMember(
      input.api,
      input.groupId,
      input.userId,
    );
    if (member.user.is_bot) {
      throw new Error("No se puede verificar una cuenta de bot.");
    }

    const existing = await getVerifiedUserRecord(input.groupId, input.userId);
    const alreadyVerified = existing?.verified && existing.revoked_at === null;
    if (!alreadyVerified) {
      await addVerifiedUser({
        groupId: input.groupId,
        userId: input.userId,
        username: member.user.username,
        displayName: [member.user.first_name, member.user.last_name]
          .filter(Boolean)
          .join(" "),
        createdBy: input.actorUserId,
      });
      await markUserVerified(
        input.groupId,
        input.userId,
        member.user.username,
        [member.user.first_name, member.user.last_name].filter(Boolean).join(" "),
      );
    }

    const result = await decideVerifiedTagReview({
      groupId: input.groupId,
      userId: input.userId,
      decision: "approved",
      expectedStatus: "pending",
      actorUserId: input.actorUserId,
    });
    if (!result) {
      if (!alreadyVerified) {
        await revokeVerifiedUser(input.groupId, input.userId);
        await unmarkUserVerified(input.groupId, input.userId);
        invalidateVerifiedUserCache(input.groupId, input.userId);
      }
      throw new Error(
        "La revisión cambió durante la aprobación; no se completó la operación.",
      );
    }
  });
}
