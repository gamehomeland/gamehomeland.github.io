import type { Vec3, Quat } from './types.js';

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** 与客户端数值表生成器一致的偶数舍入，避免跨语言 .5 边界漂移。 */
export function roundEven(x: number): number {
  const lo = Math.floor(x),
    fraction = x - lo;
  return fraction < 0.5 ? lo : fraction > 0.5 ? lo + 1 : lo % 2 === 0 ? lo : lo + 1;
}
export function multiply(a: Quat, b: Quat): Quat {
  const [x, y, z, w] = a,
    [i, j, k, l] = b;
  return [
    w * i + x * l + y * k - z * j,
    w * j - x * k + y * l + z * i,
    w * k + x * j - y * i + z * l,
    w * l - x * i - y * j - z * k,
  ];
}
export function rotate(v: Vec3, q: Quat): Vec3 {
  const [x, y, z] = v,
    [a, b, c, d] = q;
  return [
    (1 - 2 * b * b - 2 * c * c) * x + 2 * (a * b - c * d) * y + 2 * (a * c + b * d) * z,
    2 * (a * b + c * d) * x + (1 - 2 * a * a - 2 * c * c) * y + 2 * (b * c - a * d) * z,
    2 * (a * c - b * d) * x + 2 * (b * c + a * d) * y + (1 - 2 * a * a - 2 * b * b) * z,
  ];
}
export function rgbLab(rgb: ArrayLike<number>): Vec3 {
  const c = [rgb[0], rgb[1], rgb[2]].map((x) => {
    const y = x / 255;
    return y <= 0.04045 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4;
  });
  const xyz = [
    (0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2]) / 0.95047,
    0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2],
    (0.0193339 * c[0] + 0.119192 * c[1] + 0.9503041 * c[2]) / 1.08883,
  ];
  const f = xyz.map((v) => (v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
export function labRgb(lab: Vec3): Vec3 {
  const fy = (lab[0] + 16) / 116;
  const f = [fy + lab[1] / 500, fy, fy - lab[2] / 200];
  const xyz = f.map(
    (v, i) => (v > 6 / 29 ? v ** 3 : 3 * (6 / 29) ** 2 * (v - 4 / 29)) * [0.95047, 1, 1.08883][i],
  );
  return [
    [3.240454836, -1.53713885, -0.498531547],
    [-0.96926639, 1.876010929, 0.041556082],
    [0.05564342, -0.204025854, 1.057225162],
  ].map((row) => {
    const v = row.reduce((sum, n, i) => sum + n * xyz[i], 0);
    return clamp(
      roundEven(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055)),
      0,
      255,
    );
  }) as Vec3;
}
export function deltaE2(a: Vec3, b: Vec3): number {
  const [l1, a1, b1] = a,
    [l2, a2, b2] = b,
    c1 = Math.hypot(a1, b1),
    c2 = Math.hypot(a2, b2);
  const power = ((c1 + c2) / 2) ** 7,
    g = 0.5 * (1 - Math.sqrt(power / (power + 25 ** 7)));
  const ap1 = (1 + g) * a1,
    ap2 = (1 + g) * a2,
    cp1 = Math.hypot(ap1, b1),
    cp2 = Math.hypot(ap2, b2);
  const degrees = (x: number) => ((x * 180) / Math.PI + 360) % 360,
    rad = (x: number) => (x * Math.PI) / 180;
  const h1 = cp1 === 0 ? 0 : degrees(Math.atan2(b1, ap1)),
    h2 = cp2 === 0 ? 0 : degrees(Math.atan2(b2, ap2));
  let dh = h2 - h1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180 + 1e-12) dh -= 360;
  else if (dh < -180 - 1e-12) dh += 360;
  const mh =
    cp1 * cp2 === 0
      ? h1 + h2
      : Math.abs(h1 - h2) <= 180 + 1e-12
        ? (h1 + h2) / 2
        : h1 + h2 < 360
          ? (h1 + h2 + 360) / 2
          : (h1 + h2 - 360) / 2;
  const mc = (cp1 + cp2) / 2,
    ml = (l1 + l2) / 2;
  const t =
    1 -
    0.17 * Math.cos(rad(mh - 30)) +
    0.24 * Math.cos(rad(2 * mh)) +
    0.32 * Math.cos(rad(3 * mh + 6)) -
    0.2 * Math.cos(rad(4 * mh - 63));
  const sl = 1 + (0.015 * (ml - 50) ** 2) / Math.sqrt(20 + (ml - 50) ** 2),
    sc = 1 + 0.045 * mc,
    sh = 1 + 0.015 * mc * t;
  const rt =
    -2 *
    Math.sqrt(mc ** 7 / (mc ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((mh - 275) / 25) ** 2))));
  const dl = (l2 - l1) / sl,
    dc = (cp2 - cp1) / sc,
    hh = (2 * Math.sqrt(cp1 * cp2) * Math.sin(rad(dh / 2))) / sh;
  return Math.max(0, dl * dl + dc * dc + hh * hh + rt * dc * hh);
}
export function colorCost(target: Vec3, candidate: Vec3): number {
  const c = Math.hypot(target[1], target[2]),
    cc = Math.hypot(candidate[1], candidate[2]);
  const weight =
    0.75 * clamp((32 - c) / 24, 0, 1) +
    0.25 * clamp((35 - target[0]) / 25, 0, 1) * clamp((55 - c) / 35, 0, 1);
  const chromaError = (target[1] - candidate[1]) ** 2 + (target[2] - candidate[2]) ** 2;
  let result = deltaE2(target, candidate) + 0.1 * weight * Math.max(0, chromaError - 64);
  result +=
    1.4 * (Math.max(0, c - cc - 1.5) / (1 + 0.03 * c)) ** 2 +
    0.4 * (Math.max(0, cc - c - 3) / (1 + 0.03 * c)) ** 2;
  return roundEven(result * 10000) / 10000;
}
