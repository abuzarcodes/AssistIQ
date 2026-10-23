import { redirect } from 'next/navigation';

/**
 * The workspace's bot management now lives inside the workspace shell. Keep the
 * old URL working for bookmarks and the remaining legacy pages.
 */
export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/w/${encodeURIComponent(workspaceId)}/bots`);
}
