import { FactClaimDetailClient } from "@/features/facts/FactClaimDetailClient";

type Props = {
  params: Promise<{
    claimId: string;
  }>;
};

export default async function FactClaimDetailPage({ params }: Props) {
  const { claimId } = await params;
  return <FactClaimDetailClient claimId={claimId} />;
}
