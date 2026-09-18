// 加权派单的纯计算部分。
// 不触碰数据库，方便在单元测试里穷举边界：新审核员、满负载、加派倍数、偏好命中……
import {
  DISPATCH_APPROVAL_FACTOR_MAX,
  DISPATCH_APPROVAL_FACTOR_MIN,
  DISPATCH_HISTORY_FACTOR_MAX,
  DISPATCH_PREFERRED_FACTOR,
  DISPATCH_PRIOR_SAMPLE,
} from "../../config/constants";

export interface ModeratorStatInput {
  userId: bigint;
  /** 近窗口内决策总数 */
  total: number;
  /** 其中通过数（含申诉改判通过） */
  approved: number;
  /** categoryCode -> 近窗口内该分类的决策数 */
  categoryCounts: Map<string, number>;
}

/**
 * 通过率因子：用贝叶斯平滑后的通过率映射到 [MIN, MAX]。
 *
 * 为什么不是通过率越高权重越大、无上限？
 * 通过率高可能是审得松——派单只做温和倾斜（±20%），
 * 分类匹配度与负载才是主要调节项。样本不足时向均值 0.5 收敛，因子约等于 1。
 */
export function approvalFactor(stat: Pick<ModeratorStatInput, "total" | "approved">): number {
  const smoothed =
    (stat.approved + DISPATCH_PRIOR_SAMPLE * 0.5) / (stat.total + DISPATCH_PRIOR_SAMPLE);
  const factor = 1 + (smoothed - 0.5) * 2 * (DISPATCH_APPROVAL_FACTOR_MAX - 1);
  return clamp(factor, DISPATCH_APPROVAL_FACTOR_MIN, DISPATCH_APPROVAL_FACTOR_MAX);
}

/**
 * 分类偏好因子。
 * 1. 审核员显式声明偏好该分类：PREFERRED_FACTOR（最强信号）；
 * 2. 否则看历史处理占比：最常做的分类拿到 1 ~ HISTORY_FACTOR_MAX 的温和加成；
 * 3. 完全没有历史：1，不惩罚新人。
 */
export function categoryFactor(
  stat: ModeratorStatInput,
  categoryCode: string,
  preferredCategories: readonly string[],
): number {
  if (preferredCategories.includes(categoryCode)) return DISPATCH_PREFERRED_FACTOR;
  if (stat.total === 0) return 1;

  const inCategory = stat.categoryCounts.get(categoryCode) ?? 0;
  if (inCategory === 0) return 1;

  const share = inCategory / stat.total;
  const maxShare = Math.max(...stat.categoryCounts.values()) / stat.total;
  // 该分类占比越接近此人的"主力分类"，加成越接近上限
  const normalized = maxShare > 0 ? share / maxShare : 0;
  return 1 + (DISPATCH_HISTORY_FACTOR_MAX - 1) * normalized;
}

/** 负载因子：手里未完成的任务越多，新任务权重越低；达到上限时为 0，不再派单 */
export function loadFactor(activeCount: number, maxActive: number): number {
  if (maxActive <= 0) return 0;
  if (activeCount >= maxActive) return 0;
  // 线性衰减：空手上岗 1，达到上限 0
  return 1 - activeCount / maxActive;
}

export interface WeightInput {
  stat: ModeratorStatInput;
  preferredCategories: readonly string[];
  activeCount: number;
  maxActive: number;
  /** ModeratorProfile.weightFactor，管理员的手动修正 */
  manualFactor?: number;
  /** 加派倍数（命中加派分类限制时），未加派为 1 */
  surgeFactor?: number;
}

/** 单个审核员对某个任务的综合派单权重 */
export function moderatorWeight(input: WeightInput, categoryCode: string): number {
  const load = loadFactor(input.activeCount, input.maxActive);
  if (load <= 0) return 0;

  return (
    approvalFactor(input.stat) *
    categoryFactor(input.stat, categoryCode, input.preferredCategories) *
    load *
    (input.manualFactor ?? 1) *
    (input.surgeFactor ?? 1)
  );
}

/**
 * 按权重随机选一个候选。加权随机而不是"永远选权重最高"，
 * 否则偏好稍有差异就会把同分类任务全压给同一个人。
 *
 * rand 可注入，测试里传确定性随机数即可复现选择结果。
 */
export function pickWeighted<T>(
  candidates: ReadonlyArray<{ value: T; weight: number }>,
  rand: () => number = Math.random,
): T | null {
  const eligible = candidates.filter((candidate) => candidate.weight > 0);
  if (eligible.length === 0) return null;

  const total = eligible.reduce((sum, candidate) => sum + candidate.weight, 0);
  // 末尾留一个极小浮点余量，避免 roll 恰好落在区间边界时被算到下一个候选
  let roll = rand() * total - Number.EPSILON;
  for (const candidate of eligible) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate.value;
  }
  // 浮点误差兜底
  return eligible[eligible.length - 1].value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
