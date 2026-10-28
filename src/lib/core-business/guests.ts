import { matchExistingUserAction } from '@/app/actions/guests-actions';

/**
 * Matches an email or phone number to an existing platform user.
 * Goes through a server action (auth + rate limit); the `find_user_public_info` RPC is no
 * longer callable from the browser (see migrations/013).
 */
export async function matchExistingUser(email?: string, phone?: string): Promise<string | null> {
    if (!email && !phone) return null;

    try {
        return await matchExistingUserAction(email, phone);
    } catch (err) {
        console.error('[Business Logic] Failed mapping user ID:', err);
        return null;
    }
}
