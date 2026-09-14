/* Derives the logo variants the documents need from the supplied artwork.
 *
 *   node tools/make-logo-variants.mjs
 *
 * The source is a white mark on an opaque black square (JPEG, no alpha). Placed
 * as-is on a coloured band that black square is visible, so two transparent PNGs
 * are generated instead:
 *
 *   logo-white.png  white mark, transparent ground — for the blue header band
 *   logo-black.png  black mark, transparent ground — for white areas
 *
 * Re-run after replacing frontend/assets/logo.jpeg.
 */

import { Jimp } from "jimp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "assets");
const SOURCE = join(assets, "logo.jpeg");

/* JPEG is lossy, so the "black" ground is never exactly 0 and the white mark is
   never exactly 255. Split on luminance well away from both. */
const THRESHOLD = 128;

const img = await Jimp.read(SOURCE);
console.log(`source: ${img.width} × ${img.height}`);

const make = (invert) => {
  const out = img.clone();
  out.scan(0, 0, out.width, out.height, function (x, y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    const isMark = lum >= THRESHOLD;          // the white bee
    const value = invert ? 0 : 255;           // black mark, or white mark

    this.bitmap.data[idx] = value;
    this.bitmap.data[idx + 1] = value;
    this.bitmap.data[idx + 2] = value;
    /* Alpha follows luminance rather than snapping to 0/255, so the anti-aliased
       edges of the artwork stay smooth instead of going jagged. */
    this.bitmap.data[idx + 3] = isMark
      ? Math.round(Math.min(255, (lum - THRESHOLD) / (255 - THRESHOLD) * 255 + 60))
      : 0;
  });
  return out;
};

/* The mark prints at about 40pt wide. 160px covers that at 300dpi with room to
   spare; the full 447px source made a one-page quotation 793 KB. */
const PRINT_PX = 160;

for(const [name, invert] of [["logo-white.png", false], ["logo-black.png", true]]){
  const out = make(invert);
  if(out.width > PRINT_PX) out.resize({ w: PRINT_PX, h: PRINT_PX });
  await out.write(join(assets, name));
  console.log(`wrote ${name} (${out.width} × ${out.height})`);
}
