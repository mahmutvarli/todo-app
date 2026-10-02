/**
 * Pure helpers for prayer/habit done tracking + cloud merge.
 * Kept in sync with index.html applyCloudBlob / releaseDuePrayerTodos / releaseHabits.
 */

export const PRAYER_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
export const PRAYER_DONE_KEY = "todo-app-prayer-done-v1";
export const HABIT_DONE_KEY = "todo-app-habit-done-v1";
export const TODOS_KEY = "todo-app-v3";
export const PRAYER_SETTINGS_KEY = "todo-app-prayer-settings-v1";
export const ARCHIVE_KEY = "todo-app-archive-v1";
export const VELI_KEY = "todo-app-veli-points-v1";
export const LEDGER_KEY = "todo-app-ledger-v1";

export const HABIT_DEFS = [
  { id: "brush-am", text: "Brush teeth (morning)", time: "10:00", makeup: false },
  { id: "brush-pm", text: "Brush teeth (night)", time: "22:00", makeup: false },
];

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

export function habitTodoExists(items, date, id) {
  return (items || []).some(
    (it) => it.kind === "habit" && it.date === date && it.habitId === id
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

/** Simulate check-off for habit. */
export function checkOffHabit(items, habitDone, index) {
  const it = items[index];
  if (!it || it.kind !== "habit") return { items, habitDone, removed: null };
  const d = it.date;
  const nextDone = recordDone(habitDone, d, it.habitId);
  const nextItems = items.filter((_, i) => i !== index);
  return { items: nextItems, habitDone: nextDone, removed: it };
}

/**
 * Delete an item. For prayer/habit, record done so inject does not bounce it back.
 * Manual todos are just removed.
 */
export function deleteTodoItem(items, prayerDone, habitDone, index) {
  const it = items[index];
  if (!it) return { items, prayerDone, habitDone, removed: null };
  let nextPrayer = prayerDone;
  let nextHabit = habitDone;
  if (it.kind === "prayer" && it.prayer && it.date) {
    nextPrayer = recordDone(prayerDone, it.date, it.prayer);
  } else if (it.kind === "habit" && it.habitId && it.date) {
    nextHabit = recordDone(habitDone, it.date, it.habitId);
  }
  return {
    items: items.filter((_, i) => i !== index),
    prayerDone: nextPrayer,
    habitDone: nextHabit,
    removed: it,
  };
}

/**
 * Stable focus key for Tabata jump — survives inject unshifts reordering indices.
 */
export function todoFocusKey(it) {
  if (!it) return "";
  if (it.kind === "prayer" && it.prayer && it.date) return "prayer:" + it.date + ":" + it.prayer;
  if (it.kind === "habit" && it.habitId && it.date) return "habit:" + it.date + ":" + it.habitId;
  // Manual todos: prefer explicit id when present, else text.
  if (it.id) return "todo:" + it.id;
  return "todo:" + (it.text || "");
}

export function findTodoByFocusKey(items, key) {
  if (!key) return null;
  return (items || []).find((it) => todoFocusKey(it) === key) || null;
}

/** Parse a todos JSON array safely. */
export function parseTodoList(raw) {
  try {
    const a = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/**
 * Empty cloud todos must not wipe local open todos.
 * Non-empty cloud replaces (then caller prunes + injects).
 */
export function chooseTodosAfterCloud(localRaw, cloudRaw) {
  const local = parseTodoList(localRaw);
  const cloud = parseTodoList(cloudRaw);
  if (cloud.length === 0 && local.length > 0) return local;
  return cloud;
}

export function parseVeli(raw) {
  try {
    const o = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
    return {
      total: (o && o.total) | 0,
      awarded: o && o.awarded && typeof o.awarded === "object" && !Array.isArray(o.awarded) ? { ...o.awarded } : {},
    };
  } catch {
    return { total: 0, awarded: {} };
  }
}

/**
 * Merge Veli awarded maps (idempotent keys). Local wins on same-key conflict.
 * Total is recomputed from awarded deltas so cloud overwrite cannot drift.
 */
export function mergeVeliPoints(localRaw, cloudRaw) {
  const local = parseVeli(localRaw);
  const cloud = parseVeli(cloudRaw);
  const awarded = { ...cloud.awarded, ...local.awarded };
  let total = 0;
  for (const d of Object.values(awarded)) total += d | 0;
  return { total, awarded };
}

export function parseArchive(raw) {
  try {
    const a = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** Union archive rows by id; local row wins on conflict; then dedupe by date+prayer. */
export function mergeArchives(localRaw, cloudRaw) {
  const local = parseArchive(localRaw);
  const cloud = parseArchive(cloudRaw);
  const byId = new Map();
  for (const row of cloud) {
    if (row && row.id) byId.set(row.id, row);
  }
  for (const row of local) {
    if (row && row.id) byId.set(row.id, row);
  }
  const extras = [];
  for (const row of [...cloud, ...local]) {
    if (row && !row.id) extras.push(row);
  }
  const rows = [...byId.values(), ...extras];
  const rank = { missed: 1, late: 2, "on-time": 3 };
  const best = new Map();
  const noPrayer = [];
  for (const row of rows) {
    if (!row) continue;
    if (!row.prayer) {
      noPrayer.push(row);
      continue;
    }
    const key = String(row.date || "") + "\0" + String(row.prayer || "");
    const prev = best.get(key);
    if (!prev) {
      best.set(key, row);
      continue;
    }
    const prevRank = rank[prev.status] || 0;
    const nextRank = rank[row.status] || 0;
    if (nextRank > prevRank) best.set(key, row);
    else if (
      nextRank === prevRank &&
      String(row.completedAt || "") > String(prev.completedAt || "")
    ) {
      best.set(key, row);
    }
  }
  const out = [...best.values(), ...noPrayer];
  out.sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  return out;
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
    } else if (k === TODOS_KEY) {
      // Empty cloud must not wipe local open todos (manual or auto).
      const chosen = chooseTodosAfterCloud(localStore[k], val);
      next[k] = JSON.stringify(chosen);
    } else if (k === VELI_KEY) {
      next[k] = JSON.stringify(mergeVeliPoints(localStore[k], val));
    } else if (k === ARCHIVE_KEY) {
      next[k] = JSON.stringify(mergeArchives(localStore[k], val));
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

/**
 * Should we add this habit for `date` at nowMins?
 * Never add an already-expired habit (avoids bounce-add → instant miss archive).
 */
export function shouldAddHabit(habitId, scheduleTime, date, today, nowMins, times, items, habitDone) {
  if (date !== today) return false;
  if (habitTodoExists(items, date, habitId) || isDone(habitDone, date, habitId)) return false;
  if (nowMins < toMins(scheduleTime)) return false;
  if (habitExpired(habitId, date, today, nowMins, times)) return false;
  return true;
}

/**
 * Pure releaseHabits: add due non-expired habits; archive+done expired open ones.
 * Returns { items, habitDone, archived, changed }.
 */
export function releaseHabitsPure(items, habitDone, { date, nowMins, times, habits }) {
  const defs = habits || HABIT_DEFS;
  let nextItems = [...(items || [])];
  let nextDone = { ...(habitDone || {}) };
  const archived = [];
  let changed = false;

  for (const h of defs) {
    if (shouldAddHabit(h.id, h.time, date, date, nowMins, times, nextItems, nextDone)) {
      nextItems = [
        {
          text: h.text,
          done: false,
          kind: "habit",
          habitId: h.id,
          makeup: false,
          time: h.time,
          date,
        },
        ...nextItems,
      ];
      changed = true;
    }
  }

  const keep = [];
  for (const it of nextItems) {
    if (it.kind !== "habit" || it.done) {
      keep.push(it);
      continue;
    }
    const h = defs.find((x) => x.id === it.habitId);
    if (!h || !habitExpired(h.id, it.date, date, nowMins, times)) {
      keep.push(it);
      continue;
    }
    archived.push({
      prayer: it.habitId,
      text: it.text,
      time: it.time,
      date: it.date,
      status: "missed",
    });
    nextDone = recordDone(nextDone, it.date, it.habitId);
    changed = true;
  }
  return { items: keep, habitDone: nextDone, archived, changed };
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

/**
 * on-time if completed in [athan, nextAthan); late if after next athan.
 * Mirrors index.html completionStatus with injectable times/now.
 */
export function completionStatusPure(prayer, athanTime, completedMins, times) {
  const athan = toMins(athanTime);
  let nextEnd = 24 * 60;
  if (times) {
    const idx = PRAYER_NAMES.indexOf(prayer);
    if (idx >= 0 && idx < PRAYER_NAMES.length - 1) {
      nextEnd = toMins(times[PRAYER_NAMES[idx + 1]]);
    }
  }
  if (completedMins >= athan && completedMins < nextEnd) return "on-time";
  if (completedMins >= nextEnd || (completedMins < athan && prayer !== "Fajr")) return "late";
  return "on-time";
}

/** Idempotent award: returns { awarded, total, applied }. */
export function awardVeliPure(state, key, delta) {
  const awarded = { ...(state.awarded || {}) };
  if (Object.prototype.hasOwnProperty.call(awarded, key)) {
    return { awarded, total: state.total | 0, applied: false };
  }
  if (!key || !delta) {
    // delta 0 still records for makeup-later sentinel when caller wants — but awardVeli skips !delta
    return { awarded, total: state.total | 0, applied: false };
  }
  awarded[key] = delta;
  const total = (state.total | 0) + delta;
  return { awarded, total, applied: true };
}

export const FARZ_RAKATS = { Fajr: 2, Dhuhr: 4, Asr: 4, Maghrib: 3, Isha: 4 };
export const ARCHIVE_STATUS_RANK = { missed: 1, late: 2, "on-time": 3 };

export function archiveSemanticKey(date, prayer) {
  return String(date || "") + "\0" + String(prayer || "");
}

/**
 * Upsert archive row by (date, prayer). Higher status rank wins; same rank prefers
 * incoming when it has a newer completedAt (or when existing has none).
 */
export function upsertArchiveRow(rows, row) {
  const src = Array.isArray(rows) ? rows : [];
  if (!row || !row.prayer) return src;
  const date = row.date || "";
  const key = archiveSemanticKey(date, row.prayer);
  const idx = src.findIndex(
    (r) => r && archiveSemanticKey(r.date || "", r.prayer) === key
  );
  if (idx < 0) {
    return [row, ...src];
  }
  const prev = src[idx];
  const prevRank = ARCHIVE_STATUS_RANK[prev.status] || 0;
  const nextRank = ARCHIVE_STATUS_RANK[row.status] || 0;
  // Same or lower rank: return original ref (soft-miss polling must not churn).
  if (nextRank <= prevRank) return src;
  const list = [...src];
  list[idx] = { ...prev, ...row, id: prev.id || row.id };
  list.sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  return list;
}

/** Dedupe archive by (date, prayer) after id-union, keeping higher-ranked status. */
export function dedupeArchiveByPrayerDate(rows) {
  const best = new Map();
  for (const row of rows || []) {
    if (!row || !row.prayer) continue;
    const key = archiveSemanticKey(row.date || "", row.prayer);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, row);
      continue;
    }
    const prevRank = ARCHIVE_STATUS_RANK[prev.status] || 0;
    const nextRank = ARCHIVE_STATUS_RANK[row.status] || 0;
    if (nextRank > prevRank) best.set(key, row);
    else if (nextRank === prevRank) {
      if (String(row.completedAt || "") > String(prev.completedAt || "")) best.set(key, row);
    }
  }
  const out = [...best.values()];
  out.sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  return out;
}

/** Alias — mergeArchives already semantic-dedupes by date+prayer. */
export function mergeArchivesDeduped(localRaw, cloudRaw) {
  return mergeArchives(localRaw, cloudRaw);
}

/**
 * Parse award key like "salah-ontime:2026-10-02:Dhuhr" → { type, date, prayer }.
 * Types: salah-ontime | salah-miss | salah-makeup | salah-unpaid | brush-ontime | brush-miss
 */
export function parseVeliAwardKey(key) {
  if (!key || typeof key !== "string") return null;
  const m = key.match(/^(salah-ontime|salah-miss|salah-makeup|salah-unpaid|brush-ontime|brush-miss):(\d{4}-\d{2}-\d{2}):(.+)$/);
  if (!m) return null;
  return { type: m[1], date: m[2], prayer: m[3] };
}

function defaultLabelForArchive(prayer) {
  if (prayer === "brush-am") return "Brush teeth (morning)";
  if (prayer === "brush-pm") return "Brush teeth (night)";
  if (PRAYER_NAMES.includes(prayer)) return "Salah · " + prayer;
  return String(prayer);
}

function defaultTimeForArchive(prayer) {
  if (prayer === "brush-am") return "10:00";
  if (prayer === "brush-pm") return "22:00";
  return "";
}

function middayISO(date) {
  return date + "T12:00:00.000Z";
}

/**
 * Infer archive status for a prayer+date from the Veli awarded map.
 * on-time > late (miss+makeup) > missed.
 */
export function statusFromVeliAwards(awarded, date, prayer) {
  const a = awarded || {};
  const isBrush = prayer === "brush-am" || prayer === "brush-pm";
  if (isBrush) {
    if (Object.prototype.hasOwnProperty.call(a, "brush-ontime:" + date + ":" + prayer)) return "on-time";
    if (Object.prototype.hasOwnProperty.call(a, "brush-miss:" + date + ":" + prayer)) return "missed";
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(a, "salah-ontime:" + date + ":" + prayer)) return "on-time";
  if (Object.prototype.hasOwnProperty.call(a, "salah-makeup:" + date + ":" + prayer)) return "late";
  if (Object.prototype.hasOwnProperty.call(a, "salah-miss:" + date + ":" + prayer)) return "missed";
  return null;
}

/**
 * One-time / every-boot repair: for each salah-ontime/miss or brush-ontime/miss
 * award without a matching archive prayer+date, insert an archive entry.
 * Returns { rows, inserted } where inserted is the list of new/upgraded rows.
 */
export function backfillArchiveFromVeli(archiveRows, veliState, opts) {
  const nowISO = (opts && opts.nowISO) || new Date().toISOString();
  const awarded = (veliState && veliState.awarded) || {};
  let rows = Array.isArray(archiveRows) ? [...archiveRows] : [];
  const inserted = [];
  const seen = new Set();

  for (const key of Object.keys(awarded)) {
    const parsed = parseVeliAwardKey(key);
    if (!parsed) continue;
    // unpaid is a day-end penalty on top of miss — do not create archive from it alone
    if (parsed.type === "salah-unpaid") continue;
    // makeup alone implies late; ontime/miss drive primary status
    if (parsed.type === "salah-makeup") continue;

    const { date, prayer } = parsed;
    const sk = archiveSemanticKey(date, prayer);
    if (seen.has(sk)) continue;
    seen.add(sk);

    const status = statusFromVeliAwards(awarded, date, prayer);
    if (!status) continue;

    const existing = rows.find(
      (r) => r && archiveSemanticKey(r.date || "", r.prayer) === sk
    );
    if (existing) {
      // Upgrade missed → late/on-time if Veli says so
      const prevRank = ARCHIVE_STATUS_RANK[existing.status] || 0;
      const nextRank = ARCHIVE_STATUS_RANK[status] || 0;
      if (nextRank <= prevRank) continue;
      const upgraded = {
        ...existing,
        status,
        completedAt: existing.completedAt || (status === "on-time" ? middayISO(date) : nowISO),
        rakats: existing.rakats != null ? existing.rakats : FARZ_RAKATS[prayer] || 0,
        text: existing.text || defaultLabelForArchive(prayer),
        time: existing.time || defaultTimeForArchive(prayer),
      };
      rows = upsertArchiveRow(rows, upgraded);
      inserted.push(upgraded);
      continue;
    }

    const row = {
      id: "bf-" + date + "-" + prayer + "-" + Math.random().toString(36).slice(2, 7),
      prayer,
      text: defaultLabelForArchive(prayer),
      time: defaultTimeForArchive(prayer),
      date,
      completedAt: status === "on-time" ? middayISO(date) : nowISO,
      status,
      rakats: FARZ_RAKATS[prayer] || 0,
    };
    rows = upsertArchiveRow(rows, row);
    inserted.push(row);
  }

  return { rows: dedupeArchiveByPrayerDate(rows), inserted };
}

/**
 * Pure check-off side-effect bundle: always produces an archive row + done map update.
 * Caller persists. status should be on-time | late | missed.
 */
export function checkOffWithArchive(items, doneMap, index, { kind, status, completedAt, idFactory }) {
  const it = items[index];
  if (!it) return { items, doneMap, archived: null };
  const date = it.date;
  const prayerOrHabit = kind === "habit" ? it.habitId : it.prayer;
  if (!date || !prayerOrHabit) {
    return {
      items: items.filter((_, i) => i !== index),
      doneMap,
      archived: null,
    };
  }
  const mkId =
    idFactory ||
    (() => Date.now() + "-" + Math.random().toString(36).slice(2, 7));
  const row = {
    id: mkId(),
    prayer: prayerOrHabit,
    text: it.text,
    time: it.time,
    date,
    completedAt: completedAt || new Date().toISOString(),
    status: status || "on-time",
    rakats: FARZ_RAKATS[prayerOrHabit] || 0,
  };
  const nextDone = recordDone(doneMap, date, prayerOrHabit);
  return {
    items: items.filter((_, i) => i !== index),
    doneMap: nextDone,
    archived: row,
  };
}
