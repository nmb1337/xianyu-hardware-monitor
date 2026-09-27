import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { appraiseText, normalizeAppraisal, sanitizeTables } from "../src/appraisal.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tables = sanitizeTables(JSON.parse(readFileSync(resolve(root, "data", "price-tables.json"), "utf8")));
const settings = normalizeAppraisal({});

console.log(`价格表载入：显卡 ${tables.gpu.items.length} 条 / AMD CPU ${tables.cpu.items.length} 条 / 内存 ${tables.memory.desktop.length + tables.memory.laptop.length + tables.memory.server.length} 条 / Intel ${tables.intelCpu.items.length} 条 / 固态 ${tables.storage.items.length} 条`);

const samples = [
  { text: "i5 12400F+RTX3060 12G 16G内存 512G固态 游戏主机", price: 2999 },
  { text: "出七彩虹RTX3060 12G显卡 自用无拆修", price: 1100 },
  { text: "R5 3600+GTX1660S+16G(8G×2)+512G固态 台式主机", price: 1500 },
  { text: "10400核显办公主机 8G内存 256G固态 无显卡", price: 700 },
  { text: "RX580 8G 显卡 自用", price: 500 },
  { text: "R7 3700X主机 16G 1T固态 2060s 显卡 水冷", price: 2100 },
  { text: "R5 2600+8G内存 办公主机", price: 400 },
  { text: "R7 9800X3D+RTX5070 高配游戏主机", price: 7800 }
];

for (const sample of samples) {
  console.log("\n" + "─".repeat(72));
  console.log(`标题: ${sample.text}`);
  const result = appraiseText(tables, sample.text, sample.price, settings);
  console.log([
    `卖家价 ${sample.price}`,
    `类型 ${result.kind === "machine" ? "整机" : "单件"}`,
    `合计 ${result.sum}`,
    `窗口 ${result.windowLow}~${result.windowHigh}`,
    `净差 ${result.diff}`,
    `命中 ${result.inWindow}`,
    `收购范围 ${result.machineRange.min}~${result.machineRange.max}${result.machineRange.ok ? "" : "（超出不收）"}`
  ].join("｜"));
  for (const part of result.parts) {
    console.log(`  - ${part.type}: ${part.label} = ${part.price} [${part.status}] ${part.notes.join(" / ")}`);
  }
  if (result.missing.length) {
    console.log(`  未计价: ${result.missing.join("、")}`);
  }
  if (result.excluded.length) {
    console.log(`  不计入: ${result.excluded.join("、")}`);
  }
  if (result.flags.length) {
    console.log(`  标记: ${result.flags.join("；")}`);
  }
}
