export const animationTimings = {
  deal: 180,
  dealSeatInterval: 70,
  ownCardReveal: 160,
  wager: 220,
  check: 140,
  fold: 200,
  allIn: 280,
  burn: 160,
  // Each community card travels from the dealer, lands in its slot, then flips.
  flopCard: 1_000,
  flopInterval: 300,
  turnRiver: 1_000,
  // Reveal source cards, fade the two non-winning candidates, then assemble the
  // five server-projected cards in the centre of the table.
  showdownReveal: 1_400,
  bestFive: 5_000,
  winner: 800,
  potAward: 450,
  handEnd: 1_000,
  hardForwardFade: 120,
} as const;

// The board card sound is the landing/flip cue, rather than the instant an
// authoritative Event reaches the queue. Keeping these beside the visual task
// timings prevents a slower table animation from sounding hurried.
export const boardCardAudioCueDelayMs = 500;
export const flopCardAudioCueSpacingMs = animationTimings.flopCard + animationTimings.flopInterval;

export const softCatchUpRate = 1.75;
export const softCatchUpBacklogMs = 2_000;
export const softCatchUpTasks = 8;
// A normal all-in sends the remaining streets, two reveals and awards as one
// burst. Keep that explainable flow in Soft Catch-up; reserve hard reset for
// genuinely stale/lossy backlogs.
export const hardForwardBacklogMs = 28_000;
export const hardForwardEvents = 40;
