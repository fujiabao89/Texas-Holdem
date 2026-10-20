import { test, expect } from "./fixture";

// Fresh production process/schema per dedicated invocation. Seed 280835 reaches a real
// two-player split on hand 1 via legal check/call; the event, not a local evaluator, is asserted.
test("固定seed双人平分：每Pot金额守恒且每手只结算一次 @timeline-rc", async ({ timeline }) => {
  await timeline.create(2, { reduced: true });
  await timeline.drive(1, "passive");
  const awards = timeline.players[0]!.events.flatMap((frame) =>
    frame.payload.event.type === "POT_AWARDED" ? [frame.payload.event.payload] : [],
  );
  expect(
    awards.some((pot) => pot.awards.length === 2),
    "seed must actually reach split",
  ).toBe(true);
  expect(
    awards.every(
      (pot) => pot.awards.reduce((sum, award) => sum + award.amount, 0) === pot.potAmount,
    ),
  ).toBe(true);
  await timeline.drive(2, "fold");
  await timeline.assert();
});
