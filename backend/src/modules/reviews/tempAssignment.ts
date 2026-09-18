import { randomUUID } from "node:crypto";
import { AUDIT_ACTIONS, ERROR_CODES, TEMP_ASSIGNMENT_MAX_HOURS } from "../../config/constants";
import { prisma } from "../../db/prisma";
import { AppError } from "../../utils/errors";
import { notify } from "../../services/notify";
import { recordAudit } from "../../services/audit";
import { invalidateProfileCache, ensureModeratorProfile } from "./profiles";
import type { AuthUser } from "../../types/auth";
import type { UserRole } from "@prisma/client";

/**
 * 临时加派：积压时管理员把普通用户临时提权为审核员。
 *
 * 设计要点：
 * - 提权就是把 users.role 改成 moderator，原角色存在 temp_assignments.original_role；
 *   到期 / 撤销时恢复。鉴权本来就每次请求回库读角色（见 middleware/auth.ts），
 *   所以不需要特殊的权限分支，提权即时生效。
 * - access token 里的 role 字段只用于日志展示，鉴权以回库结果为准。
 * - 同一个用户同一时间只允许一条 active 加派记录，续期 = 撤销旧的再开新的。
 * - 到期回收在 cleanup 定时任务里做，鉴权路径也做了兜底（loadUser 时顺手过期），
 *   worker 不在也不会让临时权限变成永久权限。
 */

export interface GrantTempAssignmentInput {
  userUuid: string;
  hours: number;
  reason: string;
  taskLimit?: number;
}

export async function grantTempAssignment(admin: AuthUser, input: GrantTempAssignmentInput) {
  if (input.hours < 1 || input.hours > TEMP_ASSIGNMENT_MAX_HOURS) {
    throw AppError.badRequest(`加派时长必须在 1–${TEMP_ASSIGNMENT_MAX_HOURS} 小时之间`);
  }
  if (input.taskLimit !== undefined && (input.taskLimit < 0 || input.taskLimit > 100)) {
    throw AppError.badRequest("接管任务数上限必须在 0–100 之间");
  }

  const user = await prisma.user.findUnique({
    where: { uuid: input.userUuid },
    select: { id: true, uuid: true, nickname: true, role: true, status: true },
  });
  if (!user) throw AppError.notFound("用户不存在");
  if (user.status !== "active") throw AppError.conflict(ERROR_CODES.TEMP_ASSIGNMENT_INVALID, "该用户当前状态不能参与审核");
  if (user.role === "admin") throw AppError.conflict(ERROR_CODES.TEMP_ASSIGNMENT_INVALID, "管理员本身已有审核权限，无需加派");

  const existing = await prisma.tempAssignment.findFirst({
    where: { userId: user.id, status: "active", expiresAt: { gt: new Date() } },
  });
  if (existing) {
    throw AppError.conflict(ERROR_CODES.TEMP_ASSIGNMENT_INVALID, "该用户已在加派期内，请先撤销或等其到期后再重新加派");
  }

  // 已经是正式审核员：只登记加派批次（用于批量接管配额），不再改角色
  const alreadyModerator = user.role === "moderator";
  const expiresAt = new Date(Date.now() + input.hours * 3600000);
  const batchId = randomUUID();

  const assignment = await prisma.$transaction(async (tx) => {
    const created = await tx.tempAssignment.create({
      data: {
        batchId,
        userId: user.id,
        grantedBy: admin.id,
        originalRole: user.role as UserRole,
        reason: input.reason,
        taskLimit: input.taskLimit ?? 0,
        expiresAt,
      },
    });

    if (!alreadyModerator) {
      await tx.user.update({ where: { id: user.id }, data: { role: "moderator" } });
    }
    await ensureModeratorProfile(user.id);
    return created;
  });

  await invalidateProfileCache();

  await recordAudit({
    actorId: admin.id,
    action: AUDIT_ACTIONS.REVIEW_TEMP_ASSIGN,
    targetType: "user",
    targetId: user.id,
    after: {
      batchId,
      hours: input.hours,
      taskLimit: input.taskLimit ?? 0,
      originalRole: user.role,
      expiresAt: expiresAt.toISOString(),
    },
    reason: input.reason,
  });

  await notify({
    userId: user.id,
    type: "report_result",
    title: "你已被临时加派为审核员",
    body: `${input.reason}。加派有效期至 ${expiresAt.toLocaleString("zh-CN")}，到期后权限自动收回。`,
    payload: { batchId, expiresAt: expiresAt.getTime() },
  });

  return {
    batchId,
    user: { uuid: user.uuid, nickname: user.nickname },
    originalRole: user.role,
    expiresAt,
    roleChanged: !alreadyModerator,
  };
}

/** 撤销加派：立即恢复原角色（正式审核员的加派撤销只关批次，不降权） */
export async function revokeTempAssignment(batchId: string, admin: AuthUser) {
  const assignment = await prisma.tempAssignment.findUnique({
    where: { batchId },
    include: { user: { select: { id: true, nickname: true, role: true } } },
  });
  if (!assignment) throw AppError.notFound("加派记录不存在");
  if (assignment.status !== "active") throw AppError.conflict(ERROR_CODES.TEMP_ASSIGNMENT_INVALID, "该加派批次已结束");

  await expireAssignment(assignment.id, "revoked");

  await recordAudit({
    actorId: admin.id,
    action: AUDIT_ACTIONS.REVIEW_TEMP_REVOKE,
    targetType: "user",
    targetId: assignment.userId,
    after: { batchId, restoredRole: assignment.originalRole },
  });

  return { batchId, status: "revoked" };
}

/**
 * 到期 / 撤销的统一回收逻辑。
 * 恢复角色时以加派开始时记录的 originalRole 为准；
 * 如果管理员在加派期间另外调整过角色（PATCH role 接口），
 * 这里不覆盖，避免把后来的正式任命降回普通用户。
 */
export async function expireAssignment(
  assignmentId: bigint,
  outcome: "expired" | "revoked",
): Promise<boolean> {
  const assignment = await prisma.tempAssignment.findUnique({
    where: { id: assignmentId },
    include: { user: { select: { id: true, role: true } } },
  });
  if (!assignment || assignment.status !== "active") return false;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.tempAssignment.update({
      where: { id: assignmentId },
      data: {
        status: outcome === "revoked" ? "revoked" : "expired",
        revokedAt: outcome === "revoked" ? now : null,
      },
    });

    // 只有角色仍然是 moderator（即加派之后没被另外调整过）才恢复原角色
    if (assignment.user.role === "moderator" && assignment.originalRole !== "moderator") {
      await tx.user.update({ where: { id: assignment.userId }, data: { role: assignment.originalRole } });
    }
  });

  await invalidateProfileCache();
  return true;
}

/**
 * 定时回收所有到期加派。返回回收条数。
 * cleanup / SLA 巡检都会调用，所以这里必须幂等。
 *
 * 鉴权中间件在每个认证请求上都会调用一次，因此先做一条廉价的 exists 查询，
 * 没有到期记录时直接返回，避免给每个请求平白增加事务开销。
 */
export async function expireDueTempAssignments(now: Date = new Date()): Promise<number> {
  // 先做一条走索引的廉价探测，没有到期记录时直接返回，
  // 避免给每个认证请求平白增加事务开销。
  const firstDue = await prisma.tempAssignment.findFirst({
    where: { status: "active", expiresAt: { lte: now } },
    select: { id: true },
  });
  if (!firstDue) return 0;

  const due = await prisma.tempAssignment.findMany({
    where: { status: "active", expiresAt: { lte: now } },
    select: { id: true, userId: true },
    take: 100,
  });

  let expired = 0;
  for (const assignment of due) {
    if (await expireAssignment(assignment.id, "expired")) expired += 1;
  }
  return expired;
}
