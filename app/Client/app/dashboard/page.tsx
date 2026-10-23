import { redirect } from 'next/navigation';

// The global dashboard and the workspace listing now live together at /home.
// Keep this URL working for bookmarks and links from the remaining workspace
// pages while they are migrated checkpoint by checkpoint.
export default function DashboardPage() {
  redirect('/home');
}
