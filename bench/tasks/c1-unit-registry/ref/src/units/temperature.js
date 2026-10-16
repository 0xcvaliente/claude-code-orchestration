// Kelvin is the base; each unit maps to and from it.
const units = {
  C: { toK: (v) => v + 273.15, fromK: (k) => k - 273.15 },
  F: { toK: (v) => ((v - 32) * 5) / 9 + 273.15, fromK: (k) => ((k - 273.15) * 9) / 5 + 32 },
  K: { toK: (v) => v, fromK: (k) => k },
};
export default {
  name: "temperature",
  units,
  convert(value, from, to) {
    const k = units[from].toK(value);
    if (k < 0) throw new RangeError(`${value} ${from} is below absolute zero`);
    return units[to].fromK(k);
  },
};
