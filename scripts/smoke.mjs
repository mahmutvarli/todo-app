#!/usr/bin/env node
/**
 * Serious regression suite for todo-app robustness.
 * Covers: todos CRUD + Tabata focus keys, salah inject/check/done,
 * brush windows (no bounce-add), archive/ledger/veli, auth/cloud merge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRAYER_DONE_KEY,
  HABIT_DONE_KEY,
  TODOS_KEY,
  PRAYER_SETTINGS_KEY,
  ARCHIVE_KEY,
  VELI_KEY,
  mergeDoneMaps,
  parseDoneMap,
  checkOffPrayer,
  checkOffHabit,
  deleteTodoItem,
  injectCurrentPrayer,
  applyCloudBlobWithDoneMerge,
  habitExpired,
  shouldAddHabit,
  releaseHabitsPure,
  ledgerSaveCalculate,
  isDone,
  pruneCompletedAutoTodos,
  duePrayerNames,
  stripDoneIdsForOpenItems,
  collectOpenAutoIds,
  chooseTodosAfterCloud,
  mergeVeliPoints,
  mergeArchives,
  todoFocusKey,
  findTodoByFocusKey,
  completionStatusPure,
  awardVeliPure,
  recordDone,
  HABIT_DEFS,
  upsertArchiveRow,
  backfillArchiveFromVeli,
  parseVeliAwardKey,
  statusFromVeliAwards,
  checkOffWithArchive,
  FARZ_RAKATS,
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
  if (hay.includes(needle)) assert(true, msg);
  else assert(false, msg + ` (missing: ${JSON.stringify(needle).slice(0, 100)})`);
}

const TIMES = { Fajr: "05:30", Dhuhr: "13:00", Asr: "16:30", Maghrib: "19:00", Isha: "20:30" };
const DATE = "2026-10-02";
const SYNC_KEYS = [
  TODOS_KEY,
  PRAYER_SETTINGS_KEY,
  PRAYER_DONE_KEY,
  HABIT_DONE_KEY,
  ARCHIVE_KEY,
  VELI_KEY,
];

console.log("\n=== 1) Todos: add / check / delete + Tabata focus keys ===");
{
  let items = [];
  items = [{ text: "Buy milk", done: false, id: "m1" }, ...items];
  assert(items.length === 1 && items[0].text === "Buy milk", "add manual todo");
  items[0].done = true;
  assert(items[0].done === true, "check manual todo");
  items[0].done = false;
  assert(items[0].done === false, "uncheck manual todo");

  items = [
    { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
    { text: "Buy milk", done: false, id: "m1" },
  ];
  const keyMilk = todoFocusKey(items[1]);
  const keyDhuhr = todoFocusKey(items[0]);
  assert(keyMilk === "todo:m1", "manual focus key uses id");
  assert(keyDhuhr === "prayer:" + DATE + ":Dhuhr", "prayer focus key stable");
  // Inject adds Fajr at front — indices shift but keys stay valid
  items = injectCurrentPrayer(items, {
    times: TIMES, date: DATE, nowMins: 14 * 60, autoTodos: true, prayerDone: {},
  });
  assert(findTodoByFocusKey(items, keyMilk)?.text === "Buy milk", "Tabata focus survives inject reorder");
  assert(findTodoByFocusKey(items, keyDhuhr)?.prayer === "Dhuhr", "Tabata prayer focus survives inject");

  // Delete prayer → recorded done, no bounce on inject
  const dhuhrIdx = items.findIndex((it) => it.prayer === "Dhuhr");
  const del = deleteTodoItem(items, {}, {}, dhuhrIdx);
  items = del.items;
  assert(!items.some((it) => it.prayer === "Dhuhr"), "delete removes Dhuhr from list");
  assert(isDone(del.prayerDone, DATE, "Dhuhr"), "delete records prayer done (no bounce)");
  items = injectCurrentPrayer(items, {
    times: TIMES, date: DATE, nowMins: 14 * 60, autoTodos: true, prayerDone: del.prayerDone,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "deleted Dhuhr does not reappear");

  assertIncludes(indexHtml, "todoFocusKey", "index.html has todoFocusKey");
  assertIncludes(indexHtml, "focusSel.value = key", "Tabata jump sets focus by key");
  assert(
    /recordDoneId\("todo-app-prayer-done-v1"/.test(indexHtml) &&
      /del\.onclick/.test(indexHtml),
    "delete path records prayer done"
  );
}

console.log("\n=== 2) Salah auto-inject: due unpaid, check stays done, no wipe ===");
{
  const nowMins = 14 * 60;
  let items = injectCurrentPrayer([], {
    times: TIMES, date: DATE, nowMins, autoTodos: true, prayerDone: {},
  });
  assert(items.some((it) => it.prayer === "Dhuhr"), "due Dhuhr appears when not checked");
  assert(items.some((it) => it.prayer === "Fajr"), "unpaid earlier Fajr still shows");
  assert(!items.some((it) => it.prayer === "Asr"), "future Asr must not appear yet");
  assert(
    duePrayerNames(TIMES, nowMins).join(",") === "Fajr,Dhuhr",
    "duePrayerNames at 14:00 is Fajr,Dhuhr"
  );

  // Check off Dhuhr
  let prayerDone = {};
  const dhuhrIdx = items.findIndex((it) => it.prayer === "Dhuhr");
  const off = checkOffPrayer(items, prayerDone, dhuhrIdx);
  items = off.items;
  prayerDone = off.prayerDone;
  assert(isDone(prayerDone, DATE, "Dhuhr"), "Dhuhr recorded in prayer-done map");
  assert(!items.some((it) => it.prayer === "Dhuhr"), "Dhuhr removed on check-off");
  items = injectCurrentPrayer(items, {
    times: TIMES, date: DATE, nowMins, autoTodos: true, prayerDone,
  });
  assert(!items.some((it) => it.prayer === "Dhuhr"), "inject must not re-add checked-off Dhuhr");
  assert(items.some((it) => it.prayer === "Fajr"), "unpaid Fajr remains after Dhuhr check");

  // Asr window: unpaid Dhuhr still shows if never checked
  let asrItems = injectCurrentPrayer([], {
    times: TIMES, date: DATE, nowMins: 17 * 60, autoTodos: true,
    prayerDone: { [DATE]: ["Fajr"] },
  });
  assert(asrItems.some((it) => it.prayer === "Dhuhr"), "unpaid Dhuhr still shows during Asr");
  assert(asrItems.some((it) => it.prayer === "Asr"), "due Asr appears");
  assert(!asrItems.some((it) => it.prayer === "Fajr"), "checked-off Fajr does not reappear");

  // All five due at Isha
  const isha = injectCurrentPrayer([], {
    times: TIMES, date: DATE, nowMins: 21 * 60, autoTodos: true, prayerDone: {},
  });
  assert(
    ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].every((n) => isha.some((it) => it.prayer === n)),
    "all due Fajr…Isha appear when unpaid"
  );

  // completion status
  assert(completionStatusPure("Dhuhr", "13:00", 13 * 60 + 30, TIMES) === "on-time", "Dhuhr on-time before Asr");
  assert(completionStatusPure("Dhuhr", "13:00", 17 * 60, TIMES) === "late", "Dhuhr late after Asr");
}

console.log("\n=== 3) Habits brush: am miss at Dhuhr; pm miss after next Fajr; on-time ===");
{
  assert(!habitExpired("brush-am", DATE, DATE, 12 * 60, TIMES), "brush-am not expired before Dhuhr");
  assert(habitExpired("brush-am", DATE, DATE, 13 * 60, TIMES), "brush-am expires at Dhuhr");
  assert(habitExpired("brush-am", "2026-10-01", DATE, 8 * 60, TIMES), "brush-am yesterday expired");
  assert(!habitExpired("brush-pm", DATE, DATE, 23 * 60, TIMES), "brush-pm same day not expired");
  assert(!habitExpired("brush-pm", "2026-10-01", DATE, 5 * 60, TIMES), "brush-pm survives until Fajr");
  assert(habitExpired("brush-pm", "2026-10-01", DATE, 5 * 60 + 30, TIMES), "brush-pm expires at next Fajr");
  assert(habitExpired("brush-pm", "2026-09-30", DATE, 1 * 60, TIMES), "brush-pm older than 1 day expired");

  // Critical: do NOT add brush-am after Dhuhr (bounce → fake miss)
  assert(
    !shouldAddHabit("brush-am", "10:00", DATE, DATE, 14 * 60, TIMES, [], {}),
    "must not add brush-am after Dhuhr"
  );
  assert(
    shouldAddHabit("brush-am", "10:00", DATE, DATE, 11 * 60, TIMES, [], {}),
    "add brush-am mid-morning when due"
  );
  assert(
    !shouldAddHabit("brush-am", "10:00", DATE, DATE, 9 * 60, TIMES, [], {}),
    "must not add brush-am before 10:00"
  );

  // releaseHabitsPure after Dhuhr with empty list → no phantom miss archive
  const afterDhuhr = releaseHabitsPure([], {}, { date: DATE, nowMins: 14 * 60, times: TIMES });
  assert(
    !afterDhuhr.archived.some((a) => a.prayer === "brush-am"),
    "no phantom brush-am miss when never shown"
  );
  assert(!afterDhuhr.items.some((it) => it.habitId === "brush-am"), "brush-am not on list after Dhuhr");

  // Mid-morning: add; then at Dhuhr: expire to missed + done
  let r = releaseHabitsPure([], {}, { date: DATE, nowMins: 11 * 60, times: TIMES });
  assert(r.items.some((it) => it.habitId === "brush-am"), "brush-am added mid-morning");
  r = releaseHabitsPure(r.items, r.habitDone, { date: DATE, nowMins: 13 * 60, times: TIMES });
  assert(r.archived.some((a) => a.prayer === "brush-am" && a.status === "missed"), "brush-am miss-archived at Dhuhr");
  assert(isDone(r.habitDone, DATE, "brush-am"), "brush-am marked done after miss");
  assert(!r.items.some((it) => it.habitId === "brush-am"), "brush-am removed after miss");

  // On-time check-off
  let items = [
    { text: "Brush teeth (morning)", done: false, kind: "habit", habitId: "brush-am", time: "10:00", date: DATE },
  ];
  const off = checkOffHabit(items, {}, 0);
  assert(isDone(off.habitDone, DATE, "brush-am"), "on-time check records habit done");
  assert(!off.items.some((it) => it.habitId === "brush-am"), "on-time check removes habit");

  // Night brush: yesterday survives until Fajr, then misses
  const yest = "2026-10-01";
  let night = releaseHabitsPure(
    [{ text: "Brush teeth (night)", done: false, kind: "habit", habitId: "brush-pm", time: "22:00", date: yest }],
    {},
    { date: DATE, nowMins: 5 * 60, times: TIMES }
  );
  assert(night.items.some((it) => it.habitId === "brush-pm"), "brush-pm from yesterday kept before Fajr");
  night = releaseHabitsPure(night.items, night.habitDone, { date: DATE, nowMins: 5 * 60 + 30, times: TIMES });
  assert(night.archived.some((a) => a.prayer === "brush-pm"), "brush-pm miss after next Fajr");

  assertIncludes(indexHtml, "!habitExpiredFn(h.id, date)", "index refuses to add expired habits");
}

console.log("\n=== 4) Archive colors + Ledger + Veli idempotent ===");
{
  assertIncludes(indexHtml, ".arch-item.on-time", "archive CSS on-time");
  assertIncludes(indexHtml, ".arch-item.late", "archive CSS late");
  assertIncludes(indexHtml, ".arch-item.missed", "archive CSS missed");
  assertIncludes(indexHtml, 'statusColor', "archive status text colored");
  assertIncludes(indexHtml, "Save & calculate will reset the on-time (green) and made-up (orange)", "ledger confirm copy");

  const L = {
    bday: "2000-01-01",
    onTime: 40,
    makeup: 8,
    qadaRegistered: 3,
    qadaPending: { Fajr: 1 },
    trackingStartedAt: "2026-09-01",
  };
  const denied = ledgerSaveCalculate(L, DATE, false);
  assert(!denied.applied, "without confirm, calculate must not apply");
  assert(denied.L.onTime === 40 && denied.L.makeup === 8, "counters unchanged when not confirmed");
  const ok = ledgerSaveCalculate(L, DATE, true);
  assert(ok.applied, "with confirm, calculate applies");
  assert(ok.L.onTime === 0 && ok.L.makeup === 0, "counters reset to 0");
  assert(ok.L.qadaRegistered === 0, "qadaRegistered reset");
  assert(ok.L.trackingStartedAt === DATE, "trackingStartedAt set to today");

  // Veli idempotent
  let V = { total: 0, awarded: {} };
  let a1 = awardVeliPure(V, "salah-ontime:" + DATE + ":Dhuhr", 2);
  assert(a1.applied && a1.total === 2, "first Veli award applies");
  let a2 = awardVeliPure({ total: a1.total, awarded: a1.awarded }, "salah-ontime:" + DATE + ":Dhuhr", 2);
  assert(!a2.applied && a2.total === 2, "second identical Veli award is no-op");

  // Veli merge across devices
  const mergedV = mergeVeliPoints(
    JSON.stringify({ total: 2, awarded: { "salah-ontime:2026-10-02:Dhuhr": 2 } }),
    JSON.stringify({ total: 1, awarded: { "brush-ontime:2026-10-02:brush-am": 1 } })
  );
  assert(mergedV.awarded["salah-ontime:2026-10-02:Dhuhr"] === 2, "veli merge keeps local award");
  assert(mergedV.awarded["brush-ontime:2026-10-02:brush-am"] === 1, "veli merge keeps cloud award");
  assert(mergedV.total === 3, "veli total recomputed from union");

  // Archive merge by id
  const arch = mergeArchives(
    JSON.stringify([{ id: "a1", prayer: "Dhuhr", status: "on-time", completedAt: "2026-10-02T14:00:00Z" }]),
    JSON.stringify([
      { id: "a1", prayer: "Dhuhr", status: "late", completedAt: "2026-10-02T14:00:00Z" },
      { id: "a2", prayer: "Fajr", status: "on-time", completedAt: "2026-10-02T06:00:00Z" },
    ])
  );
  assert(arch.find((r) => r.id === "a1").status === "on-time", "archive merge: local wins same id");
  assert(arch.some((r) => r.id === "a2"), "archive merge: keeps cloud-only row");
}

console.log("\n=== 5) Auth/cloud: empty wipe blocked; done merge; open items survive ===");
{
  // Empty cloud must not wipe manual + open salah
  const local = {
    [TODOS_KEY]: JSON.stringify([
      { text: "Buy milk", done: false, id: "m1" },
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
    ]),
    [PRAYER_DONE_KEY]: JSON.stringify({}),
    [PRAYER_SETTINGS_KEY]: JSON.stringify({ autoTodos: true, lastDate: DATE, times: TIMES }),
  };
  const emptyCloud = { [TODOS_KEY]: "[]", [PRAYER_DONE_KEY]: "{}" };
  assert(
    chooseTodosAfterCloud(local[TODOS_KEY], "[]").some((t) => t.text === "Buy milk"),
    "chooseTodos keeps local when cloud empty"
  );
  const afterEmpty = applyCloudBlobWithDoneMerge(local, emptyCloud, SYNC_KEYS);
  const todosAfterEmpty = JSON.parse(afterEmpty[TODOS_KEY]);
  assert(todosAfterEmpty.some((t) => t.text === "Buy milk"), "empty cloud must not wipe Buy milk");
  assert(todosAfterEmpty.some((t) => t.prayer === "Dhuhr"), "empty cloud must not wipe open Dhuhr");

  // Stale cloud with Dhuhr todo + empty done; local already checked
  const localChecked = {
    [TODOS_KEY]: JSON.stringify([]),
    [PRAYER_DONE_KEY]: JSON.stringify({ [DATE]: ["Dhuhr"] }),
    [PRAYER_SETTINGS_KEY]: JSON.stringify({ autoTodos: true, lastDate: DATE, times: TIMES }),
  };
  const staleCloud = {
    [TODOS_KEY]: JSON.stringify([
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
    ]),
    [PRAYER_DONE_KEY]: JSON.stringify({}),
  };
  const merged = applyCloudBlobWithDoneMerge(localChecked, staleCloud, SYNC_KEYS);
  const done = parseDoneMap(merged[PRAYER_DONE_KEY]);
  assert(isDone(done, DATE, "Dhuhr"), "merge keeps local Dhuhr done over empty cloud done");
  const todos = JSON.parse(merged[TODOS_KEY]);
  assert(!todos.some((it) => it.prayer === "Dhuhr"), "prune strips Dhuhr restored from stale cloud");
  let reinject = injectCurrentPrayer(todos, {
    times: TIMES, date: DATE, nowMins: 14 * 60, autoTodos: true, prayerDone: done,
  });
  assert(!reinject.some((it) => it.prayer === "Dhuhr"), "after merge, inject must not re-add Dhuhr");

  // Stale cloud done must not kill locally-open Dhuhr
  const localOpen = {
    [TODOS_KEY]: JSON.stringify([
      { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
      { text: "Salah · Fajr", done: false, kind: "prayer", prayer: "Fajr", time: "05:30", date: DATE },
    ]),
    [PRAYER_DONE_KEY]: JSON.stringify({}),
    [PRAYER_SETTINGS_KEY]: JSON.stringify({ autoTodos: true, lastDate: DATE, times: TIMES }),
  };
  const staleDoneCloud = {
    [TODOS_KEY]: "[]",
    [PRAYER_DONE_KEY]: JSON.stringify({ [DATE]: ["Dhuhr", "Fajr"] }),
    [PRAYER_SETTINGS_KEY]: JSON.stringify({ autoTodos: true, lastDate: "2026-10-01", times: null }),
  };
  const m2 = applyCloudBlobWithDoneMerge(localOpen, staleDoneCloud, SYNC_KEYS);
  const done2 = parseDoneMap(m2[PRAYER_DONE_KEY]);
  assert(!isDone(done2, DATE, "Dhuhr"), "stale cloud must not mark open local Dhuhr done");
  assert(!isDone(done2, DATE, "Fajr"), "stale cloud must not mark open local Fajr done");
  // Empty cloud todos: local kept (new protect), so items still there
  let items2 = JSON.parse(m2[TODOS_KEY] || "[]");
  assert(items2.some((it) => it.prayer === "Dhuhr"), "open Dhuhr kept despite empty+stale cloud");
  const settings = JSON.parse(m2[PRAYER_SETTINGS_KEY]);
  assert(settings.lastDate === DATE && settings.times, "local today's times kept over stale cloud");

  // prune must not remove undoned
  const kept = pruneCompletedAutoTodos(
    [{ text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE }],
    {},
    {}
  );
  assert(kept.some((it) => it.prayer === "Dhuhr"), "prune must not remove undoned Dhuhr");

  const open = collectOpenAutoIds([
    { kind: "prayer", prayer: "Dhuhr", date: DATE, done: false },
  ]);
  const stripped = stripDoneIdsForOpenItems({ [DATE]: ["Dhuhr", "Asr"] }, open.prayer);
  assert(!stripped[DATE].includes("Dhuhr") && stripped[DATE].includes("Asr"), "strip removes only open ids");

  assertIncludes(indexHtml, "cloudItems.length === 0 && localItems.length > 0", "index guards empty-cloud todo wipe");
  assertIncludes(indexHtml, "todo-app-veli-points-v1", "veli in sync keys / merge path");
  assertIncludes(indexHtml, "local first paint", "local-first paint comment/log present");
  assert(
    /scheduleCloudSave/.test(indexHtml) && /SYNC_KEYS\.includes\(key\)/.test(indexHtml),
    "localStorage writes schedule cloud save"
  );
}

console.log("\n=== 6) index.html wiring ===");
{
  assertIncludes(indexHtml, "mergeDoneMaps", "defines/uses mergeDoneMaps");
  assertIncludes(indexHtml, "stripDoneIdsForOpenItems", "defines/uses stripDoneIdsForOpenItems");
  assertIncludes(indexHtml, "duePrayerNames", "defines/uses duePrayerNames");
  assertIncludes(indexHtml, "pruneCompletedAutoTodos", "defines/uses pruneCompletedAutoTodos");
  assertIncludes(indexHtml, "todo-app-prayer-done-v1", "prayer-done key present");
  assertIncludes(indexHtml, "stripDoneIdsForOpenItems(merged", "apply reconciles open vs merged done");
  assertIncludes(indexHtml, "injectDueTodosFromCache", "cache inject before paint");
  assertIncludes(indexHtml, "releaseDuePrayerTodos", "salah release wired");
  assertIncludes(indexHtml, "releaseHabits", "habits release wired");
  assert(
    HABIT_DEFS.some((h) => h.id === "brush-am") && HABIT_DEFS.some((h) => h.id === "brush-pm"),
    "habit defs include brush-am/pm"
  );
}


console.log("\n=== 6) Archive always on check-off/miss; Veli→archive backfill ===");
{
  // Pure check-off always yields archive row
  const items = [
    { text: "Salah · Dhuhr", done: false, kind: "prayer", prayer: "Dhuhr", time: "13:00", date: DATE },
  ];
  const off = checkOffWithArchive(items, {}, 0, {
    kind: "prayer",
    status: "on-time",
    completedAt: DATE + "T13:30:00.000Z",
    idFactory: () => "arch-dhuhr-1",
  });
  assert(off.archived && off.archived.prayer === "Dhuhr", "check-off produces archive row");
  assert(off.archived.status === "on-time", "check-off archive status on-time");
  assert(off.archived.rakats === FARZ_RAKATS.Dhuhr, "check-off archive rakats=4 for Dhuhr");
  assert(isDone(off.doneMap, DATE, "Dhuhr"), "check-off records prayer-done");
  assert(off.items.length === 0, "check-off removes todo");

  // Upsert by date+prayer: miss then late upgrades; same status no churn
  let rows = [];
  rows = upsertArchiveRow(rows, {
    id: "1", prayer: "Asr", date: DATE, status: "missed", completedAt: DATE + "T17:00:00Z", rakats: 4,
  });
  assert(rows.length === 1 && rows[0].status === "missed", "upsert inserts miss");
  rows = upsertArchiveRow(rows, {
    id: "2", prayer: "Asr", date: DATE, status: "missed", completedAt: DATE + "T17:05:00Z", rakats: 4,
  });
  assert(rows.length === 1 && rows[0].id === "1", "same-status upsert does not churn id/completedAt");
  rows = upsertArchiveRow(rows, {
    id: "3", prayer: "Asr", date: DATE, status: "late", completedAt: DATE + "T18:00:00Z", rakats: 4,
  });
  assert(rows[0].status === "late" && rows[0].id === "1", "miss upgrades to late, keeps id");

  // Reproduce cloud bug: Veli has Dhuhr on-time + brush miss, archive lacks them → backfill
  const brokenArchive = [
    { id: "a-fajr", prayer: "Fajr", date: DATE, status: "on-time", completedAt: DATE + "T04:04:00Z", rakats: 2, text: "Salah · Fajr" },
    { id: "a-bpm", prayer: "brush-pm", date: "2026-10-01", status: "on-time", completedAt: "2026-10-02T04:09:00Z", rakats: 0 },
  ];
  const veli = {
    total: 3,
    awarded: {
      "salah-ontime:2026-10-02:Fajr": 2,
      "salah-ontime:2026-10-02:Dhuhr": 2,
      "brush-miss:2026-10-02:brush-am": -1,
      "brush-ontime:2026-10-01:brush-pm": 1,
      "brush-miss:2026-10-01:brush-am": -1,
    },
  };
  const bf = backfillArchiveFromVeli(brokenArchive, veli, { nowISO: DATE + "T15:00:00.000Z" });
  assert(bf.inserted.length >= 2, "backfill inserts missing Dhuhr + brush-am");
  assert(
    bf.rows.some((r) => r.prayer === "Dhuhr" && r.date === DATE && r.status === "on-time" && r.rakats === 4),
    "backfill adds Dhuhr on-time 4 rakats"
  );
  assert(
    bf.rows.some((r) => r.prayer === "brush-am" && r.date === DATE && r.status === "missed"),
    "backfill adds brush-am miss for today"
  );
  assert(
    bf.rows.some((r) => r.prayer === "Fajr" && r.date === DATE),
    "backfill keeps existing Fajr"
  );
  // Idempotent second pass
  const bf2 = backfillArchiveFromVeli(bf.rows, veli, { nowISO: DATE + "T16:00:00.000Z" });
  assert(bf2.inserted.length === 0, "second backfill is no-op");

  assert(parseVeliAwardKey("salah-ontime:2026-10-02:Dhuhr").prayer === "Dhuhr", "parse veli key");
  assert(statusFromVeliAwards(veli.awarded, DATE, "Dhuhr") === "on-time", "status from veli on-time");
  assert(statusFromVeliAwards(veli.awarded, DATE, "brush-am") === "missed", "status from veli brush miss");

  // index.html wiring: check-off calls archivePrayer; boot backfills archive from veli
  assertIncludes(indexHtml, "backfillArchiveFromVeli", "index has archive←veli backfill");
  assertIncludes(indexHtml, "upsertArchiveRow", "index upserts archive by date+prayer");
  assertIncludes(indexHtml, "archivePrayer(items[i], st)", "salah check-off still calls archivePrayer");
  assertIncludes(indexHtml, 'archivePrayer({\n              prayer: items[i].habitId', "habit check-off calls archivePrayer");
  // Soft miss archives too
  assertIncludes(indexHtml, 'archivePrayer({ prayer: it.prayer, text: it.text, time: it.time, date }, "missed")', "soft miss creates archive");
}

console.log(`\nSmoke result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
