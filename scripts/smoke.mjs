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
  PRAYER_SETTINGS_KEY,
  mergeDoneMaps,
  parseDoneMap,
  checkOffPrayer,
  injectCurrentPrayer,
  applyCloudBlobWithDoneMerge,
  habitExpired,
  ledgerSaveCalculate,
  isDone,
  pruneCompletedAutoTodos,
  duePrayerNames,
  stripDoneIdsForOpenItems,
  collectOpenAutoIds,
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

const TIMES = { Fajr: "05:30", Dhuhr: "13:00", Asr: "16:30", Maghrib: "19:00", Isha: "20:30" };
const DATE = "2026-10-02";
const SYNC_KEYS = [
  TODOS_KEY,
  PRAYER_SETTINGS_KEY,
  PRAYER_DONE_KEY,
  HABIT_DONE_KEY,
];

console.log("\n1) check off prayer → inject again → must not reappear");
{
  const nowMins = 14 * 60; // mid-Dhuhr window
  let items = [
    { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
  ];
  let prayerDone = {};
  const off = checkOffPrayer(items, prayerDone, 0);
  items = off.items;
  prayerDone = off.prayerDone;
  assert(isDone(prayerDone, DATE, "Dhuhr"), "Dhuhr recorded in prayer-done map");
  assert(!items.some((it) => it.prayer === "Dhuhr"), "Dhuhr removed from todos on check-off");
  items = injectCurrentPrayer(items, {
    times: TIMES,
    date: DATE,
    nowMins,
    autoTodos: true,
    prayerDone,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "inject must not re-add checked-off Dhuhr");
}

console.log("\n2) brush miss windows");
{
  assert(
    !habitExpired("brush-am", "2026-10-02", "2026-10-02", 12 * 60, TIMES),
    "brush-am not expired before Dhuhr same day"
  );
  assert(
    habitExpired("brush-am", "2026-10-02", "2026-10-02", 13 * 60, TIMES),
    "brush-am expires at Dhuhr same day"
  );
  assert(
    habitExpired("brush-am", "2026-10-01", "2026-10-02", 8 * 60, TIMES),
    "brush-am from yesterday is expired"
  );
  assert(
    !habitExpired("brush-pm", "2026-10-02", "2026-10-02", 23 * 60, TIMES),
    "brush-pm not expired same calendar day"
  );
  assert(
    !habitExpired("brush-pm", "2026-10-01", "2026-10-02", 5 * 60, TIMES),
    "brush-pm from yesterday survives until today's Fajr"
  );
  assert(
    habitExpired("brush-pm", "2026-10-01", "2026-10-02", 5 * 60 + 30, TIMES),
    "brush-pm from yesterday expires at today's Fajr"
  );
  assert(
    habitExpired("brush-pm", "2026-09-30", "2026-10-02", 1 * 60, TIMES),
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
  const local = {
    [TODOS_KEY]: JSON.stringify([]), // already checked off
    [PRAYER_DONE_KEY]: JSON.stringify({ [DATE]: ["Dhuhr"] }),
    [PRAYER_SETTINGS_KEY]: JSON.stringify({
      autoTodos: true,
      lastDate: DATE,
      times: TIMES,
    }),
  };
  // Stale cloud: still has Dhuhr todo + empty done map (as if pre-check-off snapshot)
  const cloudKeys = {
    [TODOS_KEY]: JSON.stringify([
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
    ]),
    [PRAYER_DONE_KEY]: JSON.stringify({}),
  };
  const merged = applyCloudBlobWithDoneMerge(local, cloudKeys, SYNC_KEYS);
  const done = parseDoneMap(merged[PRAYER_DONE_KEY]);
  assert(isDone(done, DATE, "Dhuhr"), "merge keeps local Dhuhr done flag over empty cloud");
  const todos = JSON.parse(merged[TODOS_KEY]);
  assert(!todos.some((it) => it.prayer === "Dhuhr"), "prune strips Dhuhr restored from stale cloud todos");

  // Empty cloud blob keys that would wipe done if naively overwritten
  const emptyCloud = {
    [TODOS_KEY]: "[]",
    [PRAYER_DONE_KEY]: "{}",
  };
  const afterEmpty = applyCloudBlobWithDoneMerge(local, emptyCloud, SYNC_KEYS);
  const done2 = parseDoneMap(afterEmpty[PRAYER_DONE_KEY]);
  assert(isDone(done2, DATE, "Dhuhr"), "empty cloud prayer-done must not wipe local done flags");
  let items = JSON.parse(afterEmpty[TODOS_KEY] || "[]");
  items = injectCurrentPrayer(items, {
    times: TIMES,
    date: DATE,
    nowMins: 14 * 60,
    autoTodos: true,
    prayerDone: done2,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "after empty-cloud merge, inject must not re-add Dhuhr");
}

console.log("\n5) due Dhuhr appears when not checked; unpaid others still show");
{
  const nowMins = 14 * 60; // Dhuhr window
  // Empty list + empty done → inject must add Fajr + Dhuhr (both due, unpaid)
  let items = injectCurrentPrayer([], {
    times: TIMES,
    date: DATE,
    nowMins,
    autoTodos: true,
    prayerDone: {},
  });
  assert(items.some((it) => it.prayer === "Dhuhr"), "due Dhuhr appears when not checked off");
  assert(items.some((it) => it.prayer === "Fajr"), "unpaid earlier Fajr still shows after Dhuhr due");
  assert(!items.some((it) => it.prayer === "Asr"), "future Asr must not appear yet");

  // After check-off, Dhuhr stays gone; Fajr unpaid remains
  const dhuhrIdx = items.findIndex((it) => it.prayer === "Dhuhr");
  const off = checkOffPrayer(items, {}, dhuhrIdx);
  items = injectCurrentPrayer(off.items, {
    times: TIMES,
    date: DATE,
    nowMins,
    autoTodos: true,
    prayerDone: off.prayerDone,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "after check, Dhuhr stays gone");
  assert(items.some((it) => it.prayer === "Fajr"), "unpaid Fajr still shows after Dhuhr check-off");

  // Later in Asr window: unpaid Dhuhr (never checked) must still be injected
  let asrItems = injectCurrentPrayer([], {
    times: TIMES,
    date: DATE,
    nowMins: 17 * 60,
    autoTodos: true,
    prayerDone: { [DATE]: ["Fajr"] }, // only Fajr paid
  });
  assert(asrItems.some((it) => it.prayer === "Dhuhr"), "unpaid Dhuhr still shows during Asr window");
  assert(asrItems.some((it) => it.prayer === "Asr"), "due Asr appears");
  assert(!asrItems.some((it) => it.prayer === "Fajr"), "checked-off Fajr does not reappear at Asr");
}

console.log("\n6) stale cloud done must not prune locally-open Dhuhr");
{
  // Local still has open Dhuhr (user has NOT checked off). Stale cloud claims Dhuhr done + empty todos.
  const local = {
    [TODOS_KEY]: JSON.stringify([
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
      { text: "Salah · Fajr", done: false, kind: "prayer", prayer: "Fajr", time: "05:30", date: DATE },
    ]),
    [PRAYER_DONE_KEY]: JSON.stringify({}), // local never checked
    [PRAYER_SETTINGS_KEY]: JSON.stringify({ autoTodos: true, lastDate: DATE, times: TIMES }),
  };
  const staleCloud = {
    [TODOS_KEY]: "[]",
    [PRAYER_DONE_KEY]: JSON.stringify({ [DATE]: ["Dhuhr", "Fajr"] }), // stale/wrong
    [PRAYER_SETTINGS_KEY]: JSON.stringify({ autoTodos: true, lastDate: "2026-10-01", times: null }),
  };
  const merged = applyCloudBlobWithDoneMerge(local, staleCloud, SYNC_KEYS);
  const done = parseDoneMap(merged[PRAYER_DONE_KEY]);
  assert(!isDone(done, DATE, "Dhuhr"), "stale cloud must not mark open local Dhuhr as done");
  assert(!isDone(done, DATE, "Fajr"), "stale cloud must not mark open local Fajr as done");

  // Todos wiped by cloud — inject must restore due unpaid
  let items = JSON.parse(merged[TODOS_KEY] || "[]");
  assert(!items.some((it) => it.prayer === "Dhuhr"), "cloud empty todos wiped list before inject");
  const settings = JSON.parse(merged[PRAYER_SETTINGS_KEY]);
  assert(settings.lastDate === DATE && settings.times, "local today's prayer times kept over stale cloud");
  items = injectCurrentPrayer(items, {
    times: settings.times || TIMES,
    date: DATE,
    nowMins: 14 * 60,
    autoTodos: true,
    prayerDone: done,
  });
  assert(items.some((it) => it.prayer === "Dhuhr"), "after stale-cloud apply, due Dhuhr reappears");
  assert(items.some((it) => it.prayer === "Fajr"), "after stale-cloud apply, unpaid Fajr reappears");

  // prune must not remove undoned
  const kept = pruneCompletedAutoTodos(
    [
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
    ],
    {},
    {}
  );
  assert(kept.some((it) => it.prayer === "Dhuhr"), "prune must not remove undoned Dhuhr");
}

console.log("\n7) index.html wiring checks");
{
  assertIncludes(indexHtml, "mergeDoneMaps", "index.html defines/uses mergeDoneMaps");
  assertIncludes(indexHtml, "stripDoneIdsForOpenItems", "index.html defines/uses stripDoneIdsForOpenItems");
  assertIncludes(indexHtml, "duePrayerNames", "index.html defines/uses duePrayerNames");
  assertIncludes(indexHtml, "pruneCompletedAutoTodos", "index.html defines/uses pruneCompletedAutoTodos");
  assertIncludes(indexHtml, "todo-app-prayer-done-v1", "prayer-done key present");
  assert(
    /todo-app-prayer-done-v1[\s\S]{0,400}mergeDoneMaps/.test(indexHtml) ||
      /mergeDoneMaps[\s\S]{0,400}todo-app-prayer-done-v1/.test(indexHtml),
    "apply path associates prayer-done with mergeDoneMaps"
  );
  assertIncludes(indexHtml, "stripDoneIdsForOpenItems(merged", "apply reconciles open local todos against merged done");
  assert(
    duePrayerNames(TIMES, 14 * 60).join(",") === "Fajr,Dhuhr",
    "duePrayerNames at 14:00 is Fajr,Dhuhr"
  );
  const open = collectOpenAutoIds([
    { kind: "prayer", prayer: "Dhuhr", date: DATE, done: false },
  ]);
  const stripped = stripDoneIdsForOpenItems({ [DATE]: ["Dhuhr", "Asr"] }, open.prayer);
  assert(!stripped[DATE].includes("Dhuhr") && stripped[DATE].includes("Asr"), "strip removes only open ids");
}

console.log(`\nSmoke result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
