#!/usr/bin/env node
/**
 * Print `coverage/coverage-summary.json` (from `vitest run --coverage`) as a
 * Markdown table, for the CI job summary. Reports only: there is no threshold.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'coverage/coverage-summary.json';
const { total } = JSON.parse(readFileSync(path, 'utf8'));
const rows = ['lines', 'statements', 'branches', 'functions'].map((key) => {
  const { covered, total: count, pct } = total[key];
  return `| ${key} | ${pct.toFixed(2)}% | ${covered} / ${count} |`;
});
console.log(['### Unit test coverage (v8)', '', '| | % | covered |', '|---|---:|---:|', ...rows].join('\n'));
