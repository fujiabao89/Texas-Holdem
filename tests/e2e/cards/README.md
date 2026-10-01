# Card-face visual regression (TEX-57)

`card-face.spec.ts` uses the wire-only table fixture to render board, local hole, and publicly revealed seat cards at the four required viewports: `360x800`, `390x844`, `1366x768`, and `1920x1080`.

The regression checks board/hole numeric pip matrices (including 7–10), aces, and J/K artwork against both card corners; it also verifies red/black suit coloring, transparent corner backgrounds, and the neutral court-card border. Seat cards retain TEX-46's compact rank/suit rows, with separate clipping and overlap checks. Explicit element counts prevent geometry/color assertions from passing on missing markup. Font sizes continue to scale with the actual card width. Successful evidence is written to `output/playwright/TEX-57-cards-*.png`.

Run from the repository root:

```bash
pnpm exec playwright test -c tests/e2e/playwright.config.ts cards --workers=1
```

## PR #61 conflict resolution verification (2026-10-01)

Merged `origin/main` at `3598fd43` into `fix/TEX-57-card-face-overlap`, preserving TEX-46's single-viewport layout, card-width font scaling, and compact seat/result cards. Kept TEX-57's safe board/hole content area, numeric matrices, neutral court border, and color regression.

- `pnpm exec playwright test -c tests/e2e/playwright.config.ts cards --workers=1`: 4 passed.
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/table-layout/single-viewport.spec.ts tests/e2e/betting/table.spec.ts --workers=2`: 182 passed.
- `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/animation-audio/experience.spec.ts --grep '小牌|公共牌依次|减少动态效果仍保留' --workers=1`: 5 passed.
- `pnpm exec vitest run --project unit apps/web/src/features/poker-table --maxWorkers 1`: 18 passed across 3 files.
- `pnpm --filter @texas-holdem/web typecheck`, `pnpm exec tsc --noEmit -p tsconfig.test.json`, and targeted ESLint: passed. Built protocol and poker-engine first in the clean worktree.
- `pnpm exec eslint apps/web/src/features/poker-table/poker-table-page.tsx tests/e2e/cards/card-face.spec.ts`, `pnpm --filter @texas-holdem/web build`, and `git diff --cached --check`: passed.

Browser runs used `TEX_E2E_PORT=3161`, `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3161`, and `NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3161/api/v1/ws`, without retries. These checks cover Chromium simulated viewports and controlled projections; full E2E, real-server/PostgreSQL integration, and mobile devices were not run.

Updated the poker-table/cards/E2E README files and frontend/testing authoritative specifications. Task/roadmap, other specifications, security and operations documentation: **已检查，无需更新** because this merge preserves the existing scope, protocol, permissions and runtime configuration.
