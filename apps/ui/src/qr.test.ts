// node --test (via tsx): the QR the pairing screen draws (qrcode.react, same props as SyncPanel) is decodable by the scanner (jsQR).
//   cd apps/ui && npx tsx --test src/qr.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import jsQR from "jsqr";

/** Rasterize the SVG qrcode.react produces (white background path + one dark path of "M x y h<w> v1 H x z" modules) into RGBA like a camera frame would hold,
 *  with the 4-module quiet zone the page gives it (the .qr box has a white padding; the component itself draws none). */
function raster(svg: string, scale = 6, quiet = 4) {
  const n = Number(/viewBox="0 0 (\d+) (\d+)"/.exec(svg)![1]), dark = /<path fill="#000000" d="([^"]+)"/i.exec(svg);
  assert.ok(dark, "svg has a module path");
  const side = (n + 2 * quiet) * scale, px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const m of dark![1].matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H/g)) { const x0 = +m[1] + quiet, y0 = +m[2] + quiet, w = +m[3]; for (let y = y0 * scale; y < (y0 + 1) * scale; y++) for (let x = x0 * scale; x < (x0 + w) * scale; x++) { const i = (y * side + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; } }
  return { data: px, size: side };
}
const link = "unichat-sync://pair?h=192.168.1.20,10.0.0.7&p=45045&c=bakolemizutanosu&k=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
for (const level of ["L", "M", "Q"] as const) test(`jsQR decodes a rendered pairing link (level ${level})`, () => {
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value: link, size: 150, level }));
  const { data, size } = raster(svg), r = jsQR(data, size, size);
  assert.equal(r?.data, link);
});
test("a link that is not ours is decoded but not mistaken for a pairing link", async () => {
  const { isSyncLink } = await import("./syncLink");
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, { value: "https://example.org/x", size: 150 })), { data, size } = raster(svg);
  assert.equal(jsQR(data, size, size)?.data, "https://example.org/x"); assert.equal(isSyncLink("https://example.org/x"), false);
});
