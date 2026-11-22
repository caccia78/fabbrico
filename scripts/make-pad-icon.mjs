// Renders public/pad-icon.png (180×180, the iPad home-screen icon for Fabbrico Pad):
// Fabbrico's blue diamond over a hand-drawn pen line. Run: node scripts/make-pad-icon.mjs
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const N = 180, SS = 4; // size, supersampling
const bg = (y) => mix([0x26, 0x2b, 0x36], [0x14, 0x16, 0x1b], y / N);
const blue = [0x4f, 0x8c, 0xff], white = [0xe6, 0xe8, 0xee];
function mix(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }

// Shapes as "inside" tests in icon coordinates.
const diamond = (x, y) => Math.abs(x - 90) + Math.abs(y - 72) <= 44;
const diamondHi = (x, y) => Math.abs(x - 90) + Math.abs(y - 72) <= 44 && x - 90 + (y - 72) < -6; // lit upper-left half
const wave = (t) => [38 + 104 * t, 136 + 9 * Math.sin(t * Math.PI * 2.2)];
function nearWave(x, y, r) {
  for (let i = 0; i <= 200; i++) {
    const [wx, wy] = wave(i / 200);
    if ((x - wx) ** 2 + (y - wy) ** 2 <= r * r) return true;
  }
  return false;
}

const raw = Buffer.alloc((N * 3 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 3 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        let c = bg(py);
        if (diamond(px, py)) c = diamondHi(px, py) ? mix(blue, [255, 255, 255], 0.18) : blue;
        else if (Math.abs(py - 136) < 16 && nearWave(px, py, 3.5)) c = white;
        acc = acc.map((v, i) => v + c[i]);
      }
    for (let i = 0; i < 3; i++) raw[y * (N * 3 + 1) + 1 + x * 3 + i] = Math.round(acc[i] / (SS * SS));
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(new URL('../public/pad-icon.png', import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote public/pad-icon.png');
