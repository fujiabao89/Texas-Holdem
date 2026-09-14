import type { RoomSnapshot } from "@texas-holdem/protocol";
import type { TournamentManager } from "../tournaments/tournament-manager";
import { RoomDomainError } from "./room-errors";
import type { RoomManager } from "./room-manager";
import { projectRoomSnapshot } from "./room-runtime";

export interface LeaveRoomMemberInput {
  readonly manager: RoomManager;
  readonly tournaments?: TournamentManager;
  readonly roomId: string;
  readonly playerId: string;
  readonly now: () => number;
  readonly connectionEpoch?: number;
}

/**
 * HTTP/WS share the withdrawal-before-membership order. The last withdrawal may
 * close and unload its Room itself; only a CLOSED snapshot observed during this
 * operation plus its authoritative tombstone can confirm that cleanup already
 * completed. The snapshot is held only by this in-flight request, never retained
 * in the tombstone or reconstructed from a stale pre-withdrawal view.
 */
export async function leaveRoomMember(input: LeaveRoomMemberInput): Promise<RoomSnapshot> {
  const { manager, tournaments, roomId, playerId, now, connectionEpoch } = input;
  let observedClosed: RoomSnapshot | undefined;
  let withdrawalConfirmed = false;
  const unsubscribe = manager.subscribe((snapshot) => {
    if (snapshot.roomId === roomId && snapshot.status === "CLOSED") observedClosed = snapshot;
  });
  const completedClosure = (): RoomSnapshot | undefined =>
    withdrawalConfirmed && manager.getTombstone(roomId) !== undefined ? observedClosed : undefined;

  try {
    const activeTournamentId = manager.getSnapshot(roomId)?.activeTournamentId;
    if (
      activeTournamentId !== null &&
      activeTournamentId !== undefined &&
      tournaments !== undefined
    ) {
      await tournaments.submit(activeTournamentId, {
        type: "WITHDRAW_PLAYER",
        playerId,
        reason: "USER_LEFT",
        connectionEpoch,
      });
      withdrawalConfirmed = true;
    }

    const closedByWithdrawal = completedClosure();
    if (closedByWithdrawal !== undefined) return closedByWithdrawal;
    try {
      const result = await manager.submitCommand(roomId, {
        type: "LEAVE",
        playerId,
        reason: "USER_LEFT",
        leftAt: now(),
        afterTournamentWithdrawal: withdrawalConfirmed,
        connectionEpoch,
      });
      return projectRoomSnapshot(result.state);
    } catch (error) {
      const closedWhileQueued = completedClosure();
      if (
        error instanceof RoomDomainError &&
        (error.code === "ROOM_NOT_FOUND" || error.code === "ROOM_LOCKED") &&
        closedWhileQueued !== undefined
      ) {
        return closedWhileQueued;
      }
      throw error;
    }
  } finally {
    unsubscribe();
  }
}
