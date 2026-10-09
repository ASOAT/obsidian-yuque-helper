'use strict';
// Write a standard stored ZIP without extra build dependencies.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'build.js')], {stdio:'inherit'});
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (!/^[a-z0-9-]+$/.test(manifest.id) || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error('Invalid plugin ID or release version');
}
const files = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, {recursive:true});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const records = [], directory = [];
let offset = 0, directorySize = 0;
for (const file of files) {
  const bytes = fs.readFileSync(path.join(root, file));
  fs.writeFileSync(path.join(dist, file), bytes);
  const name = Buffer.from(`${manifest.id}/${file}`, 'utf8');
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0x0021, 12); // Fixed 1980-01-01 for reproducible packages.
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  records.push(local, name, bytes);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  directorySize += central.length + name.length;
  offset += local.length + name.length + bytes.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directorySize, 12);
end.writeUInt32LE(offset, 16);
const output = path.join(dist, `obsidian-yuque-helper-${manifest.version}.zip`);
fs.writeFileSync(output, Buffer.concat([...records, ...directory, end]));
console.log(`Packaged ${files.length} release files: ${path.basename(output)}`);
