import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logosDir = path.join(webRoot, "public", "media", "artist");
const outputDir = path.join(webRoot, "src", "generated");
const outputFile = path.join(outputDir, "logo-dimensions.json");

function dimensions(bytes, filename) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.toString("ascii", 0, 3) === "GIF") {
    return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
  }
  throw new Error(`No se pudo leer el tamaño de ${filename}`);
}

const filenames = (await readdir(logosDir)).filter((name) => /-logo\.(?:png|jpe?g|gif)$/i.test(name)).sort();
const result = {};
for (const filename of filenames) {
  const size = dimensions(await readFile(path.join(logosDir, filename)), filename);
  if (size[0] <= 0 || size[1] <= 0) throw new Error(`Tamaño inválido en ${filename}`);
  result[filename] = size;
}
await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Dimensiones de ${filenames.length} logos registradas.`);
