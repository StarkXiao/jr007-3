import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 加权派单 + 临时加派接管积压的端到端验证。
// 需要真实数据库与 Redis：docker compose up -d postgres redis。
let app: Express;
let adminToken = "";
let modToken = "";
let tempToken = "";
let contributorToken = "";

const suffix = Date.now().toString(36);
const adminEmail = `dispatch-admin-${suffix}@example.com`;
const modEmail = `dispatch-mod-${suffix}@example.com`;
const tempEmail = `dispatch-temp-${suffix}@example.com`;
const contributorEmail = `dispatch-contrib-${suffix}@example.com`;
const password = "Str0ngPass1";

const createdUserEmails = [adminEmail, modEmail, tempEmail, contributorEmail];

async function login(account: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ account, password })
    .expect(200);
  return response.body.data.accessToken as string;
}

async function submitSpot(token: string, title: string): Promise<string> {
  const created = await request(app)
    .post("/api/v1/spots")
    .set("Authorization", `Bearer ${token}`)
    .send({
      categoryCode: "bench",
      title,
      attributes: { has_backrest: true, condition: "good", count: 2 },
      lat: 30.1 + Math.random() * 0.01,
      lng: 120.5 + Math.random() * 0.01,
      mediaUuids: [],
    })
    .expect(201);

  const submitted = await request(app)
    .post(`/api/v1/spots/${created.body.data.uuid}/submit`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  return submitted.body.data.taskId as string;
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  for (const [email, nickname] of [
    [adminEmail, `派单管理员${suffix.slice(-4)}`],
    [modEmail, `派单审核员${suffix.slice(-4)}`],
    [tempEmail, `临时人手${suffix.slice(-4)}`],
    [contributorEmail, `派单贡献者${suffix.slice(-4)}`],
  ] as const) {
    await request(app)
      .post("/api/v1/auth/register")
      .send({ email, password, nickname })
      .expect(201);
  }

  await prisma.user.update({ where: { email: adminEmail }, data: { role: "admin" } });
  await prisma.user.update({ where: { email: modEmail }, data: { role: "moderator" } });

  adminToken = await login(adminEmail);
  modToken = await login(modEmail);
  contributorToken = await login(contributorEmail);
}, 60000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { in: createdUserEmails } },
    select: { id: true },
  });
  const ids = users.map((item) => item.id);

  if (ids.length > 0) {
    await prisma.tempAssignment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.moderatorProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.comment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("加权派单", () => {
  it("智能派单会锁住一条待审任务给审核员", async () => {
    await submitSpot(contributorToken, `派单测试长椅${suffix.slice(-4)}A`);

    const response = await request(app)
      .post("/api/v1/moderation/dispatch/next")
      .set("Authorization", `Bearer ${modToken}`)
      .send({})
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(typeof response.body.data.taskId).toBe("string");
    expect(response.body.data.score).toBeGreaterThan(0);
    expect(response.body.data.factors).toBeTruthy();

    // 任务确实被锁住并派给了该审核员
    const task = await prisma.reviewTask.findUniqueOrThrow({
      where: { id: BigInt(response.body.data.taskId) },
    });
    const mod = await prisma.user.findUniqueOrThrow({ where: { email: modEmail } });
    expect(task.status).toBe("in_review");
    expect(task.assignedTo).toBe(mod.id);
    expect(task.lockedUntil).not.toBeNull();
  });

  it("普通用户不能调用派单接口", async () => {
    await request(app)
      .post("/api/v1/moderation/dispatch/next")
      .set("Authorization", `Bearer ${contributorToken}`)
      .send({})
      .expect(403);
  });

  it("画像面板返回审核员的通过率与分类统计", async () => {
    const response = await request(app)
      .get("/api/v1/moderation/dispatch/moderators")
      .set("Authorization", `Bearer ${modToken}`)
      .expect(200);

    expect(Array.isArray(response.body.data.items)).toBe(true);
    expect(response.body.data.items.length).toBeGreaterThan(0);
  });
});

describe("临时加派与接管积压", () => {
  let batchId = "";
  let tempUuid = "";

  it("加派前提权前的普通用户无法访问审核队列", async () => {
    tempToken = await login(tempEmail);
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tempToken}`)
      .expect(200);
    tempUuid = me.body.data.user.uuid;

    await request(app)
      .get("/api/v1/moderation/queue")
      .set("Authorization", `Bearer ${tempToken}`)
      .expect(403);
  });

  it("管理员加派后，普通用户临时获得审核权限", async () => {
    const response = await request(app)
      .post("/api/v1/admin/dispatch/temp-assignments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userUuid: tempUuid, hours: 8, reason: "集成测试：节假日积压加派" })
      .expect(201);

    expect(response.body.data.roleChanged).toBe(true);
    batchId = response.body.data.batchId;

    // 鉴权以回库角色为准，旧 token 无需刷新即可访问审核接口
    await request(app)
      .get("/api/v1/moderation/queue")
      .set("Authorization", `Bearer ${tempToken}`)
      .expect(200);
  });

  it("重复加派同一用户会被拒绝", async () => {
    const response = await request(app)
      .post("/api/v1/admin/dispatch/temp-assignments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userUuid: tempUuid, hours: 2, reason: "重复加派" })
      .expect(409);
    expect(response.body.error.code).toBe("TEMP_ASSIGNMENT_INVALID");
  });

  it("管理员可以把超时积压批量分配给全部审核员（含临时人手）", async () => {
    // 再造两条积压，并直接把 SLA 时间改成过去
    const taskIds: string[] = [];
    for (const suffix2 of ["B", "C"]) {
      taskIds.push(await submitSpot(contributorToken, `派单测试长椅${suffix.slice(-4)}${suffix2}`));
    }
    await prisma.reviewTask.updateMany({
      where: { id: { in: taskIds.map((id) => BigInt(id)) } },
      data: { slaDueAt: new Date(Date.now() - 3600_000) },
    });

    const response = await request(app)
      .post("/api/v1/admin/dispatch/takeover")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ overdueOnly: true, limit: 10, reason: "集成测试：批量接管超时积压" })
      .expect(200);

    expect(response.body.data.assigned.length).toBeGreaterThanOrEqual(2);
    const assignees = response.body.data.assigned.map((item: { moderator: string }) => item.moderator);
    expect(assignees.length).toBeGreaterThan(0);

    // 任务已脱离 pending
    const remaining = await prisma.reviewTask.count({
      where: { id: { in: taskIds.map((id) => BigInt(id)) }, status: "pending" },
    });
    expect(remaining).toBe(0);
  });

  it("非管理员不能批量接管", async () => {
    await request(app)
      .post("/api/v1/admin/dispatch/takeover")
      .set("Authorization", `Bearer ${modToken}`)
      .send({ reason: "越权尝试" })
      .expect(403);
  });

  it("撤销加派后恢复原角色，临时人手失去审核权限", async () => {
    await request(app)
      .post(`/api/v1/admin/dispatch/temp-assignments/${batchId}/revoke`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const tempUser = await prisma.user.findUniqueOrThrow({ where: { email: tempEmail } });
    expect(tempUser.role).toBe("user");

    await request(app)
      .get("/api/v1/moderation/queue")
      .set("Authorization", `Bearer ${tempToken}`)
      .expect(403);

    const assignment = await prisma.tempAssignment.findUniqueOrThrow({ where: { batchId } });
    expect(assignment.status).toBe("revoked");
  });

  it("到期未撤销的加派在下一次鉴权请求时被自动回收", async () => {
    // 再加派一次，然后直接把到期时间改到过去
    const created = await request(app)
      .post("/api/v1/admin/dispatch/temp-assignments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userUuid: tempUuid, hours: 8, reason: "集成测试：到期回收" })
      .expect(201);

    await prisma.tempAssignment.update({
      where: { batchId: created.body.data.batchId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // 任意鉴权请求都会触发兜底回收
    await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tempToken}`)
      .expect(200);

    const tempUser = await prisma.user.findUniqueOrThrow({ where: { email: tempEmail } });
    expect(tempUser.role).toBe("user");

    const assignment = await prisma.tempAssignment.findUniqueOrThrow({
      where: { batchId: created.body.data.batchId },
    });
    expect(assignment.status).toBe("expired");
  });
});
