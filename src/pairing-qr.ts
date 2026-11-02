import { createRequire } from "node:module";

// Reuse the encoder already shipped with qrcode-terminal; never turn terminal ANSI into markup.
const require = createRequire(import.meta.url);
type QrMatrix = { addData(value: string): void; make(): void; getModuleCount(): number; isDark(row: number, column: number): boolean };
const QRCode = require("qrcode-terminal/vendor/QRCode") as new (version: number, level: number) => QrMatrix;
const levels = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { M: number };

/** A self-contained numeric SVG matrix; input is the existing base64url setup code. */
export function renderPairingQrSvg(code: string): string {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(code)) throw new Error("invalid_pairing_code");
  const qr = new QRCode(-1, levels.M);
  qr.addData(code);
  qr.make();
  const count = qr.getModuleCount();
  const quietZone = 4;
  const size = count + quietZone * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (qr.isDark(row, column)) cells.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="320" height="320" shape-rendering="crispEdges" role="img" aria-label="ClawSense pairing QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${cells.join("")}" fill="#000"/></svg>`;
}
