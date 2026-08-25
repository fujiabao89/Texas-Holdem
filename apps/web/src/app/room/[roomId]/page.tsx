import { LobbyPage } from "../../../features/lobby/lobby-page";

export default async function RoomPage({ params }: { readonly params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <LobbyPage roomId={roomId} />;
}
