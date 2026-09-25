import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobs } from "../server/jobs.js";
test("jobs persist results and mark interrupted work failed after restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-jobs-"));
  try {
    const jobs = createJobs(dir);
    const done = jobs.create({ gameId: "g" });
    done.state = "done";
    done.results = [{ variantId: 1 }];
    const running = jobs.create({ gameId: "g" });
    running.state = "running";
    const restarted = createJobs(dir);
    assert.deepEqual(restarted.get(done.id).results, [{ variantId: 1 }]);
    assert.equal(restarted.get(running.id).state, "failed");
    assert.match(restarted.get(running.id).error, /restarted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
