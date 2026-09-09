export const CATEGORIES = [
  ["laptop", "笔记本"],
  ["desktop", "台式整机"],
  ["cpu", "CPU"],
  ["motherboard", "主板"],
  ["gpu", "显卡"],
  ["memory", "内存"],
  ["storage", "硬盘 / SSD"],
  ["monitor", "显示器"],
  ["power_supply", "电源"],
  ["case", "机箱"],
  ["cooling", "散热器"],
  ["network", "网卡"],
  ["other", "自定义"]
];

const categoryMap = new Map(CATEGORIES);

export function categoryLabel(category) {
  return categoryMap.get(category) ?? "自定义";
}
