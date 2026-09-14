import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { XianyuBrowser } from "../src/browser.js";

test("Edge uses a persistent profile separate from the existing Chrome profile", () => {
  const dataDirectory = resolve("fixture-data");
  const chrome = new XianyuBrowser({
    dataDirectory, executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  });
  const options = {
    dataDirectory, executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  };
  const edge = new XianyuBrowser(options);
  assert.equal(chrome.profileDirectory, resolve(dataDirectory, "chrome-profile"));
  assert.equal(edge.profileDirectory, resolve(dataDirectory, "edge-profile"));
  assert.equal(new XianyuBrowser(options).profileDirectory, edge.profileDirectory);
  assert.equal(chrome.status().browserName, "Google Chrome");
  assert.equal(edge.status().browserName, "Microsoft Edge");
  assert.equal(edge.status().executablePath, options.executablePath);
  assert.equal(edge.status().browserOpen, false);
});

test("Edge detection handles filename case and forward slashes without matching parent names", () => {
  for (const executablePath of ["C:/Edge/MSEDGE.EXE", "/opt/microsoft/msedge/msedge"]) {
    const browser = new XianyuBrowser({ dataDirectory: ".", executablePath });
    assert.equal(browser.profileDirectory, resolve("edge-profile"));
    assert.equal(browser.status().browserName, "Microsoft Edge");
  }
  const chrome = new XianyuBrowser({
    dataDirectory: ".", executablePath: "C:/msedge.exe/chrome.exe"
  });
  assert.equal(chrome.profileDirectory, resolve("chrome-profile"));
});

test("a configured Edge executable is selected and an invalid override never falls back to Chrome", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xianyu-browser-selection-"));
  const original = process.env.XIANYU_BROWSER_PATH;
  t.after(() => {
    if (original === undefined) {
      delete process.env.XIANYU_BROWSER_PATH;
    } else {
      process.env.XIANYU_BROWSER_PATH = original;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const executablePath = join(directory, "msedge.exe");
  writeFileSync(executablePath, "");
  process.env.XIANYU_BROWSER_PATH = executablePath;
  const edge = new XianyuBrowser({ dataDirectory: directory });
  assert.equal(edge.executablePath, executablePath);
  assert.equal(edge.profileDirectory, resolve(directory, "edge-profile"));
  process.env.XIANYU_BROWSER_PATH = join(directory, "missing.exe");
  const unavailable = new XianyuBrowser({ dataDirectory: directory });
  assert.equal(unavailable.status().available, false);
  assert.equal(unavailable.status().browserName, "");
});

test("switchBrowser closes the current session and selects the other browser profile", async () => {
  const browser = new XianyuBrowser({
    dataDirectory: ".",
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    alternateExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  });
  let closed = 0;
  browser.context = { close: async () => { closed += 1; } };
  const status = await browser.switchBrowser();
  assert.equal(closed, 1);
  assert.equal(status.browserName, "Google Chrome");
  assert.equal(status.alternateBrowserName, "Microsoft Edge");
  assert.equal(status.canSwitch, true);
  assert.equal(status.browserOpen, false);
  assert.equal(browser.profileDirectory, resolve("chrome-profile"));
});
