export const animationTimings = {
  deal: 180,
  dealSeatInterval: 70,
  ownCardReveal: 160,
  wager: 220,
  check: 140,
  fold: 200,
  allIn: 280,
  burn: 160,
  flopCard: 220,
  flopInterval: 90,
  turnRiver: 240,
  showdownReveal: 260,
  bestFive: 320,
  winner: 800,
  potAward: 450,
  handEnd: 1_000,
  hardForwardFade: 120,
} as const;

export const softCatchUpRate = 1.75;
export const softCatchUpBacklogMs = 2_000;
export const softCatchUpTasks = 8;
export const hardForwardBacklogMs = 5_000;
export const hardForwardEvents = 20;
