# Edgewood Wind Analysis

Analyze wind patterns near **Edgewood Yacht Club** (Cranston, RI) to identify statistically favorable times of day for sailing, by week of year. Supports scheduling sailing classes based on historical wind data.

## Project Structure

```
edgewood-wind/
├── config/
│   ├── stations.yaml    # Weather station definitions (add more here)
│   └── download.yaml    # Download defaults (dates, interval, etc.)
├── data/
│   ├── raw/             # Downloaded JSON from NOAA CO-OPS API
│   │   │   └── 8453662/   # PVDR1 by year: 2017.json, 2018.json, ...
│   └── processed/       # 8453662_stats.json (histogram by week × half-hour slot)
├── scripts/
│   ├── download_wind.js # Fetch wind data from NOAA (6-min, monthly chunks)
│   ├── process_wind.js  # Build histograms by (week, half-hour slot 0-47)
│   ├── query.js         # Query probability for a wind range
│   └── schedule.js      # Recommend optimal timeslots for sessions
├── package.json
└── README.md
```

## Quick Start

```bash
# Install dependencies
npm install

# Download wind data (PVDR1, 2017–present)
npm run download

# Dry run to see what would be fetched
npm run download:dry

# Note: 6-minute data requires ~5 API requests per year (1 per month). Download takes longer than hourly.
# Specific date range or station
node scripts/download_wind.js --start 2020-01-01 --end 2024-12-31
node scripts/download_wind.js --station PVDR1

# Process raw data into histogram statistics (week × half-hour slot)
npm run process

# Query probability of wind in a range (e.g., 5–12 kt for beginners)
npm run query -- --week 28 --slot 28 --min 5 --max 12
node scripts/query.js --week 28 --hour 14 --minute 30 --min 5 --max 12 --gust-max 15

# Recommend optimal timeslots for a date range (wind ≥ min, gust ≤ max)
npm run schedule -- --start 2024-06-15 --end 2024-07-05 --wind-min 5 --gust-max 15
```

## Processing and Querying

After downloading, run `npm run process` to aggregate raw 6-minute data into histograms (1-knot bins) by week and **half-hour slot** (0–47). Slot 0 = 00:00–00:30, slot 28 = 2:00–2:30 PM, etc. This produces `data/processed/8453662_stats.json`, which supports flexible queries for any wind range without reprocessing.

**Query options:**

- `--week` (1–52): ISO week of year (sailing season ≈ weeks 18–39)
- `--slot` (0–47): Half-hour slot, or `--hour` (0–23) with optional `--minute` (0 or 30)
- `--min`, `--max`: Wind speed range in knots (e.g., 5–12 for beginners, 8–18 for advanced)
- `--gust-max`: Optionally show % of observations with gust ≤ this value

**Schedule recommendation** (`npm run schedule`): Input a date range and wind criteria (wind ≥ min, gust ≤ max). Outputs a ranked list of optimal timeslots in half-hour alignment (e.g., "2:00 PM – 5:00 PM: 62%"). Uses `--start`, `--end`, `--wind-min`, `--gust-max`; optional `--hours` (default 3), `--top` (default 10), `--from` and `--to` to constrain time windows (e.g. `--to 12` for morning-only, `--from 5pm` for evening-only). Times accept flexible formats: 0–23, `8a`, `5pm`, `14.5` or `2:30pm` for half-hour.

## Data Source

**Primary station: PVDR1 (8453662) — Providence Visibility**

- Location: Providence River, ~0.6 mi from Edgewood Yacht Club
- Established: Sept 2016
- Data: 6-minute wind (speed, direction, gusts); 1 month per API request
- API: [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/)

## Sailing Season

Data is downloaded only for **May 1 – September 30** each year (when the sailing school is open). Adjust `config/download.yaml` → `sailing_season` to change these dates. Remove or comment out `sailing_season` to fetch full calendar years.

## Adding More Stations

Edit `config/stations.yaml` and set `active: true` for additional stations (e.g. Providence 8454000, Conimicut Light 8452944). The download script will fetch all active stations.

---

## Statistical Guidance: How Much Data Do We Need?

**Short answer: 5–10 years is ideal. 3 years is a minimum for meaningful patterns.**

### The Problem

We want to estimate **best times of day for sailing by week** — e.g. “Week 28 (mid-July), 2–4 PM” — to inform class scheduling. Wind varies a lot day to day, so we need many independent observations per (week × time) cell to get stable statistics.

### Sample Size

- **Granularity**: 52 weeks × 48 half-hour slots = 2,496 cells.
- **Observations per cell** (half-hour slots): With 6-minute data, ~5 observations per half-hour. 1 year × 5 months × ~7 days/week ≈ 35 per cell; 8 years → ~280 — robust.
- **Rule of thumb**: 20–30+ observations per cell gives reasonable confidence intervals.

### Is Meaningful Analysis Possible?

**Yes.** Coastal wind has seasonal and diurnal patterns (e.g. sea breeze in afternoon, calmer mornings). With 5–10 years of data we can:

1. **Mean wind speed** by (week, half-hour) — identify when wind is typically strong enough to sail.
2. **Probability of “sailable” conditions** — e.g. P(5 kt ≤ wind ≤ 20 kt) for teaching.
3. **Variability** — lower variability can mean more predictable scheduling.
4. **Confidence intervals** — quantify uncertainty in our estimates.

### Defining “Best” for Sailing

You’ll need to define “sailable” for your use case. Common criteria:

- **Beginners**: 5–12 knots, steady; avoid gusts > 15 kt.
- **Intermediate**: 8–18 knots.
- **Racing**: 10–20 knots, consistent direction.

The analysis can compute the probability of conditions falling in your chosen range, by week and time of day.

### Practical Recommendation

1. **Download 2017–present** (~8 years for PVDR1) — plenty for robust statistics.
2. **6-minute data** is used for half-hour granularity; download makes ~5 API requests per year (1 per month). Run `npm run download:dry` to preview.
3. **2–3 hour time blocks** (e.g. 9–11, 12–2, 2–4, 4–6) for session scheduling; schedule tool slides half-hour-aligned windows.
4. **Focus on sailing season** (May–September) — configurable in `config/download.yaml`.
