export function capitalize(str) {
  if (typeof str !== "string") throw new TypeError("string expected");
  return str.charAt(0).toUpperCase() + str.slice(1);
}
