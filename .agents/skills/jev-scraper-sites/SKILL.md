---
name: jev-scraper-sites
description: Adapt the Deal Hunter Jev scraper to a new website.
disable-model-invocation: true
---

# Adapt the Scraper to a New Site

Use when adding a new supported site to this extension (today: Facebook
Marketplace) or when touching anything on the Jev wire format. The contract
below is verified, not guessed: reverse-engineering it from 400s cost several
rounds — never do that again.

## 1. Jev SystemOne contract (verified 2026-09-21)

Sources: `docs.typesafe.ai` via the verified
[JEV_API.md](https://raw.githubusercontent.com/adrian-lzr/jev-spire-brain/HEAD/docs/JEV_API.md),
plus the working client in the sibling project at
`~/Projects/proyectos-jev/jarvis/nilo/jev.py`.

- Endpoint: `POST https://openrouter.ai/api/v1/systemone`, key in
  `Authorization: Bearer`. Model `jev-1.13` (`typesafe/jev-1.13` also
  accepted). Never `/chat/completions` — Jev 400s there as "not a valid
  model ID" and is absent from the public `/models` listing.
- Request: `{model, state, questions}`. `state` may be string, object, or
  array — prefer an object with named parts. `questions` is a **record**
  keyed by question name (not an array); values hold exactly
  `{type, instructions, criteria}`.
- Types and their `criteria` / answers:

  | type | criteria | returns |
  |---|---|---|
  | `noul` | optional `{"true": "…", "false": "…"}` object | `{"noul": 0..1}` — no confidence; the number is the belief |
  | `choice` | `{label: description}` record | `{"choice", "probabilities", "confidence"}` |
  | `score` | ordered `["lowest", …, "highest"]` string list | `{"score"` level, may be fractional, `"legend", "probabilities", "confidence"}` |

- Questions in one call run in parallel and isolation; batch, don't loop.
- Response: `{model, provider, answers: {name: {type, …}}, usage:
  {input_tokens, output_tokens, cost}, id}`. `usage.cost` is provider-computed
  USD — use it. Output tokens are priced at zero.
- Gotchas: an account provider-policy violation surfaces as a confusing
  404, not 403; confidence measures distribution peakedness, so verdict
  thresholds are domain choices, never model-derived; expect ~1–1.6 s per
  call via OpenRouter.

## 2. What is site-specific in this repo

Site-agnostic — reuse untouched: `src/gateway/openrouter.ts` (this
contract), `src/session/marketplace.ts` verdict/chunk/cache/CSV engine,
`src/stores/*`, `src/messaging.ts`, side panel, options page.

Site-specific — the adaptation surface:

- `entrypoints/*.content.ts`: `matches`/`excludeMatches`, the watched-route
  check, the tile-anchor selector, the accessible-name reader.
- `src/session/marketplace.ts`: `ITEM_ID_PATTERN` (id extraction from tile
  URLs), `parseTile` (it assumes Facebook's "title, price, place"
  accessible-name shape), `csvUrlFor`.
- Side-panel copy mentioning the site (e.g. "Open a Marketplace grid…").

## 3. Adaptation procedure

1. Copy `entrypoints/marketplace.content.ts` to
   `entrypoints/<site>.content.ts`. Keep the wave machinery (debounce queue,
   brief epoch, `failed` set, badge painting, view pushes); replace matches,
   route check, tile selector, and name reader. The script stays read-only:
   DOM reads plus badge overlays, no clicks/scrolls/messages.
2. Add the site's id pattern, tile parser, and CSV URL builder next to the
   existing ones in `src/session/marketplace.ts` (or a sibling module the
   content script passes in). Do not bend the verdict engine — it consumes
   parsed tiles, never DOM.
3. Update site-named UI copy.
4. Extend the suite the same way the existing one works: script the gateway
   (`ScriptedGateway` + `answersFor`), never hit the live API from tests.
   Cover the new parser (price/currency/place edges), the id pattern, and one
   wave asserting the request's record keys.

## 4. Rules

- Contract questions are answered by section 1 and the two sources above —
  not by trial 400s. If the server rejects a request, its zod body names
  `path` + expected type; the gateway already surfaces it in the panel and
  the page console. Read it, don't guess past it.
- After any content-script or gateway change: `npm test`, `npm run
  typecheck`, `npm run build`, then reload the extension card at
  `chrome://extensions` AND the site tab before re-testing.
