#!/usr/bin/env node
/**
 * Process raw wind JSON files into histogram-based statistics by (week, half-hour slot).
 * Output: data/processed/{station_id}_stats.json
 * Half-hour slots 0-47: slot 0 = 00:00-00:30, slot 1 = 00:30-01:00, etc.
 * Supports flexible querying of any wind range without reprocessing.
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const RAW_DIR = join(PROJECT_ROOT, "data", "raw");
const PROCESSED_DIR = join(PROJECT_ROOT, "data", "processed");

const BIN_COUNT = 36; // 0-35 knots
const GUST_BIN_COUNT = 36;

function getISOWeek(d) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7; // Mon=0, Sun=6
  target.setDate(target.getDate() - dayNr + 3); // Thursday
  const jan4 = new Date(target.getFullYear(), 0, 4);
  const dayDiff = (target - jan4) / 86400000;
  return 1 + Math.ceil(dayDiff / 7);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function getHalfHourSlot(d) {
  const hour = d.getHours();
  const minute = d.getMinutes();
  return hour * 2 + (minute >= 30 ? 1 : 0);
}

function processStation(stationId) {
  const histograms = new Map(); // "week,slot" -> { histogram, gust_histogram, values, gustValues }

  function getCell(week, slot) {
    const key = `${week},${slot}`;
    if (!histograms.has(key)) {
      histograms.set(key, {
        histogram: new Array(BIN_COUNT).fill(0),
        gust_histogram: new Array(GUST_BIN_COUNT).fill(0),
        values: [],
        gustValues: [],
      });
    }
    return histograms.get(key);
  }

  return {
    add(speed, gust, week, slot) {
      const cell = getCell(week, slot);
      const bin = Math.min(Math.floor(Number(speed)), BIN_COUNT - 1);
      const gustBin = Math.min(Math.floor(Number(gust)), GUST_BIN_COUNT - 1);
      if (bin >= 0) {
        cell.histogram[bin]++;
        cell.values.push(Number(speed));
      }
      if (gustBin >= 0) {
        cell.gust_histogram[gustBin]++;
        cell.gustValues.push(Number(gust));
      }
    },
    buildOutput() {
      const by_week_halfhour = {};
      for (const [key, cell] of histograms) {
        const [week, slot] = key.split(",");
        const n = cell.values.length;
        if (n === 0) continue;

        const sorted = [...cell.values].sort((a, b) => a - b);
        const mean = cell.values.reduce((a, b) => a + b, 0) / n;
        const variance =
          cell.values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
        const std = Math.sqrt(variance);

        if (!by_week_halfhour[week]) by_week_halfhour[week] = {};
        by_week_halfhour[week][slot] = {
          histogram: cell.histogram,
          gust_histogram: cell.gust_histogram,
          n,
          mean: Math.round(mean * 10) / 10,
          std: Math.round(std * 10) / 10,
          p10: Math.round(percentile(sorted, 10) * 10) / 10,
          p25: Math.round(percentile(sorted, 25) * 10) / 10,
          p50: Math.round(percentile(sorted, 50) * 10) / 10,
          p75: Math.round(percentile(sorted, 75) * 10) / 10,
          p90: Math.round(percentile(sorted, 90) * 10) / 10,
        };
      }
      return by_week_halfhour;
    },
  };
}

async function main() {
  const stationId = "8453662";
  const rawStationDir = join(RAW_DIR, stationId);
  const files = await readdir(rawStationDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  if (jsonFiles.length === 0) {
    console.error(`No JSON files found in ${rawStationDir}`);
    process.exit(1);
  }

  const processor = processStation(stationId);
  let totalRecords = 0;

  for (const file of jsonFiles) {
    const path = join(rawStationDir, file);
    const content = await readFile(path, "utf8");
    const { data = [] } = JSON.parse(content);

    for (const row of data) {
      const t = row.t;
      const s = row.s;
      const g = row.g ?? row.s;
      if (!t || s === undefined) continue;

      const d = new Date(t.replace(" ", "T"));
      const week = getISOWeek(d);
      const slot = getHalfHourSlot(d);
      processor.add(s, g, week, slot);
      totalRecords++;
    }
  }

  const years = jsonFiles
    .map((f) => f.replace(".json", ""))
    .filter((y) => /^\d{4}$/.test(y));
  const period =
    years.length > 0
      ? `${Math.min(...years)}-${Math.max(...years)}`
      : "unknown";

  const output = {
    station: stationId,
    period,
    sailing_season: "05-01 to 09-30",
    bin_max_knots: BIN_COUNT,
    by_week_halfhour: processor.buildOutput(),
  };

  const outPath = join(PROCESSED_DIR, `${stationId}_stats.json`);
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`Processed ${totalRecords} records from ${jsonFiles.length} files`);
  console.log(`Output: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
