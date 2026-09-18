import { describe, expect, it } from "vitest";
import {
  approvalFactor,
  categoryFactor,
  loadFactor,
  moderatorWeight,
  pickWeighted,
  type ModeratorStatInput,
} from "../../src/modules/reviews/dispatchWeights";

function stat(partial: Partial<ModeratorStatInput> = {}): ModeratorStatInput {
  return {
    userId: 1n,
    total: 0,
    approved: 0,
    categoryCounts: new Map(),
    ...partial,
  };
}

describe("加权派单 - 通过率因子", () => {
  it("没有历史样本时因子约为 1，新人不被惩罚", () => {
    expect(approvalFactor(stat())).toBeCloseTo(1, 5);
  });

  it("高样本下全部通过趋近温和上限，避免马太效应", () => {
    const factor = approvalFactor(stat({ total: 10000, approved: 10000 }));
    expect(factor).toBeCloseTo(1.2, 2);
    expect(factor).toBeLessThanOrEqual(1.2);
  });

  it("高样本下全部驳回趋近温和下限，但不会归零", () => {
    const factor = approvalFactor(stat({ total: 10000, approved: 0 }));
    expect(factor).toBeCloseTo(0.8, 2);
    expect(factor).toBeGreaterThanOrEqual(0.8);
  });

  it("通过率一半时因子为 1", () => {
    expect(approvalFactor(stat({ total: 50, approved: 25 }))).toBeCloseTo(1, 5);
  });

  it("样本很少时向均值收敛，小样本波动不被放大", () => {
    const oneDecision = approvalFactor(stat({ total: 1, approved: 1 }));
    expect(oneDecision).toBeLessThan(1.2);
    expect(oneDecision).toBeGreaterThan(1);
  });
});

describe("加权派单 - 分类偏好因子", () => {
  it("显式声明偏好命中时拿最强加成", () => {
    expect(categoryFactor(stat(), "bench", ["bench"])).toBe(2);
  });

  it("没有历史时不惩罚", () => {
    expect(categoryFactor(stat(), "bench", [])).toBe(1);
  });

  it("历史主力分类拿到最高隐性加成，其他分类按占比递减", () => {
    const experienced = stat({
      total: 100,
      categoryCounts: new Map([
        ["bench", 80],
        ["water", 20],
      ]),
    });
    expect(categoryFactor(experienced, "bench", [])).toBeCloseTo(1.5, 5);
    expect(categoryFactor(experienced, "water", [])).toBeCloseTo(1.125, 3);
  });

  it("从没做过的分类不给加成", () => {
    const experienced = stat({ total: 10, categoryCounts: new Map([["bench", 10]]) });
    expect(categoryFactor(experienced, "water", [])).toBe(1);
  });
});

describe("加权派单 - 负载因子", () => {
  it("空手上岗为 1，满载为 0", () => {
    expect(loadFactor(0, 10)).toBe(1);
    expect(loadFactor(10, 10)).toBe(0);
    expect(loadFactor(5, 10)).toBeCloseTo(0.5, 5);
  });

  it("上限配置非正数时不派单", () => {
    expect(loadFactor(0, 0)).toBe(0);
  });
});

describe("加权派单 - 综合权重", () => {
  it("满载或暂停（maxActive 已满）时权重为 0", () => {
    const weight = moderatorWeight(
      {
        stat: stat({ total: 100, approved: 100 }),
        preferredCategories: ["bench"],
        activeCount: 10,
        maxActive: 10,
      },
      "bench",
    );
    expect(weight).toBe(0);
  });

  it("偏好分类 + 高通过率 + 空手 的权重大于 陌生分类 + 同条件", () => {
    const preferred = moderatorWeight(
      {
        stat: stat({ total: 100, approved: 90, categoryCounts: new Map([["bench", 100]]) }),
        preferredCategories: ["bench"],
        activeCount: 0,
        maxActive: 10,
      },
      "bench",
    );
    const unfamiliar = moderatorWeight(
      {
        stat: stat({ total: 100, approved: 90, categoryCounts: new Map([["bench", 100]]) }),
        preferredCategories: [],
        activeCount: 0,
        maxActive: 10,
      },
      "water",
    );
    expect(preferred).toBeGreaterThan(unfamiliar);
  });

  it("加派倍数在最终权重上相乘", () => {
    const base = moderatorWeight(
      { stat: stat(), preferredCategories: [], activeCount: 0, maxActive: 10 },
      "bench",
    );
    const surged = moderatorWeight(
      { stat: stat(), preferredCategories: [], activeCount: 0, maxActive: 10, surgeFactor: 3 },
      "bench",
    );
    expect(surged / base).toBeCloseTo(3, 5);
  });
});

describe("加权派单 - 加权随机选择", () => {
  it("所有权重为 0 时返回 null（没有人能接这条任务）", () => {
    expect(pickWeighted([{ value: "a", weight: 0 }])).toBeNull();
  });

  it("空候选返回 null", () => {
    expect(pickWeighted([])).toBeNull();
  });

  it("注入确定性随机数时按累计权重区间选择", () => {
    const candidates = [
      { value: "a", weight: 1 },
      { value: "b", weight: 2 },
      { value: "c", weight: 1 },
    ];
    // 总权重 4：a [0,1) b [1,3) c [3,4)
    expect(pickWeighted(candidates, () => 0)).toBe("a");
    expect(pickWeighted(candidates, () => 0.24)).toBe("a");
    expect(pickWeighted(candidates, () => 0.3)).toBe("b");
    expect(pickWeighted(candidates, () => 0.7)).toBe("b");
    expect(pickWeighted(candidates, () => 0.9)).toBe("c");
  });

  it("高权重候选在大样本下被选中的比例更高", () => {
    const candidates = [
      { value: "a", weight: 1 },
      { value: "b", weight: 3 },
    ];
    let aCount = 0;
    for (let i = 0; i < 4000; i += 1) {
      if (pickWeighted(candidates) === "a") aCount += 1;
    }
    // 期望 25%，留足随机余量
    expect(aCount).toBeGreaterThan(800);
    expect(aCount).toBeLessThan(1200);
  });
});
