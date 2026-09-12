import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { XianyuBrowser } from "../src/browser.js";

const executablePath = new XianyuBrowser({ dataDirectory: "." }).executablePath;
let chrome;

before(async () => {
  if (executablePath) {
    chrome = await chromium.launch({ executablePath, headless: true });
  }
});
after(async () => chrome?.close());

async function fixture(t, {
  url = "https://www.goofish.com/search?q=gpu",
  html = "<body>Search results</body>",
  frameHtml = "<body>Challenge</body>"
} = {}) {
  const context = await chrome.newContext({ serviceWorkers: "block" });
  t.after(() => context.close());
  const requests = [];
  await context.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().isNavigationRequest() && route.request().frame().parentFrame()
        ? frameHtml
        : html
    });
  });
  await context.addCookies([{ name: "unb", value: "test-user", domain: ".goofish.com", path: "/" }]);
  const page = await context.newPage();
  await page.goto(url);
  const browser = new XianyuBrowser({ dataDirectory: "." });
  browser.context = context;
  browser.page = page;
  return { browser, context, page, requests };
}

const browserTest = (name, callback) => test(name, { skip: !executablePath }, callback);

browserTest("verification redirect URL is not accepted as logged in", async (t) => {
  const { browser } = await fixture(t, { url: "https://sec.taobao.com/query.htm" });
  assert.equal((await browser.verifyLogin()).state, "waiting_for_verification");
});

browserTest("a hidden first mask cannot hide a second visible verification mask", async (t) => {
  const { browser } = await fixture(t, {
    html: '<body><div class="baxia-dialog-mask" hidden></div><div class="baxia-dialog-mask" style="width:100px;height:100px"></div></body>'
  });
  assert.equal((await browser.verifyLogin()).state, "waiting_for_verification");
});

browserTest("visible cross-origin challenge iframe blocks verification", async (t) => {
  const { browser } = await fixture(t, {
    html: '<body>Results<iframe src="https://sec.taobao.com/challenge"></iframe></body>'
  });
  assert.equal((await browser.verifyLogin()).state, "waiting_for_verification");
});

browserTest("a hidden dormant challenge iframe does not block verification", async (t) => {
  const { browser } = await fixture(t, {
    html: '<body>Results<iframe hidden src="https://sec.taobao.com/challenge"></iframe></body>'
  });
  assert.equal((await browser.verifyLogin()).state, "verified");
});

browserTest("cookies on a blank page cannot confirm login", async (t) => {
  const { browser } = await fixture(t, { url: "about:blank" });
  assert.notEqual((await browser.verifyLogin()).state, "verified");
});

browserTest("login redirect is reported as login expiry, not a usable session", async (t) => {
  const { browser } = await fixture(t, { url: "https://login.taobao.com/member/login.jhtml" });
  assert.equal((await browser.verifyLogin()).state, "waiting_for_login");
});

browserTest("scan preserves an existing challenge without issuing any new request", async (t) => {
  const { browser, page, requests } = await fixture(t, {
    url: "https://sec.taobao.com/query.htm"
  });
  const count = requests.length;
  page.goto = async () => { throw new Error("Unexpected navigation"); };
  await assert.rejects(browser.scan({ keyword: "gpu" }), /验证/);
  assert.equal(requests.length, count);
  assert.equal(page.url(), "https://sec.taobao.com/query.htm");
});

browserTest("open login preserves the challenge and the tracked tab", async (t) => {
  const { browser, context, page, requests } = await fixture(t);
  const challenge = await context.newPage();
  await challenge.goto("https://sec.taobao.com/query.htm");
  browser.page = challenge;
  const count = requests.length;
  await browser.openLogin();
  assert.ok(browser.page === challenge);
  assert.equal(challenge.url(), "https://sec.taobao.com/query.htm");
  assert.equal(requests.length, count);
  assert.equal(page.url(), "https://www.goofish.com/search?q=gpu");
});

browserTest("verification in another relevant tab cannot be ignored", async (t) => {
  const { browser, context } = await fixture(t);
  const challenge = await context.newPage();
  await challenge.goto("https://sec.taobao.com/query.htm");
  assert.equal((await browser.verifyLogin()).state, "waiting_for_verification");
  assert.ok(browser.page === challenge);
});

browserTest("search keywords containing captcha are not verification redirects", async (t) => {
  const { browser } = await fixture(t, { url: "https://www.goofish.com/search?q=captcha" });
  assert.equal((await browser.verifyLogin()).state, "verified");
});

const searchPayload = {
  ret: ["SUCCESS::ok"],
  data: { resultList: [{ data: { item: { main: { exContent: {
    itemId: "fixture-gpu", title: "GPU", detailParams: { soldPrice: "800" }
  } } } } }] }
};

async function scanFixture(t, { payload = searchPayload, status = 200 } = {}) {
  const result = await fixture(t, {
    html: `<body>
      <span hidden>\u65b0\u53d1\u5e03</span>
      <button onclick="document.querySelector('#latest').hidden=false">\u65b0\u53d1\u5e03</button>
      <span hidden>\u6700\u65b0</span>
      <button id="latest" hidden onclick="fetch('/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/')">\u6700\u65b0</button>
    </body>`
  });
  await result.context.route("**/h5/mtop.taobao.idlemtopsearch.pc.search/**", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })
  );
  result.page.waitForTimeout = async () => {};
  return result;
}

browserTest("a successful scan clicks visible sort options and parses the response", async (t) => {
  const { browser } = await scanFixture(t);
  const listings = await browser.scan({ keyword: "gpu" });
  assert.equal(listings.length, 1);
  assert.equal(listings[0].itemId, "fixture-gpu");
  assert.equal(browser.status().state, "verified");
});

browserTest("a challenge appearing during the search gap prevents navigation", async (t) => {
  const { browser, page, requests } = await fixture(t);
  browser.lastSearchStartedAt = Date.now();
  page.waitForTimeout = async () => {
    await page.setContent('<body><div class="baxia-dialog-mask" style="height:100px">Check</div></body>');
  };
  const count = requests.length;
  await assert.rejects(browser.scan({ keyword: "gpu" }), /验证/);
  assert.equal(requests.length, count);
});

browserTest("sort click failure removes pending response listeners", async (t) => {
  const { browser, page } = await scanFixture(t);
  const getByText = page.getByText.bind(page);
  page.getByText = (text, options) => text === "\u6700\u65b0"
    ? {
      filter() { return this; },
      first() { return this; },
      click: async () => { throw new Error("sort click failed"); }
    }
    : getByText(text, options);
  const count = page.listenerCount("response");
  await assert.rejects(browser.scan({ keyword: "gpu" }), /sort click failed/);
  assert.equal(page.listenerCount("response"), count);
  await page.close();
});

browserTest("search API verification responses are not treated as missing prices", async (t) => {
  const { browser } = await scanFixture(t, {
    payload: { ret: ["FAIL_SYS_USER_VALIDATE::verification required"], data: {} }
  });
  await assert.rejects(browser.scan({ keyword: "gpu" }), /验证/);
  assert.equal(browser.status().state, "waiting_for_verification");
});

browserTest("search API expired sessions pause for login", async (t) => {
  const { browser } = await scanFixture(t, {
    payload: { ret: ["FAIL_SYS_SESSION_EXPIRED::expired"], data: {} }
  });
  await assert.rejects(browser.scan({ keyword: "gpu" }), /登录/);
  assert.equal(browser.status().state, "waiting_for_login");
});

browserTest("HTTP rate limiting pauses before interpreting the response body", async (t) => {
  const { browser } = await scanFixture(t, { status: 429 });
  await assert.rejects(browser.scan({ keyword: "gpu" }), /验证/);
  assert.equal(browser.status().state, "waiting_for_verification");
});

browserTest("closing a scanning browser never automatically retries the search", async (t) => {
  const { browser, page } = await scanFixture(t);
  let navigations = 0;
  page.goto = async () => {
    navigations += 1;
    throw new Error("Target page, context or browser has been closed");
  };
  await assert.rejects(browser.scan({ keyword: "gpu" }), /浏览器已关闭/);
  assert.equal(navigations, 1);
  assert.equal(browser.status().state, "waiting_for_login");
});
