import { redirect } from 'next/navigation';

/**
 * The inbox now lives inside the workspace shell. The old URL still carries the
 * workspace id, so this can be a server redirect rather than a client bridge.
 */
export default async function LegacyWorkspaceInboxPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/w/${encodeURIComponent(workspaceId)}/inbox`);
}
