/**
 * Pure helpers for prayer/habit done tracking + cloud merge.
 * Kept in sync with index.html applyCloudBlob / releaseDuePrayerTodos.
 */

export const PRAYER_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
export const PRAYER_DONE_KEY = "todo-app-prayer-done-v1";
export const HABIT_DONE_KEY = "todo-app-habit-done-v1";
export const TODOS_KEY = "todo-app-v3";
export const PRAYER_SETTINGS_KEY = "todo-app-prayer-settings-v1";

export function parseDoneMap(raw) {
  try {
    const o = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** Union of date → id[] maps. Never drops local or remote entries. */
export function mergeDoneMaps(localRaw, cloudRaw) {
  const local = parseDoneMap(localRaw);
  const cloud = parseDoneMap(cloudRaw);
  const out = {};
  for (const src of [local, cloud]) {
    for (const [date, arr] of Object.entries(src)) {
      const list = Array.isArray(arr) ? arr : [];
      const set = new Set([...(out[date] || []), ...list]);
      out[date] = [...set];
    }
  }
  return out;
}

/**
 * Local open (unchecked) auto-todos beat stale cloud done flags.
 * Empty/stale cloud must not mark a salah/habit done if this device still shows it open.
 */
export function stripDoneIdsForOpenItems(doneMap, openByDate) {
  const out = {};
  for (const [date, arr] of Object.entries(doneMap || {})) {
    const open = openByDate && openByDate[date] ? openByDate[date] : null;
    const list = Array.isArray(arr) ? arr : [];
    out[date] = open ? list.filter((id) => !open.has(id)) : [...list];
  }
  return out;
}

export function collectOpenAutoIds(items) {
  const prayer = {};
  const habit = {};
  for (const it of items || []) {
    if (it.done) continue;
    if (it.kind === "prayer" && it.prayer && it.date) {
      prayer[it.date] = prayer[it.date] || new Set();
      prayer[it.date].add(it.prayer);
    }
    if (it.kind === "habit" && it.habitId && it.date) {
      habit[it.date] = habit[it.date] || new Set();
      habit[it.date].add(it.habitId);
    }
  }
  return { prayer, habit };
}

export function recordDone(doneMap, date, id) {
  if (!date || !id) return doneMap;
  const next = { ...doneMap };
  next[date] = next[date] ? [...next[date]] : [];
  if (!next[date].includes(id)) next[date].push(id);
  return next;
}

export function isDone(doneMap, date, id) {
  return !!(
    doneMap &&
    date &&
    id &&
    Array.isArray(doneMap[date]) &&
    doneMap[date].length &&
    doneMap[date].includes(id)
  );
}

/** Remove prayer/habit todos that are marked done for their date. Never prunes undoned. */
export function pruneCompletedAutoTodos(items, prayerDone, habitDone) {
  return (items || []).filter((it) => {
    if (it.kind === "prayer" && it.prayer) {
      const d = it.date;
      if (d && isDone(prayerDone, d, it.prayer)) return false;
    }
    if (it.kind === "habit" && it.habitId) {
      const d = it.date;
      if (d && isDone(habitDone, d, it.habitId)) return false;
    }
    return true;
  });
}

export function prayerTodoExists(items, date, name) {
  return (items || []).some(
    (it) => it.kind === "prayer" && it.date === date && it.prayer === name
  );
}

export function toMins(hhmm) {
  const [h, m] = (hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function currentPrayerName(times, nowMins) {
  if (!times) return null;
  let current = null;
  for (const name of PRAYER_NAMES) {
    if (nowMins >= toMins(times[name])) current = name;
  }
  return current;
}

/** All salah whose athan has passed (Fajr…current), oldest first. */
export function duePrayerNames(times, nowMins) {
  if (!times) return [];
  const due = [];
  for (const name of PRAYER_NAMES) {
    if (nowMins >= toMins(times[name])) due.push(name);
  }
  return due;
}

/**
 * Inject every due unpaid salah (not only the current window).
 * Mirrors releaseDuePrayerTodos add path.
 */
export function injectCurrentPrayer(items, { times, date, nowMins, autoTodos, prayerDone }) {
  if (!autoTodos || !times) return items;
  const due = duePrayerNames(times, nowMins);
  let next = (items || []).filter((it) => !(it.kind === "prayer" && it.done));
  // Newest-first unshift so list order matches live app (current on top)
  for (let i = due.length - 1; i >= 0; i--) {
    const name = due[i];
    if (prayerTodoExists(next, date, name) || isDone(prayerDone, date, name)) continue;
    next = [
      {
        text: "Salah · " + name,
        done: false,
        kind: "prayer",
        prayer: name,
        time: times[name],
        date,
      },
      ...next,
    ];
  }
  return next;
}

/** Simulate check-off: archive side-effects left to caller; record done + remove. */
export function checkOffPrayer(items, prayerDone, index) {
  const it = items[index];
  if (!it || it.kind !== "prayer") return { items, prayerDone, removed: null };
  const d = it.date;
  const nextDone = recordDone(prayerDone, d, it.prayer);
  const nextItems = items.filter((_, i) => i !== index);
  return { items: nextItems, prayerDone: nextDone, removed: it };
}

/**
 * Apply a cloud blob onto local keys with done-map merge + open-item reconcile + todo prune.
 * localStore / cloudKeys are plain { key: stringValue } maps.
 */
export function applyCloudBlobWithDoneMerge(localStore, cloudKeys, syncKeys) {
  const next = { ...localStore };
  let localItems = [];
  try {
    localItems = JSON.parse(localStore[TODOS_KEY] || "[]") || [];
  } catch {
    localItems = [];
  }
  const localOpen = collectOpenAutoIds(localItems);

  for (const k of syncKeys) {
    if (!Object.prototype.hasOwnProperty.call(cloudKeys, k)) continue;
    const val = cloudKeys[k];
    if (k === PRAYER_DONE_KEY || k === HABIT_DONE_KEY) {
      let merged = mergeDoneMaps(localStore[k], val);
      const open = k === PRAYER_DONE_KEY ? localOpen.prayer : localOpen.habit;
      merged = stripDoneIdsForOpenItems(merged, open);
      next[k] = JSON.stringify(merged);
    } else if (val == null) {
      delete next[k];
    } else {
      next[k] = typeof val === "string" ? val : JSON.stringify(val);
    }
  }

  // Prefer today's local prayer times over stale cloud lastDate.
  if (Object.prototype.hasOwnProperty.call(cloudKeys, PRAYER_SETTINGS_KEY)) {
    try {
      const localPs = JSON.parse(localStore[PRAYER_SETTINGS_KEY] || "{}") || {};
      const cloudPs = JSON.parse(next[PRAYER_SETTINGS_KEY] || "{}") || {};
      const today =
        localPs.lastDate && localPs.times
          ? localPs.lastDate
          : cloudPs.lastDate;
      if (
        localPs.times &&
        localPs.lastDate &&
        (!cloudPs.lastDate || cloudPs.lastDate !== localPs.lastDate || !cloudPs.times)
      ) {
        next[PRAYER_SETTINGS_KEY] = JSON.stringify({
          ...cloudPs,
          times: localPs.times,
          lastDate: localPs.lastDate,
          lat: localPs.lat != null ? localPs.lat : cloudPs.lat,
          lon: localPs.lon != null ? localPs.lon : cloudPs.lon,
          autoTodos:
            localPs.autoTodos != null ? localPs.autoTodos : cloudPs.autoTodos,
        });
      }
      void today;
    } catch {
      /* keep cloud settings */
    }
  }

  const prayerDone = parseDoneMap(next[PRAYER_DONE_KEY]);
  const habitDone = parseDoneMap(next[HABIT_DONE_KEY]);
  if (Object.prototype.hasOwnProperty.call(next, TODOS_KEY) || localStore[TODOS_KEY]) {
    let items = [];
    try {
      items = JSON.parse(next[TODOS_KEY] ?? localStore[TODOS_KEY] ?? "[]") || [];
    } catch {
      items = [];
    }
    const pruned = pruneCompletedAutoTodos(items, prayerDone, habitDone);
    next[TODOS_KEY] = JSON.stringify(pruned);
  }
  return next;
}

export function daysBetweenISO(from, to) {
  const a = new Date(from + "T00:00:00");
  const b = new Date(to + "T00:00:00");
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * Brush habit expiry windows (mirrors releaseHabits habitExpired).
 * morning brush ends at today's Dhuhr; night brush ends after next day's Fajr.
 */
export function habitExpired(habitId, itemDate, today, nowMins, times) {
  const age = daysBetweenISO(itemDate, today);
  if (age < 0) return false;
  if (habitId === "brush-am") {
    if (age > 0) return true;
    const dhuhr = times && times.Dhuhr != null ? toMins(times.Dhuhr) : null;
    return dhuhr != null && nowMins >= dhuhr;
  }
  if (habitId === "brush-pm") {
    if (age > 1) return true;
    if (age === 1) {
      const fajr = times && times.Fajr != null ? toMins(times.Fajr) : null;
      return fajr != null && nowMins >= fajr;
    }
    return false;
  }
  return false;
}

/** Ledger Save & calculate reset payload (only applied after user confirms). */
export function ledgerSaveCalculate(L, today, confirmed) {
  if (!confirmed) return { L, applied: false };
  const next = { ...L };
  next.onTime = 0;
  next.makeup = 0;
  next.qadaRegistered = 0;
  next.qadaPending = { Fajr: 0, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0, Witr: 0 };
  next.trackingStartedAt = today;
  return { L: next, applied: true };
}
