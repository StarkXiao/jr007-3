import { describe, expect, it } from "vitest";
import {
  categoryAffinityScore,
  expectedApprovalRate,
  moderatorApprovalRate,
  passRateFitScore,
  scoreTaskForModerator,
  taskUrgencyMultiplier,
  weightedPick,
  workloadScore,
  type ModeratorDispatchFeatures,
  type TaskDispatchFeatures,
} from "../../src/modules/reviews/dispatch-score";

function moderator(overrides: Partial<ModeratorDispatchFeatures> = {}): ModeratorDispatchFeatures {
  return {
    userId: 1n,
    decidedCount: 0,
    approvedCount: 0,
    categoryStats: {},
    categoryWeights: {},
    capacityFactor: 1,
    activeCount: 0,
    temporary: false,
    ...overrides,
  };
}

function task(overrides: Partial<TaskDispatchFeatures> = {}): TaskDispatchFeatures {
  return {
    submitterCreditScore: 100,
    categoryCode: "bench",
    overdue: false,
    priority: 0,
    ...overrides,
  };
}

describe("期望通过率映射", () => {
  it("信用分 100 → 0.95，信用分 0 → 0.3，中间线性", () => {
    expect(expectedApprovalRate(100)).toBeCloseTo(0.95);
    expect(expectedApprovalRate(0)).toBeCloseTo(0.3);
    expect(expectedApprovalRate(50)).toBeCloseTo(0.625);
  });

  it("越界信用分被钳制", () => {
    expect(expectedApprovalRate(-20)).toBeCloseTo(0.3);
    expect(expectedApprovalRate(120)).toBeCloseTo(0.95);
  });
});

describe("通过率匹配分", () => {
  it("审核员通过率与期望完全一致时得满分 1", () => {
    // 信用 100 → 期望 0.95；该审核员历史通过率 0.95
    const m = moderator({ decidedCount: 100, approvedCount: 95 });
    expect(passRateFitScore(m, task({ submitterCreditScore: 100 }))).toBeCloseTo(1);
  });

  it("偏离越远分数越低，但有保底", () => {
    const strict = moderator({ decidedCount: 100, approvedCount: 30 }); // 通过率 0.3
    const fitForHighCredit = passRateFitScore(strict, task({ submitterCreditScore: 100 }));
    expect(fitForHighCredit).toBeLessThan(0.5);
    expect(fitForHighCredit).toBeGreaterThanOrEqual(0.35);
  });

  it("严格审核员更适合低信用作者的任务", () => {
    const strict = moderator({ decidedCount: 100, approvedCount: 30 });
    const lenient = moderator({ userId: 2n, decidedCount: 100, approvedCount: 95 });
    const lowCreditTask = task({ submitterCreditScore: 10 });

    expect(passRateFitScore(strict, lowCreditTask)).toBeGreaterThan(
      passRateFitScore(lenient, lowCreditTask),
    );
  });

  it("无历史数据时中性给 1 分，不惩罚新人", () => {
    expect(passRateFitScore(moderator(), task())).toBe(1);
  });

  it("moderatorApprovalRate 在无决策时返回 null", () => {
    expect(moderatorApprovalRate(moderator())).toBeNull();
    expect(moderatorApprovalRate(moderator({ decidedCount: 10, approvedCount: 4 }))).toBeCloseTo(0.4);
  });
});

describe("分类偏好分", () => {
  it("手工权重优先生效并被钳制在 0–2", () => {
    const m = moderator({ categoryWeights: { bench: 2 } });
    expect(categoryAffinityScore(m, "bench")).toBe(2);
    m.categoryWeights = { bench: 5 };
    expect(categoryAffinityScore(m, "bench")).toBe(2);
    m.categoryWeights = { bench: -1 };
    expect(categoryAffinityScore(m, "bench")).toBe(0);
  });

  it("手工权重为 0 时确实不再派该分类（但其他因子还在，由总分层控制）", () => {
    const m = moderator({ categoryWeights: { bench: 0 } });
    expect(categoryAffinityScore(m, "bench")).toBe(0);
  });

  it("无历史无手工配置时中性 1 分", () => {
    expect(categoryAffinityScore(moderator(), "bench")).toBe(1);
  });

  it("某分类审得越多偏好分越高，有上限", () => {
    const m = moderator({
      decidedCount: 10,
      categoryStats: { bench: { decided: 10, approved: 8 } },
    });
    const score = categoryAffinityScore(m, "bench");
    expect(score).toBeGreaterThan(1);
    expect(score).toBeLessThanOrEqual(1.8);
  });
});

describe("负载均衡分", () => {
  it("在办越多分越低，有保底", () => {
    expect(workloadScore(moderator({ activeCount: 0 }))).toBe(1);
    expect(workloadScore(moderator({ activeCount: 3 }))).toBeCloseTo(1 - 3 * 0.12);
    expect(workloadScore(moderator({ activeCount: 100 }))).toBe(0.25);
  });
});

describe("综合打分", () => {
  it("零历史新人获得探索加成，总分高于基线", () => {
    const newbie = scoreTaskForModerator(moderator({ decidedCount: 0 }), task());
    expect(newbie.factors.exploration).toBe(1.25);
    expect(newbie.total).toBeCloseTo(1.25);
  });

  it("样本不足 5 条时即使有通过率也给探索加成", () => {
    const newbie = scoreTaskForModerator(moderator({ decidedCount: 3, approvedCount: 3 }), task());
    expect(newbie.factors.exploration).toBe(1.25);
  });

  it("临时人手带折扣", () => {
    const temp = scoreTaskForModerator(moderator({ temporary: true }), task());
    const regular = scoreTaskForModerator(moderator(), task());
    expect(temp.total).toBeLessThan(regular.total);
    expect(temp.total / regular.total).toBeCloseTo(0.7);
  });

  it("容量系数为 0 时总分为 0（暂停派单的硬手段）", () => {
    const result = scoreTaskForModerator(moderator({ capacityFactor: 0 }), task());
    expect(result.total).toBe(0);
  });

  it("各因子相乘：匹配×偏好×负载", () => {
    const m = moderator({
      decidedCount: 100,
      approvedCount: 95,
      categoryStats: { bench: { decided: 50, approved: 48 } },
      activeCount: 2,
    });
    const result = scoreTaskForModerator(m, task({ submitterCreditScore: 100 }));
    const expected =
      result.factors.passRateFit *
      result.factors.categoryAffinity *
      result.factors.workload *
      result.factors.exploration *
      result.factors.temporaryPenalty *
      result.factors.capacity;
    expect(result.total).toBeCloseTo(expected);
  });
});

describe("任务紧急度", () => {
  it("超时任务倍率 1.5", () => {
    expect(taskUrgencyMultiplier(task({ overdue: true }))).toBeCloseTo(1.5);
  });

  it("每级优先级加 0.1", () => {
    expect(taskUrgencyMultiplier(task({ priority: 2 }))).toBeCloseTo(1.2);
    expect(taskUrgencyMultiplier(task({ priority: -5 }))).toBeCloseTo(1);
  });
});

describe("加权随机", () => {
  it("空数组返回 null", () => {
    expect(weightedPick([], () => 1)).toBeNull();
  });

  it("单个候选项总是它", () => {
    expect(weightedPick([{ id: "a" }], () => 10)?.id).toBe("a");
  });

  it("权重为 0 的候选项永远不会被选中", () => {
    const candidates = [
      { id: "zero", weight: 0 },
      { id: "one", weight: 1 },
    ];
    for (let i = 0; i < 50; i += 1) {
      expect(weightedPick(candidates, (item) => item.weight)?.id).toBe("one");
    }
  });

  it("高权重候选项被选中的频次明显更高（统计意义）", () => {
    const candidates = [
      { id: "rare", weight: 1 },
      { id: "common", weight: 99 },
    ];
    const counts = { rare: 0, common: 0 };
    for (let i = 0; i < 2000; i += 1) {
      const picked = weightedPick(candidates, (item) => item.weight);
      counts[picked!.id as keyof typeof counts] += 1;
    }
    expect(counts.common).toBeGreaterThan(1500);
  });

  it("全部负权重时退化为选第一个，不抛异常", () => {
    expect(weightedPick([{ id: "a" }, { id: "b" }], () => -1)?.id).toBe("a");
  });
});
