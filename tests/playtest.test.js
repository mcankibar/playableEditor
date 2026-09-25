import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  checkStatus,
  countErrors,
  difficultyLabel,
  difficultySummary
} from "../web/src/components/playtestStats.js";

test("difficulty label thresholds", () => {
  assert.equal(difficultyLabel(100), "Easy");
  assert.equal(difficultyLabel(80), "Easy");
  assert.equal(difficultyLabel(79), "Medium");
  assert.equal(difficultyLabel(50), "Medium");
  assert.equal(difficultyLabel(49), "Hard");
  assert.equal(difficultyLabel(20), "Hard");
  assert.equal(difficultyLabel(19), "Very hard");
  assert.equal(difficultyLabel(0), "Very hard");
});

test("aggregate counts outcomes and averages", () => {
  const stats = aggregate([
    { outcome: "won", steps: 10, movesLeft: 4, errors: [] },
    { outcome: "won", steps: 12, movesLeft: 1, errors: [] },
    { outcome: "lost", steps: 20, movesLeft: 0, errors: [] },
    { outcome: "error", steps: 3, movesLeft: 17, errors: ["boom", "boom"] },
    { outcome: "weird", steps: null, errors: ["boom", "other"] }
  ]);
  assert.equal(stats.runs, 5);
  assert.equal(stats.wins, 2);
  assert.equal(stats.winRate, 40);
  assert.equal(stats.label, "Hard");
  assert.equal(stats.avgMovesLeft, 2.5);
  assert.equal(stats.avgSteps, 11.3);
  assert.deepEqual(stats.outcomes, { won: 2, lost: 1, stuck: 0, timeout: 0, error: 2 });
  assert.deepEqual(stats.errors, [
    { message: "boom", count: 2 },
    { message: "other", count: 1 }
  ]);
});

test("aggregate of nothing / no wins", () => {
  const empty = aggregate([]);
  assert.equal(empty.winRate, 0);
  assert.equal(empty.label, null);
  assert.equal(empty.avgSteps, null);
  const lost = aggregate([{ outcome: "lost", steps: 5, movesLeft: 0 }]);
  assert.equal(lost.avgMovesLeft, null);
  assert.equal(lost.label, "Very hard");
});

test("summary keeps the first 5 distinct errors", () => {
  const results = Array.from({ length: 7 }, (_, i) => ({ outcome: "error", steps: 1, errors: [`e${i}`] }));
  const summary = difficultySummary(aggregate(results), { releaseId: 3, revision: 9, strategy: "greedy", speed: 8 });
  assert.deepEqual(summary.errors, ["e0", "e1", "e2", "e3", "e4"]);
  assert.equal(summary.releaseId, 3);
  assert.equal(summary.revision, 9);
  assert.equal(summary.runs, 7);
  assert.equal(summary.label, "Very hard");
  assert.deepEqual(countErrors([{ errors: ["a"] }, { errors: ["a"] }]), [{ message: "a", count: 2 }]);
});

test("release check status", () => {
  assert.deepEqual(checkStatus({ outcome: "timeout", errors: [] }), { check: "ok" });
  assert.deepEqual(checkStatus({ outcome: "won", errors: [] }), { check: "ok" });
  assert.deepEqual(checkStatus({ outcome: "error", errors: ["x"] }), { check: "error", error: "x" });
  assert.deepEqual(checkStatus({ outcome: "timeout", errors: ["late"] }), { check: "error", error: "late" });
  assert.deepEqual(checkStatus({ outcome: "error", errors: [] }), { check: "error", error: "Unknown error" });
  assert.deepEqual(checkStatus({ outcome: "unsupported" }), { check: "unsupported" });
});
