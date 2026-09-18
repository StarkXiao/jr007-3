import { Prisma } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  DISPATCH_BATCH_SIZE,
  DISPATCH_STATS_WINDOW_MS,
  DISPATCH_SURGE_BOOST_MAX,
  DISPATCH_SURGE_BOOST_MIN,
  DISPATCH_SURGE_MAX_HOURS,
  ERROR_CODES,
  REVIEW_LOCK_MS,
} from "../../config/constants";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { recordAudit } from "../../services/audit";
import { notify } from "../../services/notify";
import { logger } from "../../utils/logger";
import type { ModeratorStatInput } from "./dispatchWeights";
import { moderatorWeight, pickWeighted } from "./dispatchWeights";
import type { AuthUser } from "../../types/auth";

// ------------------------------------------------------------------ 审核员画像

export async function getOrCreateProfile(userId: bigint) {
  const existing = await prisma.moderatorProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.moderatorProfile.create({ data: { userId } });
}

export async function getMyDispatchProfile(user: AuthUser) {
  const profile = await getOrCreateProfile(user.id);
  const stats = await loadModeratorStats([user.id]);
  return serializeProfile(profile, stats.get(user.id.toString()));
}

export async function updateMyPreferences(
  user: AuthUser,
  payload: { preferredCategories?: string[]; maxActive?: number; paused?: boolean },
) {
  const profile = await getOrCreateProfile(user.id);

  let preferred = profile.preferredCategories;
  if (payload.preferredCategories) {
    preferred = await normalizeCategoryCodes(payload.preferredCategories);
  }

  const maxActive =
    payload.maxActive !== undefined
      ? Math.min(50, Math.max(1, Math.trunc(payload.maxActive)))
      : profile.maxActive;

  const pausedAt =
    payload.paused === undefined
      ? profile.dispatchPausedAt
      : payload.paused
        ? (profile.dispatchPausedAt ?? new Date())
        : null;

  const updated = await prisma.moderatorProfile.update({
    where: { userId: user.id },
    data: {
      preferredCategories: preferred,
      maxActive,
      dispatchPausedAt: pausedAt,
    },
  });

  await recordAudit({
    actorId: user.id,
    action: AUDIT_ACTIONS.DISPATCH_PREFERENCE_UPDATE,
    targetType: "moderator_profile",
    targetId: user.id,
    after: { preferredCategories: preferred, maxActive, paused: pausedAt !== null },
  });

  const stats = await loadModeratorStats([user.id]);
  return serializeProfile(updated, stats.get(user.id.toString()));
}

async function normalizeCategoryCodes(codes: string[]): Promise<string[]> {
  const unique = [...new Set(codes.map((code) => code.trim()).filter(Boolean))].slice(0, 20);
  if (unique.length === 0) return [];
  const found = await prisma.category.findMany({
    where: { code: { in: unique } },
    select: { code: true },
  });
  return found.map((category) => category.code);
}

// ------------------------------------------------------------------ 历史统计

interface StatRow {
  userId: bigint;
  total: bigint;
  approved: bigint;
  categoryCode: string | null;
  categoryCount: bigint;
}

/**
 * 近 90 天决策统计，一条 SQL 聚合：总数、通过数、各分类处理数。
 * 申诉改判通过也算通过；要求修改 / 驳回都算非通过。
 */
async function loadModeratorStats(userIds: bigint[]): Promise<Map<string, ModeratorStatInput>> {
  if (userIds.length === 0) return new Map();
  const since = new Date(Date.now() - DISPATCH_STATS_WINDOW_MS);

  const rows = await prisma.$queryRaw<StatRow[]>`
    SELECT t.decided_by AS "userId",
           COUNT(*)::BIGINT AS total,
           COUNT(*) FILTER (WHERE t.status IN ('approved', 'appeal_approved'))::BIGINT AS approved,
           c.code AS "categoryCode",
           COUNT(*) FILTER (WHERE c.code IS NOT NULL)::BIGINT AS "categoryCount"
    FROM review_tasks t
    JOIN spots s ON s.id = t.spot_id
    JOIN categories c ON c.id = s.category_id
    WHERE t.decided_by IN (${Prisma.join(userIds)})
      AND t.decided_at IS NOT NULL
      AND t.decided_at >= ${since}
    GROUP BY t.decided_by, c.code
  `;

  const map = new Map<string, ModeratorStatInput>();
  for (const userId of userIds) {
    map.set(userId.toString(), { userId, total: 0, approved: 0, categoryCounts: new Map() });
  }
  for (const row of rows) {
    const entry = map.get(row.userId.toString())!;
    // 每个分类分组都会带一份 total/approved，分组间相同
    entry.total = Number(row.total);
    entry.approved = Number(row.approved);
    if (row.categoryCode) entry.categoryCounts.set(row.categoryCode, Number(row.categoryCount));
  }
  return map;
}

async function loadActiveSurges(now: Date) {
  const surges = await prisma.dispatchSurge.findMany({
    where: { endedAt: null, expiresAt: { gt: now } },
  });
  const byUser = new Map<
    string,
    { id: bigint; boostFactor: number; categoryCodes: string[] }
  >();
  for (const surge of surges) {
    byUser.set(surge.userId.toString(), {
      id: surge.id,
      boostFactor: surge.boostFactor,
      categoryCodes: surge.categoryCodes,
    });
  }
  return byUser;
}

// ------------------------------------------------------------------ 加权派单

interface PendingTaskRow {
  id: bigint;
  spotId: bigint;
  priority: number;
  categoryCode: string;
  ownerId: bigint;
  slaDueAt: Date;
}

/** 取待派任务：无主的 pending，或锁已过期、原审核员无法继续持有的 in_review */
async function loadDispatchableTasks(take: number): Promise<PendingTaskRow[]> {
  const now = new Date();
  return prisma.$queryRaw<PendingTaskRow[]>`
    SELECT t.id, t.spot_id AS "spotId", t.priority, c.code AS "categoryCode",
           s.owner_id AS "ownerId", t.sla_due_at AS "slaDueAt"
    FROM review_tasks t
    JOIN spots s ON s.id = t.spot_id
    JOIN categories c ON c.id = s.category_id
    WHERE t.decided_at IS NULL
      AND t.status IN ('pending', 'in_review')
      AND (t.assigned_to IS NULL OR t.locked_until < ${now})
    ORDER BY t.priority DESC, t.sla_due_at ASC, t.id ASC
    LIMIT ${take}
  `;
}

interface Candidate {
  userId: bigint;
  weight: number;
}

/**
 * 加权派单主流程。
 *
 * @param opts.limit 本轮最多派多少条
 * @param opts.assignee 只为该审核员找任务（智能领单）；不传则为全员自动派单
 * @returns 实际派出的任务数与任务 id
 */
export async function dispatchWeighted(
  opts: { limit?: number; assignee?: bigint; source?: "auto" | "claim" } = {},
): Promise<{ assigned: Array<{ taskId: bigint; userId: bigint }> }> {
  const now = new Date();
  const limit = Math.min(opts.limit ?? DISPATCH_BATCH_SIZE, DISPATCH_BATCH_SIZE);

  const tasks = await loadDispatchableTasks(limit);
  if (tasks.length === 0) return { assigned: [] };

  // 候选审核员：角色达标、账号正常、未暂停派单
  const users = await prisma.user.findMany({
    where: {
      role: { in: ["moderator", "admin"] },
      status: "active",
      ...(opts.assignee ? { id: opts.assignee } : {}),
    },
    include: { moderatorProfile: true },
  });
  if (users.length === 0) return { assigned: [] };

  const [stats, surges] = await Promise.all([
    loadModeratorStats(users.map((user) => user.id)),
    loadActiveSurges(now),
  ]);

  // 每人当前在手工单数
  const activeGroups = await prisma.reviewTask.groupBy({
    by: ["assignedTo"],
    where: {
      assignedTo: { in: users.map((user) => user.id) },
      status: "in_review",
      decidedAt: null,
      OR: [{ lockedUntil: null }, { lockedUntil: { gt: now } }],
    },
    _count: { _all: true },
  });
  const activeCount = new Map<string, number>();
  for (const group of activeGroups) {
    if (group.assignedTo !== null) activeCount.set(group.assignedTo.toString(), group._count._all);
  }

  const assigned: Array<{ taskId: bigint; userId: bigint }> = [];
  // 智能领单时，一旦该审核员在单任务上达到上限就可以提前结束
  for (const task of tasks) {
    const candidates: Candidate[] = [];

    for (const user of users) {
      // 自己不能审自己，这条规则在派单阶段就要挡住，不能等点"通过"才报错
      if (user.id === task.ownerId) continue;

      const profile = user.moderatorProfile;
      if (profile?.dispatchPausedAt) continue;

      const maxActive = profile?.maxActive ?? 10;
      const current = activeCount.get(user.id.toString()) ?? 0;
      const surge = surges.get(user.id.toString());
      // 加派限定了分类范围：不匹配时该审核员在本任务上不加乘，但仍可按常规权重参与
      const surgeFactor =
        surge && (surge.categoryCodes.length === 0 || surge.categoryCodes.includes(task.categoryCode))
          ? surge.boostFactor
          : 1;

      const weight = moderatorWeight(
        {
          stat: stats.get(user.id.toString()) ?? {
            userId: user.id,
            total: 0,
            approved: 0,
            categoryCounts: new Map(),
          },
          preferredCategories: profile?.preferredCategories ?? [],
          activeCount: current,
          maxActive,
          manualFactor: profile?.weightFactor ?? 1,
          surgeFactor,
        },
        task.categoryCode,
      );
      if (weight > 0) candidates.push({ userId: user.id, weight });
    }

    const chosenId = pickWeighted(candidates.map((candidate) => ({ value: candidate.userId, weight: candidate.weight })));
    if (chosenId === null) continue;

    // 条件 UPDATE 兜底并发：两个派单进程同时选中同一任务时只有一个成功
    const lockUntil = new Date(now.getTime() + REVIEW_LOCK_MS);
    const updated = await prisma.reviewTask.updateMany({
      where: {
        id: task.id,
        decidedAt: null,
        status: { in: ["pending", "in_review"] },
        OR: [{ assignedTo: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        assignedTo: chosenId,
        lockedUntil: lockUntil,
        status: "in_review",
        dispatchMeta: {
          source: opts.source ?? "auto",
          mode: "weighted",
          surge: surges.get(chosenId.toString())?.id ?? null,
          dispatchedAt: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    if (updated.count === 0) continue;

    assigned.push({ taskId: task.id, userId: chosenId });
    activeCount.set(chosenId.toString(), (activeCount.get(chosenId.toString()) ?? 0) + 1);
  }

  if (assigned.length > 0) {
    // 每个被派到任务的审核员只通知一次，告诉 TA 这一轮共分到几条
    const byUser = new Map<string, bigint[]>();
    for (const item of assigned) {
      const list = byUser.get(item.userId.toString()) ?? [];
      list.push(item.taskId);
      byUser.set(item.userId.toString(), list);
    }
    for (const [userId, taskIds] of byUser) {
      await notify({
        userId: BigInt(userId),
        type: "review_assigned",
        title: "系统给你派了新的审核任务",
        body: `本轮加权派单为你分配了 ${taskIds.length} 条待审任务，锁单 30 分钟，请及时处理。`,
        payload: { taskIds: taskIds.map((id) => id.toString()), count: taskIds.length },
      });
    }
    logger.info({ assigned: assigned.length }, "加权派单完成");
  }

  return { assigned };
}

/** 审核员点"智能领单"：按权重为 TA 取一条最合适的任务 */
export async function claimNextTask(moderator: AuthUser) {
  const { assigned } = await dispatchWeighted({ limit: 1, assignee: moderator.id, source: "claim" });
  if (assigned.length === 0) {
    throw AppError.conflict(
      ERROR_CODES.REVIEW_NOTHING_TO_CLAIM,
      "当前没有适合你的待审任务（可能队列已空，或你的在手工单已达上限）",
    );
  }

  const taskId = assigned[0].taskId;
  await recordAudit({
    actorId: moderator.id,
    action: AUDIT_ACTIONS.REVIEW_CLAIM,
    targetType: "review_task",
    targetId: taskId,
    after: { mode: "weighted" },
  });

  return { taskId, lockedUntil: new Date(Date.now() + REVIEW_LOCK_MS) };
}

// ------------------------------------------------------------------ 临时加派

interface StartSurgeInput {
  userUuids: string[];
  hours: number;
  boostFactor?: number;
  categoryCodes?: string[];
  reason?: string;
}

/**
 * 管理员临时加派：
 * 1. 把选中的普通用户提升为 moderator（已是审核角色则跳过）；
 * 2. 建立加派批次，期间这些人在加权派单里拿 boostFactor 倍倾斜；
 * 3. 立即跑一轮派单，让加派人手当场接管积压。
 */
export async function startSurge(admin: AuthUser, payload: StartSurgeInput) {
  const hours = Math.min(Math.max(1, Math.trunc(payload.hours)), DISPATCH_SURGE_MAX_HOURS);
  const boostFactor = Math.min(
    DISPATCH_SURGE_BOOST_MAX,
    Math.max(DISPATCH_SURGE_BOOST_MIN, payload.boostFactor ?? 2),
  );
  const reason = payload.reason?.trim().slice(0, 200) || null;

  const categoryCodes = payload.categoryCodes
    ? await normalizeCategoryCodes(payload.categoryCodes)
    : [];

  const users = await prisma.user.findMany({
    where: { uuid: { in: payload.userUuids } },
    select: { id: true, uuid: true, nickname: true, role: true, status: true },
  });
  if (users.length === 0) throw AppError.badRequest("没有找到指定的用户");
  const invalid = users.filter((user) => user.status !== "active");
  if (invalid.length > 0) {
    throw AppError.badRequest(`以下账号状态异常，不能加派：${invalid.map((u) => u.nickname).join("、")}`);
  }

  const expiresAt = new Date(Date.now() + hours * 3600000);
  const created: Array<{ surgeId: bigint; userId: bigint; roleChanged: boolean }> = [];

  for (const user of users) {
    // 已在生效加派中则不重复建档，旧批次自然到期即可
    const active = await prisma.dispatchSurge.findFirst({
      where: { userId: user.id, endedAt: null, expiresAt: { gt: new Date() } },
    });
    if (active) continue;

    const roleChanged = user.role === "user" || user.role === "visitor";
    const surge = await prisma.dispatchSurge.create({
      data: {
        userId: user.id,
        createdBy: admin.id,
        boostFactor,
        categoryCodes,
        reason,
        rolePromoted: roleChanged,
        expiresAt,
      },
    });

    if (roleChanged) {
      await prisma.user.update({ where: { id: user.id }, data: { role: "moderator" } });
      await getOrCreateProfile(user.id);
    }

    await recordAudit({
      actorId: admin.id,
      action: AUDIT_ACTIONS.DISPATCH_SURGE_START,
      targetType: "user",
      targetId: user.id,
      after: {
        surgeId: surge.id.toString(),
        hours,
        boostFactor,
        categoryCodes,
        roleChanged,
      },
      reason: reason ?? undefined,
    });

    await notify({
      userId: user.id,
      type: "surge_started",
      title: "你已被临时加派为审核支援",
      body:
        `管理员因审核积压临时邀请你支援 ${hours} 小时` +
        (categoryCodes.length > 0 ? `（分类：${categoryCodes.join("、")}）` : "") +
        `。到期后权限自动收回。${reason ? `原因：${reason}` : ""}`,
      payload: { surgeId: surge.id.toString(), expiresAt: expiresAt.toISOString() },
    });

    created.push({ surgeId: surge.id, userId: user.id, roleChanged });
  }

  // 立即接管积压
  const { assigned } = await dispatchWeighted({ source: "auto" });

  return {
    surgeCount: created.length,
    rolePromoted: created.filter((item) => item.roleChanged).length,
    expiresAt,
    dispatchedTasks: assigned.length,
    surgeIds: created.map((item) => item.surgeId.toString()),
  };
}

/**
 * 结束加派。
 * @param reassign true 时把该支援者手里未决策的任务收回待派池并立刻重新派给其他人；
 *                 false 时保留其在锁内的任务（仍可手动处理，只是不再收到新单）。
 */
export async function endSurge(
  admin: AuthUser,
  surgeId: bigint,
  payload: { reassign?: boolean; reason?: string } = {},
) {
  const surge = await prisma.dispatchSurge.findUnique({ where: { id: surgeId } });
  if (!surge) throw AppError.notFound("加派批次不存在");
  if (surge.endedAt !== null) throw AppError.conflict(ERROR_CODES.REVIEW_SURGE_ENDED, "该加派批次已经结束");

  const now = new Date();

  let reassigned = 0;
  if (payload.reassign) {
    const result = await prisma.reviewTask.updateMany({
      where: {
        assignedTo: surge.userId,
        decidedAt: null,
        status: { in: ["pending", "in_review"] },
      },
      data: { assignedTo: null, lockedUntil: null, status: "pending" },
    });
    reassigned = result.count;
  }

  // 加派时被临时提升、且没有其他生效加派的用户，恢复为普通用户
  let roleDemoted = false;
  if (surge.rolePromoted) {
    const otherActive = await prisma.dispatchSurge.count({
      where: { userId: surge.userId, id: { not: surge.id }, endedAt: null, expiresAt: { gt: now } },
    });
    if (otherActive === 0) {
      await prisma.user.update({ where: { id: surge.userId }, data: { role: "user" } });
      roleDemoted = true;
    }
  }

  await prisma.dispatchSurge.update({
    where: { id: surge.id },
    data: { endedAt: now, endedBy: admin.id },
  });

  await recordAudit({
    actorId: admin.id,
    action: AUDIT_ACTIONS.DISPATCH_SURGE_END,
    targetType: "dispatch_surge",
    targetId: surge.id,
    after: { reassign: payload.reassign ?? false, reassigned, roleDemoted },
    reason: payload.reason,
  });

  await notify({
    userId: surge.userId,
    type: "surge_ended",
    title: "你的临时审核支援已结束",
    body: payload.reassign
      ? `管理员已结束本次加派，你手头未完成的 ${reassigned} 条任务已转交其他审核员。`
      : "管理员已结束本次加派，你将不再收到新的派单；锁单内的任务仍可处理完。",
    payload: { surgeId: surge.id.toString(), reassign: payload.reassign ?? false },
  });

  if (payload.reassign && reassigned > 0) {
    await dispatchWeighted({ source: "auto" });
  }

  return { ended: true as const, reassigned, roleDemoted };
}

/**
 * 定时巡检：
 * 1. 结束已到期但未显式关闭的加派批次，临时提升的用户降回普通角色；
 * 2. 把待派池中的任务按权重派出去。
 */
export async function expireSurgesAndDispatch(): Promise<{ expired: number; assigned: number }> {
  const now = new Date();
  const due = await prisma.dispatchSurge.findMany({
    where: { endedAt: null, expiresAt: { lte: now } },
  });

  let expired = 0;
  for (const surge of due) {
    // 到期自动结束：未完成任务留在待派池（锁 30 分钟，到期后下一轮派单自然回收）
    let demote = false;
    if (surge.rolePromoted) {
      const otherActive = await prisma.dispatchSurge.count({
        where: { userId: surge.userId, id: { not: surge.id }, endedAt: null, expiresAt: { gt: now } },
      });
      demote = otherActive === 0;
      if (demote) {
        await prisma.user.update({ where: { id: surge.userId }, data: { role: "user" } });
      }
    }
    await prisma.dispatchSurge.update({
      where: { id: surge.id },
      data: { endedAt: now },
    });
    await notify({
      userId: surge.userId,
      type: "surge_ended",
      title: "临时审核支援已到期",
      body: demote
        ? "你的加派时长已用完，审核权限已自动收回，感谢支援。"
        : "本次加派已到期，你将不再收到新的加派派单。",
      payload: { surgeId: surge.id.toString(), auto: true },
    });
    expired += 1;
  }

  const { assigned } = await dispatchWeighted({ source: "auto" });
  return { expired, assigned: assigned.length };
}

// ------------------------------------------------------------------ 派单总览

export async function dispatchOverview() {
  const now = new Date();
  const since = new Date(Date.now() - DISPATCH_STATS_WINDOW_MS);

  const [moderators, activeSurges, pendingCount, overdueCount, statsRows, activeGroups] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ["moderator", "admin"] }, status: "active" },
      include: { moderatorProfile: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.dispatchSurge.findMany({
      where: { endedAt: null, expiresAt: { gt: now } },
      include: { user: { select: { nickname: true, uuid: true } } },
      orderBy: { expiresAt: "asc" },
    }),
    prisma.reviewTask.count({ where: { status: "pending", decidedAt: null } }),
    prisma.reviewTask.count({
      where: { decidedAt: null, status: { in: ["pending", "in_review"] }, slaDueAt: { lt: now } },
    }),
    prisma.$queryRaw<
      Array<{ userId: bigint; total: bigint; approved: bigint }>
    >`
      SELECT decided_by AS "userId",
             COUNT(*)::BIGINT AS total,
             COUNT(*) FILTER (WHERE status IN ('approved', 'appeal_approved'))::BIGINT AS approved
      FROM review_tasks
      WHERE decided_at IS NOT NULL AND decided_at >= ${since}
      GROUP BY decided_by
    `,
    prisma.reviewTask.groupBy({
      by: ["assignedTo"],
      where: {
        status: "in_review",
        decidedAt: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { gt: now } }],
      },
      _count: { _all: true },
    }),
  ]);

  const statMap = new Map(statsRows.map((row) => [row.userId.toString(), row]));
  const activeMap = new Map(
    activeGroups.filter((group) => group.assignedTo !== null).map((group) => [group.assignedTo!.toString(), group._count._all]),
  );
  const surgeByUser = new Map(activeSurges.map((surge) => [surge.userId.toString(), surge]));

  return {
    windowDays: Math.round(DISPATCH_STATS_WINDOW_MS / 86400000),
    backlog: { pending: pendingCount, overdue: overdueCount },
    moderators: moderators.map((user) => {
      const row = statMap.get(user.id.toString());
      const total = row ? Number(row.total) : 0;
      const approved = row ? Number(row.approved) : 0;
      return {
        userId: user.uuid,
        nickname: user.nickname,
        role: user.role,
        paused: user.moderatorProfile?.dispatchPausedAt != null,
        preferredCategories: user.moderatorProfile?.preferredCategories ?? [],
        maxActive: user.moderatorProfile?.maxActive ?? 10,
        activeCount: activeMap.get(user.id.toString()) ?? 0,
        stats: {
          windowTotal: total,
          approved,
          approvalRate: total > 0 ? Number((approved / total).toFixed(3)) : null,
        },
        surge: (() => {
          const surge = surgeByUser.get(user.id.toString());
          return surge
            ? {
                id: surge.id.toString(),
                boostFactor: surge.boostFactor,
                categoryCodes: surge.categoryCodes,
                reason: surge.reason,
                expiresAt: surge.expiresAt,
              }
            : null;
        })(),
      };
    }),
    activeSurges: activeSurges.map((surge) => ({
      id: surge.id.toString(),
      user: { uuid: surge.user.uuid, nickname: surge.user.nickname },
      boostFactor: surge.boostFactor,
      categoryCodes: surge.categoryCodes,
      reason: surge.reason,
      expiresAt: surge.expiresAt,
    })),
  };
}

// ------------------------------------------------------------------ 序列化

function serializeProfile(
  profile: Prisma.ModeratorProfileGetPayload<Record<string, never>>,
  stat: ModeratorStatInput | undefined,
) {
  const total = stat?.total ?? 0;
  const approved = stat?.approved ?? 0;
  return {
    preferredCategories: profile.preferredCategories,
    maxActive: profile.maxActive,
    weightFactor: profile.weightFactor,
    paused: profile.dispatchPausedAt !== null,
    pausedAt: profile.dispatchPausedAt,
    stats: {
      windowDays: Math.round(DISPATCH_STATS_WINDOW_MS / 86400000),
      total,
      approved,
      approvalRate: total > 0 ? Number((approved / total).toFixed(3)) : null,
      categoryCounts: Object.fromEntries(stat?.categoryCounts ?? new Map()),
    },
  };
}
