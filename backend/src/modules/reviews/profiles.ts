import type { Prisma, ReviewStatus, TempAssignmentStatus } from "@prisma/client";
import { DISPATCH_STATS_WINDOW_MS, DISPATCH_PROFILE_CACHE_TTL_SECONDS } from "../../config/constants";
import { prisma } from "../../db/prisma";
import { redis } from "../../db/redis";
import { logger } from "../../utils/logger";
import type { CategoryStat } from "./dispatch-score";

/**
 * 审核员画像与临时加派状态的读写。
 *
 * 画像里的统计字段不是实时 COUNT 出来的——派单接口每次领取都要算一遍，
 * 实时聚合会把 review_tasks 打成热点。这里维护滚动快照：
 * - 每次审核决策后增量更新 decidedCount / approvedCount / categoryStats；
 * - 每天有一次兜底重算（rebuildModeratorStats），防止窗口外数据长期滞留。
 */

const PROFILE_CACHE_KEY = "psdm:dispatch:profiles";

export interface ModeratorProfileView {
  userId: bigint;
  decidedCount: number;
  approvedCount: number;
  categoryStats: Record<string, CategoryStat>;
  categoryWeights: Record<string, number>;
  capacityFactor: number;
  dispatchEnabled: boolean;
  temporary: boolean;
}

function normalizeCategoryStats(value: Prisma.JsonValue): Record<string, CategoryStat> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, CategoryStat> = {};
  for (const [code, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<CategoryStat>;
    const decided = typeof entry.decided === "number" ? Math.max(0, Math.trunc(entry.decided)) : 0;
    const approved = typeof entry.approved === "number" ? Math.max(0, Math.trunc(entry.approved)) : 0;
    if (decided > 0) result[code] = { decided, approved: Math.min(approved, decided) };
  }
  return result;
}

function normalizeWeights(value: Prisma.JsonValue): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [code, weight] of Object.entries(value as Record<string, unknown>)) {
    if (typeof weight === "number" && Number.isFinite(weight)) {
      result[code] = Math.max(0, Math.min(2, weight));
    }
  }
  return result;
}

async function loadActiveTempUserIds(): Promise<Set<string>> {
  try {
    const rows = await prisma.tempAssignment.findMany({
      where: { status: "active", expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId.toString()));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "临时加派名单读取失败，按非临时处理");
    return new Set();
  }
}

interface CachedProfiles {
  fetchedAt: number;
  // userId 在缓存里以字符串存放（BigInt 不能直接 JSON 序列化）
  profiles: Array<Omit<ModeratorProfileView, "userId"> & { userId: string }>;
}

/**
 * 读取可参与派单的全部审核员画像（含临时加派人员）。
 * 短 TTL 缓存：派单打分是高频读，60 秒内的画像陈旧度可接受，
 * 决策后调用 invalidateProfileCache 主动刷新。
 *
 * 以 users 表为基表左连接画像：审核员可能先于画像行存在
 * （老数据、被直接授予 moderator 角色的账号），这种情况按默认画像处理，
 * 不能因为缺一行 profile 就把人从派单名单里漏掉。
 */
export async function getDispatchProfiles(): Promise<ModeratorProfileView[]> {
  try {
    const cached = await redis.get(PROFILE_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedProfiles;
      return parsed.profiles.map((profile) => ({ ...profile, userId: BigInt(profile.userId) }));
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "画像缓存读取失败，回源数据库");
  }

  const tempIds = await loadActiveTempUserIds();
  const users = await prisma.user.findMany({
    where: {
      status: "active",
      OR: [
        { role: { in: ["moderator", "admin"] } },
        { id: { in: [...tempIds].map((value) => BigInt(value)) } },
      ],
    },
    include: { moderatorProfile: true },
  });

  const result: ModeratorProfileView[] = users
    .filter((user) => user.moderatorProfile?.dispatchEnabled ?? true)
    .map((user) => ({
      userId: user.id,
      decidedCount: user.moderatorProfile?.decidedCount ?? 0,
      approvedCount: user.moderatorProfile?.approvedCount ?? 0,
      categoryStats: normalizeCategoryStats(user.moderatorProfile?.categoryStats ?? {}),
      categoryWeights: normalizeWeights(user.moderatorProfile?.categoryWeights ?? {}),
      capacityFactor: user.moderatorProfile?.capacityFactor ?? 1,
      dispatchEnabled: user.moderatorProfile?.dispatchEnabled ?? true,
      temporary: tempIds.has(user.id.toString()),
    }));

  try {
    const payload: CachedProfiles = {
      fetchedAt: Date.now(),
      profiles: result.map((profile) => ({ ...profile, userId: profile.userId.toString() })),
    };
    await redis.set(PROFILE_CACHE_KEY, JSON.stringify(payload), "EX", DISPATCH_PROFILE_CACHE_TTL_SECONDS);
  } catch {
    // Redis 不可用时每次回源，功能不受影响
  }

  return result;
}

export async function invalidateProfileCache(): Promise<void> {
  try {
    await redis.del(PROFILE_CACHE_KEY);
  } catch {
    // 缓存失效失败不影响主流程，最多 60 秒陈旧
  }
}

/** 确保画像行存在（新审核员首次派单 / 首次决策时调用） */
export async function ensureModeratorProfile(userId: bigint): Promise<void> {
  await prisma.moderatorProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function updateModeratorConfig(
  userId: bigint,
  config: { categoryWeights?: Record<string, number>; capacityFactor?: number; dispatchEnabled?: boolean },
) {
  await ensureModeratorProfile(userId);
  const updated = await prisma.moderatorProfile.update({
    where: { userId },
    data: {
      categoryWeights:
        config.categoryWeights === undefined ? undefined : (config.categoryWeights as Prisma.InputJsonValue),
      capacityFactor: config.capacityFactor,
      dispatchEnabled: config.dispatchEnabled,
    },
    include: { user: { select: { uuid: true, nickname: true, role: true } } },
  });
  await invalidateProfileCache();
  return updated;
}

/**
 * 一次审核决策后增量更新画像。
 * approved = 通过（含申诉改判通过）；驳回 / 要求修改都计入 decided 但不计 approved。
 */
export async function recordDecisionStats(params: {
  moderatorId: bigint;
  categoryCode: string;
  approved: boolean;
}): Promise<void> {
  await ensureModeratorProfile(params.moderatorId);
  const profile = await prisma.moderatorProfile.findUnique({
    where: { userId: params.moderatorId },
    select: { categoryStats: true },
  });
  const stats = normalizeCategoryStats(profile?.categoryStats ?? {});
  const entry = stats[params.categoryCode] ?? { decided: 0, approved: 0 };
  entry.decided += 1;
  if (params.approved) entry.approved += 1;
  stats[params.categoryCode] = entry;

  await prisma.moderatorProfile.update({
    where: { userId: params.moderatorId },
    data: {
      decidedCount: { increment: 1 },
      approvedCount: { increment: params.approved ? 1 : 0 },
      categoryStats: stats as unknown as Prisma.InputJsonValue,
      statsUpdatedAt: new Date(),
    },
  });
  await invalidateProfileCache();
}

/**
 * 兜底重算：按滚动窗口从 review_tasks 重新统计全部有决策记录的审核员。
 * 每天由 worker 调一次，清掉滑出窗口的历史对画像的影响。
 */
export async function rebuildModeratorStats(now: Date = new Date()): Promise<{ moderators: number }> {
  const since = new Date(now.getTime() - DISPATCH_STATS_WINDOW_MS);
  const APPROVED_STATUSES: ReviewStatus[] = ["approved", "appeal_approved"];

  const rows = await prisma.reviewTask.groupBy({
    by: ["decidedBy"],
    where: { decidedBy: { not: null }, decidedAt: { gte: since } },
    _count: { _all: true },
  });

  for (const row of rows) {
    const moderatorId = row.decidedBy;
    if (moderatorId === null) continue;

    const approved = await prisma.reviewTask.count({
      where: { decidedBy: moderatorId, decidedAt: { gte: since }, status: { in: APPROVED_STATUSES } },
    });

    // Prisma 不能直接按关联表字段 groupBy，分类维度走一条原生 SQL
    const categoryRows = await prisma.$queryRaw<Array<{ code: string; status: string; count: bigint }>>`
      SELECT c.code AS code, rt.status AS status, COUNT(*)::bigint AS count
      FROM review_tasks rt
      JOIN spots s ON s.id = rt.spot_id
      JOIN categories c ON c.id = s.category_id
      WHERE rt.decided_by = ${moderatorId} AND rt.decided_at >= ${since}
      GROUP BY c.code, rt.status
    `;

    const categoryStats: Record<string, CategoryStat> = {};
    for (const item of categoryRows) {
      const entry = categoryStats[item.code] ?? { decided: 0, approved: 0 };
      const count = Number(item.count);
      entry.decided += count;
      if (APPROVED_STATUSES.includes(item.status as ReviewStatus)) entry.approved += count;
      categoryStats[item.code] = entry;
    }

    await ensureModeratorProfile(moderatorId);
    await prisma.moderatorProfile.update({
      where: { userId: moderatorId },
      data: {
        decidedCount: row._count._all,
        approvedCount: approved,
        categoryStats: categoryStats as unknown as Prisma.InputJsonValue,
        statsUpdatedAt: now,
      },
    });
  }

  await invalidateProfileCache();
  return { moderators: rows.length };
}

export async function listTempAssignments(status?: TempAssignmentStatus) {
  return prisma.tempAssignment.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      user: { select: { uuid: true, nickname: true, role: true, status: true } },
      grantedByUser: { select: { nickname: true } },
    },
  });
}
