import { Stack } from "./stack.js";
export function evalRPN(tokens) {
  const s = new Stack();
  for (const t of tokens) {
    if (/^-?\d+$/.test(t)) { s.push(Number(t)); continue; }
    if (!["+", "-", "*", "/"].includes(t)) throw new Error(`unknown token ${t}`);
    if (s.size < 2) throw new Error("too few operands");
    const b = s.pop(), a = s.pop();
    if (t === "/" && b === 0) throw new RangeError("division by zero");
    s.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b : Math.trunc(a / b));
  }
  if (s.size !== 1) throw new Error("invalid expression");
  return s.pop();
}
