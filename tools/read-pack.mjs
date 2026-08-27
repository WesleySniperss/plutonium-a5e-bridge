// Minimal LevelDB SSTable reader: footer -> index block -> data blocks, with a
// raw Snappy decompressor. Enough to read a Foundry pack without a native dep.
import { readFileSync } from 'node:fs';

function varint(buf, pos) {
  let result = 0n; let shift = 0n; let byte;
  do {
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [Number(result), pos];
}

function snappy(input) {
  let pos = 0;
  let [len, p] = varint(input, 0);
  pos = p;
  const out = Buffer.alloc(len);
  let o = 0;

  while (pos < input.length && o < len) {
    const tag = input[pos++];
    const type = tag & 0x03;

    if (type === 0) {
      let n = tag >> 2;
      if (n < 60) n += 1;
      else {
        const bytes = n - 59;
        let v = 0;
        for (let i = 0; i < bytes; i++) v |= input[pos + i] << (8 * i);
        pos += bytes;
        n = (v >>> 0) + 1;
      }
      input.copy(out, o, pos, pos + n);
      pos += n; o += n;
      continue;
    }

    let length; let offset;
    if (type === 1) {
      length = ((tag >> 2) & 0x07) + 4;
      offset = ((tag >> 5) << 8) | input[pos++];
    } else if (type === 2) {
      length = (tag >> 2) + 1;
      offset = input.readUInt16LE(pos); pos += 2;
    } else {
      length = (tag >> 2) + 1;
      offset = input.readUInt32LE(pos); pos += 4;
    }

    for (let i = 0; i < length; i++) { out[o] = out[o - offset]; o++; }
  }
  return out;
}

function readBlock(buf, offset, size) {
  const raw = buf.subarray(offset, offset + size);
  const type = buf[offset + size];
  return type === 1 ? snappy(raw) : Buffer.from(raw);
}

function blockEntries(block) {
  // The restart array sits at the end; its count is the last 4 bytes.
  const numRestarts = block.readUInt32LE(block.length - 4);
  const dataEnd = block.length - 4 - numRestarts * 4;

  const out = [];
  let pos = 0;
  let lastKey = Buffer.alloc(0);

  while (pos < dataEnd) {
    let shared; let nonShared; let valueLen;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);

    const key = Buffer.concat([lastKey.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;

    out.push({ key, value });
    lastKey = key;
  }
  return out;
}

export function readPack(file) {
  const buf = readFileSync(file);

  // Footer: 40 bytes of handles + 8 byte magic.
  const footer = buf.subarray(buf.length - 48);
  let p = 0;
  [, p] = varint(footer, p);        // metaindex offset
  [, p] = varint(footer, p);        // metaindex size
  let indexOffset; let indexSize;
  [indexOffset, p] = varint(footer, p);
  [indexSize, p] = varint(footer, p);

  const index = readBlock(buf, indexOffset, indexSize);

  const records = [];
  for (const { value } of blockEntries(index)) {
    let q = 0; let off; let size;
    [off, q] = varint(value, q);
    [size, q] = varint(value, q);
    try {
      for (const entry of blockEntries(readBlock(buf, off, size))) records.push(entry);
    } catch { /* a block we cannot read is skipped, not fatal */ }
  }
  return records;
}
