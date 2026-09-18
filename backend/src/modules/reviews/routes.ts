import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../utils/asyncHandler";
import { ok } from "../../utils/serialize";
import { validate } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { rateLimit } from "../../middleware/rateLimit";
import { bigintParam } from "../../utils/params";
import {
  approveTask,
  claimTask,
  decideAppeal,
  getTaskDetail,
  listAppeals,
  listQueue,
  moderationStats,
  rejectTask,
  releaseTask,
  requestChanges,
} from "./service";
import { dispatchNext } from "./dispatch";
import { getDispatchProfiles } from "./profiles";

export const moderationRouter = Router();

const taskIdParam = z.object({ id: z.coerce.bigint() });

const queueQuery = z.object({
  status: z
    .enum(["pending", "in_review", "approved", "changes_requested", "rejected", "auto_rejected", "appealed", "appeal_approved", "appeal_rejected"])
    .optional(),
  categoryCode: z.string().max(32).optional(),
  hasMedia: z.coerce.boolean().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  scope: z.enum(["mine", "all"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const reasonCodeEnum = z.enum([
  "INSUFFICIENT_DETAIL",
  "LOCATION_WRONG",
  "DUPLICATE",
  "PRIVACY_RISK",
  "ADVERTISING",
  "OFF_TOPIC",
  "INAPPROPRIATE",
  "PHOTO_QUALITY",
]);

moderationRouter.get(
  "/moderation/queue",
  requireAuth,
  requireRole("moderator"),
  validate({ query: queueQuery }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await listQueue(req.query as never, req.user!)));
  }),
);

moderationRouter.get(
  "/moderation/stats",
  requireAuth,
  requireRole("moderator"),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await moderationStats()));
  }),
);

// 加权派单：依据审核员历史通过率与分类偏好，从待审池里挑最合适的任务并直接加锁
moderationRouter.post(
  "/moderation/dispatch/next",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-dispatch", limit: 120, windowSeconds: 3600 }),
  validate({
    body: z
      .object({
        categoryCode: z.string().max(32).optional(),
        overdueOnly: z.boolean().optional(),
      })
      .default({}),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await dispatchNext(req.user!, req.body)));
  }),
);

// 派单面板：查看当前可派单审核员的画像（通过率/分类偏好/在办负载）
moderationRouter.get(
  "/moderation/dispatch/moderators",
  requireAuth,
  requireRole("moderator"),
  asyncHandler(async (req, res) => {
    const profiles = await getDispatchProfiles();
    res.json(
      ok(req, {
        items: profiles.map((profile) => ({
          userId: profile.userId.toString(),
          decidedCount: profile.decidedCount,
          approvedCount: profile.approvedCount,
          approvalRate:
            profile.decidedCount > 0
              ? Number((profile.approvedCount / profile.decidedCount).toFixed(3))
              : null,
          categoryStats: profile.categoryStats,
          categoryWeights: profile.categoryWeights,
          capacityFactor: profile.capacityFactor,
          temporary: profile.temporary,
        })),
      }),
    );
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/claim",
  requireAuth,
  requireRole("moderator"),
  validate({ params: taskIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await claimTask(bigintParam(req, "id"), req.user!)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/release",
  requireAuth,
  requireRole("moderator"),
  validate({ params: taskIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await releaseTask(bigintParam(req, "id"), req.user!)));
  }),
);

moderationRouter.get(
  "/moderation/tasks/:id",
  requireAuth,
  requireRole("moderator"),
  validate({ params: taskIdParam }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await getTaskDetail(bigintParam(req, "id"), req.user!)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/approve",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-decide", limit: 300, windowSeconds: 3600 }),
  validate({
    params: taskIdParam,
    body: z.object({
      reason: z.string().max(300).optional(),
      overridePrivacy: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await approveTask(bigintParam(req, "id"), req.user!, req.body)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/request-changes",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-decide", limit: 300, windowSeconds: 3600 }),
  validate({
    params: taskIdParam,
    body: z.object({
      reasonCode: reasonCodeEnum,
      reason: z.string().max(300).optional(),
      points: z.array(z.string().max(120)).max(10).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await requestChanges(bigintParam(req, "id"), req.user!, req.body)));
  }),
);

moderationRouter.post(
  "/moderation/tasks/:id/reject",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-decide", limit: 300, windowSeconds: 3600 }),
  validate({
    params: taskIdParam,
    body: z.object({
      reasonCode: reasonCodeEnum,
      reason: z.string().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await rejectTask(bigintParam(req, "id"), req.user!, req.body)));
  }),
);

moderationRouter.get(
  "/moderation/appeals",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(ok(req, { items: await listAppeals() }));
  }),
);

moderationRouter.post(
  "/moderation/appeals/:id/decide",
  requireAuth,
  requireRole("admin"),
  validate({
    params: taskIdParam,
    body: z.object({
      decision: z.enum(["approve", "uphold"]),
      reason: z.string().trim().min(5, "请填写终审理由").max(300),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await decideAppeal(bigintParam(req, "id"), req.user!, req.body.decision, req.body.reason);
    res.json(ok(req, result));
  }),
);
