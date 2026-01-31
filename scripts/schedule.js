#!/usr/bin/env node
/**
 * Recommend optimal timeslots for sailing sessions based on historical wind data.
 * Uses half-hour granularity (48 slots/day). Stats are in UTC; CLI accepts and
 * displays times in Cranston, RI (America/New_York).
 *
 * Usage: node scripts/schedule.js --start YYYY-MM-DD --end YYYY-MM-DD [--hours N] --wind-min K --gust-max K [--top N]
 *         [--from HOUR] [--to HOUR]  # Cranston local (e.g. --to 12 = noon Eastern)
 *         Hours: 0-23, or "8a"/"8am", "5p"/"5pm", "14.5"/"2:30pm" for half-hour.
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PROCESSED_DIR = join(PROJECT_ROOT, "data", "processed");

const CRANSTON_TZ = "America/New_York";

function getISOWeekUTC(d) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(d.getUTCDate() - dayNr + 3);
  const jan4 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const dayDiff = (target - jan4) / 86400000;
  return 1 + Math.ceil(dayDiff / 7);
}

/** Get UTC offset in hours (UTC - local) at noon UTC on the given UTC date. */
function getCranstonOffsetHoursAtUTCNoon(y, m, d) {
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CRANSTON_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(noonUTC);
  const hour = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
  const easternMins = hour * 60 + minute;
  const utcMins = 12 * 60;
  return (utcMins - easternMins) / 60;
}

/** Cranston local (dateStr YYYY-MM-DD, localHour 0-24) -> UTC half-hour slot 0-47. */
function cranstonLocalToUTCSlot(dateStr, localHour) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const offset = getCranstonOffsetHoursAtUTCNoon(y, m, d);
  const utcHour = localHour + offset;
  const utcHourFloored = Math.floor(utcHour);
  const utcMin = (utcHour - utcHourFloored) * 60;
  let slot = utcHourFloored * 2 + (utcMin >= 30 ? 1 : 0);
  if (slot < 0) slot += 48;
  if (slot >= 48) slot -= 48;
  return Math.max(0, Math.min(47, slot));
}

/** UTC slot 0-47 -> Cranston time string (reference date for DST). */
function utcSlotToCranstonTimeString(utcSlot, referenceDateStr) {
  const [y, m, d] = referenceDateStr.split("-").map(Number);
  const utcHour = Math.floor(utcSlot / 2);
  const utcMin = (utcSlot % 2) * 30;
  const utcDate = new Date(Date.UTC(y, m - 1, d, utcHour, utcMin, 0));
  const str = utcDate.toLocaleString("en-US", {
    timeZone: CRANSTON_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return str;
}

/** Date range in Cranston (local calendar dates) -> set of UTC ISO week numbers. */
function cranstonDateRangeToUTCWeeks(startDateStr, endDateStr) {
  const [sy, sm, sd] = startDateStr.split("-").map(Number);
  const [ey, em, ed] = endDateStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const weeks = new Set();
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    const d = cur.getDate();
    const offset = getCranstonOffsetHoursAtUTCNoon(y, m, d);
    const midnightCranstonUTC = new Date(Date.UTC(y, m - 1, d, offset, 0, 0));
    weeks.add(getISOWeekUTC(midnightCranstonUTC));
    cur.setDate(cur.getDate() + 1);
  }
  return [...weeks].sort((a, b) => a - b);
}

function parseDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function parseHour(str) {
  if (str == null || str === "") return null;
  const s = String(str).trim().toLowerCase();

  const halfMatch = s.match(/^(\d{1,2})[:.](\d{2})([ap]m?)?$/);
  if (halfMatch) {
    let hour = parseInt(halfMatch[1], 10);
    const min = parseInt(halfMatch[2], 10);
    const suffix = halfMatch[3] || "";
    if (suffix) {
      if (suffix.startsWith("a")) hour = hour === 12 ? 0 : hour;
      else hour = hour === 12 ? 12 : hour + 12;
    }
    const frac = hour + min / 60;
    if (frac >= 0 && frac <= 24) return frac;
    return null;
  }

  const numMatch = s.match(/^(\d{1,2})(\.\d+)?([ap]m?)?$/);
  if (!numMatch) return null;

  let hour = parseFloat(numMatch[1] + (numMatch[2] || ""));
  const suffix = numMatch[3] || "";

  if (suffix) {
    if (suffix.startsWith("a")) {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour >= 0 && hour <= 23) {
    return hour;
  }

  if (hour < 0 || hour > 24) return null;
  return hour;
}


const SLOTS_PER_DAY = 48;

function aggregateByHalfHour(stats, weeks) {
  const byWeek = stats.by_week_halfhour || {};
  const aggregate = [];

  for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
    const merged = {
      histogram: new Array(36).fill(0),
      gust_histogram: new Array(36).fill(0),
      n: 0,
    };

    for (const week of weeks) {
      const weekData = byWeek[String(week)];
      if (!weekData) continue;

      const cell = weekData[String(slot)];
      if (!cell || !cell.histogram || !cell.gust_histogram) continue;

      for (let b = 0; b < 36; b++) {
        merged.histogram[b] += cell.histogram[b] || 0;
        merged.gust_histogram[b] += cell.gust_histogram[b] || 0;
      }
      merged.n += cell.n || 0;
    }

    aggregate[slot] = merged;
  }

  return aggregate;
}

function mergeCells(cells) {
  const merged = {
    histogram: new Array(36).fill(0),
    gust_histogram: new Array(36).fill(0),
    n: 0,
  };

  for (const cell of cells) {
    if (!cell || cell.n === 0) continue;
    for (let b = 0; b < 36; b++) {
      merged.histogram[b] += cell.histogram[b] || 0;
      merged.gust_histogram[b] += cell.gust_histogram[b] || 0;
    }
    merged.n += cell.n;
  }

  return merged;
}

function pGoodConditions(cell, windMin, gustMax) {
  if (!cell || cell.n === 0) return 0;

  let windCount = 0;
  for (let b = windMin; b < 36; b++) {
    windCount += cell.histogram[b] || 0;
  }
  const pWind = windCount / cell.n;

  let gustCount = 0;
  for (let b = 0; b <= Math.min(gustMax, 35); b++) {
    gustCount += cell.gust_histogram[b] || 0;
  }
  const pGust = gustCount / cell.n;

  return pWind * pGust;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    start: null,
    end: null,
    hours: 3,
    windMin: null,
    gustMax: null,
    top: 10,
    from: null,
    to: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--start") result.start = args[++i];
    else if (args[i] === "--end") result.end = args[++i];
    else if (args[i] === "--hours") result.hours = parseInt(args[++i], 10);
    else if (args[i] === "--wind-min") result.windMin = parseInt(args[++i], 10);
    else if (args[i] === "--gust-max") result.gustMax = parseInt(args[++i], 10);
    else if (args[i] === "--top") result.top = parseInt(args[++i], 10);
    else if (args[i] === "--from") result.from = parseHour(args[++i]);
    else if (args[i] === "--to") result.to = parseHour(args[++i]);
  }

  return result;
}

async function main() {
  const args = parseArgs();

  if (!args.start || !args.end || args.windMin == null || args.gustMax == null) {
    console.error("Usage: node scripts/schedule.js --start YYYY-MM-DD --end YYYY-MM-DD --wind-min <kt> --gust-max <kt> [--hours 3] [--top 10] [--from HOUR] [--to HOUR]");
    console.error("Example: npm run schedule -- --start 2024-06-15 --end 2024-07-05 --wind-min 5 --gust-max 15");
    console.error("         npm run schedule -- ... --to 12  (morning only, end by noon)");
    process.exit(1);
  }

  if (args.from !== null && (args.from < 0 || args.from > 24)) {
    console.error("Error: --from must be 0-24 or a time like 8a, 5pm, 14.5");
    process.exit(1);
  }
  if (args.to !== null && (args.to < 0 || args.to > 24)) {
    console.error("Error: --to must be 0-24 or a time like 12, noon");
    process.exit(1);
  }

  const startDate = parseDate(args.start);
  const endDate = parseDate(args.end);

  if (startDate > endDate) {
    console.error("Error: start date must be before end date");
    process.exit(1);
  }

  const statsPath = join(PROCESSED_DIR, "8453662_stats.json");
  let stats;
  try {
    const content = await readFile(statsPath, "utf8");
    stats = JSON.parse(content);
  } catch (err) {
    console.error(`Failed to load ${statsPath}. Run 'npm run process' first.`);
    process.exit(1);
  }

  const weeks = cranstonDateRangeToUTCWeeks(args.start, args.end);
  const byWeekHalfHour = stats.by_week_halfhour || {};
  const availableWeeks = weeks.filter((w) => byWeekHalfHour[String(w)]);

  if (availableWeeks.length === 0) {
    console.error("No data for weeks in date range.");
    process.exit(1);
  }

  if (availableWeeks.length < weeks.length) {
    console.error(`Warning: ${weeks.length - availableWeeks.length} week(s) in range have no data.`);
  }

  const aggregate = aggregateByHalfHour(stats, availableWeeks);
  const slotsCount = args.hours * 2;
  const maxStart = SLOTS_PER_DAY - slotsCount;
  const fromSlot = args.from != null ? cranstonLocalToUTCSlot(args.start, args.from) : 0;
  const toSlot = args.to != null ? cranstonLocalToUTCSlot(args.start, args.to) : SLOTS_PER_DAY;
  const candidates = [];

  for (let startSlot = 0; startSlot <= maxStart; startSlot++) {
    if (args.from != null && startSlot < fromSlot) continue;
    const endSlot = startSlot + slotsCount;
    if (args.to != null && endSlot > toSlot) continue;

    const cells = [];
    for (let i = 0; i < slotsCount; i++) {
      cells.push(aggregate[startSlot + i]);
    }
    const merged = mergeCells(cells);
    const score = pGoodConditions(merged, args.windMin, args.gustMax);
    candidates.push({ startSlot, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, args.top);

  if (candidates.length === 0) {
    console.error("No time windows match the constraints (--from / --to). Try broadening the range.");
    process.exit(1);
  }

  console.log(`\nSchedule recommendation: ${args.hours}-hour sessions (times in Eastern / Cranston, RI)`);
  console.log(`Date range: ${args.start} to ${args.end} (weeks ${availableWeeks[0]}-${availableWeeks[availableWeeks.length - 1]})`);
  console.log(`Criteria: wind ≥ ${args.windMin} kt, gust ≤ ${args.gustMax} kt`);
  if (args.from != null || args.to != null) {
    const constraints = [];
    if (args.from != null) constraints.push(`start ≥ ${utcSlotToCranstonTimeString(fromSlot, args.start)}`);
    if (args.to != null) constraints.push(`end ≤ ${utcSlotToCranstonTimeString(toSlot, args.start)}`);
    console.log(`Constraints: ${constraints.join(", ")}`);
  }
  const timeWidth = 12;
  console.log(`\nRank  ${"Start".padStart(timeWidth)}  ${"End".padStart(timeWidth)}  Score`);
  console.log("─".repeat(45));

  top.forEach((c, i) => {
    const pct = (c.score * 100).toFixed(1);
    const slotsCount = args.hours * 2;
    const startStr = utcSlotToCranstonTimeString(c.startSlot, args.start).padStart(timeWidth);
    const endStr = utcSlotToCranstonTimeString(c.startSlot + slotsCount, args.start).padStart(timeWidth);
    console.log(`${String(i + 1).padStart(4)}  ${startStr}  ${endStr}  ${pct}%`);
  });

  console.log("\n(Score = estimated % of session hours with good conditions; assumes wind and gust are independent)\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
