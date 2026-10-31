#!/usr/bin/env python3
"""Format check for answers.json: keys q1 to q12, each a non-empty string or a number. Does not check the answers."""
import json
import sys

try:
    with open("answers.json") as f:
        data = json.load(f)
except (OSError, ValueError) as e:
    print(f"answers.json missing or not valid JSON: {e}")
    sys.exit(1)
bad = []
if not isinstance(data, dict):
    bad.append("answers.json must be a JSON object")
else:
    for k in [f"q{i}" for i in range(1, 13)]:
        v = data.get(k)
        if isinstance(v, bool) or not (isinstance(v, (int, float)) or (isinstance(v, str) and v.strip())):
            bad.append(f"{k}: missing or empty")
for b in bad:
    print(b)
print("format ok: 12 answers" if not bad else f"{len(bad)} problem(s)")
sys.exit(1 if bad else 0)
