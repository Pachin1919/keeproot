#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const size = 32;
const rowBytes = size * 4;
const pixels = Buffer.alloc(rowBytes * size);

function insideMark(x, y) {
  const left = 8 + Math.floor((23 - y) * 0.28);
  const right = 23 - Math.floor((23 - y) * 0.28);
  const legs = y >= 7 && y <= 25 && (Math.abs(x - left) <= 1 || Math.abs(x - right) <= 1);
  const bar = y >= 17 && y <= 19 && x >= left && x <= right;
  return legs || bar;
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = ((size - 1 - y) * size + x) * 4;
    const corner = Math.min(x, y, size - 1 - x, size - 1 - y);
    const visible = corner >= 4 || ((x >= 2 && x < 30) && (y >= 2 && y < 30));
    const mark = insideMark(x, y);
    pixels[offset] = mark ? 236 : 54;
    pixels[offset + 1] = mark ? 244 : 88;
    pixels[offset + 2] = mark ? 240 : 55;
    pixels[offset + 3] = visible ? 255 : 0;
  }
}

const bitmapHeader = Buffer.alloc(40);
bitmapHeader.writeUInt32LE(40, 0);
bitmapHeader.writeInt32LE(size, 4);
bitmapHeader.writeInt32LE(size * 2, 8);
bitmapHeader.writeUInt16LE(1, 12);
bitmapHeader.writeUInt16LE(32, 14);
bitmapHeader.writeUInt32LE(pixels.length, 20);
const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
const image = Buffer.concat([bitmapHeader, pixels, mask]);

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = size;
entry[1] = size;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'assets', 'atlas.ico');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([header, entry, image]));
console.log(output);
