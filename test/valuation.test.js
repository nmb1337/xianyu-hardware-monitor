import test from "node:test";
import assert from "node:assert/strict";
import { estimateDesktopListing, parseComponents, valuationBounds } from "../src/valuation.js";

test("parses CPU, GPU variants, memory and supported SSD capacities", () => {
  const result = parseComponents(
    "台式主机 R5 5600 RTX 3060 12G B550 DDR4 16G 3200 NVMe 512G"
  );
  assert.equal(result.components.cpu.model, "R5 5600");
  assert.equal(result.components.gpu.model, "RTX 3060 12G");
  assert.equal(result.components.gpu.priceCny, 1750);
  assert.equal(result.components.memory.priceCny, 180);
  assert.equal(result.components.storage.priceCny, 200);
  assert.equal(result.components.motherboard.priceCny, 50);
});

test("distinguishes bare GPU memory variants without an RTX prefix", () => {
  assert.equal(parseComponents("台式主机 R5 5600 3060 8G DDR4 16G").components.gpu.priceCny, 1400);
  assert.equal(parseComponents("台式主机 R5 5600 3060 12G DDR4 16G").components.gpu.priceCny, 1750);
});

test("does not confuse CPU generations or memory frequency with prices", () => {
  const result = parseComponents("台式电脑 i5-12400F RTX 3060 8G DDR4 16G 3200");
  assert.equal(result.components.cpu.priceCny, 675);
  assert.equal(result.components.gpu.priceCny, 1400);
  assert.equal(result.components.memory.priceCny, 180);
  assert.equal(result.components.storage, null);
});

test("uses a default motherboard and skips unsupported storage", () => {
  const result = parseComponents("台式主机 R7 5700X RTX 3060 12G 固态 2TB");
  assert.equal(result.components.motherboard.default, true);
  assert.equal(result.components.motherboard.priceCny, 50);
  assert.equal(result.components.storage.unsupported, true);
  assert.equal(result.components.storage.priceCny, null);
  assert.ok(result.missingParts.includes("storage"));
});

test("enforces CPU/GPU requirements and the 5500 valuation cap", () => {
  const missingGpu = estimateDesktopListing({ title: "台式主机 i5-12400F", price: 500 });
  assert.equal(missingGpu.matched, false);
  assert.equal(missingGpu.valuationStatus, "missing_required");

  const overCap = estimateDesktopListing({
    title: "台式主机 i9-14900K RTX 5070Ti DDR5 32G 1TB 固态",
    price: 6_000
  });
  assert.equal(overCap.valuationStatus, "over_cap");
  assert.equal(overCap.matched, false);
});

test("matches the inclusive upper 15 percent boundary and flags extreme low prices", () => {
  const title = "台式主机 R5 5600 RTX 3060 12G DDR4 16G 512G固态";
  const estimate = estimateDesktopListing({ title, price: 0 });
  const boundary = valuationBounds(estimate.valuationCny, 15).upperPrice;
  const normal = estimateDesktopListing({ title, price: boundary });
  assert.equal(normal.matched, true);
  assert.equal(normal.extremelyLow, false);

  const extreme = estimateDesktopListing({ title, price: estimate.valuationCny * 0.8 });
  assert.equal(extreme.matched, true);
  assert.equal(extreme.extremelyLow, true);
});

test("uses the selected tolerance for both matching and extreme-low labels", () => {
  const title = "台式主机 R5 5600 RTX 3060 12G DDR4 16G 512G固态";
  const estimate = estimateDesktopListing({ title, price: 0, tolerancePercent: 20 });
  const bounds = valuationBounds(estimate.valuationCny, 20);
  const atUpperBoundary = estimateDesktopListing({
    title,
    price: bounds.upperPrice,
    tolerancePercent: 20
  });
  const justAboveLowerBoundary = estimateDesktopListing({
    title,
    price: bounds.lowerPrice + 0.01,
    tolerancePercent: 20
  });
  assert.equal(atUpperBoundary.matched, true);
  assert.equal(justAboveLowerBoundary.extremelyLow, false);
});

test("requires desktop wording and accepts detail text separately", () => {
  const result = estimateDesktopListing({
    title: "台式主机低价出",
    description: "CPU: R5 5600，显卡 RTX 3060 12G，内存 DDR4 16G，固态 1TB",
    price: 2_000
  });
  assert.equal(result.desktopEligible, true);
  assert.equal(result.components.cpu.model, "R5 5600");
  assert.equal(result.components.gpu.model, "RTX 3060 12G");
  assert.equal(result.components.storage.priceCny, 400);
});

test("keeps unusable hardware out of the alert result", () => {
  const result = estimateDesktopListing({
    title: "台式主机 R5 5600 RTX 3060 12G DDR4 16G 花屏维修",
    price: 500
  });
  assert.equal(result.unusable, true);
  assert.equal(result.valuationStatus, "unusable");
  assert.equal(result.matched, false);
  assert.ok(result.conditionIssues.includes("花屏"));
  assert.ok(result.conditionIssues.includes("维修"));
});

test("does not treat an unknown priced CPU or GPU as a required component", () => {
  const result = estimateDesktopListing({
    title: "台式主机 Ryzen 9 9950X RTX 5090 DDR5 32G",
    price: 2_000
  });
  assert.equal(result.valuationStatus, "missing_required");
  assert.equal(result.matched, false);
  assert.equal(result.components.cpu.priceCny, null);
  assert.equal(result.components.gpu.priceCny, null);
});
