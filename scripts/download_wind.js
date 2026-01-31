#!/usr/bin/env node
/**
 * Download wind data from NOAA CO-OPS API.
 * Uses stations defined in config/stations.yaml.
 * Saves raw JSON to data/raw/{station_id}/ by year.
 */

import { readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONFIG_DIR = join(PROJECT_ROOT, "config");
const DATA_DIR = join(PROJECT_ROOT, "data", "raw");

const CO_OPS_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

function loadConfig() {
  const stationsPath = join(CONFIG_DIR, "stations.yaml");
  const downloadPath = join(CONFIG_DIR, "download.yaml");

  const config = yaml.load(readFileSync(downloadPath, "utf8"));
  const stations = yaml.load(readFileSync(stationsPath, "utf8")).stations;
  const download = config.defaults;
  const sailingSeason = config.sailing_season || null;

  return { stations, download, sailingSeason };
}

function parseDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWind(stationId, begin, end, interval, units, tz) {
  const params = new URLSearchParams({
    station: stationId,
    product: "wind",
    begin_date: begin,
    end_date: end,
    interval,
    units,
    time_zone: tz,
    application: "EdgewoodWind",
    format: "json",
  });
  const url = `${CO_OPS_BASE}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

function getSeasonRange(year, sailingSeason, startDate, endDate) {
  if (!sailingSeason) {
    return {
      begin: new Date(year, 0, 1),
      end: new Date(year, 11, 31),
    };
  }
  const [startM, startD] = sailingSeason.start.split("-").map(Number);
  const [endM, endD] = sailingSeason.end.split("-").map(Number);
  const seasonStart = new Date(year, startM - 1, startD);
  const seasonEnd = new Date(year, endM - 1, endD);
  const begin = seasonStart < startDate ? startDate : seasonStart;
  const end = seasonEnd > endDate ? endDate : seasonEnd;
  return begin <= end ? { begin, end } : null;
}

/**
 * Generate month chunks for a date range. 6-min data is limited to 1 month per request.
 * Returns [{ begin, end }, ...] covering the range.
 */
function getMonthChunks(begin, end) {
  const chunks = [];
  const cur = new Date(begin.getFullYear(), begin.getMonth(), 1);

  while (cur <= end) {
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const chunkBegin = cur < begin ? new Date(begin) : new Date(cur);
    const chunkEnd = monthEnd > end ? new Date(end) : new Date(monthEnd);
    if (chunkBegin <= chunkEnd) {
      chunks.push({ begin: chunkBegin, end: chunkEnd });
    }
    cur.setMonth(cur.getMonth() + 1);
  }

  return chunks;
}

async function downloadStation(
  stationKey,
  station,
  cfg,
  startDate,
  endDate,
  sailingSeason,
  delay,
  dryRun
) {
  const stationId = station.id;
  const outDir = join(DATA_DIR, stationId);
  await mkdir(outDir, { recursive: true });

  const is6Min = cfg.interval === "6" || cfg.interval === 6;
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();
  let totalRecords = 0;

  for (let year = startYear; year <= endYear; year++) {
    const range = getSeasonRange(year, sailingSeason, startDate, endDate);
    if (!range) continue;

    if (is6Min) {
      const chunks = getMonthChunks(range.begin, range.end);
      if (dryRun) {
        for (const c of chunks) {
          console.log(`  [dry-run] Would fetch ${stationKey} ${formatDate(c.begin)}–${formatDate(c.end)}`);
        }
      } else {
        const allRecords = [];
        let metadata = null;
        for (const chunk of chunks) {
          const begin = formatDate(chunk.begin);
          const end = formatDate(chunk.end);
          try {
            const data = await fetchWind(
              stationId,
              begin,
              end,
              cfg.interval,
              cfg.units,
              cfg.time_zone
            );

            if (data.error) {
              console.error(`  ERROR ${stationKey} ${begin}–${end}:`, data.error);
            } else {
              if (data.metadata && !metadata) metadata = data.metadata;
              const records = data.data || [];
              allRecords.push(...records);
              console.log(
                `  ${stationKey} ${begin}–${end}: ${records.length} records`
              );
            }
          } catch (err) {
            console.error(`  ERROR ${stationKey} ${begin}–${end}:`, err.message);
          }

          if (delay > 0) {
            await sleep(delay * 1000);
          }
        }
        if (allRecords.length > 0) {
          allRecords.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
          const outFile = join(outDir, `${year}.json`);
          const output = {
            metadata: metadata || { id: stationId },
            data: allRecords,
          };
          await writeFile(
            outFile,
            JSON.stringify(output, null, 2),
            "utf8"
          );
          totalRecords += allRecords.length;
          console.log(`  ${stationKey} ${year}: ${allRecords.length} records -> ${year}.json`);
        }
      }
    } else {
      const begin = formatDate(range.begin);
      const end = formatDate(range.end);

      if (dryRun) {
        console.log(`  [dry-run] Would fetch ${stationKey} ${begin}–${end}`);
      } else {
        try {
          const data = await fetchWind(
            stationId,
            begin,
            end,
            cfg.interval,
            cfg.units,
            cfg.time_zone
          );

          if (data.error) {
            console.error(`  ERROR ${stationKey} ${begin}–${end}:`, data.error);
          } else {
            const records = data.data || [];
            if (records.length > 0) {
              const outFile = join(outDir, `${year}.json`);
              await writeFile(outFile, JSON.stringify(data, null, 2), "utf8");
              totalRecords += records.length;
              console.log(
                `  ${stationKey} ${begin}–${end}: ${records.length} records -> ${year}.json`
              );
            } else {
              console.log(`  ${stationKey} ${begin}–${end}: no data`);
            }
          }
        } catch (err) {
          console.error(`  ERROR ${stationKey} ${begin}–${end}:`, err.message);
        }

        if (delay > 0) {
          await sleep(delay * 1000);
        }
      }
    }
  }

  return totalRecords;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { start: null, end: null, station: null, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--start") result.start = args[++i];
    else if (args[i] === "--end") result.end = args[++i];
    else if (args[i] === "--station") result.station = args[++i];
    else if (args[i] === "--dry-run") result.dryRun = true;
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const { stations, download: cfg, sailingSeason } = loadConfig();

  const active = Object.fromEntries(
    Object.entries(stations).filter(([, v]) => v.active !== false)
  );

  if (args.station) {
    if (!active[args.station]) {
      console.error(`Unknown or inactive station: ${args.station}`);
      process.exit(1);
    }
    Object.keys(active).forEach((k) => {
      if (k !== args.station) delete active[k];
    });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let endDate = cfg.end_date
    ? parseDate(cfg.end_date)
    : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let startDate = parseDate(args.start || cfg.start_date);
  if (args.end) endDate = parseDate(args.end);

  const delay = cfg.delay_seconds ?? 1.0;

  console.log(
    `Downloading wind data: ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`
  );
  if (sailingSeason) {
    console.log(`Sailing season only: ${sailingSeason.start} – ${sailingSeason.end}`);
  }
  console.log(`Stations: ${Object.keys(active).join(", ")}`);
  console.log();

  let total = 0;
  for (const [key, station] of Object.entries(active)) {
    total += await downloadStation(
      key,
      station,
      cfg,
      startDate,
      endDate,
      sailingSeason,
      delay,
      args.dryRun
    );
  }

  if (!args.dryRun && total > 0) {
    console.log(`\nTotal records: ${total}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
