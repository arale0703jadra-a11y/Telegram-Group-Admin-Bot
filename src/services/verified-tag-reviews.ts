import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type VerifiedTagReviewStatus =
  | "pending"
  | "approving"
  | "approved"
  | "rejected"
  | "matched"
  | "tag_absent"
  | "missing_tag"
  | "revoked_tag"
  | "uncertain";

export interface VerifiedTagReview {
  group_id: number;
  user_id: number;
  username: string | null;
  display_name: string | null;
  observed_tag: string | null;
  status: VerifiedTagReviewStatus;
  first_seen_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
  reviewed_by: number | null;
  review_claim_token: string | null;
  review_claim_expires_at: string | null;
  review_claim_previous_status: "pending" | "revoked_tag" | null;
}

let client: SupabaseClient | undefined;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Faltan credenciales de Supabase para revisar etiquetas verificadas.");
  }
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

function makeEventKey(values: Array<string | number | null>): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function recordAudit(input: {
  groupId: number;
  userId: number;
  eventType: "OBSERVED" | "APPROVED" | "REJECTED" | "CHECK_FAILED";
  previousStatus: VerifiedTagReviewStatus | null;
  currentStatus: VerifiedTagReviewStatus;
  observedTag: string | null;
  actorUserId?: number;
  failureCode?: string;
}): Promise<void> {
  const eventKey = makeEventKey([
    input.groupId,
    input.userId,
    input.eventType,
    input.previousStatus,
    input.currentStatus,
    input.observedTag,
    input.actorUserId ?? null,
    input.failureCode ?? null,
  ]);
  const { error } = await getClient()
    .from("verified_member_tag_audit")
    .upsert(
      {
        event_key: eventKey,
        group_id: input.groupId,
        user_id: input.userId,
        event_type: input.eventType,
        previous_status: input.previousStatus,
        current_status: input.currentStatus,
        observed_tag: input.observedTag,
        failure_code: input.failureCode ?? null,
        actor_user_id: input.actorUserId ?? null,
      },
      { onConflict: "event_key", ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function recordVerifiedTagCheckFailure(input: {
  groupId: number;
  userId: number;
  failureCode: string;
}): Promise<void> {
  const previous = await getVerifiedTagReview(input.groupId, input.userId);
  await recordAudit({
    groupId: input.groupId,
    userId: input.userId,
    eventType: "CHECK_FAILED",
    previousStatus: previous?.status ?? null,
    currentStatus: "uncertain",
    observedTag: previous?.observed_tag ?? null,
    failureCode: input.failureCode,
  });
}

export async function getVerifiedTagReview(
  groupId: number,
  userId: number,
): Promise<VerifiedTagReview | undefined> {
  const { data, error } = await getClient()
    .from("verified_member_tag_reviews")
    .select("*")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as VerifiedTagReview | null) ?? undefined;
}

export async function listVerifiedTagReviews(
  groupId: number,
): Promise<VerifiedTagReview[]> {
  const { data, error } = await getClient()
    .from("verified_member_tag_reviews")
    .select("*")
    .eq("group_id", groupId)
    .in("status", [
      "pending",
      "approving",
      "tag_absent",
      "missing_tag",
      "revoked_tag",
      "uncertain",
    ])
    .order("last_seen_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as VerifiedTagReview[];
}

export async function recordVerifiedTagObservation(input: {
  groupId: number;
  userId: number;
  username?: string;
  displayName?: string;
  observedTag: string | null;
  status: Extract<
    VerifiedTagReviewStatus,
    "pending" | "matched" | "tag_absent" | "missing_tag" | "revoked_tag" | "uncertain"
  >;
}): Promise<VerifiedTagReview> {
  const previous = await getVerifiedTagReview(input.groupId, input.userId);
  if (previous?.status === "approving") return previous;
  const status =
    previous?.status === "rejected" && input.status === "pending"
      ? "rejected"
      : input.status;
  const { data, error } = await getClient()
    .from("verified_member_tag_reviews")
    .upsert(
      {
        group_id: input.groupId,
        user_id: input.userId,
        username: input.username ?? null,
        display_name: input.displayName ?? null,
        observed_tag: input.observedTag,
        status,
        first_seen_at: previous?.first_seen_at ?? new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        reviewed_at:
          previous?.status === status ? previous.reviewed_at : null,
        reviewed_by:
          previous?.status === status ? previous.reviewed_by : null,
        review_claim_token: null,
        review_claim_expires_at: null,
        review_claim_previous_status: null,
      },
      { onConflict: "group_id,user_id" },
    )
    .select("*")
    .single();
  if (error) throw error;

  if (
    previous?.status !== status ||
    previous?.observed_tag?.trim().toLowerCase() !==
      input.observedTag?.trim().toLowerCase()
  ) {
    await recordAudit({
      groupId: input.groupId,
      userId: input.userId,
      eventType: "OBSERVED",
      previousStatus: previous?.status ?? null,
      currentStatus: status,
      observedTag: input.observedTag,
    });
  }
  return data as VerifiedTagReview;
}

export async function decideVerifiedTagReview(input: {
  groupId: number;
  userId: number;
  decision: "approved" | "rejected";
  expectedStatus?: "pending" | "revoked_tag" | "approving";
  claimToken?: string;
  actorUserId: number;
}): Promise<VerifiedTagReview | undefined> {
  const previous = await getVerifiedTagReview(input.groupId, input.userId);
  const expectedStatus = input.expectedStatus ?? "pending";
  if (!previous || previous.status !== expectedStatus) return undefined;
  if (expectedStatus === "approving" && !input.claimToken) return undefined;

  let query = getClient()
    .from("verified_member_tag_reviews")
    .update({
      status: input.decision,
      reviewed_at: new Date().toISOString(),
      reviewed_by: input.actorUserId,
      review_claim_token: null,
      review_claim_expires_at: null,
      review_claim_previous_status: null,
    })
    .eq("group_id", input.groupId)
    .eq("user_id", input.userId)
    .eq("status", expectedStatus);
  if (input.claimToken) {
    query = query.eq("review_claim_token", input.claimToken);
  }
  const { data, error } = await query
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;

  await recordAudit({
    groupId: input.groupId,
    userId: input.userId,
    eventType: input.decision === "approved" ? "APPROVED" : "REJECTED",
    previousStatus:
      previous.status === "approving"
        ? previous.review_claim_previous_status
        : previous.status,
    currentStatus: input.decision,
    observedTag: previous.observed_tag,
    actorUserId: input.actorUserId,
  });
  return data as VerifiedTagReview;
}

export async function completeVerifiedTagReviewAsMatched(input: {
  groupId: number;
  userId: number;
  claimToken: string;
  username?: string;
  displayName?: string;
  observedTag: string;
}): Promise<VerifiedTagReview | undefined> {
  const previous = await getVerifiedTagReview(input.groupId, input.userId);
  if (
    previous?.status !== "approving" ||
    previous.review_claim_token !== input.claimToken
  ) {
    return undefined;
  }
  const { data, error } = await getClient()
    .from("verified_member_tag_reviews")
    .update({
      status: "matched",
      username: input.username ?? null,
      display_name: input.displayName ?? null,
      observed_tag: input.observedTag,
      reviewed_by: null,
      review_claim_token: null,
      review_claim_expires_at: null,
      review_claim_previous_status: null,
    })
    .eq("group_id", input.groupId)
    .eq("user_id", input.userId)
    .eq("status", "approving")
    .eq("review_claim_token", input.claimToken)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  await recordAudit({
    groupId: input.groupId,
    userId: input.userId,
    eventType: "OBSERVED",
    previousStatus: previous.review_claim_previous_status,
    currentStatus: "matched",
    observedTag: input.observedTag,
  });
  return data as VerifiedTagReview;
}

export async function claimVerifiedTagReview(input: {
  groupId: number;
  userId: number;
  expectedStatus: "pending" | "revoked_tag";
  actorUserId: number;
}): Promise<VerifiedTagReview | undefined> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
  const { data, error } = await getClient()
    .from("verified_member_tag_reviews")
    .update({
      status: "approving",
      reviewed_by: input.actorUserId,
      review_claim_token: token,
      review_claim_expires_at: expiresAt,
      review_claim_previous_status: input.expectedStatus,
    })
    .eq("group_id", input.groupId)
    .eq("user_id", input.userId)
    .eq("status", input.expectedStatus)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as VerifiedTagReview | null) ?? undefined;
}

export async function releaseVerifiedTagReviewClaim(input: {
  groupId: number;
  userId: number;
  claimToken: string;
  previousStatus: "pending" | "revoked_tag";
}): Promise<void> {
  const { error } = await getClient()
    .from("verified_member_tag_reviews")
    .update({
      status: input.previousStatus,
      reviewed_by: null,
      review_claim_token: null,
      review_claim_expires_at: null,
      review_claim_previous_status: null,
    })
    .eq("group_id", input.groupId)
    .eq("user_id", input.userId)
    .eq("status", "approving")
    .eq("review_claim_token", input.claimToken);
  if (error) throw error;
}

export async function recoverExpiredVerifiedTagReviewClaim(
  groupId: number,
  userId: number,
): Promise<VerifiedTagReview | undefined> {
  const current = await getVerifiedTagReview(groupId, userId);
  if (
    !current ||
    current.status !== "approving" ||
    !current.review_claim_token ||
    !current.review_claim_expires_at ||
    Date.parse(current.review_claim_expires_at) > Date.now() ||
    !current.review_claim_previous_status
  ) {
    return current;
  }

  const { data, error } = await getClient()
    .from("verified_member_tag_reviews")
    .update({
      status: current.review_claim_previous_status,
      reviewed_by: null,
      review_claim_token: null,
      review_claim_expires_at: null,
      review_claim_previous_status: null,
    })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("status", "approving")
    .eq("review_claim_token", current.review_claim_token)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as VerifiedTagReview | null) ?? getVerifiedTagReview(groupId, userId);
}

const reviewLocks = new Map<string, Promise<void>>();

export async function withVerifiedTagReviewLock<T>(
  groupId: number,
  userId: number,
  action: () => Promise<T>,
): Promise<T> {
  const key = `${groupId}:${userId}`;
  const prior = reviewLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  reviewLocks.set(key, current);
  await prior;
  try {
    return await action();
  } finally {
    release();
    if (reviewLocks.get(key) === current) {
      reviewLocks.delete(key);
    }
  }
}
