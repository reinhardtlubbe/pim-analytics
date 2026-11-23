const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const outputDirectory = path.join(__dirname, '..', 'fixtures', 'synthetic');
const label = 'SYNTHETIC TEST DATA - generated for development, not real supplier exports';

function months(start, count) {
  const [year, month] = start.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildTikTok() {
  const random = seeded(42);
  const headers = ['Campaign name', 'Advertising objective', 'By month', 'Ad group name', 'Placements Types', 'Spend', 'Impressions', 'Clicks (destination)', 'Currency'];
  const campaigns = [
    ['Synthetic Always On Traffic', 'Traffic', 'Broad 18-34'],
    ['Synthetic Always On Traffic', 'Traffic', 'Retargeting'],
    ['Synthetic Brand Reach', 'Reach', 'National'],
    ['Synthetic Video Push', 'Video views', 'Interest stack'],
    ['Synthetic Lead Drive', 'Lead generation', 'Lookalike'],
  ];
  const rows = [];
  months('2024-07', 18).forEach((month, monthIndex) => {
    const festive = month.endsWith('-11') || month.endsWith('-12') ? 1.35 : 1;
    campaigns.forEach(([campaign, objective, adGroup]) => {
      const spend = Math.round((1500 + random() * 6000) * festive * 100) / 100;
      const cpm = 18 + random() * 12;
      const impressions = Math.round((spend / cpm) * 1000);
      const clicks = Math.round((impressions * (0.006 + random() * 0.01)) / Math.pow(festive, 0.5));
      rows.push([campaign, objective, month, adGroup, 'Automatic placement', spend.toFixed(2), impressions, clicks, 'ZAR']);
    });
    if (monthIndex === 3) {
      rows.push(['Synthetic Data Quality Check', 'Traffic', 'not a month', 'QA', 'Automatic placement', '120.00', 5000, 40, 'ZAR']);
    }
  });
  const totalSpend = rows.reduce((sum, row) => sum + (Number(row[5]) || 0), 0);
  const lines = [headers, ...rows, [`Total of ${rows.length} results`, '-', '-', '-', '-', totalSpend.toFixed(2), '', '', '']];
  return lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

function buildMeta() {
  const random = seeded(7);
  const headers = ['Reporting starts', 'Reporting ends', 'Objective', 'Month', 'Platform', 'Amount spent (ZAR)', 'Impressions', 'Link clicks'];
  const combinations = [
    ['Link clicks', 'Facebook'],
    ['Link clicks', 'Instagram'],
    ['Reach', 'Facebook'],
    ['Reach', 'Instagram'],
    ['Conversions', 'Facebook'],
    ['Post engagement', 'Instagram'],
  ];
  const rows = [];
  let counter = 0;
  months('2024-07', 18).forEach((month) => {
    const [year, monthNumber] = month.split('-').map(Number);
    const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    combinations.forEach(([objective, platform]) => {
      counter += 1;
      const spend = Math.round((2000 + random() * 9000) * 100) / 100;
      const impressions = Math.round((spend / (25 + random() * 15)) * 1000);
      const clicks = objective === 'Reach' && counter % 4 === 0 ? null : Math.round(impressions * (0.004 + random() * 0.012));
      rows.push([`${month}-01`, `${month}-${last}`, objective, `${month}-01 - ${month}-${last}`, platform, spend, impressions, clicks]);
    });
  });
  const summary = [rows[0][0], rows[rows.length - 1][1], null, null, null, rows.reduce((sum, row) => sum + row[5], 0), rows.reduce((sum, row) => sum + row[6], 0), null];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[label]]), 'About');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, summary, ...rows]), 'Raw Data Report');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'SYNTHETIC_tiktok_ads_sample.csv'), `﻿${buildTikTok()}`);
fs.writeFileSync(path.join(outputDirectory, 'SYNTHETIC_meta_client_sample.xlsx'), buildMeta());
fs.writeFileSync(
  path.join(outputDirectory, 'README.txt'),
  `${label}\r\n\r\nSYNTHETIC_tiktok_ads_sample.csv: 18 months of TikTok-style rows, one deliberately invalid month, and one "Total of N results" summary row.\r\nSYNTHETIC_meta_client_sample.xlsx: 18 months of Meta-style rows on worksheet "Raw Data Report", a summary row directly under the header, and some blank Link clicks values.\r\n\r\nThe real reference files (Tiktok Ads Yr 1.csv, Tiktok Ads Yr 2.csv, Meta client 1.xlsx, Meta Client 2.xlsx) are not included.\r\n`,
);
console.log(`Synthetic fixtures written to ${outputDirectory}`);
