// Wraps index.html (written for the claude.ai artifact) into a normal page for GitHub Pages: node build.js
const fs = require('fs');
const path = require('path');

const body = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const head = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>[hidden]{display:none!important}img{max-width:100%}</style></head><body>';

fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), head + body + '</body></html>\n');
console.log('wrote docs/index.html');
