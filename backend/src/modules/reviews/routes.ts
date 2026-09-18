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
  dispatchOverview,
  endSurge,
  getMyDispatchProfile,
  getTaskDetail,
  claimNextTask,
  listAppeals,
  listQueue,
  moderationStats,
  rejectTask,
  releaseTask,
  requestChanges,
  startSurge,
  updateMyPreferences,
} from "./service";

export const moderationRouter = Router();

const taskIdParam = z.object({ id: z.coerce.bigint() });

const queueQuery = z.object({
  status: z
    .enum(["pending", "in_review", "approved", "changes_requested", "rejected", "auto_rejected", "appealed", "appeal_approved", "appeal_rejected"])
    .optional(),
  categoryCode: z.string().max(32).optional(),
  hasMedia: z.coerce.boolean().optional(),
  overdueOnly: z.coerce.boolean().optional(),
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
    res.json(ok(req, await listQueue(req.query as never)));
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

// 加权派单：让系统按通过率、分类偏好、当前负载给我分一条最合适的任务
moderationRouter.post(
  "/moderation/claim-next",
  requireAuth,
  requireRole("moderator"),
  rateLimit({ scope: "review-claim-next", limit: 60, windowSeconds: 300 }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await claimNextTask(req.user!)));
  }),
);

// 审核员查看 / 更新自己的派单画像（偏好分类、在手上限、暂停派单）
moderationRouter.get(
  "/moderation/dispatch/me",
  requireAuth,
  requireRole("moderator"),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await getMyDispatchProfile(req.user!)));
  }),
);

moderationRouter.patch(
  "/moderation/dispatch/me",
  requireAuth,
  requireRole("moderator"),
  validate({
    body: z.object({
      preferredCategories: z.array(z.string().max(32)).max(20).optional(),
      maxActive: z.number().int().min(1).max(50).optional(),
      paused: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await updateMyPreferences(req.user!, req.body)));
  }),
);

// ------------------------------------------------------------------ 临时加派（管理员）

const surgeBody = z.object({
  userUuids: z.array(z.string().uuid()).min(1).max(20),
  hours: z.coerce.number().int().min(1).max(720),
  boostFactor: z.coerce.number().min(1).max(5).optional(),
  categoryCodes: z.array(z.string().max(32)).max(20).optional(),
  reason: z.string().trim().min(2).max(200).optional(),
});

moderationRouter.get(
  "/moderation/dispatch/overview",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await dispatchOverview()));
  }),
);

moderationRouter.post(
  "/moderation/dispatch/surges",
  requireAuth,
  requireRole("admin"),
  validate({ body: surgeBody }),
  asyncHandler(async (req, res) => {
    res.json(ok(req, await startSurge(req.user!, req.body)));
  }),
);

moderationRouter.post(
  "/moderation/dispatch/surges/:id/end",
  requireAuth,
  requireRole("admin"),
  validate({
    params: z.object({ id: z.coerce.bigint() }),
    body: z.object({
      reassign: z.boolean().optional(),
      reason: z.string().trim().min(2).max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(
      ok(
        req,
        await endSurge(req.user!, bigintParam(req, "id"), {
          reassign: req.body.reassign,
          reason: req.body.reason,
        }),
      ),
    );
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
