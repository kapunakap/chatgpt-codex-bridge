# Exploratory Sol vs Luna comparison — 2026-09-30

This note records one manually run comparison. It is not a universal model ranking or product guarantee.

- ChatGPT: GPT-5.6 Sol, Extra High
- Local Codex: `gpt-6-luna`, `max`

Results:

| Test | Sol | Luna |
| --- | ---: | ---: |
| Hard reasoning/coding | 12/12 | 12/12 |
| Fresh synthetic rules | 8/8 | 8/8 |
| KESTREL-9 long-state synthetic world | 20/20 | 18/20 |
| **Total** | **40/40** | **38/40** |

In KESTREL-9, Luna made one left-to-right rewrite-order mistake; it propagated into two scored answers.

Interpretation: in this small single-run sample, Luna Max matched Sol Extra High on the shorter tests, while Sol was more reliable on the longest novel state-tracking test.

Operational takeaway: this evidence alone does not justify changing the current Luna Max default.
