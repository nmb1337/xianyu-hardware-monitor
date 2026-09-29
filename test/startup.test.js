import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("server loads PORT from its .env before listening", { timeout: 15_000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const root = mkdtempSync(join(tmpdir(), "xianyu-startup-"));
  let child;
  let exited;
  try {
    const source = fileURLToPath(new URL("../src", import.meta.url));
    cpSync(source, join(root, "src"), { recursive: true });
    cpSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, ".env"), `PORT=${port}\n`);
    const env = { ...process.env };
    delete env.PORT;
    child = spawn(process.execPath, [join(root, "src/server.js")], {
      cwd: root,
      env: { ...env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`Server did not start: ${output}`));
      }, 10_000);
      const poll = setInterval(() => {
        if (output.includes(`http://127.0.0.1:${port}`)) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        } else if (child.exitCode !== null) {
          clearTimeout(timeout);
          clearInterval(poll);
          reject(new Error(`Server exited early: ${output}`));
        }
      }, 50);
      child.once("error", (error) => {
        clearTimeout(timeout);
        clearInterval(poll);
        reject(error);
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(3_000)
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).running, false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
