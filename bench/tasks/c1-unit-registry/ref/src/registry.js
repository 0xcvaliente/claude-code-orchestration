// The one table of unit categories. Every category module in src/units/ must be imported and listed here.
import data from "./units/data.js";
import length from "./units/length.js";
import mass from "./units/mass.js";
import temperature from "./units/temperature.js";
import time from "./units/time.js";
import volume from "./units/volume.js";

export const registry = Object.fromEntries([length, mass, time, data, volume, temperature].map((c) => [c.name, c]));
