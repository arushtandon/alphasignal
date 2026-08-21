'use strict';

const fs = require('fs');
const path = require('path');

function atomicWriteFileSync(file, contents, encoding = 'utf8') {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, contents, { encoding });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    const backup = `${file}.bak`;
    let backedUp = false;
    try {
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, backup);
        backedUp = true;
        fs.unlinkSync(file);
      }
      fs.renameSync(tmp, file);
      if (backedUp) fs.unlinkSync(backup);
    } catch (retryError) {
      try {
        if (!fs.existsSync(file) && backedUp && fs.existsSync(backup)) {
          fs.renameSync(backup, file);
        }
      } catch (_) {}
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      throw retryError.cause ? retryError : new Error(`Atomic replace failed: ${retryError.message}`, { cause: error });
    }
  }
}

function atomicWriteJsonSync(file, value, space = 0) {
  atomicWriteFileSync(file, JSON.stringify(value, null, space));
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync };
