# press web — DESIGN BRIEF

Law doc for the press web surface (feed, collection pages, login, chrome around
served reports), present-tense, no narrated history — git is the changelog.
Amend Decisions and Boundary only with Allen's confirmation. Engineering law
is the root `BRIEF.md`; this file governs taste.

## Bar

A first-time visitor's impression is a modern editorial magazine — calm,
typographic, generous with space — never "internal tool" or "dashboard". Design
is baked in from day 1: there is no unstyled milestone.

## Dimensions

- **Typographic hierarchy** — headlines, standfirsts, bylines, and body read as
  a deliberate system; type does the design work.
- **Space & density** — uncrowded; whitespace is a feature; nothing competes.
- **Palette restraint** — near-monochrome base, at most one accent.
- **Rhythm** — a consistent grid and spacing scale; entries align, margins
  breathe.
- **Restraint in motion** — transitions are subtle or absent; nothing bounces.
- **Responsiveness** — magazine-grade at phone, tablet, laptop, wide.
- **Accessibility** — readable, contrast-safe, keyboard-navigable.

Reference exemplars (ratified): Stripe Press, Increment magazine, iA, the
Linear and Vercel blogs. Anti-exemplars: admin dashboards, Bootstrap-default
looks, news portals with competing sidebars/tickers.

## Floors (gate, not ceiling — measured in `nub run e2e` design checks)

| Floor                                      | Measured by                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| No horizontal scroll                       | Playwright at 360, 768, 1280, 1920 px widths on `/`, `/c/:slug`, `/login`, and the `password` entry page   |
| Contrast ≥ WCAG AA                         | automated axe/contrast audit in the e2e run                                                                |
| Zero third-party requests                  | Playwright network log: every request originates from the instance origin (fonts self-hosted; sovereignty) |
| Type scale is systematic                   | font sizes on rendered pages ∈ the defined scale tokens (asserted from computed styles)                    |
| Spacing is systematic                      | margins/paddings ∈ the spacing scale tokens (spot-asserted on feed entries)                                |
| No layout shift on load                    | CLS < 0.1 on `/` in the e2e run                                                                            |
| ≤ 2 typefaces                              | computed font-families on rendered pages ∈ the two configured families                                     |
| Dark and light both hold every floor above | the matrix runs in both color schemes                                                                      |

## Oracle

Blind screenshot quorum — maker ≠ judge, and judges see pixels, not code:

1. The harness captures full-page screenshots (`/` and one collection page;
   light + dark; 360/1280 widths) with seeded demo content.
2. Three fresh-context judge agents — no access to the implementation, the
   diff, or this repo's history — receive only the screenshots, the Bar, the
   Dimensions, and the exemplar names, and return `magazine-grade | not yet`
   per dimension with one sentence of evidence.
3. Pass = at least 2 of 3 judges rate every dimension `magazine-grade`. A
   failing dimension's evidence becomes the next loop iteration's input.
4. It can't be gamed because judges are blind to authorship and context,
   prompts name the exemplars (tuning to flatter one screenshot visibly
   degrades the others), and the quorum is re-drawn fresh each round.

Final acceptance: Allen looks at the deployed instance and says it feels like a
publication he'd read — the human gate no quorum replaces.

## Never

- A page that reads as dashboard/admin-tool (dense cards, sidebars, tickers,
  more than 3 competing elements above the fold).
- More than 2 typefaces, or any typeface loaded from a third-party origin.
- Horizontal scroll at any supported width; overlapping/clipped text.
- Default-looking UI-kit styling leaking through (unthemed buttons/inputs).
- A reader gate with no way through: an OS Basic-Auth dialog instead of a branded
  `password` entry page, or a `/login` that renders copy with no sign-in
  affordance.
- Shipping a milestone with "style comes later" — design floors run from the
  first rendered page.

## Decisions (ratified 2026-07-02 unless marked)

- Direction: editorial, typography-first, generous whitespace, restrained
  palette — Stripe-Press-adjacent (Allen: "yes that is it exactly").
- Fonts self-hosted, no CDN. Concrete pairing (assumption, amendable at first
  oracle round): a display/text serif (e.g. Newsreader or Source Serif) for
  headlines + a quiet humanist sans (e.g. Inter) for UI/meta. ≤ 2 families.
- Light-first with full dark support via Tamagui themes (assumption — flip
  needs Allen).
- The feed is the front door: featured/latest entries with title, collection,
  byline, date. Reports themselves render unstyled by press (they are
  self-contained documents); press styles everything around them.
- Tamagui is the styling system; design tokens (type scale, spacing scale,
  palette) are defined once in the Tamagui config and are the source the floors
  assert against.
- Feed entry titles carry no static at-rest link affordance; the underline
  appears on hover only (magazine convention). Judge G's round-3 dissent
  requesting a static affordance is resolved: hover-only stands (ratified
  2026-07-03).
- The `password` entry page and the `/login` identity gate are first-class
  editorial surfaces (same masthead, type scale, spacing, dark/light) — a reader
  who hits a gate stays inside the publication. Both are captured in the blind
  screenshot oracle alongside `/` and a collection page (ratified 2026-07-04,
  from the dogfood bug bash).

## Boundary (Allen's alone)

- Ratifying or changing the taste direction, exemplars, font pairing, and
  light/dark stance.
- Any brand identity for unrulysystems/press (logo, name treatment).
- Final acceptance on the deployed instance.
