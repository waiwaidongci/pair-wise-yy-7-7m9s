// 环境补偿规则：温度折算与合格判定（独立模块，不依赖存储）

export const rules = {
  baseTemp: 20, // 折算基准温度 ℃
  minTemp: 5, // 测点温度下限 ℃
  maxTemp: 35, // 测点温度上限 ℃
  adjacentTolerance: 0.08, // 相邻折算读数允许偏差 8%
  coefficients: {
    // 材料温度系数（每 ℃）
    蜡线: 0.004,
    棉线: 0.003,
    金属索: 0.0012,
    default: 0.002
  }
};

export function getRules() {
  return rules;
}

export function coefficientFor(material) {
  return rules.coefficients[material] ?? rules.coefficients.default;
}

// 把 temp 下的实测读数折算到 20℃ 基准：v20 = raw × (1 + α × (20 − T))
export function toBaseTemp(value, temp, material) {
  const alpha = coefficientFor(material);
  return Number((value * (1 + alpha * (rules.baseTemp - temp))).toFixed(4));
}

// 判定一条读数是否合格：测点温度越界 5–35℃，或与上一条折算值偏差超 8%，则转待复测
export function evaluateReading({ temp, converted, prevConverted }) {
  const flags = [];
  if (temp < rules.minTemp || temp > rules.maxTemp) flags.push("temp_out_of_range");
  if (prevConverted != null && prevConverted !== 0) {
    const drift = Math.abs(converted - prevConverted) / Math.abs(prevConverted);
    if (drift > rules.adjacentTolerance) flags.push("adjacent_drift");
  }
  return { qualified: flags.length === 0, flags };
}
