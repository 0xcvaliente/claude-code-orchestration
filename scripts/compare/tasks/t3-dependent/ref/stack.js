export class Stack {
  #a = [];
  push(x) { this.#a.push(x); }
  pop() { if (!this.#a.length) throw new RangeError("empty"); return this.#a.pop(); }
  peek() { if (!this.#a.length) throw new RangeError("empty"); return this.#a[this.#a.length - 1]; }
  get size() { return this.#a.length; }
}
