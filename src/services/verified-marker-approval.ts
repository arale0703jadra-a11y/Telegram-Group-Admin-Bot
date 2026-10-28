import type { ChatMember } from "@grammyjs/types";
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
import {
  getVerifiedGroupMember,
  isActiveVerifiedGroupMember,
  VerifiedUserRegistrationError,
} from "./verified-user-registration.js";
import { isActiveVerifiedRecord } from "./verified-user-policy.js";
import { markUserVerified, unmarkUserVerified } from "./user-registry.js";

export class VerifiedMarkerApprovalError extends Error {
  constructor(
    readonly code: "USER_NOT_IN_GROUP" | "REACTIVATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "VerifiedMarkerApprovalError";
  }
}

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

    let member: ChatMember;
    try {
      member = await getVerifiedGroupMember(
        input.api,
        input.groupId,
        input.userId,
      );
    } catch (error) {
      if (
        !(error instanceof VerifiedUserRegistrationError) ||
        error.code !== "USER_NOT_IN_GROUP"
      ) {
        throw error;
      }
      const removed = await decideVerifiedTagReview({
        groupId: input.groupId,
        userId: input.userId,
        decision: "rejected",
        expectedStatus: "pending",
        actorUserId: input.actorUserId,
      });
      if (!removed) {
        throw new Error("La revisión cambió durante la comprobación de membresía.");
      }
      throw new VerifiedMarkerApprovalError(
        "USER_NOT_IN_GROUP",
        "⚠️ El usuario ya no está en el grupo.",
      );
    }
    if (!isActiveVerifiedGroupMember(member)) {
      const removed = await decideVerifiedTagReview({
        groupId: input.groupId,
        userId: input.userId,
        decision: "rejected",
        expectedStatus: "pending",
        actorUserId: input.actorUserId,
      });
      if (!removed) {
        throw new Error("La revisión cambió durante la comprobación de membresía.");
      }
      throw new VerifiedMarkerApprovalError(
        "USER_NOT_IN_GROUP",
        "⚠️ El usuario ya no está en el grupo.",
      );
    }
    if (member.user.is_bot) {
      throw new Error("No se puede verificar una cuenta de bot.");
    }

    const existing = await getVerifiedUserRecord(input.groupId, input.userId);
    const alreadyVerified = isActiveVerifiedRecord(existing);
    if (
      existing?.verified &&
      existing.revoked_at === null &&
      !alreadyVerified
    ) {
      throw new VerifiedMarkerApprovalError(
        "REACTIVATION_REQUIRED",
        "La verificación existente no está vigente. Renueva explícitamente la verificación desde gestión antes de aprobar esta candidata.",
      );
    }
    if (!alreadyVerified) {
      await addVerifiedUser({
        groupId: input.groupId,
        userId: input.userId,
        username: member.user.username,
        displayName: [member.user.first_name, member.user.last_name]
          .filter(Boolean)
          .join(" "),
        createdBy: input.actorUserId,
        reactivate: true,
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
