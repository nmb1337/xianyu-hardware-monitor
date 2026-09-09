import test from "node:test";
import assert from "node:assert/strict";
import { parseSearchResponse } from "../src/browser.js";

test("parseSearchResponse reads structured price instead of title numbers", () => {
  const listings = parseSearchResponse({
    data: {
      resultList: [
        {
          data: {
            item: {
              main: {
                exContent: {
                  itemId: "1001",
                  title: "七彩虹 RTX3060 12G 显卡 2.5K 分辨率展示",
                  userNick: "卖家",
                  detailParams: { soldPrice: "1200.00" }
                },
                clickParam: { args: {} }
              }
            }
          }
        }
      ]
    }
  });

  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 1200);
  assert.equal(listings[0].title.includes("12G"), true);
});
