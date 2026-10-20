// Builds the store packages: dist/sonambulo-<version>-chrome.zip and dist/sonambulo-<version>-firefox.zip.
// No dependencies; the zip writer below is intentionally minimal.
import { deflateRawSync } from 'node:zlib';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const source = join(root, 'extension');
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const { version } = manifest;

const GECKO_ID = 'sonambulo@radiowasnton';

const targets = {
  chrome: (m) => m,
  firefox: (m) => {
    delete m.minimum_chrome_version;
    m.background = { scripts: ['src/core.js', 'src/background.js'] };
    m.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } },
      gecko_android: { strict_min_version: '142.0' },
    };
    return m;
  },
};

/* ---------- minimal zip writer ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const stamp = { time: 0x6000, date: 0x5c21 }; // fixed 2026-01-01 so builds are reproducible

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function listFiles(dir) {
  return readdirSync(dir).sort().flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/* ---------- build ---------- */

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const [target, transform] of Object.entries(targets)) {
  const out = join(dist, target);
  cpSync(source, out, { recursive: true });
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
  cpSync(join(root, 'NOTICE'), join(out, 'NOTICE'));
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(transform(structuredClone(manifest)), null, 2)}\n`);

  const entries = listFiles(out).map((file) => ({
    name: relative(out, file).split(sep).join('/'),
    data: readFileSync(file),
  }));
  const archive = join(dist, `sonambulo-${version}-${target}.zip`);
  writeFileSync(archive, zip(entries));
  console.log(`${target}: ${entries.length} files → ${relative(root, archive)} (${(statSync(archive).size / 1024).toFixed(0)} KB)`);
}
