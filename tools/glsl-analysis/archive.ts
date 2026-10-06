import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface PinnedDownload {
  url: string;
  sha256: string;
  size: number;
}

/**
 * Downloads a pinned file once and verifies its size and SHA-256 before it is
 * used. A matching `<file>.part` left by an interrupted run is promoted rather
 * than fetched again; anything else that does not match is discarded.
 */
export async function ensurePinnedDownload(pin: PinnedDownload, target: string): Promise<void> {
  if ((await fileExists(target)) && (await sha256File(target)) === pin.sha256) return;
  await rm(target, { force: true });
  const partial = `${target}.part`;
  if (await fileExists(partial)) {
    const { size } = await stat(partial);
    if (size === pin.size && (await sha256File(partial)) === pin.sha256) {
      await rename(partial, target);
      return;
    }
    await rm(partial, { force: true });
  }
  await mkdir(dirname(target), { recursive: true });
  console.log(`[glsl-analysis] downloading ${pin.url}`);
  const response = await fetch(pin.url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${pin.url}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    meter,
    createWriteStream(partial),
  );
  const digest = hash.digest('hex');
  if (bytes !== pin.size || digest !== pin.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `Pinned download mismatch for ${pin.url}: expected ${pin.size} bytes sha256 ${pin.sha256}, ` +
        `received ${bytes} bytes sha256 ${digest}`,
    );
  }
  await rename(partial, target);
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function safeEntryPath(destination: string, name: string): string {
  const relative = normalize(name);
  if (isAbsolute(relative) || relative.split(sep).includes('..')) {
    throw new Error(`Refusing unsafe archive entry: ${name}`);
  }
  return join(destination, relative);
}

/** Minimal ZIP (stored/deflate, optional ZIP64) extractor; no external unzip tool. */
export async function extractZip(archive: string, destination: string): Promise<number> {
  const file = await open(archive, 'r');
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`Not a ZIP archive: ${archive}`);
    let entryCount = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) {
        throw new Error('ZIP64 locator missing');
      }
      const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
      const record = Buffer.alloc(56);
      await file.read(record, 0, 56, recordOffset);
      if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('ZIP64 record missing');
      entryCount = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }

    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index++) {
      if (directory.readUInt32LE(cursor) !== CENTRAL) throw new Error('Corrupt ZIP directory');
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      let localHeaderOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      let extra = cursor + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(directory.readBigUInt64LE(field));
            field += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(directory.readBigUInt64LE(field));
          }
        }
        extra += 4 + length;
      }
      entries.push({ name, method, compressedSize, localHeaderOffset });
      cursor = extraEnd + commentLength;
    }

    let files = 0;
    const header = Buffer.alloc(30);
    for (const entry of entries) {
      const target = safeEntryPath(destination, entry.name);
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await file.read(header, 0, 30, entry.localHeaderOffset);
      if (header.readUInt32LE(0) !== LOCAL) throw new Error(`Corrupt ZIP entry: ${entry.name}`);
      const dataStart =
        entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      await mkdir(dirname(target), { recursive: true });
      if (entry.compressedSize === 0) {
        await (await open(target, 'w')).close();
      } else {
        const source = createReadStream(archive, {
          start: dataStart,
          end: dataStart + entry.compressedSize - 1,
        });
        if (entry.method === 0) {
          await pipeline(source, createWriteStream(target));
        } else if (entry.method === 8) {
          await pipeline(source, createInflateRaw(), createWriteStream(target));
        } else {
          throw new Error(`Unsupported ZIP method ${entry.method}: ${entry.name}`);
        }
      }
      files++;
    }
    return files;
  } finally {
    await file.close();
  }
}
