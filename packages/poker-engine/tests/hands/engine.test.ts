import { describe, it, expect } from "vitest";
import {
  PokerHandEngine,
  SeededRandomSource,
  parseCard,
  createStandardDeck,
  cardKey,
  assertInvariants,
} from "../../src";
import type { HandConfig, PlayerAction, SeatConfig, Deck } from "../../src";

const seat = (i: number, chips = 100): SeatConfig => ({ seatIndex: i, name: `P${i}`, kind: "human", chips });
const act = (seatIndex: number, type: PlayerAction["type"], amount?: number): PlayerAction => ({
  type,
  seatIndex,
  amount,
  source: "human_socket",
});

function cfg(seats: SeatConfig[], over: Partial<HandConfig> = {}): HandConfig {
  return {
    handNumber: 1,
    smallBlind: 10,
    bigBlind: 20,
    rng: new SeededRandomSource(42),
    dealerSeat: seats[0]!.seatIndex,
    ...over,
    seats,
  };
}

/** 构造受控牌堆：ordered 为「按引擎发牌消费顺序」的前缀（底牌→Burn→公共牌），其余自动补足 52 张。 */
function controlledDeck(ordered: string[]): Deck {
  const used = new Set(ordered.map((code) => cardKey(parseCard(code))));
  const rest = createStandardDeck().filter((c) => !used.has(cardKey(c)));
  const full = [...ordered.map((code) => parseCard(code)), ...rest];
  return { toArray: () => full, draw: () => full.shift()!, shuffle: () => {}, size: full.length } as unknown as Deck;
}

describe("PokerHandEngine 单局行为", () => {
  it("仅剩一名未弃牌：直接判给最后剩余者（无比牌），不变量成立，BURN 无面", () => {
    const eng = new PokerHandEngine(cfg([seat(0), seat(1), seat(2)]));
    assertInvariants(eng.getState());
    eng.applyAction(act(0, "fold"));
    eng.applyAction(act(1, "fold"));
    expect(eng.isComplete()).toBe(true);
    const outcome = eng.getOutcome()!;
    expect(outcome.winners).toEqual([2]);
    expect(outcome.showdown).toBe(false);
    const seats = eng.getState().seats;
    expect(seats.find((s) => s.seatIndex === 0)!.chips).toBe(100);
    expect(seats.find((s) => s.seatIndex === 1)!.chips).toBe(90); // SB = 10
    expect(seats.find((s) => s.seatIndex === 2)!.chips).toBe(110); // 主池 + 退回未跟注
    assertInvariants(eng.getState());
    expect(eng.getEvents().some((e) => e.type === "BURN_CARD")).toBe(false); // preflop 即结算，无烧牌
  });

  it("Heads-Up 走到比牌，公共牌按序补给，A 对获胜；BURN 无面且不变量成立", () => {
    // HU：dealer=0(button/SB)；发牌顺序 [0,1] → seat0=As/Ah，seat1=Ks/Kh。
    const deck = controlledDeck(["As", "Ks", "Ah", "Kh", "Td", "2c", "3d", "4s", "Jd", "7h", "Qd", "9c"]);
    const eng = new PokerHandEngine(cfg([seat(0), seat(1)], { dealerSeat: 0, deck }));
    assertInvariants(eng.getState());
    eng.applyAction(act(0, "call")); // preflop: button/SB 跟到 20
    eng.applyAction(act(1, "check")); // BB option
    eng.applyAction(act(1, "check"));
    eng.applyAction(act(0, "check"));
    eng.applyAction(act(1, "check"));
    eng.applyAction(act(0, "check"));
    eng.applyAction(act(1, "check"));
    const result = eng.applyAction(act(0, "check"));
    expect(eng.isComplete()).toBe(true);
    expect(result).toBeNull();
    const outcome = eng.getOutcome()!;
    expect(outcome.showdown).toBe(true);
    expect(outcome.winners).toEqual([0]);
    expect(eng.getState().communityCards).toHaveLength(5);
    const seats = eng.getState().seats;
    expect(seats.find((s) => s.seatIndex === 0)!.chips).toBe(120);
    expect(seats.find((s) => s.seatIndex === 1)!.chips).toBe(80);
    assertInvariants(eng.getState());
    for (const e of eng.getEvents()) if (e.type === "BURN_CARD") expect((e as Record<string, unknown>).card).toBeUndefined();
  });

  it("非法 Action（非当前行动者 / 低于最小加注）被拒，状态与事件序列均不变", () => {
    const eng = new PokerHandEngine(cfg([seat(0), seat(1), seat(2)]));
    expect(() => eng.applyAction(act(1, "fold"))).toThrow(); // 非当前行动者（当前 seat0）
    eng.applyAction(act(0, "call")); // 合法：跟注 BB=20
    const stateAfterBet = eng.getState();
    const eventsAfterBet = eng.getEvents();
    expect(() => eng.applyAction(act(1, "raise", 25))).toThrow(); // 低于最小加注(40)
    expect(eng.getState()).toBe(stateAfterBet); // 状态引用未变
    expect(eng.getEvents()).toEqual(eventsAfterBet); // 事件序列（内容）未变
  });

  it("全员 All-in：自动 Runout 补满 5 张公共牌再结算，成牌高者获胜，不变量成立", () => {
    const deck = controlledDeck(["As", "Ks", "Ah", "Kh", "Td", "2c", "3d", "4s", "Jd", "7h", "Qd", "9c"]);
    const eng = new PokerHandEngine(cfg([seat(0, 100), seat(1, 100)], { dealerSeat: 0, deck }));
    eng.applyAction(act(0, "all-in")); // button/SB 全下 100
    const result = eng.applyAction(act(1, "call")); // BB 全下跟注（与全下等价，提交 CALL）→ 双全下 → runout
    expect(eng.isComplete()).toBe(true);
    expect(result).toBeNull();
    const state = eng.getState();
    expect(state.communityCards).toHaveLength(5);
    expect(state.outcome!.showdown).toBe(true);
    expect(state.outcome!.winners).toEqual([0]); // 对 A 胜对 K
    expect(state.seats.find((s) => s.seatIndex === 0)!.chips).toBe(200);
    expect(state.seats.find((s) => s.seatIndex === 1)!.chips).toBe(0);
    assertInvariants(state);
  });

  it("三人不同筹码深度 All-in：主池+边池分别由不同玩家获胜（回归 · 关键验收）", () => {
    // 发牌顺序（dealer=0 多人）=[1,2,0] → seat1=Ks/9d，seat2=As/Ah，seat0=8h/5d；board=2c,3d,4s,Jh,Qc。
    // 牌力：seat2(AA) > seat1(K 高) > seat0(Q 高)。主池(三人)胜者 seat2，边池(seat0,seat1)胜者 seat1。
    const deck = controlledDeck([
      "Ks", "As", "8h", "9d", "Ah", "5d", "Td", "2c", "3d", "4s", "8c", "Jh", "9c", "Qc",
    ]);
    const eng = new PokerHandEngine(
      cfg([seat(0, 200), seat(1, 200), seat(2, 100)], { dealerSeat: 0, deck, bigBlind: 20, smallBlind: 10 }),
    );
    assertInvariants(eng.getState());
    eng.applyAction(act(0, "all-in")); // seat0(UTG) 全下 200
    eng.applyAction(act(1, "call")); // seat1(SB) 跟足 190 → 亦全下（与全下等价，提交 CALL）
    const result = eng.applyAction(act(2, "all-in")); // seat2(BB, 仅 100) 短全下 → 双池 → runout
    expect(eng.isComplete()).toBe(true);
    expect(result).toBeNull();
    const state = eng.getState();
    expect(state.pots).toHaveLength(2);
    expect(state.pots[0]!.index).toBe(0); // main
    expect(state.pots[0]!.amount).toBe(300); // 100 × 3
    expect(state.pots[1]!.index).toBe(1); // side
    expect(state.pots[1]!.amount).toBe(200); // (200-100) × 2
    // 不同 Pot 不同赢家：主池 → seat2(AA)，边池 → seat1(K 高)。
    const awards = state.outcome!.awards;
    expect(awards[0]!.winners).toEqual([2]);
    expect(awards[1]!.winners).toEqual([1]);
    expect([...state.outcome!.winners].sort((a, b) => a - b)).toEqual([1, 2]);
    // 筹码结算：seat2 得主池，seat1 得边池，seat0 出局。
    expect(state.seats.find((s) => s.seatIndex === 0)!.chips).toBe(0);
    expect(state.seats.find((s) => s.seatIndex === 1)!.chips).toBe(200);
    expect(state.seats.find((s) => s.seatIndex === 2)!.chips).toBe(300);
    assertInvariants(state);
  });

  it("HU 短盲全下不卡死：SB 不足盲注而从盲注全下后，首行动者跳到 BB，仍可推进至结算", () => {
    // seat0(dealer/SB) 仅 5 < SB=10 → 缴盲即全下；首行动者应为 seat1(BB) 而非卡在全下座位。
    const eng = new PokerHandEngine(cfg([seat(0, 5), seat(1, 100)], { dealerSeat: 0, smallBlind: 10, bigBlind: 20 }));
    expect(eng.getState().currentActor).toBe(1);
    expect(eng.getLegalActions().canCheck).toBe(true); // BB 面临全下 SB，callAmount=0，可 Check
    eng.applyAction(act(1, "check")); // preflop
    eng.applyAction(act(1, "check")); // flop
    eng.applyAction(act(1, "check")); // turn
    const result = eng.applyAction(act(1, "check")); // river → showdown
    expect(eng.isComplete()).toBe(true);
    expect(result).toBeNull();
    expect(eng.getOutcome()!.showdown).toBe(true);
    assertInvariants(eng.getState());
  });

  it("HU 双方筹码皆不足盲注（全员全下）→ 构造即自动 Runout 结算，不卡死", () => {
    const eng = new PokerHandEngine(cfg([seat(0, 5), seat(1, 15)], { dealerSeat: 0, smallBlind: 10, bigBlind: 20 }));
    expect(eng.isComplete()).toBe(true); // 开局即结算
    const outcome = eng.getOutcome()!;
    expect(outcome.pots.length).toBeGreaterThanOrEqual(1);
    assertInvariants(eng.getState());
  });

  it("排除零筹码座位：0 筹码座位不参与本手，且不可被指定为 Dealer", () => {
    const eng = new PokerHandEngine(cfg([seat(0, 0), seat(1, 100), seat(2, 100)], { dealerSeat: 1 }));
    const inHandSeats = eng.getState().seats.map((s) => s.seatIndex);
    expect(inHandSeats).toEqual([1, 2]); // 0 筹码座位被排除
    expect(inHandSeats).not.toContain(0);
    assertInvariants(eng.getState());
    // 指定 0 筹码座位为 Dealer → 非法配置，抛错。
    expect(() => new PokerHandEngine(cfg([seat(0, 0), seat(1, 100), seat(2, 100)], { dealerSeat: 0 }))).toThrow();
  });

  it("E2E：A 加注后遇 Short All-in，A 不重开（只能 Call 差额）", () => {
    const eng = new PokerHandEngine(cfg([seat(0, 2000), seat(1, 350), seat(2, 500)], { dealerSeat: 0, smallBlind: 50, bigBlind: 100 }));
    eng.applyAction(act(0, "raise", 300)); // A(UTG) 加注到 300（完整，±200）
    eng.applyAction(act(1, "all-in"));     // B(SB) 短全下到 350（+50 < 200 → Short All-in）
    eng.applyAction(act(2, "call"));       // C(BB) 跟注到 350
    const la = eng.getLegalActions();
    expect(eng.getState().currentActor).toBe(0);
    expect(la.canRaise).toBe(false); // 增量 350-300=50 < A 的完整加注 200 → 不重开
    expect(la.canCall).toBe(true);
    expect(la.callAmount).toBe(50);
  });

  it("事件 sequence 唯一且单调（覆盖自动 BURN/deal/showdown/award 事件后的游标回写）", () => {
    const deck = controlledDeck(["As", "Ks", "Ah", "Kh", "Td", "2c", "3d", "4s", "Jd", "7h", "Qd", "9c"]);
    const eng = new PokerHandEngine(cfg([seat(0), seat(1)], { dealerSeat: 0, deck }));
    eng.applyAction(act(0, "all-in"));
    eng.applyAction(act(1, "call"));
    expect(eng.isComplete()).toBe(true);
    const seqs = eng.getEvents().map((e) => e.sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // 0,1,2,… 无重复、无缺号
  });

  it("短 BB：preflop 为完整默认 BB 态（currentBet=名义 BB、minRaiseTo=40、SB 补足到 BB）", () => {
    const eng = new PokerHandEngine(cfg([seat(0, 500), seat(1, 200), seat(2, 5)], { dealerSeat: 0, smallBlind: 10, bigBlind: 20 }));
    const state = eng.getState();
    expect(state.currentBet).toBe(20); // 名义 BB，而非短 BB 实际投入或 SB 额
    expect(state.hasFullBetOrRaise).toBe(true); // BB 视为完整开注（完整默认 BB 态）
    const la = eng.getLegalActions(); // UTG(seat0)
    expect(la.canCall).toBe(true);
    expect(la.callAmount).toBe(20); // 须跟到 20
    expect(la.minRaiseTo).toBe(40); // 完整加注基线 = currentBet(20) + lastFullRaiseSize(20)
    eng.applyAction(act(0, "call"));
    expect(eng.getState().currentActor).toBe(1); // 轮到 SB(seat1)
    expect(eng.getLegalActions().callAmount).toBe(10); // SB 须补足到 20
  });

  it("注入牌堆不足（2×参与人数+6 张）时构造必须抛错（缺少 River 烧牌）", () => {
    const cards = ["As", "Ks", "Ah", "Kh", "2c", "3d", "4s", "5h", "6d", "7c"].map((code) => parseCard(code));
    const shortDeck = { toArray: () => [...cards], draw: () => cards.shift()!, shuffle: () => {}, size: cards.length } as unknown as Deck;
    // 2 人完整手牌需 2×2 + 3 + 5 = 12 张；10 张不足 → 抛错。
    expect(() => new PokerHandEngine(cfg([seat(0), seat(1)], { dealerSeat: 0, deck: shortDeck }))).toThrow();
  });
});
