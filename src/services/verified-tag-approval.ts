import type { ChatMember } from "@grammyjs/types";
import type { Api } from "grammy";
import {
  addVerifiedUser,
  getVerifiedUserRecord,
  type VerifiedUser,
} from "./verified-users.js";
import {
  decideVerifiedTagReview,
  completeVerifiedTagReviewAsMatched,
  getVerifiedTagReview,
  claimVerifiedTagReview,
  recoverExpiredVerifiedTagReviewClaim,
  recordVerifiedTagCheckFailure,
  releaseVerifiedTagReviewClaim,
  withVerifiedTagReviewLock,
} from "./verified-tag-reviews.js";
import {
  getVerifiedGroupMember,
  VerifiedUserRegistrationError,
} from "./verified-user-registration.js";
import { markUserVerified } from "./user-registry.js";
import {
  isRecognizedVerifiedMemberTag,
  observeVerifiedMemberTag,
} from "./verified-tag-sync.js";

export type VerifiedTagApprovalErrorCode =
  | "UNAUTHORIZED"
  | "NOT_PENDING"
  | "IN_PROGRESS"
  | "TAG_NOT_CONFIRMED"
  | "REVIEW_CHANGED";

export class VerifiedTagApprovalError extends Error {
  constructor(
    readonly code: VerifiedTagApprovalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VerifiedTagApprovalError";
  }
}

export type VerifiedTagApprovalResult =
  | { status: "approved"; user: VerifiedUser }
  | { status: "already-verified"; user: VerifiedUser }
  | { status: "uncertain"; message: string };

export async function approveVerifiedTagCandidate(input: {
  api: Pick<Api, "getChatMember">;
  groupId: number;
  userId: number;
  actorUserId: number;
  recognizedTags: string[];
  authorize: () => Promise<boolean>;
  syncLocal?: typeof markUserVerified;
}): Promise<VerifiedTagApprovalResult> {
  return withVerifiedTagReviewLock(input.groupId, input.userId, async () => {
    if (!(await input.authorize())) {
      throw new VerifiedTagApprovalError(
        "UNAUTHORIZED",
        "Ya no tienes permisos de administrador para este grupo.",
      );
    }

    let review = await getVerifiedTagReview(input.groupId, input.userId);
    if (review?.status === "approving") {
      if (
        review.review_claim_expires_at &&
        Date.parse(review.review_claim_expires_at) <= Date.now()
      ) {
        review = await recoverExpiredVerifiedTagReviewClaim(
          input.groupId,
          input.userId,
        );
      }
      if (review?.status === "approving") {
        throw new VerifiedTagApprovalError(
          "IN_PROGRESS",
          "Otra revisión está comprobando esta candidata. Espera unos minutos y vuelve a intentarlo.",
        );
      }
    }
    if (
      !review ||
      (review.status !== "pending" && review.status !== "revoked_tag")
    ) {
      throw new VerifiedTagApprovalError(
        "NOT_PENDING",
        "La candidata ya no está pendiente de revisión.",
      );
    }

    const claim = await claimVerifiedTagReview({
      groupId: input.groupId,
      userId: input.userId,
      expectedStatus: review.status,
      actorUserId: input.actorUserId,
    });
    if (!claim?.review_claim_token) {
      throw new VerifiedTagApprovalError(
        "IN_PROGRESS",
        "Otra revisión ha cambiado el estado de esta candidata. Actualiza la lista y vuelve a comprobar.",
      );
    }

    let completed = false;
    try {
      let member: ChatMember;
      try {
        member = await getVerifiedGroupMember(
          input.api,
          input.groupId,
          input.userId,
        );
      } catch (cause) {
        const failureCode =
          cause instanceof VerifiedUserRegistrationError
            ? cause.code
            : "TELEGRAM_ERROR";
        await recordVerifiedTagCheckFailure({
          groupId: input.groupId,
          userId: input.userId,
          failureCode,
        });
        await releaseVerifiedTagReviewClaim({
          groupId: input.groupId,
          userId: input.userId,
          claimToken: claim.review_claim_token,
          previousStatus: review.status,
        });
        completed = true;
        return {
          status: "uncertain",
          message: cause instanceof VerifiedUserRegistrationError
            ? `Resultado incierto: ${cause.message} La candidata sigue pendiente y no se modificó la verificación.`
            : "Resultado incierto: Telegram no pudo confirmar la identidad y pertenencia. La candidata sigue pendiente y no se modificó la verificación.",
        };
      }

      const supportsMemberTag =
        member.status === "member" || member.status === "restricted";
      const memberTag = member.status === "member"
        ? member.tag?.trim()
        : member.status === "restricted"
          ? member.tag?.trim()
          : undefined;
      if (
        !supportsMemberTag ||
        !memberTag ||
        !isRecognizedVerifiedMemberTag(memberTag, input.recognizedTags)
      ) {
        await releaseVerifiedTagReviewClaim({
          groupId: input.groupId,
          userId: input.userId,
          claimToken: claim.review_claim_token,
          previousStatus: review.status,
        });
        if (supportsMemberTag) {
          await observeVerifiedMemberTag({
            groupId: input.groupId,
            member,
            recognizedTags: input.recognizedTags,
          });
        }
        throw new VerifiedTagApprovalError(
          "TAG_NOT_CONFIRMED",
          "No se pudo confirmar la etiqueta actual. La candidata no se aprobó.",
        );
      }

      const existing = await getVerifiedUserRecord(input.groupId, input.userId);
      if (existing?.verified && existing.revoked_at === null) {
        const displayName = [member.user.first_name, member.user.last_name]
          .filter(Boolean)
          .join(" ");
        await (input.syncLocal ?? markUserVerified)(
          input.groupId,
          input.userId,
          member.user.username,
          displayName,
        );
        const matched = await completeVerifiedTagReviewAsMatched({
          groupId: input.groupId,
          userId: input.userId,
          claimToken: claim.review_claim_token,
          username: member.user.username,
          displayName,
          observedTag: memberTag,
        });
        if (!matched) {
          throw new VerifiedTagApprovalError(
            "REVIEW_CHANGED",
            "La verificación existente no se modificó, pero la revisión cambió de estado.",
          );
        }
        completed = true;
        return { status: "already-verified", user: existing };
      }

      const displayName = [member.user.first_name, member.user.last_name]
        .filter(Boolean)
        .join(" ");
      const user = await addVerifiedUser({
        groupId: input.groupId,
        userId: input.userId,
        username: member.user.username,
        displayName,
        createdBy: input.actorUserId,
      });
      await (input.syncLocal ?? markUserVerified)(
        input.groupId,
        input.userId,
        member.user.username,
        displayName,
      );
      const approved = await decideVerifiedTagReview({
        groupId: input.groupId,
        userId: input.userId,
        decision: "approved",
        expectedStatus: "approving",
        claimToken: claim.review_claim_token,
        actorUserId: input.actorUserId,
      });
      if (!approved) {
        throw new VerifiedTagApprovalError(
          "REVIEW_CHANGED",
          "La verificación se guardó, pero no se pudo cerrar la revisión. Comprueba el estado antes de reintentar.",
        );
      }
      completed = true;
      return { status: "approved", user };
    } finally {
      if (!completed) {
        await releaseVerifiedTagReviewClaim({
          groupId: input.groupId,
          userId: input.userId,
          claimToken: claim.review_claim_token,
          previousStatus: review.status,
        });
      }
    }
  });
}
