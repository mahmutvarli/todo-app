#!/usr/bin/env node
/**
 * Regression smoke tests for prayer done persistence, brush windows,
 * ledger confirm, and cloud merge behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRAYER_DONE_KEY,
  HABIT_DONE_KEY,
  TODOS_KEY,
  mergeDoneMaps,
  parseDoneMap,
  checkOffPrayer,
  injectCurrentPrayer,
  applyCloudBlobWithDoneMerge,
  habitExpired,
  ledgerSaveCalculate,
  isDone,
} from "./todo-logic.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ok  —", msg);
  } else {
    failed++;
    console.error("  FAIL —", msg);
  }
}

function assertIncludes(hay, needle, msg) {
  assert(hay.includes(needle), msg + ` (missing: ${JSON.stringify(needle).slice(0, 80)})`);
}

console.log("\n1) check off prayer → inject again → must not reappear");
{
  const date = "2026-10-02";
  const times = { Fajr: "05:30", Dhuhr: "13:00", Asr: "16:30", Maghrib: "19:00", Isha: "20:30" };
  const nowMins = 14 * 60; // mid-Dhuhr window
  let items = [
    { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date },
  ];
  let prayerDone = {};
  const off = checkOffPrayer(items, prayerDone, 0);
  items = off.items;
  prayerDone = off.prayerDone;
  assert(isDone(prayerDone, date, "Dhuhr"), "Dhuhr recorded in prayer-done map");
  assert(!items.some((it) => it.prayer === "Dhuhr"), "Dhuhr removed from todos on check-off");
  items = injectCurrentPrayer(items, {
    times,
    date,
    nowMins,
    autoTodos: true,
    prayerDone,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "inject must not re-add checked-off Dhuhr");
}

console.log("\n2) brush miss windows");
{
  const times = { Fajr: "05:30", Dhuhr: "13:00", Asr: "16:30", Maghrib: "19:00", Isha: "20:30" };
  assert(
    !habitExpired("brush-am", "2026-10-02", "2026-10-02", 12 * 60, times),
    "brush-am not expired before Dhuhr same day"
  );
  assert(
    habitExpired("brush-am", "2026-10-02", "2026-10-02", 13 * 60, times),
    "brush-am expires at Dhuhr same day"
  );
  assert(
    habitExpired("brush-am", "2026-10-01", "2026-10-02", 8 * 60, times),
    "brush-am from yesterday is expired"
  );
  assert(
    !habitExpired("brush-pm", "2026-10-02", "2026-10-02", 23 * 60, times),
    "brush-pm not expired same calendar day"
  );
  assert(
    !habitExpired("brush-pm", "2026-10-01", "2026-10-02", 5 * 60, times),
    "brush-pm from yesterday survives until today's Fajr"
  );
  assert(
    habitExpired("brush-pm", "2026-10-01", "2026-10-02", 5 * 60 + 30, times),
    "brush-pm from yesterday expires at today's Fajr"
  );
  assert(
    habitExpired("brush-pm", "2026-09-30", "2026-10-02", 1 * 60, times),
    "brush-pm older than 1 day is expired"
  );
}

console.log("\n3) ledger save confirm");
{
  const L = {
    bday: "2000-01-01",
    onTime: 40,
    makeup: 8,
    qadaRegistered: 3,
    qadaPending: { Fajr: 1 },
    trackingStartedAt: "2026-09-01",
  };
  const denied = ledgerSaveCalculate(L, "2026-10-02", false);
  assert(!denied.applied, "without confirm, calculate must not apply");
  assert(denied.L.onTime === 40 && denied.L.makeup === 8, "counters unchanged when not confirmed");
  const ok = ledgerSaveCalculate(L, "2026-10-02", true);
  assert(ok.applied, "with confirm, calculate applies");
  assert(ok.L.onTime === 0 && ok.L.makeup === 0, "counters reset to 0 after confirm");
  assert(ok.L.trackingStartedAt === "2026-10-02", "trackingStartedAt set to today");
  assertIncludes(
    indexHtml,
    "Save & calculate will reset the on-time (green) and made-up (orange)",
    "index.html still gates Save & calculate behind confirm()"
  );
}

console.log("\n4) cloud empty/stale blob must not wipe done flags / re-inject");
{
  const date = "2026-10-02";
  const times = { Fajr: "05:30", Dhuhr: "13:00", Asr: "16:30", Maghrib: "19:00", Isha: "20:30" };
  const SYNC_KEYS = [
    TODOS_KEY,
    "todo-app-prayer-settings-v1",
    PRAYER_DONE_KEY,
    HABIT_DONE_KEY,
  ];
  const local = {
    [TODOS_KEY]: JSON.stringify([]), // already checked off
    [PRAYER_DONE_KEY]: JSON.stringify({ [date]: ["Dhuhr"] }),
    "todo-app-prayer-settings-v1": JSON.stringify({
      autoTodos: true,
      lastDate: date,
      times,
    }),
  };
  // Stale cloud: still has Dhuhr todo + empty done map (as if pre-check-off snapshot)
  const cloudKeys = {
    [TODOS_KEY]: JSON.stringify([
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date },
    ]),
    [PRAYER_DONE_KEY]: JSON.stringify({}),
  };
  const merged = applyCloudBlobWithDoneMerge(local, cloudKeys, SYNC_KEYS);
  const done = parseDoneMap(merged[PRAYER_DONE_KEY]);
  assert(isDone(done, date, "Dhuhr"), "merge keeps local Dhuhr done flag over empty cloud");
  const todos = JSON.parse(merged[TODOS_KEY]);
  assert(!todos.some((it) => it.prayer === "Dhuhr"), "prune strips Dhuhr restored from stale cloud todos");

  // Empty cloud blob keys that would wipe done if naively overwritten
  const emptyCloud = {
    [TODOS_KEY]: "[]",
    [PRAYER_DONE_KEY]: "{}",
  };
  const afterEmpty = applyCloudBlobWithDoneMerge(local, emptyCloud, SYNC_KEYS);
  const done2 = parseDoneMap(afterEmpty[PRAYER_DONE_KEY]);
  assert(isDone(done2, date, "Dhuhr"), "empty cloud prayer-done must not wipe local done flags");
  let items = JSON.parse(afterEmpty[TODOS_KEY] || "[]");
  items = injectCurrentPrayer(items, {
    times,
    date,
    nowMins: 14 * 60,
    autoTodos: true,
    prayerDone: done2,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "after empty-cloud merge, inject must not re-add Dhuhr");
}

console.log("\n5) index.html wiring checks");
{
  assertIncludes(indexHtml, "mergeDoneMaps", "index.html defines/uses mergeDoneMaps");
  assertIncludes(indexHtml, "pruneCompletedAutoTodos", "index.html defines/uses pruneCompletedAutoTodos");
  assertIncludes(indexHtml, "todo-app-prayer-done-v1", "prayer-done key present");
  // ensure applyCloudBlob merges done keys rather than blind overwrite only
  assert(
    /todo-app-prayer-done-v1[\s\S]{0,400}mergeDoneMaps/.test(indexHtml) ||
      /mergeDoneMaps[\s\S]{0,400}todo-app-prayer-done-v1/.test(indexHtml),
    "apply path associates prayer-done with mergeDoneMaps"
  );
}

console.log(`\nSmoke result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
