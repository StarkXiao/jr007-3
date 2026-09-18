/**
 * 加权派单的纯打分逻辑。
 *
 * 派一个任务给谁，由三个因子共同决定：
 *
 *   总分 = 通过率匹配分 × 分类偏好分 × 负载均衡分 × 容量系数
 *
 * - 通过率匹配：任务作者信用分高 → 历史通过率高的审核员更合适；
 *   信用分低 → 历史上更敢于驳回的审核员更合适。用「审核员通过率与期望通过率
 *   的接近程度」打分，两者完全一致为 1，偏离越多越低。
 * - 分类偏好：审核员在某分类上审得越多，说明越熟；管理员也可手工设置权重。
 * - 负载均衡：手上在办的任务越多，权重越低，防止任务全堆到一个人身上。
 *
 * 这里刻意不做黑盒模型：每个因子都能解释给审核员听，
 * 出了分配争议时管理员可以手工修正偏好权重。
 */

import { DISPATCH_EXPLORATION_BOOST, DISPATCH_MIN_SAMPLE } from "../../config/constants";

export interface CategoryStat {
  decided: number;
  approved: number;
}

export interface ModeratorDispatchFeatures {
  userId: bigint;
  /** 滚动窗口内已决任务数 */
  decidedCount: number;
  /** 滚动窗口内通过数（含申诉改判通过） */
  approvedCount: number;
  /** 各分类统计，key 为分类 code */
  categoryStats: Record<string, CategoryStat>;
  /** 管理员手工分类权重，key 为分类 code（0–2） */
  categoryWeights: Record<string, number>;
  /** 全局容量系数（0–2，1 为正常） */
  capacityFactor: number;
  /** 当前在办（已领取未决策）任务数 */
  activeCount: number;
  /** 是否临时加派人员：在同等条件下排在职审核员之后 */
  temporary: boolean;
}

export interface TaskDispatchFeatures {
  /** 任务作者信用分 0–100 */
  submitterCreditScore: number;
  /** 任务分类 code */
  categoryCode: string;
  /** 是否已超 SLA */
  overdue: boolean;
  /** 任务优先级（越高越急） */
  priority: number;
}

export const SCORE_WEIGHTS = {
  /** 通过率匹配分最低保底，避免某个审核员被完全饿死 */
  passRateFloor: 0.35,
  /** 自动分类偏好的上限：纯历史经验不应压过其他因子太多 */
  autoCategoryMax: 1.8,
  /** 手工权重的允许范围 */
  manualWeightMin: 0,
  manualWeightMax: 2,
  /** 每条在办任务带来的乘性衰减 */
  workloadDecay: 0.12,
  /** 负载分保底 */
  workloadFloor: 0.25,
  /** 临时人手相对在职审核员的优先级折扣 */
  temporaryPenalty: 0.7,
  /** 超时任务的额外倍率（在候选排序时生效，不在人-人之间生效） */
  overdueMultiplier: 1.5,
  /** 每级优先级的加分倍率 */
  priorityStep: 0.1,
} as const;

/**
 * 把作者信用分换算为「期望审核通过率」。
 * 信用满分的作者，约 95% 的提交应通过；信用 0 的作者，约 30%。
 */
export function expectedApprovalRate(creditScore: number): number {
  const clamped = Math.max(0, Math.min(100, creditScore));
  return 0.3 + (clamped / 100) * 0.65;
}

export function moderatorApprovalRate(moderator: ModeratorDispatchFeatures): number | null {
  if (moderator.decidedCount <= 0) return null;
  return moderator.approvedCount / moderator.decidedCount;
}

/** 通过率匹配分：1 表示审核员的尺度与任务需要的尺度完全吻合 */
export function passRateFitScore(
  moderator: ModeratorDispatchFeatures,
  task: TaskDispatchFeatures,
): number {
  const rate = moderatorApprovalRate(moderator);
  // 无历史数据时不给惩罚也不给奖励，由探索加成统一处理
  if (rate === null) return 1;

  const expected = expectedApprovalRate(task.submitterCreditScore);
  const distance = Math.abs(rate - expected);
  // 通过率每偏离期望 0.1，分数降 0.15；偏离 0.43 以上触底
  return Math.max(SCORE_WEIGHTS.passRateFloor, 1 - distance * 1.5);
}

/**
 * 分类偏好分。
 * 手工权重优先；没有手工配置时，用该分类在审核员历史中的占比做平滑估计：
 *   占比 0 → 1（中性），占比越高分数越高，封顶 autoCategoryMax。
 */
export function categoryAffinityScore(
  moderator: ModeratorDispatchFeatures,
  categoryCode: string,
): number {
  const manual = moderator.categoryWeights[categoryCode];
  if (typeof manual === "number") {
    return Math.max(SCORE_WEIGHTS.manualWeightMin, Math.min(SCORE_WEIGHTS.manualWeightMax, manual));
  }

  const stat = moderator.categoryStats[categoryCode];
  if (!stat || stat.decided <= 0 || moderator.decidedCount <= 0) return 1;

  const share = stat.decided / moderator.decidedCount;
  // share=0 → 1，share=1 → autoCategoryMax（线性映射）
  return 1 + share * (SCORE_WEIGHTS.autoCategoryMax - 1);
}

/** 负载均衡分：在办任务越多分越低 */
export function workloadScore(moderator: ModeratorDispatchFeatures): number {
  return Math.max(
    SCORE_WEIGHTS.workloadFloor,
    1 - moderator.activeCount * SCORE_WEIGHTS.workloadDecay,
  );
}

/**
 * 计算某个审核员对某个任务的综合派单分（未含紧急度倍率）。
 * 返回各因子明细，方便接口侧解释「为什么派给他」。
 */
export function scoreTaskForModerator(
  moderator: ModeratorDispatchFeatures,
  task: TaskDispatchFeatures,
): { total: number; factors: { passRateFit: number; categoryAffinity: number; workload: number; exploration: number; temporaryPenalty: number; capacity: number } } {
  const passRateFit = passRateFitScore(moderator, task);
  const categoryAffinity = categoryAffinityScore(moderator, task.categoryCode);
  const workload = workloadScore(moderator);
  const exploration = moderator.decidedCount < DISPATCH_MIN_SAMPLE ? DISPATCH_EXPLORATION_BOOST : 1;
  const temporaryPenalty = moderator.temporary ? SCORE_WEIGHTS.temporaryPenalty : 1;
  const capacity = Math.max(0, Math.min(2, moderator.capacityFactor));

  const total =
    passRateFit * categoryAffinity * workload * exploration * temporaryPenalty * capacity;

  return {
    total,
    factors: { passRateFit, categoryAffinity, workload, exploration, temporaryPenalty, capacity },
  };
}

/** 任务本身的紧急度倍率：超时 / 高优先级任务在候选排序里更靠前 */
export function taskUrgencyMultiplier(task: TaskDispatchFeatures): number {
  const overdue = task.overdue ? SCORE_WEIGHTS.overdueMultiplier : 1;
  const priority = 1 + Math.max(0, task.priority) * SCORE_WEIGHTS.priorityStep;
  return overdue * priority;
}

/** 加权随机选择：总分越高被选中的概率越大，而不是永远只选最高分 */
export function weightedPick<T>(candidates: Array<T>, scoreOf: (item: T) => number): T | null {
  if (candidates.length === 0) return null;

  const weights = candidates.map((item) => Math.max(0, scoreOf(item)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return candidates[0] ?? null;

  let roll = Math.random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return candidates[index];
  }
  return candidates[candidates.length - 1] ?? null;
}
