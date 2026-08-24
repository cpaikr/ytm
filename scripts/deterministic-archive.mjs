import { gzipSync, gunzipSync } from "node:zlib";

const TAR_BLOCK = 512;
const ZIP_DATE = 0x0021;
const ZIP_TIME = 0;

export function createTarGz(entries) {
  const chunks = [];
  for (const entry of sortedEntries(entries)) {
    const body = Buffer.from(entry.contents);
    const header = Buffer.alloc(TAR_BLOCK);
    writeTarText(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeTarText(header, 257, 6, "ustar");
    Buffer.from("00").copy(header, 263);
    writeTarText(header, 265, 32, "root");
    writeTarText(header, 297, 32, "root");
    writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    chunks.push(header, body, Buffer.alloc((TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  // zlib writes the host platform into the gzip OS byte. Normalize it so an
  // archive built on macOS can be reproduced exactly on the Linux release job.
  archive[9] = 0xff;
  return archive;
}

export function readTarGz(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + TAR_BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readNullTerminated(header.subarray(0, 100));
    const size = Number.parseInt(readNullTerminated(header.subarray(124, 136)).trim() || "0", 8);
    const mode = Number.parseInt(readNullTerminated(header.subarray(100, 108)).trim() || "0", 8);
    if (header[156] !== 0x30 && header[156] !== 0) throw new Error(`Unsupported tar entry type for ${name}.`);
    const start = offset + TAR_BLOCK;
    const end = start + size;
    if (end > tar.length) throw new Error(`Truncated tar entry ${name}.`);
    entries.push({ name, mode, contents: tar.subarray(start, end) });
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return entries;
}

export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of sortedEntries(entries)) {
    const name = Buffer.from(entry.name);
    const body = Buffer.from(entry.contents);
    const crc = crc32(body);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(ZIP_TIME, 10);
    localHeader.writeUInt16LE(ZIP_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(ZIP_TIME, 12);
    centralHeader.writeUInt16LE(ZIP_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE((entry.mode & 0xffff) << 16, 38);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(localHeader, name, body);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export function readZip(archive) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const flags = archive.readUInt16LE(offset + 6);
    const compression = archive.readUInt16LE(offset + 8);
    if (flags !== 0x0800 || compression !== 0) throw new Error("ZIP archive uses unsupported flags or compression.");
    const crc = archive.readUInt32LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if (compressedSize !== size) throw new Error("ZIP archive must use stored entries.");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const contents = archive.subarray(dataStart, dataStart + size);
    if (contents.length !== size || crc32(contents) !== crc) throw new Error("ZIP entry is truncated or corrupt.");
    entries.push({ name: archive.subarray(nameStart, nameStart + nameLength).toString(), contents });
    offset = dataStart + size;
  }
  return entries;
}

function sortedEntries(entries) {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function writeTarText(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length >= length) throw new Error(`Tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`Tar numeric field is too large: ${value}`);
  buffer.write(encoded, offset, "ascii");
  buffer[offset + length - 1] = 0;
}

function readNullTerminated(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
