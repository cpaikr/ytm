---
name: kisnet-ytm
description: Look up Korean KIS-NET YTM Matrix rows or list supported bond kinds through the ytm CLI.
---

# KIS-NET YTM

Use `ytm matrix --base-date <YYYY-MM-DD> --kind <code-or-label>` for matrix
data and `ytm kinds` for the canonical kind catalog. Add
`--fallback previous-available` when an unavailable date may be resolved to a
prior calendar day. Machine-readable failures are written as JSON to stdout.
