// Pure helpers for the bot playtest: turn run results (pl:bot-result) into difficulty stats.

export const OUTCOMES = ["won", "lost", "stuck", "timeout", "error"];

/** Win rate in % → label shown to the user. */
export function difficultyLabel(winRate) {
  if (winRate >= 80) return "Easy";
  if (winRate >= 50) return "Medium";
  if (winRate >= 20) return "Hard";
  return "Very hard";
}

const average = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
const isNumber = (n) => typeof n === "number" && Number.isFinite(n);

/** Distinct error messages with how often they happened, most frequent first. */
export function countErrors(results) {
  const counts = new Map();
  for (const r of results) {
    // The same message repeated within one run counts once for that run.
    for (const message of new Set((r.errors || []).map(String))) counts.set(message, (counts.get(message) || 0) + 1);
  }
  return [...counts].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}

/**
 * results: [{ outcome, steps, movesLeft, goalsLeft, errors, ms }] →
 * { runs, wins, winRate, label, avgMovesLeft, avgSteps, outcomes, errors: [{ message, count }] }
 * winRate is a whole percentage; avgMovesLeft counts wins only (null when there are none).
 */
export function aggregate(results) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of results) {
    const outcome = OUTCOMES.includes(r.outcome) ? r.outcome : "error";
    outcomes[outcome]++;
  }
  const runs = results.length;
  const wins = outcomes.won;
  const completed = outcomes.won + outcomes.lost;
  const winRate = completed ? Math.round((wins / completed) * 100) : 0;
  const winsList = results.filter((r) => r.outcome === "won");
  return {
    runs,
    completed,
    wins,
    winRate,
    label: completed ? difficultyLabel(winRate) : null,
    avgMovesLeft: average(winsList.map((r) => r.movesLeft).filter(isNumber)),
    avgSteps: average(results.map((r) => r.steps).filter(isNumber)),
    outcomes,
    errors: countErrors(results)
  };
}

/** The compact object the caller stores for a variant after a difficulty playtest. */
export function difficultySummary(stats, { releaseId, revision, strategy, speed }) {
  return {
    releaseId,
    revision,
    runs: stats.runs,
    wins: stats.wins,
    winRate: stats.winRate,
    label: stats.label,
    avgMovesLeft: stats.avgMovesLeft,
    avgSteps: stats.avgSteps,
    outcomes: stats.outcomes,
    errors: stats.errors.slice(0, 5).map((e) => e.message),
    strategy,
    speed
  };
}

/** Release check: one short run → "ok" | "error" | "unsupported" (+ the first error message). */
export function checkStatus(result) {
  if (!result || result.outcome === "unsupported") return { check: "unsupported" };
  const message = result.errors?.[0];
  if (result.outcome === "error" || message) return { check: "error", error: String(message || "Unknown error") };
  if (["won", "lost", "checked"].includes(result.outcome)) return { check: "ok" };
  return {
    check: "error",
    error:
      result.outcome === "stuck"
        ? "No legal moves / game stuck"
        : "Playtest did not complete (timeout or invalid result)"
  };
}
