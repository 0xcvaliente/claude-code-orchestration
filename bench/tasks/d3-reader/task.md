Answer twelve questions about the documents in `docs/` by delegating the reading. Do not open, read or search the documents yourself: for each question, launch the project's `researcher` agent (Agent tool, `subagent_type: "researcher"`) exactly once, and launch all twelve researchers in one message so they run in parallel. Do not set the Agent tool's `model` parameter: the researcher runs on the model its setup gives it. Use this brief for question n, with the question's document path and text from the list below, and nothing else in the brief:

```
SLICE: q<n>
SOURCES: <document path>
READ: extract
Question: <question text>
Answer with a QUOTE line.
```

Wait until every researcher has reported. Then write `answers.json` in the repo root with one key per question (`q1` to `q12`), taking each answer from that question's researcher report. A number answer is a JSON number without units, currency or thousands separators; a text answer is a JSON string. If a researcher could not answer, give your best value from its report rather than leaving the key out. Do not launch a second researcher for a question.

1. `docs/report.pdf`: On what date did the Lisbon office open? Answer as YYYY-MM-DD.
2. `docs/report.pdf`: How many staff did the Madrid office have at year end?
3. `docs/pricing.pdf`: What is the unit price in EUR of SKU KX-220 at an order volume of 500 to 999 units?
4. `docs/pricing.pdf`: What is the unit price in EUR of SKU KR-220 at an order volume of 100 to 499 units?
5. `docs/inspection.pdf`: This is a scanned certificate. What is its certificate serial number?
6. `docs/inspection.pdf`: This is a scanned certificate. What is the inspector's licence number?
7. `docs/chart.png`: What value does the bar for the Coastal region show, in thousand units?
8. `docs/chart.png`: Which region has the highest bar?
9. `docs/budget.xlsx`: The workbook has formulas without stored results. What is the value of cell B6 (net total) on the Summary sheet?
10. `docs/budget.xlsx`: The workbook has formulas without stored results. What is the value of cell B3 (volume discount) on the Summary sheet?
11. `docs/agreement.docx`: What is the notice period in days for a customer on the Premium tier?
12. `docs/manual.pdf`: What is the service interval in operating hours for an MX-9 compressor at a site classified as dusty?

Acceptance check: `python3 tools/check.py` (checks the format of `answers.json`, not the answers). The final grade checks every answer.
