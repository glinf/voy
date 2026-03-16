import { test } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const RESULTS_DIR = join(import.meta.dirname, "..", "results");

test("run benchmarks and collect results", async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);

  const logs = [];
  page.on("console", (msg) => logs.push(msg.text()));

  await page.goto("/benchmarks/page/index.html");

  await page.waitForFunction(() => window.__benchmarkResults, null, {
    timeout: 30 * 60 * 1000,
  });

  const results = await page.evaluate(() => window.__benchmarkResults);

  if (results.error) {
    console.log("--- Benchmark console output ---");
    logs.forEach((l) => console.log(l));
    console.log("--- End console output ---");
    throw new Error(`Benchmark failed: ${results.error}`);
  }

  await mkdir(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const timestampedPath = join(RESULTS_DIR, `${timestamp}.json`);
  const latestPath = join(RESULTS_DIR, "latest.json");

  const json = JSON.stringify(results, null, 2);
  await writeFile(timestampedPath, json);
  await writeFile(latestPath, json);

  console.log(`Results written to ${timestampedPath}`);
});
