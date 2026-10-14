import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreNodeHidden } from "../../lib/score.mjs";

export const score = (dir) => scoreNodeHidden(dirname(fileURLToPath(import.meta.url)), dir);
