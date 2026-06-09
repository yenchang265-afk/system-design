# Public review scenario — design

Date: 2026-06-09
File touched: `design-template-generator.html` (single-file app)

## Goal

Replace the `committee-review` scenario with a `public-review` scenario: a
pre-coding design-review meeting open to all department members. The audience
is broad and cross-functional (eng, PM, design, etc.) rather than a narrow
architecture committee, so the section emphasis shifts toward shared
comprehension.

## Change 1 — scenario swap

In the `SCENARIOS` array, remove the `committee-review` entry and add
`public-review` in the same slot (last card). Each scenario carries 18 section
ratings: `2` = strongly recommended (SR), `1` = recommended, `0` = optional,
`-1` = not relevant.

New entry:

```js
{id:'public-review',name:'Public review',desc:'Pre-coding design review meeting open to all department members',short:'Public design review',
 ratings:[-1,-1,2,2,-1,-1,2,1,-1,-1,2,2,1,2,-1,-1,2,2]}
```

Ratings (index → section), derived from the old committee-review set with two
bumps for the broader audience:

| # | Section | committee | public-review | Note |
|---|---|---|---|---|
| 01 | Version history | -1 | -1 | impl detail, skip for review |
| 02 | Review history | -1 | -1 | |
| 03 | Project snapshot | 2 | 2 SR | what-is-this, for everyone |
| 04 | System context | 2 | 2 SR | |
| 05 | FE architecture | -1 | -1 | |
| 06 | State & data flow | -1 | -1 | |
| 07 | AuthN & AuthZ | 2 | 2 SR | key design decision |
| 08 | Security | 1 | 1 | |
| 09 | Error handling | -1 | -1 | |
| 10 | Data validation map | -1 | -1 | |
| 11 | Business rules | 1 | **2 SR** | non-eng members need domain rules |
| 12 | Reliability | 2 | 2 SR | |
| 13 | Data model | 1 | 1 | |
| 14 | API surface | 2 | 2 SR | |
| 15 | Background jobs & caching | -1 | -1 | |
| 16 | Testing strategy | -1 | -1 | |
| 17 | Trade-off | 2 | 2 SR | the decisions under review |
| 18 | Terminology | -1 | **2 SR** | wide audience must share vocabulary |

## Change 2 — rename pre-read feature

The "Committee pre-read" download button and `downloadPreRead()` /
`generatePreRead()` functions are a generic SR-section export (their SR list
`srNums` is hardcoded, independent of the selected scenario). Retarget the
naming to the new scenario; content unchanged.

- Button label (`L581`): `⬇ Committee pre-read` → `⬇ Public review pre-read`
- Comment (`L1250`) + markdown heading (`L1254`): `committee pre-read` → `public review pre-read`
- Download filename (`L1274`): `${slug}-committee-preread.md` → `${slug}-public-review-preread.md`
- `srNums` hardcoded list: left as-is (sensible design-review SR sections)

## Out of scope

- Save/load: `selectedScenario` is persisted by id generically; no
  `committee-review` string appears anywhere else (verified by grep). The old
  id simply stops being produced.
- No tests reference `committee` (grep confirmed).

## Verification

- Open `design-template-generator.html`, reach step 3, confirm the last card
  reads "Public review" with desc "Pre-coding design review meeting open to all
  department members"; no "Committee review" card remains.
- Select it → step 4 shows SR badges on sections 03, 04, 07, 11, 12, 14, 17, 18.
- Step 5: pre-read button reads "Public review pre-read"; downloaded file is
  named `<slug>-public-review-preread.md` with heading `# <name> — public review pre-read`.
