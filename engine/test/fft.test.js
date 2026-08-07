import test from 'node:test';
import assert from 'node:assert/strict';
import { fftInPlace, fft2Real, ifft2Real } from '../src/fft.js';
import { mulberry32 } from './fixtures.js';

function naiveDft(re, im, inverse = false) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const ang = (sign * 2 * Math.PI * k * t) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      outRe[k] += re[t] * c - im[t] * s;
      outIm[k] += re[t] * s + im[t] * c;
    }
  }
  if (inverse) {
    for (let k = 0; k < n; k++) {
      outRe[k] /= n;
      outIm[k] /= n;
    }
  }
  return { re: outRe, im: outIm };
}

test('fft matches naive DFT (n=64)', () => {
  const n = 64;
  const rand = mulberry32(42);
  const re = new Float64Array(n).map(() => rand() * 2 - 1);
  const im = new Float64Array(n).map(() => rand() * 2 - 1);
  const expected = naiveDft(re, im);
  const fre = re.slice();
  const fim = im.slice();
  fftInPlace(fre, fim);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(fre[i] - expected.re[i]) < 1e-9, `re[${i}]`);
    assert.ok(Math.abs(fim[i] - expected.im[i]) < 1e-9, `im[${i}]`);
  }
});

test('fft inverse round-trips (n=4096)', () => {
  const n = 4096;
  const rand = mulberry32(7);
  const re = new Float64Array(n).map(() => rand() * 2 - 1);
  const im = new Float64Array(n);
  const fre = re.slice();
  const fim = im.slice();
  fftInPlace(fre, fim);
  fftInPlace(fre, fim, true);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(fre[i] - re[i]) < 1e-10, `re[${i}] drift ${fre[i] - re[i]}`);
    assert.ok(Math.abs(fim[i]) < 1e-10, `im[${i}]`);
  }
});

test('fft rejects non-power-of-2 sizes', () => {
  assert.throws(() => fftInPlace(new Float64Array(48), new Float64Array(48)));
});

// The packed transforms carry two real signals through one complex FFT. They
// are drop-in replacements for the calls they stand in for, so the bar is
// agreement with those calls to machine precision — not "close enough".
test('fft2Real matches two separate real-input FFTs', () => {
  for (const n of [16, 64, 1024, 4096]) {
    const rand = mulberry32(n + 7);
    const a = new Float64Array(n).map(() => rand() * 2 - 1);
    const b = new Float64Array(n).map(() => rand() * 2 - 1);

    const refARe = a.slice(); const refAIm = new Float64Array(n);
    const refBRe = b.slice(); const refBIm = new Float64Array(n);
    fftInPlace(refARe, refAIm);
    fftInPlace(refBRe, refBIm);

    const aRe = a.slice(); const aIm = new Float64Array(n);
    const bRe = b.slice(); const bIm = new Float64Array(n);
    fft2Real(aRe, aIm, bRe, bIm);

    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(aRe[k] - refARe[k]) < 1e-10, `n=${n} A.re[${k}]`);
      assert.ok(Math.abs(aIm[k] - refAIm[k]) < 1e-10, `n=${n} A.im[${k}]`);
      assert.ok(Math.abs(bRe[k] - refBRe[k]) < 1e-10, `n=${n} B.re[${k}]`);
      assert.ok(Math.abs(bIm[k] - refBIm[k]) < 1e-10, `n=${n} B.im[${k}]`);
    }
  }
});

test('ifft2Real recovers two real signals from their two spectra', () => {
  for (const n of [16, 1024, 4096]) {
    const rand = mulberry32(n + 31);
    const a = new Float64Array(n).map(() => rand() * 2 - 1);
    const b = new Float64Array(n).map(() => rand() * 2 - 1);

    const aRe = a.slice(); const aIm = new Float64Array(n);
    const bRe = b.slice(); const bIm = new Float64Array(n);
    fft2Real(aRe, aIm, bRe, bIm);
    ifft2Real(aRe, aIm, bRe, bIm);

    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(aRe[i] - a[i]) < 1e-10, `n=${n} first[${i}] ${aRe[i]} != ${a[i]}`);
      assert.ok(Math.abs(aIm[i] - b[i]) < 1e-10, `n=${n} second[${i}] ${aIm[i]} != ${b[i]}`);
    }
  }
});

test('fft2Real handles the DC and Nyquist bins, where k and n-k coincide', () => {
  const n = 64;
  const rand = mulberry32(5);
  const a = new Float64Array(n).map(() => rand() * 2 - 1);
  const b = new Float64Array(n).map(() => rand() * 2 - 1);
  const aRe = a.slice(); const aIm = new Float64Array(n);
  const bRe = b.slice(); const bIm = new Float64Array(n);
  fft2Real(aRe, aIm, bRe, bIm);
  // a real signal has a real DC and Nyquist bin; a bad untangle leaks the other
  // signal into them
  for (const k of [0, n / 2]) {
    assert.ok(Math.abs(aIm[k]) < 1e-10, `A.im[${k}] should be 0, got ${aIm[k]}`);
    assert.ok(Math.abs(bIm[k]) < 1e-10, `B.im[${k}] should be 0, got ${bIm[k]}`);
  }
  let sumA = 0; let sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  assert.ok(Math.abs(aRe[0] - sumA) < 1e-10, 'A DC bin');
  assert.ok(Math.abs(bRe[0] - sumB) < 1e-10, 'B DC bin');
});
