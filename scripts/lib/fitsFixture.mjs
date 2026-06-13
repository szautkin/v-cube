/**
 * Synthetic FITS cube generator — the ground-truth source for value-truth
 * tests. Every voxel value is analytically known, so anything the app
 * displays can be checked against a closed-form expectation.
 * Plain ESM so both vitest (TS) and the playwright scripts can import it.
 */

const BLOCK = 2880;

function card(key, value, comment = '') {
  let v;
  if (typeof value === 'string') v = `'${value.padEnd(8)}'`;
  else if (typeof value === 'boolean') v = value ? 'T' : 'F';
  else v = String(value);
  const head = `${key.padEnd(8)}= ${v.padStart(20)}`;
  return `${head}${comment ? ` / ${comment}` : ''}`.padEnd(80).slice(0, 80);
}

/**
 * Build a float32 BITPIX=-32 cube with v = value(x, y, z).
 * Default WCS: TAN at (RA, Dec) = (180, 0), 1°/px, linear FREQ axis.
 */
export function makeFitsCube({ nx, ny, nz, value, extraCards = [] }) {
  const cards = [
    card('SIMPLE', true, 'fixture'),
    card('BITPIX', -32),
    card('NAXIS', 3),
    card('NAXIS1', nx),
    card('NAXIS2', ny),
    card('NAXIS3', nz),
    card('BUNIT', 'JY'),
    card('OBJECT', 'FIXTURE'),
    card('CTYPE1', 'RA---TAN'),
    card('CTYPE2', 'DEC--TAN'),
    card('CTYPE3', 'FREQ'),
    card('CRVAL1', 180.0),
    card('CRVAL2', 0.0),
    card('CRVAL3', 1.0e9),
    card('CRPIX1', (nx + 1) / 2),
    card('CRPIX2', (ny + 1) / 2),
    card('CRPIX3', 1),
    card('CDELT1', -1.0),
    card('CDELT2', 1.0),
    card('CDELT3', 1.0e6),
    card('CUNIT3', 'Hz'),
    ...extraCards,
    'END'.padEnd(80),
  ];
  const headerText = cards.join('');
  const headerLen = Math.ceil(headerText.length / BLOCK) * BLOCK;
  const dataLen = Math.ceil((nx * ny * nz * 4) / BLOCK) * BLOCK;
  const buf = new Uint8Array(headerLen + dataLen);
  buf.fill(0x20, 0, headerLen);
  for (let i = 0; i < headerText.length; i++) buf[i] = headerText.charCodeAt(i);

  const dv = new DataView(buf.buffer, headerLen);
  let off = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        dv.setFloat32(off, value(x, y, z), false); // FITS is big-endian
        off += 4;
      }
    }
  }
  return buf;
}

/** The canonical truth cube: v = x + 16y + 256z, plus NaN at (0, 0, every z). */
export function gradientCube(nx = 16, ny = 16, nz = 8) {
  return makeFitsCube({
    nx,
    ny,
    nz,
    value: (x, y, z) => (x === 0 && y === 0 ? NaN : x + 16 * y + 256 * z),
  });
}

export const gradientValue = (x, y, z) => x + 16 * y + 256 * z;
