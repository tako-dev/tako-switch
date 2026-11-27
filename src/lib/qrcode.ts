// Pure TypeScript, zero-dependency QR Code (ISO/IEC 18004) Byte-mode Level-L/M encoder.
// Renders crisp inline SVG modules with zero network requests (100% CSP compliant: img-src 'self' data:).

// Reed-Solomon GF(256) with primitive polynomial 0x11D
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(ecLen: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < ecLen; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecLen - 1; j++) rem[j] = rem[j + 1];
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

interface VersionSpec {
  version: number;
  totalCodewords: number;
  ecPerBlock: number;
  groups: [number, number][]; // [numBlocks, dataCodewordsPerBlock]
  align: number[];
}

// Level L specs for versions 1..10 (up to 271 UTF-8 bytes — plenty for any EdgeOne URL)
const VERSION_SPECS: VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 7, groups: [[1, 19]], align: [] },
  { version: 2, totalCodewords: 44, ecPerBlock: 10, groups: [[1, 34]], align: [6, 18] },
  { version: 3, totalCodewords: 70, ecPerBlock: 15, groups: [[1, 55]], align: [6, 22] },
  { version: 4, totalCodewords: 100, ecPerBlock: 20, groups: [[1, 80]], align: [6, 26] },
  { version: 5, totalCodewords: 134, ecPerBlock: 26, groups: [[1, 108]], align: [6, 30] },
  { version: 6, totalCodewords: 172, ecPerBlock: 18, groups: [[2, 68]], align: [6, 34] },
  { version: 7, totalCodewords: 196, ecPerBlock: 20, groups: [[2, 78]], align: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecPerBlock: 24, groups: [[2, 97]], align: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecPerBlock: 30, groups: [[2, 116]], align: [6, 26, 46] },
  { version: 10, totalCodewords: 346, ecPerBlock: 18, groups: [[2, 68], [2, 69]], align: [6, 28, 50] },
];

// Format info bits for Error Correction Level L (01) and masks 0..7 (pre-XORed with 0x5412)
const FORMAT_BITS_L = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

// Version info bits for versions 7..10
const VERSION_BITS: Record<number, number> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

function totalDataCapacity(spec: VersionSpec): number {
  return spec.groups.reduce((sum, [n, k]) => sum + n * k, 0);
}

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let spec = VERSION_SPECS[VERSION_SPECS.length - 1];
  for (const cand of VERSION_SPECS) {
    const countBits = cand.version >= 10 ? 16 : 8;
    const capBits = totalDataCapacity(cand) * 8;
    if (4 + countBits + bytes.length * 8 <= capBits) {
      spec = cand;
      break;
    }
  }

  const dataCap = totalDataCapacity(spec);
  const countBits = spec.version >= 10 ? 16 : 8;
  const maxBytes = Math.floor((dataCap * 8 - 4 - countBits) / 8);
  const payload = bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;

  // Build bit stream: Byte mode (0100) + char count + bytes + terminator + pad bytes
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(payload.length, countBits);
  for (let i = 0; i < payload.length; i++) pushBits(payload[i], 8);
  const termLen = Math.min(4, dataCap * 8 - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = new Uint8Array(dataCap);
  let cwIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCodewords[cwIdx++] = b;
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (cwIdx < dataCap) {
    dataCodewords[cwIdx++] = padBytes[padIdx++ & 1];
  }

  // Split into RS blocks and interleave
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [numBlocks, blockDataLen] of spec.groups) {
    for (let b = 0; b < numBlocks; b++) {
      const slice = dataCodewords.slice(offset, offset + blockDataLen);
      offset += blockDataLen;
      dataBlocks.push(slice);
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
    }
  }

  const interleaved: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      if (i < ec.length) interleaved.push(ec[i]);
    }
  }

  const size = spec.version * 4 + 17;
  const isFunc = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const base = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      base[r][c] = dark;
      isFunc[r][c] = true;
    }
  };

  // Finder patterns + separators
  const drawFinder = (tr: number, tc: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = tr + dr;
        const c = tc + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (onBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  for (const ar of spec.align) {
    for (const ac of spec.align) {
      if (
        (ar <= 8 && ac <= 8) ||
        (ar <= 8 && ac >= size - 9) ||
        (ar >= size - 9 && ac <= 8)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(ar + dr, ac + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Dark module & reserve format info areas
  setFunc(size - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }
  for (let i = size - 8; i < size; i++) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }

  // Reserve & write version info (v >= 7)
  if (spec.version >= 7) {
    const vBits = VERSION_BITS[spec.version];
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // Place data bits in zigzag columns
  const streamBits: number[] = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i--) streamBits.push((byte >>> i) & 1);
  }
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (!isFunc[row][c]) {
          base[row][c] = bitIdx < streamBits.length ? streamBits[bitIdx++] === 1 : false;
        }
      }
    }
    upward = !upward;
  }

  // Evaluate masks 0..7 and pick lowest penalty
  const maskFns: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  const writeFormat = (grid: boolean[][], maskId: number) => {
    const bits15 = FORMAT_BITS_L[maskId];
    for (let i = 0; i <= 5; i++) grid[8][i] = ((bits15 >>> (14 - i)) & 1) === 1;
    grid[8][7] = ((bits15 >>> 8) & 1) === 1;
    grid[8][8] = ((bits15 >>> 7) & 1) === 1;
    grid[7][8] = ((bits15 >>> 6) & 1) === 1;
    for (let i = 9; i < 15; i++) grid[14 - i][8] = ((bits15 >>> (14 - i)) & 1) === 1;

    for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = ((bits15 >>> i) & 1) === 1;
    for (let i = 0; i < 7; i++) grid[size - 7 + i][8] = ((bits15 >>> (14 - i)) & 1) === 1;
  };

  const penalty = (grid: boolean[][]): number => {
    let score = 0;
    // Rule 1: adjacent runs >= 5
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (grid[r][c] === grid[r - 1][c]) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
          score += 3;
        }
      }
    }
    // Rule 4: dark ratio balance
    let dark = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (grid[r][c]) dark++;
    }
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  };

  let bestGrid = base;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const grid = base.map((row, r) =>
      row.map((val, c) => (!isFunc[r][c] && maskFns[m](r, c) ? !val : val)),
    );
    writeFormat(grid, m);
    const sc = penalty(grid);
    if (sc < bestScore) {
      bestScore = sc;
      bestGrid = grid;
    }
  }

  return { size, modules: bestGrid };
}

export function qrMatrixToSvgPath(matrix: QrMatrix, quietZone = 2): { viewBox: number; path: string } {
  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r++) {
    const row = matrix.modules[r];
    let c = 0;
    while (c < matrix.size) {
      if (!row[c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < matrix.size && row[c]) c++;
      const w = c - start;
      parts.push(`M${start + quietZone},${r + quietZone}h${w}v1h-${w}z`);
    }
  }
  return { viewBox: matrix.size + quietZone * 2, path: parts.join("") };
}
