export function parseDuration(str) {
  if (typeof str !== "string") throw new TypeError("string expected");
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(str);
  if (!m || str === "") throw new RangeError("invalid duration");
  const [d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}
