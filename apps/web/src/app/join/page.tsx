import { JoinRoomFlow } from "../../features/lobby/room-flows";

export default async function JoinRoomPage({ searchParams }: { readonly searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  return <JoinRoomFlow initialInviteCode={code ?? ""} />;
}
