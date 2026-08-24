/**
 * rooms/** 测试共享替身（非测试文件，不被 Vitest 自动收集）。
 * 仅在测试中使用：内存记录型 RoomRepository 与 RoomPersistence。
 */

import type {
  CreateRoomWithHostInput,
  InsertRoomPlayerInput,
  RoomRepository,
} from "../infrastructure/persistence/repositories";
import type { InsertMemberInput, RoomPersistence } from "./room-persistence";
import type { TournamentStartRequest } from "./tournament-starter";

export interface FakeRoomRepository extends RoomRepository {
  readonly createdRooms: CreateRoomWithHostInput[];
}

export function fakeRoomRepository(): FakeRoomRepository {
  const createdRooms: CreateRoomWithHostInput[] = [];
  return {
    createdRooms,
    async createRoomWithHost(input) {
      createdRooms.push(input);
    },
    async insertRoomPlayer(_input: InsertRoomPlayerInput) {},
    async setRoomStatus() {},
    async updateRoomConfig() {},
    async setRoomHost() {},
    async markRoomPlayerLeft() {},
    async markRoomPlayerLeftAndSetHost() {},
    async startTournament() {},
  };
}

export interface FakePersistence extends RoomPersistence {
  readonly calls: string[];
  failNext: (error: Error) => void;
}

export function fakePersistence(): FakePersistence {
  const calls: string[] = [];
  let fail: Error | undefined;
  return {
    calls,
    failNext(error) {
      fail = error;
    },
    async insertMember(_input: InsertMemberInput) {
      calls.push("insertMember");
      if (fail) throw fail;
    },
    async markMemberLeft() {
      calls.push("markMemberLeft");
    },
    async leaveRoomMember() {
      calls.push("leaveRoomMember");
    },
    async updateRoomConfig() {
      calls.push("updateRoomConfig");
    },
    async setRoomHost() {
      calls.push("setRoomHost");
    },
    async setRoomStatus(_roomId, status) {
      calls.push(`setRoomStatus:${status}`);
    },
    async startTournament(_request: TournamentStartRequest) {
      calls.push("startTournament");
    },
  };
}
