Build a unit-conversion library in this Node repository (ES modules, no dependencies).

Six categories, each in its own module under `src/units/` (one file per category, named after it, for example `src/units/length.js`). Every category must be imported and registered in the one shared table `src/registry.js`, and `src/index.js` must serve the public API from that table only.

Units, each with its size in the category's base unit. Unit symbols are case-sensitive and must be listed by `listUnits` in exactly this order:

- length (base m): mm 0.001, cm 0.01, m 1, km 1000, in 0.0254, ft 0.3048, yd 0.9144, mi 1609.344
- mass (base kg): mg 0.000001, g 0.001, kg 1, t 1000, oz 0.028349523125, lb 0.45359237
- time (base s): ms 0.001, s 1, min 60, h 3600, d 86400, wk 604800
- data (base B): bit 0.125, B 1, KB 1000, MB 1000000, GB 1000000000, KiB 1024, MiB 1048576, GiB 1073741824
- volume (base L): mL 0.001, L 1, m3 1000, tsp 0.00492892159375, tbsp 0.01478676478125, cup 0.2365882365, gal 3.785411784
- temperature: C, F, K, where K = C + 273.15 and F = C × 9/5 + 32

Public API in `src/index.js`:

- `convert(category, value, from, to)` returns the value converted from unit `from` to unit `to`.
  - `value` that is not a finite number: throw `TypeError`.
  - Unknown category, or a unit that is not in that category: throw `RangeError`.
  - Temperature: a value below absolute zero (0 K, in the `from` unit) throws `RangeError`.
- `categories()` returns the category names sorted alphabetically.
- `listUnits(category)` returns that category's unit symbols in the order above; an unknown category throws `RangeError`.

Results are compared with a relative tolerance of 1e-9.

Acceptance check: `npm test` (public examples in `test/public.test.js`; add your own tests under `test/`).
