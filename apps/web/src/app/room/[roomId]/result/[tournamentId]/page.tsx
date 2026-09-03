import { ResultPageContent } from "../../../../../features/result/result-page-content";

export default async function ResultPage({ params }: { readonly params: Promise<{ roomId: string; tournamentId: string }> }) {
  const { roomId, tournamentId } = await params;
  return <ResultPageContent roomId={roomId} tournamentId={tournamentId} />;
}
