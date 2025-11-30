import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Redirect /r (no room code) back to home
export const load: PageServerLoad = async () => {
  throw redirect(307, '/');
};
