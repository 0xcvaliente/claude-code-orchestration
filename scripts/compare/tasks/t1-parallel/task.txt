Add two independent ES modules (named exports) with node:test files.
1. slugify.js exports slugify(str): strip accents, lowercase, replace every run of non-alphanumeric characters with a single "-", no leading or trailing "-". Throw TypeError if str is not a string. Tests in slugify.test.js.
2. capitalize.js exports capitalize(str): uppercase the first character and leave the rest unchanged; "" returns "". Throw TypeError if str is not a string. Tests in capitalize.test.js.
Acceptance check: npm test
