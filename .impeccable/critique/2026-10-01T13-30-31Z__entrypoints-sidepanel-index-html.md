---
target: side panel
total_score: 14
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/chato/Projects/proyectos-jev/hermit/entrypoints/sidepanel/index.html"
target_fingerprint: "sha256:142483c6f68ce754e7b9d5bb2f29b43d2e456f137c2480a662532461e032a485"
target_path: /home/chato/Projects/proyectos-jev/hermit/entrypoints/sidepanel/index.html
timestamp: 2026-10-01T13-30-31Z
slug: entrypoints-sidepanel-index-html
---
# Critique snapshot — side panel (`entrypoints/sidepanel/index.html`)

Method: dual-agent (A: main/critique-A-sidepanel/1 · B: main/critique-B-sidepanel/2). Assessment A finished before detector output entered synthesis. Detector: exit 0, `[]` (clean, static markup only). No browser automation exposed; overlay path skipped.

## Design Health Score — 14/40 (Poor)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | Autosave invisible; no judging/wave progress; CSV failure silent |
| 2 | Match System / Real World | 2 | `Kept` vs `MATCH`, `Last request` ms, `$0.0000`, unexplained fit number |
| 3 | User Control and Freedom | 1 | No undo/reset brief, no stop/retry, brief edits wipe judgments |
| 4 | Consistency and Standards | 2 | `Kept/MATCH`, `Skipped/SKIP`, `entries/judgments` triple-naming; reason text in numeric column |
| 5 | Error Prevention | 1 | Garbage max-price coerces to null = no cap, widening the hunt |
| 6 | Recognition Rather Than Recall | 2 | Places semantics, fit scale, bound-tab identity must be recalled |
| 7 | Flexibility and Efficiency | 1 | No shortcuts, saved briefs, filters, or bulk path |
| 8 | Aesthetic and Minimalist Design | 2 | Clean but flat; h1 14px vs body 13px; no sections |
| 9 | Error Recovery | 1 | `#notice.error` names problems, suggests nothing; CSV `catch {}` swallows all |
| 10 | Help and Documentation | 1 | Zero help; placeholders are the only guidance |
| **Total** | | **14/40** | **Poor** |

## Design Specificity Verdict: INTERCHANGEABLE

Generic scaffold with zero marketplace character: no prices, thumbnails, price-vs-cap delta, or listing links in the rows; system vocabulary (`MATCH`/`SKIP`/`REVIEW`, `Kept`, `$0.0000`) instead of shopper vocabulary; five undifferentiated fields, no section headers. Could be relabeled any CRUD-plus-list tool unchanged. Detector found no slop patterns — the sparseness is honest absence of design, not minimalism as a choice.

## Priority Issues

- **[P1] Invalid max-price silently becomes "no cap"** (`readMaxPrice`, main.ts:92-98). Garbage widens the hunt and spends budget. Fix: inline validation, keep last valid cap, echo parsed value. Suggested: `$impeccable harden`
- **[P1] No save or judging status anywhere.** 300ms autosave, bound tab, wave progress all invisible. Fix: status strip (saved/dirty · bound tab · idle/judging/error). Suggested: `$impeccable clarify`
- **[P1] Any brief edit silently discards all judgments** (`judgeWave` clears on hash change, marketplace.ts:663-669). Most common action is most destructive. Fix: dirty-state banner with Re-judge/Show-old, or scoped invalidation. Suggested: `$impeccable harden`
- **[P2] Verdict rows unscannable.** Raw chips, 1-line truncated titles, bare fit number, reasons in the score column, no filter/sort/link. Fix: filter chips, price + fit-with-scale columns, human reasons, row links. Suggested: `$impeccable layout`
- **[P2] Export CSV fails silently, disables opaquely** (main.ts:75-80). Fix: surface failures in `#notice`, add disabled reason. Suggested: `$impeccable harden`

## Persona Red Flags (Jordan, Sam, Alex; no AGENTS.md — no project personas)

- **Jordan (first-timer):** places-substring semantics, currency no-exchange rule, and fit numbers unexplained; typing produces zero visible response; `No judgments yet.` gives no next step.
- **Sam (a11y):** no custom `:focus-visible` (UA default only); stats + entries updates not announced (`#notice` has `role=status` and IS announced); truncated titles hover-only for sighted keyboard users; disabled export has no reason; no section landmarks.
- **Alex (power user):** no keyboard path, no saved briefs/templates, no entry filters, and the tighten-cap → re-judge loop wipes results silently.

## Minor Observations

`$0.0000` false precision; raw `ms` telemetry; h1 wastes a 360px row; currency select over-wide vs price input; `formatMaxPrice` strips `250.000`→`250000`; translucent skip chip vs solid siblings; `#note` min-height too small for its placeholder's promise.

## Questions to Consider

- What if rows led with price (`title · $price vs cap · fit`) so the panel reads as a hunt, not a log?
- What would the brief editor look like if it admitted every keystroke costs money?
- Is this one column, or three instruments (brief, pulse, ranking) each needing its own visual contract?

## Cognitive load: 5/8 fails = HIGH

Fails: chunking, grouping, visual hierarchy, working memory (bound tab? fit scale? places semantics? invalidation rule?), progressive disclosure (ms + 4-decimal cost always on). Dynamic list is an unbounded, unfilterable comparison set.
