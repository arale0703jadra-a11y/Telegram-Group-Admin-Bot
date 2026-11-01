import { randomBytes } from "node:crypto";
import type { MyContext, VerifiedConfirmationOperation } from "../types.js";

const CONFIRMATION_TTL_MS = 5 * 60_000;

export function createVerifiedConfirmation(
  ctx: MyContext,
  groupId: number,
  userId: number,
  operation: VerifiedConfirmationOperation,
  permissionsSnapshot?: string,
): string {
  if (!ctx.from) throw new Error("No se pudo identificar al operador.");
  const token = randomBytes(9).toString("hex");
  ctx.session.user.verifiedConfirmation = {
    groupId,
    userId,
    actorUserId: ctx.from.id,
    operation,
    token,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    permissionsSnapshot,
  };
  return token;
}

export function consumeVerifiedConfirmation(
  ctx: MyContext,
  input: {
    groupId: number;
    userId: number;
    operation: VerifiedConfirmationOperation;
    token?: string;
    permissionsSnapshot?: string;
  },
): boolean {
  const confirmation = ctx.session.user.verifiedConfirmation;
  if (confirmation && confirmation.expiresAt <= Date.now()) {
    ctx.session.user.verifiedConfirmation = undefined;
    return false;
  }
  if (
    !ctx.from ||
    !confirmation ||
    !input.token ||
    confirmation.token !== input.token ||
    confirmation.actorUserId !== ctx.from.id ||
    confirmation.groupId !== input.groupId ||
    confirmation.userId !== input.userId ||
    confirmation.operation !== input.operation ||
    (input.permissionsSnapshot !== undefined &&
      confirmation.permissionsSnapshot !== input.permissionsSnapshot)
  ) {
    return false;
  }
  ctx.session.user.verifiedConfirmation = undefined;
  return true;
}
