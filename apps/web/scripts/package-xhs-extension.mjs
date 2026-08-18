import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(
  scriptDir,
  "../../../extensions/xiaohongshu-draft-uploader",
);
const outputPath = resolve(
  scriptDir,
  "../public/downloads/geekdance-multi-platform-draft-uploader.zip",
);
const legacyOutputPath = resolve(
  scriptDir,
  "../public/downloads/geekdance-xiaohongshu-draft-uploader.zip",
);

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1)
    current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

const files = await Promise.all(
  (await readdir(sourceDir))
    .filter((name) => !name.startsWith(".") && name !== "test.mjs")
    .sort()
    .map(async (name) => ({
      name,
      data: await readFile(join(sourceDir, name)),
    })),
);

function buildArchive(rootDirectory) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(`${rootDirectory}/${file.name}`);
    const checksum = crc32(file.data);
    const local = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(file.data.length),
      uint32(file.data.length),
      uint16(name.length),
      uint16(0),
      name,
      file.data,
    ]);
    localParts.push(local);
    centralParts.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(checksum),
        uint32(file.data.length),
        uint32(file.data.length),
        uint16(name.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        name,
      ]),
    );
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(central.length),
    uint32(offset),
    uint16(0),
  ]);
}

await mkdir(dirname(outputPath), { recursive: true });
await Promise.all([
  writeFile(
    outputPath,
    buildArchive("geekdance-multi-platform-draft-uploader"),
  ),
  // Preserve the previous directory name so an existing unpacked extension
  // can be overwritten in place, retaining its Chrome ID and local pairing.
  writeFile(
    legacyOutputPath,
    buildArchive("geekdance-xiaohongshu-draft-uploader"),
  ),
]);
