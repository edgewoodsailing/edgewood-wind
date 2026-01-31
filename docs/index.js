/**
 * Schedule analysis UI: port of scripts/schedule.js logic.
 * Stats are in UTC; UI accepts and displays times in Cranston, RI (America/New_York).
 */

const SLOTS_PER_DAY = 48;
const HISTOGRAM_MIN_DISPLAY = 10;
const CRANSTON_TZ = "America/New_York";

// Station coordinates (PVDR1 / 8453662) for nautical twilight
const STATION_LAT = 41.7857;
const STATION_LON = -71.3831;

const bandHighlightPlugin = {
  id: "bandHighlight",
  beforeDatasetsDraw(chart) {
    const opts = chart.options.plugins?.bandHighlight;
    if (!opts || opts.windMin == null || opts.gustMax == null) return;
    const { windMin, gustMax } = opts;
    const ctx = chart.ctx;
    const xScale = chart.scales.x;
    if (!xScale) return;
    const left = xScale.left;
    const right = xScale.right;
    const top = chart.chartArea?.top ?? 0;
    const bottom = chart.chartArea?.bottom ?? chart.height;
    const xAt = (v) => xScale.getPixelForValue(v);
    const gray = "rgba(0, 0, 0, 0.12)";
    ctx.save();
    ctx.fillStyle = gray;
    ctx.fillRect(left, top, xAt(windMin) - left, bottom - top);
    ctx.fillStyle = "white";
    const bandLeft = xAt(windMin);
    const bandRight = xAt(gustMax);
    if (bandRight > bandLeft) {
      ctx.fillRect(bandLeft, top, bandRight - bandLeft, bottom - top);
    }
    ctx.fillStyle = gray;
    ctx.fillRect(xAt(gustMax), top, right - xAt(gustMax), bottom - top);
    ctx.restore();
  },
};

let chartInstances = [];

if (typeof Chart !== "undefined") {
  Chart.register(bandHighlightPlugin);
}

function getISOWeekUTC(d) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(d.getUTCDate() - dayNr + 3);
  const jan4 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const dayDiff = (target - jan4) / 86400000;
  return 1 + Math.ceil(dayDiff / 7);
}

function parseDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

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
  return utcDate.toLocaleString("en-US", {
    timeZone: CRANSTON_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
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

/** SunCalc returns UTC Date; express as UTC half-hour slot 0-47. */
function dateToUTCHours(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCMilliseconds() / 3600000;
}

function getNauticalSlotsForRange(startDateStr, endDateStr, lat, lon) {
  if (typeof SunCalc === "undefined") {
    return null;
  }
  const startDate = parseDate(startDateStr);
  const endDate = parseDate(endDateStr);
  let fromSlotNauticalBegin = 0;
  let fromSlotNauticalEnd = 0;
  let toSlotNauticalBegin = SLOTS_PER_DAY;
  let toSlotNauticalEnd = SLOTS_PER_DAY;
  let hasValidDawn = false;
  let hasValidDusk = false;
  const cur = new Date(startDate);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const dayAtNoon = new Date(cur);
    dayAtNoon.setHours(12, 0, 0, 0);
    const times = SunCalc.getTimes(dayAtNoon, lat, lon);
    const dawnHours = dateToUTCHours(times.nauticalDawn);
    const duskHours = dateToUTCHours(times.nauticalDusk);
    if (dawnHours != null && dawnHours >= 0 && dawnHours <= 24) {
      hasValidDawn = true;
      const slotCeil = Math.min(47, Math.max(0, Math.ceil(dawnHours * 2)));
      const slotFloor = Math.min(48, Math.max(0, Math.floor(dawnHours * 2)));
      fromSlotNauticalBegin = Math.max(fromSlotNauticalBegin, slotCeil);
      toSlotNauticalBegin = Math.min(toSlotNauticalBegin, slotFloor);
    }
    if (duskHours != null && duskHours >= 0 && duskHours <= 24) {
      hasValidDusk = true;
      const slotCeil = Math.min(47, Math.max(0, Math.ceil(duskHours * 2)));
      const slotFloor = Math.min(48, Math.max(0, Math.floor(duskHours * 2)));
      fromSlotNauticalEnd = Math.max(fromSlotNauticalEnd, slotCeil);
      toSlotNauticalEnd = Math.min(toSlotNauticalEnd, slotFloor);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return {
    fromSlotNauticalBegin: hasValidDawn ? fromSlotNauticalBegin : 0,
    fromSlotNauticalEnd: hasValidDusk ? fromSlotNauticalEnd : 0,
    toSlotNauticalBegin: hasValidDawn ? toSlotNauticalBegin : SLOTS_PER_DAY,
    toSlotNauticalEnd: hasValidDusk ? toSlotNauticalEnd : SLOTS_PER_DAY,
  };
}

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

function runAnalysis(stats, args) {
  const weeks = cranstonDateRangeToUTCWeeks(args.start, args.end);
  const byWeekHalfHour = stats.by_week_halfhour || {};
  const availableWeeks = weeks.filter((w) => byWeekHalfHour[String(w)]);

  if (availableWeeks.length === 0) {
    return { error: "No data for weeks in date range." };
  }

  const aggregate = aggregateByHalfHour(stats, availableWeeks);
  const slotsCount = Math.round(args.hours * 2);
  const maxStart = SLOTS_PER_DAY - slotsCount;
  const fromSlot = args.from !== "" && args.from !== null ? parseInt(args.from, 10) : 0;
  const toSlot = args.to !== "" && args.to !== null ? parseInt(args.to, 10) : SLOTS_PER_DAY;
  const candidates = [];

  for (let startSlot = 0; startSlot <= maxStart; startSlot++) {
    if (args.from !== "" && args.from !== null && startSlot < fromSlot) continue;
    const endSlot = startSlot + slotsCount;
    if (args.to !== "" && args.to !== null && endSlot > toSlot) continue;

    const cells = [];
    for (let i = 0; i < slotsCount; i++) {
      cells.push(aggregate[startSlot + i]);
    }
    const merged = mergeCells(cells);
    const score = pGoodConditions(merged, args.windMin, args.gustMax);
    candidates.push({ startSlot, score, merged });
  }

  if (candidates.length === 0) {
    return { error: "No time windows match the constraints (Earliest start / Latest end). Try broadening the range." };
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, args.top);

  return {
    summary: {
      start: args.start,
      end: args.end,
      weeks: availableWeeks,
      windMin: args.windMin,
      gustMax: args.gustMax,
      hours: args.hours,
    },
    results: top.map((c, i) => ({
      rank: i + 1,
      start: utcSlotToCranstonTimeString(c.startSlot, args.start),
      end: utcSlotToCranstonTimeString(c.startSlot + slotsCount, args.start),
      score: (c.score * 100).toFixed(1),
      histogram: c.merged.histogram,
      gust_histogram: c.merged.gust_histogram,
    })),
    slotsCount,
  };
}

function getInputs() {
  const start = document.getElementById("start").value;
  const end = document.getElementById("end").value;
  const hours = parseFloat(document.getElementById("hours").value, 10);
  const windMin = parseInt(document.getElementById("windMin").value, 10);
  const gustMax = parseInt(document.getElementById("gustMax").value, 10);
  const top = parseInt(document.getElementById("top").value, 10) || 10;
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;
  return { start, end, hours, windMin, gustMax, top, from, to };
}

function validateInputs(args) {
  if (!args.start || !args.end) return "Set start and end date.";
  if (Number.isNaN(args.windMin) || args.windMin < 0 || args.windMin > 35) return "Wind min must be 0–35 kt.";
  if (Number.isNaN(args.gustMax) || args.gustMax < 0 || args.gustMax > 35) return "Gust max must be 0–35 kt.";
  const startDate = parseDate(args.start);
  const endDate = parseDate(args.end);
  if (startDate > endDate) return "Start date must be before end date.";
  if (Number.isNaN(args.hours) || args.hours < 0.5) return "Session length must be at least 0.5 hours.";
  return null;
}

function render(stats, args) {
  const summaryEl = document.getElementById("summary");
  const messageEl = document.getElementById("message");
  const tbody = document.querySelector("#results tbody");
  const footnoteEl = document.getElementById("footnote");

  const err = validateInputs(args);
  if (err) {
    summaryEl.textContent = "";
    messageEl.textContent = err;
    messageEl.className = "error";
    tbody.innerHTML = "";
    footnoteEl.textContent = "";
    return;
  }

  let resolvedArgs = { ...args };
  const needsNautical =
    args.from === "nautical-begin" ||
    args.from === "nautical-end" ||
    args.to === "nautical-begin" ||
    args.to === "nautical-end";
  if (needsNautical) {
    const nautical = getNauticalSlotsForRange(
      args.start,
      args.end,
      STATION_LAT,
      STATION_LON
    );
    if (nautical == null) {
      summaryEl.textContent = "";
      messageEl.textContent =
        "SunCalc not loaded. Nautical twilight options require the SunCalc script.";
      messageEl.className = "error";
      tbody.innerHTML = "";
      footnoteEl.textContent = "";
      return;
    }
    if (args.from === "nautical-begin") {
      resolvedArgs.from = String(nautical.fromSlotNauticalBegin);
    } else if (args.from === "nautical-end") {
      resolvedArgs.from = String(nautical.fromSlotNauticalEnd);
    }
    if (args.to === "nautical-begin") {
      resolvedArgs.to = String(nautical.toSlotNauticalBegin);
    } else if (args.to === "nautical-end") {
      resolvedArgs.to = String(nautical.toSlotNauticalEnd);
    }
  } else {
    if (args.from !== "" && args.from != null && /^\d+$/.test(args.from)) {
      resolvedArgs.from = String(cranstonLocalToUTCSlot(args.start, parseInt(args.from, 10) / 2));
    }
    if (args.to !== "" && args.to != null && /^\d+$/.test(args.to)) {
      resolvedArgs.to = String(cranstonLocalToUTCSlot(args.start, parseInt(args.to, 10) / 2));
    }
  }

  const out = runAnalysis(stats, resolvedArgs);
  if (out.error) {
    summaryEl.textContent = "";
    messageEl.textContent = out.error;
    messageEl.className = "error";
    tbody.innerHTML = "";
    footnoteEl.textContent = "";
    return;
  }

  const w = out.summary.weeks;
  summaryEl.textContent = `Date range ${out.summary.start} to ${out.summary.end} (weeks ${w[0]}-${w[w.length - 1]}); wind ≥ ${out.summary.windMin} kt, gust ≤ ${out.summary.gustMax} kt. Times in Eastern (Cranston, RI).`;
  messageEl.textContent = "";
  messageEl.className = "";

  chartInstances.forEach((chart) => chart.destroy());
  chartInstances = [];

  let xMax = 0;
  for (const r of out.results) {
    for (let i = 0; i < 36; i++) {
      if ((r.histogram[i] || 0) > 0 || (r.gust_histogram[i] || 0) > 0) {
        xMax = Math.max(xMax, i);
      }
    }
  }
  xMax = Math.max(xMax, HISTOGRAM_MIN_DISPLAY);

  const labels = Array.from({ length: xMax + 1 }, (_, i) => i);

  tbody.innerHTML = out.results
    .map(
      (r) =>
        `<tr><td>${r.rank}</td><td>${r.start}</td><td>${r.end}</td><td class="histogram-cell"></td><td>${r.score}%</td></tr>`
    )
    .join("");

  const rows = tbody.querySelectorAll("tr");
  rows.forEach((tr, idx) => {
    const r = out.results[idx];
    const cell = tr.querySelector(".histogram-cell");
    const canvas = document.createElement("canvas");
    canvas.width = 150;
    canvas.height = 50;
    cell.appendChild(canvas);

    const rawWind = r.histogram.slice(0, xMax + 1);
    const rawGust = r.gust_histogram.slice(0, xMax + 1);
    let lastWind = -1;
    let lastGust = -1;
    for (let i = 0; i < rawWind.length; i++) {
      if (rawWind[i] > 0) lastWind = i;
      if (rawGust[i] > 0) lastGust = i;
    }
    const windData = rawWind.map((v, i) => (i > lastWind ? null : v));
    const gustData = rawGust.map((v, i) => (i > lastGust ? null : v));

    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Gust",
            data: gustData,
            borderColor: "rgb(255, 159, 64)",
            backgroundColor: "transparent",
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
          },
          {
            label: "Wind",
            data: windData,
            borderColor: "rgb(54, 162, 235)",
            backgroundColor: "transparent",
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          bandHighlight: {
            windMin: args.windMin,
            gustMax: args.gustMax,
          },
        },
        scales: {
          x: { display: false },
          y: { display: false },
        },
      },
    });
    chartInstances.push(chart);
  });

  footnoteEl.textContent =
    "Score = estimated % of session hours with good conditions (wind ≥ min, gust ≤ max); assumes wind and gust are independent. Times shown in Eastern (Cranston, RI).";
}

function bindRangeDisplay(id, valueId) {
  const input = document.getElementById(id);
  const valueSpan = document.getElementById(valueId);
  function update() {
    valueSpan.textContent = input.value;
  }
  input.addEventListener("input", update);
  update();
}

function main() {
  const year = new Date().getFullYear();
  document.getElementById("start").value = `${year}-06-15`;
  document.getElementById("end").value = `${year}-07-05`;

  const messageEl = document.getElementById("message");
  messageEl.textContent = "Loading…";

  fetch("8453662_stats.json")
    .then((r) => {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    })
    .then((stats) => {
      messageEl.textContent = "";

      bindRangeDisplay("windMin", "windMinValue");
      bindRangeDisplay("gustMax", "gustMaxValue");

      function update() {
        render(stats, getInputs());
      }

      ["start", "end", "hours", "windMin", "gustMax", "top", "from", "to"].forEach(
        (id) => {
          document.getElementById(id).addEventListener("input", update);
          document.getElementById(id).addEventListener("change", update);
        }
      );

      update();
    })
    .catch((err) => {
      messageEl.textContent = "Failed to load stats: " + err.message;
      messageEl.className = "error";
    });
}

main();
