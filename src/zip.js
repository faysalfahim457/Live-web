'use strict';
// Minimal streaming ZIP writer (no dependencies). Supports deflate + store, UTF-8 names,
// data descriptors for deflated entries and back-pressure. No ZIP64 (limits enforced).
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream');

const MAX32 = 0xffffffff;

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Reject names that could escape the extraction directory.
function assertSafeZipName(name) {
  if (typeof name !== 'string' || !name || name.length > 500) throw new Error(`Unsafe ZIP entry name: ${name}`);
  if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name) || /[\u0000-\u001f]/.test(name)) throw new Error(`Unsafe ZIP entry name: ${name}`);
  if (name.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) throw new Error(`Unsafe ZIP entry name: ${name}`);
}

class ZipWriter {
  constructor(out) {
    this.out = out; this.offset = 0; this.entries = []; this.names = new Set();
  }

  _write(buf) {
    this.offset += buf.length;
    return new Promise((resolve, reject) => {
      const o = this.out;
      if (o.destroyed) return reject(abortErr());
      if (o.write(buf)) return resolve();
      const done = (fn, arg) => { o.off('drain', onDrain); o.off('close', onClose); o.off('error', onErr); fn(arg); };
      const onDrain = () => done(resolve);
      const onClose = () => done(reject, abortErr());
      const onErr = (e) => done(reject, e);
      o.once('drain', onDrain); o.once('close', onClose); o.once('error', onErr);
    });
  }

  /**
   * @param {string} name   path inside the zip
   * @param {{buffer?:Buffer, path?:string, size?:number, crc32?:number, store?:boolean, mtime?:Date}} src
   */
  async addFile(name, src) {
    assertSafeZipName(name);
    const key = name.toLowerCase();
    if (this.names.has(key)) throw new Error(`Duplicate ZIP entry: ${name}`);
    this.names.add(key);
    if (this.entries.length >= 65534) throw new Error('Too many files for a ZIP archive.');
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(src.mtime || new Date());
    const offset = this.offset;
    let crc; let usize; let csize; let method; let flags = 0x0800;

    if (src.buffer) {
      const raw = src.buffer;
      usize = raw.length; crc = zlib.crc32(raw);
      const deflated = src.store || usize === 0 ? null : zlib.deflateRawSync(raw, { level: 6 });
      const useDeflate = deflated && deflated.length < usize;
      method = useDeflate ? 8 : 0;
      const body = useDeflate ? deflated : raw;
      csize = body.length;
      if (usize > MAX32) throw new Error('File too large for ZIP.');
      await this._write(localHeader(nameBuf, flags, method, time, date, crc, csize, usize));
      if (body.length) await this._write(body);
    } else {
      const st = await fs.promises.stat(src.path);
      usize = st.size;
      if (usize > MAX32) throw new Error('File too large for ZIP.');
      if (src.store && src.crc32 !== undefined) {
        method = 0; crc = src.crc32 >>> 0; csize = usize;
        await this._write(localHeader(nameBuf, flags, 0, time, date, crc, csize, usize));
        await this._pump(fs.createReadStream(src.path), null);
      } else {
        method = 8; flags |= 0x0008;
        await this._write(localHeader(nameBuf, flags, 8, time, date, 0, 0, 0));
        const rs = fs.createReadStream(src.path);
        let c = 0; let n = 0;
        rs.on('data', (chunk) => { c = zlib.crc32(chunk, c); n += chunk.length; });
        const before = this.offset;
        await this._pump(rs, zlib.createDeflateRaw({ level: 6 }));
        csize = this.offset - before; crc = c >>> 0; usize = n;
        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
        await this._write(dd);
      }
    }
    if (csize > MAX32) throw new Error('File too large for ZIP.');
    this.entries.push({ nameBuf, flags, method, time, date, crc: crc >>> 0, csize, usize, offset });
    if (this.offset > MAX32 - 1024 * 1024) throw new Error('Archive too large for ZIP (4 GiB limit).');
  }

  async _pump(readStream, transform) {
    const src = transform ? pipeline(readStream, transform, () => {}) : readStream;
    if (!transform) readStream.on('error', () => {});
    for await (const chunk of src) await this._write(chunk);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
      h.writeUInt16LE(e.flags, 8); h.writeUInt16LE(e.method, 10); h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.csize, 20); h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28); h.writeUInt32LE(e.offset, 42);
      await this._write(Buffer.concat([h, e.nameBuf]));
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12); end.writeUInt32LE(start, 16);
    await this._write(end);
  }
}

function localHeader(nameBuf, flags, method, time, date, crc, csize, usize) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8);
  h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(csize, 18); h.writeUInt32LE(usize, 22); h.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([h, nameBuf]);
}

function abortErr() { const e = new Error('Download aborted by client'); e.code = 'ABORTED'; return e; }

module.exports = { ZipWriter, assertSafeZipName };
