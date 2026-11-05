const fs = require('fs');

const sizes = [16, 32, 48];
const pngs = sizes.map((size) => fs.readFileSync(`dashboard/public/favicon-${size}.png`));
const headerSize = 6;
const directorySize = 16 * sizes.length;
let offset = headerSize + directorySize;
const entries = [];

for (let i = 0; i < sizes.length; i += 1) {
  const size = sizes[i];
  const data = pngs[i];
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}

const output = Buffer.concat([
  Buffer.from([0, 0, 1, 0, sizes.length, 0]),
  ...entries,
  ...pngs,
]);

fs.writeFileSync('dashboard/public/favicon.ico', output);
console.log(`wrote dashboard/public/favicon.ico (${output.length} bytes)`);