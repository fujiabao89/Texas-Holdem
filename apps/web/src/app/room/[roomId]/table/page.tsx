import { PokerTablePage } from "../../../../features/poker-table/poker-table-page";

export default async function TablePage({ params }: { readonly params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <PokerTablePage roomId={roomId} />;
}
