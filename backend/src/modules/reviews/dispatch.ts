import type { Prisma } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  REVIEW_LOCK_MS,
  TEMP_TAKEOVER_LIMIT,
} from "../../config/constants";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { recordAudit } from "../../services/audit";
import type { AuthUser } from "../../types/auth";
import {
  scoreTaskForModerator,
  taskUrgencyMultiplier,
  weightedPick,
  type ModeratorDispatchFeatures,
  type TaskDispatchFeatures,
} from "./dispatch-score";
import { getDispatchProfiles, type ModeratorProfileView } from "./profiles";

/**
 * 加权派单。
 *
 * 两条入口：
 * - dispatchNext：审核员点「智能派单」，从待审池里给他挑最合适的任务并直接加锁；
 * - takeoverBacklog：管理员针对积压（默认超时任务）批量预分配给一组审核员，
 *   含临时加派人员，用于高峰期快速泄洪。
 *
 * 并发安全与手动领取一致：最终落库用一条带条件的 updateMany，
 * 抢不到就换下一个候选，绝不在应用层"先查再改"。
 */

// 可派任务：未决策，且要么从未被领取，要么领取锁已过期
// （cleanup 每天才统一重置过期锁，派单不能因此漏掉这些任务，与手动领取语义一致）
const PENDING_TASK_FILTER = {
  status: { in: ["pending" as const, "in_review" as const] },
  decidedAt: null,
  OR: [{ assignedTo: null }, { lockedUntil: { lt: new Date() } }],
} satisfies Prisma.ReviewTaskWhereInput;

async function loadCandidatesForScoring(limit: number) {
  // 候选池：按 SLA 紧迫度排序取头部，打分在应用层完成（权重依赖跨表统计）
  return prisma.reviewTask.findMany({
    where: PENDING_TASK_FILTER,
    orderBy: [{ priority: "desc" }, { slaDueAt: "asc" }],
    take: limit,
    include: {
      spot: {
        select: {
          id: true,
          ownerId: true,
          owner: { select: { creditScore: true } },
          category: { select: { code: true } },
        },
      },
    },
  });
}

function toFeatures(profile: ModeratorProfileView, activeCount: number): ModeratorDispatchFeatures {
  return {
    userId: profile.userId,
    decidedCount: profile.decidedCount,
    approvedCount: profile.approvedCount,
    categoryStats: profile.categoryStats,
    categoryWeights: profile.categoryWeights,
    capacityFactor: profile.capacityFactor,
    activeCount,
    temporary: profile.temporary,
  };
}

/**
 * 原子加锁：沿用 claimTask 的条件 UPDATE 模式。
 * 返回 true 表示抢到；false 表示任务在打分后被别人拿走了。
 */
async function tryLockTask(taskId: bigint, moderatorId: bigint): Promise<boolean> {
  const now = new Date();
  const updated = await prisma.reviewTask.updateMany({
    where: {
      id: taskId,
      status: { in: ["pending", "in_review"] },
      decidedAt: null,
      OR: [{ assignedTo: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      assignedTo: moderatorId,
      lockedUntil: new Date(now.getTime() + REVIEW_LOCK_MS),
      status: "in_review",
    },
  });
  return updated.count > 0;
}

async function loadActiveCounts(userIds: bigint[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.reviewTask.groupBy({
    by: ["assignedTo"],
    where: {
      assignedTo: { in: userIds },
      status: "in_review",
      decidedAt: null,
      lockedUntil: { gt: new Date() },
    },
    _count: { _all: true },
  });
  return new Map(
    rows
      .filter((row) => row.assignedTo !== null)
      .map((row) => [row.assignedTo!.toString(), row._count._all]),
  );
}

export interface DispatchResult {
  taskId: bigint;
  matchedModeratorId: bigint;
  score: number;
  factors: ReturnType<typeof scoreTaskForModerator>["factors"];
  urgency: number;
}

/**
 * 为指定审核员派下一个任务。
 *
 * 流程：取候选池 → 过滤掉自己提交的条目 → 逐任务算分 →
 * 用加权随机挑一个（分数越高概率越大）→ 条件 UPDATE 抢锁，
 * 抢不到则在剩余候选里重试。
 */
export async function dispatchNext(
  moderator: AuthUser,
  options: { categoryCode?: string; overdueOnly?: boolean; limit?: number } = {},
): Promise<{ taskId: bigint; lockedUntil: Date; score: number; factors: unknown }> {
  const poolLimit = Math.max(5, Math.min(options.limit ?? 40, 100));
  const [candidates, profiles] = await Promise.all([
    loadCandidatesForScoring(poolLimit),
    getDispatchProfiles(),
  ]);

  const profile = profiles.find((item) => item.userId === moderator.id);
  if (!profile) {
    throw AppError.conflict(ERROR_CODES.DISPATCH_UNAVAILABLE, "你当前不在派单名单中，如有疑问请联系管理员");
  }
  if (!profile.dispatchEnabled) {
    throw AppError.conflict(ERROR_CODES.DISPATCH_UNAVAILABLE, "你的派单已被暂停，请联系管理员");
  }

  const now = Date.now();
  const scorable = candidates.filter((task) => {
    // 自己提交的条目永远不能派给自己（与手动领取的门禁一致）
    if (task.spot.ownerId === moderator.id) return false;
    if (options.categoryCode && task.spot.category.code !== options.categoryCode) return false;
    if (options.overdueOnly && task.slaDueAt.getTime() >= now) return false;
    return true;
  });

  if (scorable.length === 0) {
    throw AppError.notFound("当前没有可派给你的待审任务");
  }

  const activeCounts = await loadActiveCounts([moderator.id]);
  const moderatorFeatures = toFeatures(profile, activeCounts.get(moderator.id.toString()) ?? 0);

  const scored = scorable
    .map((task) => {
      const taskFeatures: TaskDispatchFeatures = {
        submitterCreditScore: task.spot.owner.creditScore,
        categoryCode: task.spot.category.code,
        overdue: task.slaDueAt.getTime() < now,
        priority: task.priority,
      };
      const result = scoreTaskForModerator(moderatorFeatures, taskFeatures);
      return {
        taskId: task.id,
        score: result.total * taskUrgencyMultiplier(taskFeatures),
        baseScore: result.total,
        factors: result.factors,
        urgency: taskUrgencyMultiplier(taskFeatures),
      };
    })
    .sort((a, b) => b.score - a.score);

  // 加权随机带来多样性，但只在分数差距不大的任务之间随机；
  // 取前 8 名进抽签池，避免派到明显不匹配的任务
  const lottery = scored.slice(0, 8);
  let attempt = 0;

  while (attempt < lottery.length) {
    const picked = weightedPick(lottery, (item) => item.score);
    if (!picked) break;

    // 锁冲突时把该候选移除后重试下一个
    const index = lottery.indexOf(picked);
    lottery.splice(index, 1);
    attempt += 1;

    const locked = await tryLockTask(picked.taskId, moderator.id);
    if (locked) {
      await recordAudit({
        actorId: moderator.id,
        action: AUDIT_ACTIONS.REVIEW_DISPATCH,
        targetType: "review_task",
        targetId: picked.taskId,
        after: { mode: "auto", score: Number(picked.baseScore.toFixed(4)), factors: picked.factors },
      });

      return {
        taskId: picked.taskId,
        lockedUntil: new Date(Date.now() + REVIEW_LOCK_MS),
        score: Number(picked.baseScore.toFixed(4)),
        factors: picked.factors,
      };
    }
  }

  throw AppError.conflict(ERROR_CODES.REVIEW_ALREADY_CLAIMED, "候选任务刚刚都被其他人领走了，请再试一次");
}

// ---------------------------------------------------------------- 批量接管

export interface TakeoverBacklogInput {
  /** 参与接管的审核员 uuid 列表；缺省时由系统按画像选派 */
  moderatorUuids?: string[];
  categoryCode?: string;
  overdueOnly?: boolean;
  /** 本轮最多分配多少条 */
  limit?: number;
  reason: string;
}

/**
 * 管理员批量把积压任务预分配给审核员（含临时加派人手）。
 *
 * 分配方式：对每条任务在指定审核员集合内打分，选加权随机胜出者，
 * 同时尊重每个人的在办负载——负载因子已经在打分里，这里再用
 * perModeratorCap 做硬上限，防止一批任务全压给同一个人。
 */
export async function takeoverBacklog(admin: AuthUser, input: TakeoverBacklogInput) {
  const limit = Math.max(1, Math.min(input.limit ?? 20, TEMP_TAKEOVER_LIMIT));

  const [candidatesRaw, profiles, users] = await Promise.all([
    loadCandidatesForScoring(Math.max(limit * 2, 20)),
    getDispatchProfiles(),
    input.moderatorUuids
      ? prisma.user.findMany({
          where: { uuid: { in: input.moderatorUuids } },
          select: { id: true, uuid: true, nickname: true, role: true, status: true },
        })
      : Promise.resolve([]),
  ]);

  let eligibleProfiles = profiles;
  if (input.moderatorUuids) {
    const allowedIds = new Set(users.filter((user) => user.status === "active").map((user) => user.id.toString()));
    eligibleProfiles = profiles.filter((profile) => allowedIds.has(profile.userId.toString()));
    if (eligibleProfiles.length === 0) {
      throw AppError.badRequest("指定的审核员均不可参与派单（账号不可用或未授权）");
    }
  } else if (eligibleProfiles.length === 0) {
    throw AppError.conflict(ERROR_CODES.DISPATCH_UNAVAILABLE, "当前没有可参与派单的审核员");
  }

  const now = Date.now();
  const tasks = candidatesRaw.filter((task) => {
    if (input.categoryCode && task.spot.category.code !== input.categoryCode) return false;
    if (input.overdueOnly !== false && task.slaDueAt.getTime() >= now) return false;
    return true;
  });

  if (tasks.length === 0) {
    throw AppError.notFound(input.overdueOnly === false ? "当前没有待审任务" : "当前没有超时积压任务");
  }

  const selected = tasks.slice(0, limit);
  const activeCounts = await loadActiveCounts(eligibleProfiles.map((profile) => profile.userId));
  const featuresById = new Map(
    eligibleProfiles.map((profile) => [
      profile.userId.toString(),
      toFeatures(profile, activeCounts.get(profile.userId.toString()) ?? 0),
    ]),
  );

    // 每人本轮最多拿 ceil(limit / 人数) + 2，留出余量但不允许垄断
  const cap = Math.ceil(limit / eligibleProfiles.length) + 2;
  const assignedThisRound = new Map<string, number>();

  // 加派批次剩余配额（taskLimit=0 表示不限）；自动派单不消耗配额，
  // 只有管理员批量接管会计入，避免临时人手一进来就被配额卡住正常工作。
  const batchByUser = new Map<string, { taskLimit: number; assignedCount: number; id: bigint }>();
  const activeBatches = await prisma.tempAssignment.findMany({
    where: { status: "active", expiresAt: { gt: new Date() } },
    select: { id: true, userId: true, taskLimit: true, assignedCount: true },
  });
  for (const batch of activeBatches) batchByUser.set(batch.userId.toString(), batch);
  const usedQuota = new Map<string, number>();

  const results: DispatchResult[] = [];
  const skipped: Array<{ taskId: bigint; reason: string }> = [];

  for (const task of selected) {
    const taskFeatures: TaskDispatchFeatures = {
      submitterCreditScore: task.spot.owner.creditScore,
      categoryCode: task.spot.category.code,
      overdue: task.slaDueAt.getTime() < now,
      priority: task.priority,
    };
    const urgency = taskUrgencyMultiplier(taskFeatures);

    const ranked = eligibleProfiles
      .filter((profile) => profile.userId !== task.spot.ownerId)
      .filter((profile) => (assignedThisRound.get(profile.userId.toString()) ?? 0) < cap)
      .filter((profile) => {
        // 有接管上限的加派批次：已派数 + 本轮已用不能超过上限
        const batch = batchByUser.get(profile.userId.toString());
        if (!batch || batch.taskLimit <= 0) return true;
        return batch.assignedCount + (usedQuota.get(profile.userId.toString()) ?? 0) < batch.taskLimit;
      })
      .map((profile) => {
        const features = featuresById.get(profile.userId.toString())!;
        const result = scoreTaskForModerator(features, taskFeatures);
        return { profile, total: result.total, factors: result.factors, urgency };
      })
      .sort((a, b) => b.total - a.total);

    if (ranked.length === 0) {
      skipped.push({ taskId: task.id, reason: "没有可用审核员（作者本人、达本轮上限或加派配额已满）" });
      continue;
    }

    // 管理员批量派发强调确定性：取最高分，而不是随机
    const winner = ranked[0];
    const locked = await tryLockTask(task.id, winner.profile.userId);
    if (!locked) {
      skipped.push({ taskId: task.id, reason: "任务已被其他人领取" });
      continue;
    }

    assignedThisRound.set(
      winner.profile.userId.toString(),
      (assignedThisRound.get(winner.profile.userId.toString()) ?? 0) + 1,
    );
    if (batchByUser.has(winner.profile.userId.toString())) {
      usedQuota.set(
        winner.profile.userId.toString(),
        (usedQuota.get(winner.profile.userId.toString()) ?? 0) + 1,
      );
    }
    results.push({
      taskId: task.id,
      matchedModeratorId: winner.profile.userId,
      score: Number(winner.total.toFixed(4)),
      factors: winner.factors,
      urgency,
    });

    // 下一轮打分时把刚分配出去的负载算上
    const features = featuresById.get(winner.profile.userId.toString());
    if (features) features.activeCount += 1;
  }

  // 回写加派批次的已分配计数（taskLimit 配额统计）
  if (usedQuota.size > 0) {
    await Promise.all(
      [...usedQuota.entries()].map(([userId, count]) =>
        prisma.tempAssignment.updateMany({
          where: { userId: BigInt(userId), status: "active" },
          data: { assignedCount: { increment: count } },
        }),
      ),
    );
  }

  const moderatorIdToName = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: results.map((result) => result.matchedModeratorId) } },
        select: { id: true, nickname: true },
      })
    ).map((user) => [user.id.toString(), user.nickname]),
  );

  await recordAudit({
    actorId: admin.id,
    action: AUDIT_ACTIONS.REVIEW_TEMP_TAKEOVER,
    targetType: "review_task",
    after: {
      reason: input.reason,
      assigned: results.length,
      skipped: skipped.length,
      assignments: results.map((result) => ({
        taskId: result.taskId.toString(),
        moderator: moderatorIdToName.get(result.matchedModeratorId.toString()) ?? "未知",
        score: result.score,
      })),
    },
    reason: input.reason,
  });

  return {
    assigned: results.map((result) => ({
      taskId: result.taskId,
      moderator: moderatorIdToName.get(result.matchedModeratorId.toString()) ?? "未知",
      score: result.score,
      factors: result.factors,
    })),
    skipped,
  };
}
