#!/usr/bin/env node
/**
 * Copy processed stats JSON to docs/, minified (no whitespace).
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const src = join(PROJECT_ROOT, "data", "processed", "8453662_stats.json");
const dest = join(PROJECT_ROOT, "docs", "8453662_stats.json");

const json = JSON.parse(readFileSync(src, "utf8"));
writeFileSync(dest, JSON.stringify(json), "utf8");
console.log(`Copied ${src} -> ${dest} (minified)`);
