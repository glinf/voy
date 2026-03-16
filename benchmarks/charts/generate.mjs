import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";

const RESULTS_DIR = join(import.meta.dirname, "..", "results");
const WIDTH = 800;
const HEIGHT = 500;

const canvas = new ChartJSNodeCanvas({ width: WIDTH, height: HEIGHT });

async function loadResults() {
  const args = process.argv.slice(2);
  const files = args.length
    ? args
    : [join(RESULTS_DIR, "latest.json")];

  const results = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(f, "utf-8"));
    const label = f.replace(/.*\//, "").replace(".json", "");
    results.push({ label, data });
  }
  return results;
}

async function renderChart(filename, config) {
  const buffer = await canvas.renderToBuffer(config);
  const outPath = join(RESULTS_DIR, filename);
  await writeFile(outPath, buffer);
  console.log(`  ${filename}`);
}

function lineChart(title, xLabel, yLabel, datasets) {
  return {
    type: "line",
    data: { datasets },
    options: {
      plugins: { title: { display: true, text: title } },
      scales: {
        x: { title: { display: true, text: xLabel }, type: "linear" },
        y: { title: { display: true, text: yLabel }, beginAtZero: true },
      },
    },
  };
}

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];

const CHARTS = [
  { file: "01-batch-index-time.png", title: "Batch Index Time" },
  { file: "02-serialized-size.png", title: "Serialized Index Size" },
  { file: "03-search-vs-size.png", title: "Search Latency vs Index Size (k=10)" },
  { file: "04-search-vs-k.png", title: "Search Latency vs k" },
  { file: "05-add-latency.png", title: "Add Latency vs Index Size" },
  { file: "06-remove-latency.png", title: "Remove Latency vs Index Size" },
  { file: "07-serde-time.png", title: "Serialize / Deserialize Time" },
  { file: "08-wasm-heap-size.png", title: "WASM Heap Size" },
];

function generateHTML() {
  const cards = CHARTS.map(({ file, title }) => `
      <section>
        <h2>${title}</h2>
        <img src="${file}" alt="${title}" />
      </section>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voy Benchmark Results</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #1a1a1a; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 2rem; font-size: 1.8rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(720px, 1fr)); gap: 2rem; max-width: 1800px; margin: 0 auto; }
    section { background: #fff; border-radius: 8px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    section h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #333; }
    img { width: 100%; height: auto; display: block; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Voy Benchmark Results</h1>
  <div class="grid">${cards}
  </div>
</body>
</html>`;
}

async function generate() {
  const runs = await loadResults();

  console.log("Generating charts...");

  // 1. Batch index time
  await renderChart("01-batch-index-time.png", lineChart(
    "Batch Index Time", "Document Count", "Time (ms)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.batchIndex.map((p) => ({ x: p.n, y: p.median })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // 2. Serialized index size
  await renderChart("02-serialized-size.png", lineChart(
    "Serialized Index Size", "Document Count", "Size (KB)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.serializedSize.map((p) => ({ x: p.n, y: p.sizeKB })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // 3. Search latency vs size
  await renderChart("03-search-vs-size.png", lineChart(
    "Search Latency vs Index Size (k=10)", "Document Count", "Time (ms)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.searchVsSize.map((p) => ({ x: p.n, y: p.median })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // 4. Search latency vs k
  await renderChart("04-search-vs-k.png", lineChart(
    "Search Latency vs k (full index)", "k", "Time (ms)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.searchVsK.map((p) => ({ x: p.k, y: p.median })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // 5. Add latency
  await renderChart("05-add-latency.png", lineChart(
    "Add Latency vs Index Size", "Current Index Size", "Time (ms)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.addLatency.map((p) => ({ x: p.size, y: p.median })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // 6. Remove latency
  await renderChart("06-remove-latency.png", lineChart(
    "Remove Latency vs Index Size", "Current Index Size", "Time (ms)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.removeLatency.map((p) => ({ x: p.size, y: p.median })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // 7. Serialize/deserialize
  await renderChart("07-serde-time.png", lineChart(
    "Serialize / Deserialize Time", "Document Count", "Time (ms)",
    [
      ...runs.map((r, i) => ({
        label: `${r.label} serialize`,
        data: r.data.serdeTime.map((p) => ({ x: p.n, y: p.serialize.median })),
        borderColor: COLORS[i * 2 % COLORS.length],
      })),
      ...runs.map((r, i) => ({
        label: `${r.label} deserialize`,
        data: r.data.serdeTime.map((p) => ({ x: p.n, y: p.deserialize.median })),
        borderColor: COLORS[(i * 2 + 1) % COLORS.length],
        borderDash: [5, 5],
      })),
    ],
  ));

  // 8. WASM heap size
  await renderChart("08-wasm-heap-size.png", lineChart(
    "WASM Heap Size", "Document Count", "Size (MB)",
    runs.map((r, i) => ({
      label: r.label,
      data: r.data.heapSize.map((p) => ({ x: p.n, y: p.heapMB })),
      borderColor: COLORS[i % COLORS.length],
    })),
  ));

  // Generate HTML viewer
  await writeFile(join(RESULTS_DIR, "index.html"), generateHTML());
  console.log("  index.html");

  console.log("Done!");
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
