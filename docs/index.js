/**
 * Schedule analysis UI: port of scripts/schedule.js logic.
 * Fetches compacted stats JSON, reads form inputs, runs aggregation and scoring, renders table.
 */

const SLOTS_PER_DAY = 48;
const HISTOGRAM_MIN_DISPLAY = 10;

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

function getISOWeek(d) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const jan4 = new Date(target.getFullYear(), 0, 4);
  const dayDiff = (target - jan4) / 86400000;
  return 1 + Math.ceil(dayDiff / 7);
}

function parseDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dateRangeToWeeks(startDate, endDate) {
  const weeks = new Set();
  const cur = new Date(startDate);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    weeks.add(getISOWeek(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return [...weeks].sort((a, b) => a - b);
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

function formatHalfHour(slot) {
  const hour = Math.floor(slot / 2);
  const minute = (slot % 2) * 30;
  const h = hour === 0 ? 12 : hour === 12 ? 12 : hour > 12 ? hour - 12 : hour;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatTimeRangeHalfHour(startSlot, slotsCount) {
  const endSlot = startSlot + slotsCount;
  return `${formatHalfHour(startSlot)} – ${formatHalfHour(endSlot)}`;
}

function runAnalysis(stats, args) {
  const startDate = parseDate(args.start);
  const endDate = parseDate(args.end);
  const weeks = dateRangeToWeeks(startDate, endDate);
  const byWeekHalfHour = stats.by_week_halfhour || {};
  const availableWeeks = weeks.filter((w) => byWeekHalfHour[String(w)]);

  if (availableWeeks.length === 0) {
    return { error: "No data for weeks in date range. Date range may be outside sailing season (May–Sept)." };
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
      start: formatHalfHour(c.startSlot),
      end: formatHalfHour(c.startSlot + slotsCount),
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

  const out = runAnalysis(stats, args);
  if (out.error) {
    summaryEl.textContent = "";
    messageEl.textContent = out.error;
    messageEl.className = "error";
    tbody.innerHTML = "";
    footnoteEl.textContent = "";
    return;
  }

  const w = out.summary.weeks;
  summaryEl.textContent = `Date range ${out.summary.start} to ${out.summary.end} (weeks ${w[0]}-${w[w.length - 1]}); wind ≥ ${out.summary.windMin} kt, gust ≤ ${out.summary.gustMax} kt.`;
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
    "Score = estimated % of session hours with good conditions (wind ≥ min, gust ≤ max); assumes wind and gust are independent.";
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
