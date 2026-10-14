export function slugify(str) {
  if (typeof str !== "string") throw new TypeError("string expected");
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
