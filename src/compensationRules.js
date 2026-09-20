// 补偿规则：只负责环境（温度）补偿与合格判定，不接触任何存储。
// 规则集中在此处，便于整体替换或调参；判定逻辑对批次服务透明。

export const DEFAULT_RULES = Object.freeze({
  referenceTemp: 20, // 折算基准温度 ℃
  tempMin: 5, // 测点温度下限（含）
  tempMax: 35, // 测点温度上限（含）
  adjacentTolerancePct: 8, // 相邻读数允许偏差 %
  coefficientPerDegree: 0.002, // 每偏离 1℃ 的线性补偿系数（相对值）
  passMaxDeviationPct: 2, // 折算值相对标称值允许偏差 %，判定“合格”
  requiredConsecutivePass: 2, // 封存所需连续合格次数
});

/** 把实测读数折算到 20℃ 基准：raw / (1 + k·(T − 20)) */
export function compensate(rawValue, temperature, rules = DEFAULT_RULES) {
  const factor = 1 + rules.coefficientPerDegree * (temperature - rules.referenceTemp);
  return rawValue / factor;
}

/** 温度是否越界（越界即转待复测） */
export function isTempOutOfRange(temperature, rules = DEFAULT_RULES) {
  return temperature < rules.tempMin || temperature > rules.tempMax;
}

/**
 * 相邻读数偏差是否超限：|current − previous| / |previous| > 8%。
 * previous 为 null/undefined 表示没有上一次读数，不超限。
 */
export function isAdjacentDeviationExceeded(current, previous, rules = DEFAULT_RULES) {
  if (previous === null || previous === undefined) return false;
  if (previous === 0) return current !== 0;
  return Math.abs(current - previous) / Math.abs(previous) > rules.adjacentTolerancePct / 100;
}

/**
 * 对一次读数做完整评估。
 * @returns {{ compensated:number, tempOutOfRange:boolean, adjacentDeviationPct:number|null, needsRecheck:boolean, reasons:string[] }}
 */
export function evaluateReading({ rawValue, temperature, previousCompensated = null }, rules = DEFAULT_RULES) {
  const compensated = compensate(rawValue, temperature, rules);
  const tempOutOfRange = isTempOutOfRange(temperature, rules);
  const adjacentDeviationPct =
    previousCompensated === null || previousCompensated === 0
      ? previousCompensated === null
        ? null
        : compensated === 0
          ? 0
          : Infinity
      : (Math.abs(compensated - previousCompensated) / Math.abs(previousCompensated)) * 100;
  const adjacentExceeded = isAdjacentDeviationExceeded(compensated, previousCompensated, rules);

  const reasons = [];
  if (tempOutOfRange) reasons.push("温度越界5–35℃");
  if (adjacentExceeded) reasons.push("相邻读数差超8%");

  return {
    compensated,
    tempOutOfRange,
    adjacentDeviationPct,
    needsRecheck: tempOutOfRange || adjacentExceeded,
    reasons,
  };
}

/** 折算值是否合格（相对标称值偏差在允许范围内；无标称值时仅要求有限数） */
export function isQualified(compensated, nominal, rules = DEFAULT_RULES) {
  if (!Number.isFinite(compensated)) return false;
  if (nominal === null || nominal === undefined) return true;
  if (nominal === 0) return compensated === 0;
  return Math.abs(compensated - nominal) / Math.abs(nominal) <= rules.passMaxDeviationPct / 100;
}
