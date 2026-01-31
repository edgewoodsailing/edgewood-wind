#!/usr/bin/env node
/**
 * Query processed wind statistics for probability of conditions in a given range.
 * Uses half-hour slots (0-47). Slot 0 = 00:00-00:30, slot 28 = 2:00-2:30 PM, etc.
 *
 * Usage: node scripts/query.js --week 28 --slot 28 --min 5 --max 12 [--gust-max 15]
 *        node scripts/query.js --week 28 --hour 14 [--minute 30] --min 5 --max 12
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PROCESSED_DIR = join(PROJECT_ROOT, "data", "processed");

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { week: null, slot: null, hour: null, minute: null, min: null, max: null, gustMax: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--week") result.week = parseInt(args[++i], 10);
    else if (args[i] === "--slot") result.slot = parseInt(args[++i], 10);
    else if (args[i] === "--hour") result.hour = parseInt(args[++i], 10);
    else if (args[i] === "--minute") result.minute = parseInt(args[++i], 10);
    else if (args[i] === "--min") result.min = parseInt(args[++i], 10);
    else if (args[i] === "--max") result.max = parseInt(args[++i], 10);
    else if (args[i] === "--gust-max") result.gustMax = parseInt(args[++i], 10);
  }

  if (result.slot == null && result.hour != null) {
    const min = result.minute ?? 0;
    result.slot = result.hour * 2 + (min >= 30 ? 1 : 0);
  }

  return result;
}

function queryProbability(stats, week, slot, minKt, maxKt, gustMaxKt = null) {
  const byWeek = stats.by_week_halfhour?.[String(week)];
  if (!byWeek) return null;

  const cell = byWeek[String(slot)];
  if (!cell) return null;

  const { histogram, gust_histogram, n } = cell;
  if (n === 0) return null;

  const minBin = Math.max(0, minKt);
  const maxBin = Math.min(maxKt, histogram.length - 1);
  let count = 0;
  for (let b = minBin; b <= maxBin; b++) {
    count += histogram[b];
  }

  const probability = count / n;
  const result = { probability, count, total: n, week, slot, minKt, maxKt };

  if (gustMaxKt != null) {
    let gustCount = 0;
    for (let b = 0; b <= Math.min(gustMaxKt, gust_histogram.length - 1); b++) {
      gustCount += gust_histogram[b];
    }
    result.gustCount = gustCount;
    result.gustProbability = gustCount / n;
    result.gustMaxKt = gustMaxKt;
  }

  return result;
}

function formatHalfHour(slot) {
  const hour = Math.floor(slot / 2);
  const minute = (slot % 2) * 30;
  if (minute === 0) {
    if (hour === 0) return "12 AM";
    if (hour === 12) return "12 PM";
    return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
  }
  const h = hour === 0 ? 12 : hour === 12 ? 12 : hour > 12 ? hour - 12 : hour;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

async function main() {
  const args = parseArgs();

  if (args.week == null || args.slot == null || args.min == null || args.max == null) {
    console.error("Usage: node scripts/query.js --week <1-52> (--slot <0-47> | --hour <0-23> [--minute 0|30]) --min <kt> --max <kt> [--gust-max <kt>]");
    console.error("Example: node scripts/query.js --week 28 --slot 28 --min 5 --max 12");
    console.error("        node scripts/query.js --week 28 --hour 14 --minute 30 --min 5 --max 12");
    process.exit(1);
  }

  if (args.slot < 0 || args.slot > 47) {
    console.error("Error: --slot must be 0-47");
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

  const result = queryProbability(
    stats,
    args.week,
    args.slot,
    args.min,
    args.max,
    args.gustMax
  );

  if (!result) {
    console.error(`No data for week ${args.week}, slot ${args.slot} (${formatHalfHour(args.slot)})`);
    process.exit(1);
  }

  const timeLabel = formatHalfHour(args.slot);
  const pct = (result.probability * 100).toFixed(1);
  console.log(
    `Week ${args.week}, ${timeLabel}: ${pct}% of observations had ${args.min}-${args.max} kt wind`
  );
  console.log(`  (${result.count} of ${result.total} observations)`);
  const cell = stats.by_week_halfhour[args.week]?.[args.slot];
  if (cell) {
    console.log(`  Mean: ${cell.mean} kt, Median: ${cell.p50} kt`);
  }

  if (result.gustProbability != null) {
    const gPct = (result.gustProbability * 100).toFixed(1);
    console.log(
      `  Gust ≤${args.gustMax} kt: ${gPct}% (${result.gustCount} of ${result.total})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
