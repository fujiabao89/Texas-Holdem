# Card-face visual regression (TEX-57)

`card-face.spec.ts` uses the wire-only table fixture to render board, local hole, and publicly revealed seat cards at the four required viewports: `360x800`, `390x844`, `1366x768`, and `1920x1080`.

The regression checks numeric pip matrices (including 7–10), aces, and J/Q/K artwork against both card corners; it also verifies red/black suit coloring, transparent corner backgrounds, and the neutral court-card border. Successful evidence is written to `output/playwright/TEX-57-cards-*.png`.

Run from the repository root:

```bash
pnpm exec playwright test -c tests/e2e/playwright.config.ts cards --workers=1
```
