Answer seven questions about the documents in `docs/`. Read the documents themselves; some facts appear only in a page image or must be computed. Write the answers to `answers.json` in the repo root, one key per question (`q1` to `q7`). A number answer is a JSON number without units or thousands separators; a text answer is a JSON string.

1. `docs/memo.txt`: what is the code name of the warehouse relocation project?
2. `docs/report.pdf`: on what date did the Lisbon office open? Answer as `YYYY-MM-DD`.
3. `docs/pricing.pdf`: what is the unit price in EUR of SKU KX-220 at an order volume of 500 to 999 units?
4. `docs/inspection.pdf` is a scanned certificate: what is its certificate serial number?
5. `docs/budget.xlsx` contains formulas without stored results: what is the value of cell `B6` (net total) on the `Summary` sheet?
6. `docs/chart.png`: what value does the bar for the Coastal region show, in thousand units?
7. `docs/manual.pdf`: what is the service interval in operating hours for an MX-9 compressor at a site classified as dusty?

Acceptance check: `python3 tools/check.py` (checks the format of `answers.json`, not the answers). The final grade checks every answer.
