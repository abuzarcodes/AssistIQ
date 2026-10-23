import { redirect } from 'next/navigation';

// Workspace selection moved to the global home at /home (CP2).
export default function WorkspacesPage() {
  redirect('/home');
}
