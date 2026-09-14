import test from "node:test";
import assert from "node:assert/strict";
import { parseBrowserProxySetting, parseSearchResponse, XianyuBrowser } from "../src/browser.js";

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

test("browser network settings map to direct, system and custom proxy modes", () => {
  assert.deepEqual(parseBrowserProxySetting(""), { mode: "system" });
  assert.deepEqual(parseBrowserProxySetting("system"), { mode: "system" });
  assert.deepEqual(parseBrowserProxySetting("DIRECT"), { mode: "direct" });
  assert.deepEqual(parseBrowserProxySetting("http://127.0.0.1:7890"), {
    mode: "custom",
    proxy: { server: "http://127.0.0.1:7890" }
  });
  assert.deepEqual(parseBrowserProxySetting("socks5://127.0.0.1:1080"), {
    mode: "custom",
    proxy: { server: "socks5://127.0.0.1:1080" }
  });
  // A bare host:port is treated as an HTTP proxy for convenience.
  assert.deepEqual(parseBrowserProxySetting("127.0.0.1:7890"), {
    mode: "custom",
    proxy: { server: "http://127.0.0.1:7890" }
  });
  assert.deepEqual(parseBrowserProxySetting("http://user:pass@127.0.0.1:7890"), {
    mode: "custom",
    proxy: { server: "http://127.0.0.1:7890", username: "user", password: "pass" }
  });
  assert.throws(() => parseBrowserProxySetting("ftp://127.0.0.1:7890"), /socks5/);
  assert.throws(() => parseBrowserProxySetting("http://127.0.0.1"), /端口/);
  assert.throws(() => parseBrowserProxySetting("http://[bad"), /无效/);
});

test("browser status reports the configured network exit and survives a bad stored value", () => {
  const options = { dataDirectory: "." };
  const direct = new XianyuBrowser({ ...options, proxyResolver: () => "direct" });
  assert.equal(direct.status().network, "直连（不使用代理）");
  const custom = new XianyuBrowser({ ...options, proxyResolver: () => "socks5://127.0.0.1:1080" });
  assert.match(custom.status().network, /socks5:\/\/127\.0\.0\.1:1080/);
  const system = new XianyuBrowser({ ...options, proxyResolver: () => "" });
  assert.equal(system.status().network, "跟随系统代理");
  const broken = new XianyuBrowser({ ...options, proxyResolver: () => "not a proxy" });
  assert.equal(broken.status().network, "跟随系统代理");
  const throwing = new XianyuBrowser({ ...options, proxyResolver: () => { throw new Error("db down"); } });
  assert.equal(throwing.status().network, "跟随系统代理");
});
