import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { safeNext } from '@/lib/safe-next'

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url)
    const code = searchParams.get('code')
    const next = safeNext(searchParams.get('next'))
    const providerError = searchParams.get('error')

    // Google (u otro proveedor) devolvió un error, p. ej. el usuario canceló en la pantalla de consentimiento.
    if (!code && providerError) {
        const redirectUrl = new URL('/login', getRedirectOrigin(request, origin))
        redirectUrl.searchParams.set('error', providerError === 'access_denied' ? 'access_denied' : 'auth-code-error')
        return NextResponse.redirect(redirectUrl.toString())
    }

    if (code) {
        const supabase = await createClient()
        const { error } = await supabase.auth.exchangeCodeForSession(code)

        if (!error) {
            const { data: { user } } = await supabase.auth.getUser()
            if (user) {
                const meta = user.user_metadata ?? {}
                const { data: existing } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('id', user.id)
                    .single()

                if (!existing) {
                    const { error: profileError } = await supabase.from('profiles').upsert({
                        id: user.id,
                        email: user.email ?? '',
                        first_name: meta.given_name ?? meta.first_name ?? meta.full_name?.split(' ')[0] ?? '',
                        last_name: meta.family_name ?? meta.last_name ?? meta.full_name?.split(' ').slice(1).join(' ') ?? '',
                        photo_url: meta.avatar_url ?? meta.picture ?? null,
                        role: 'USER',
                        account_type: 'free',
                        onboarding_completed: false,
                        reservation_reputation: 100,
                        total_reservations: 0,
                        favorite_restaurant_ids: [],
                        subscribed_daily_menu_ids: [],
                        preferred_payment_methods: [],
                    }, { onConflict: 'id', ignoreDuplicates: true })

                    if (profileError) {
                        console.error('[Auth Callback] Profile creation failed:', profileError.message)
                        // Redirect to login with error — profile is required for the app to work
                        const redirectUrl = new URL('/login', getRedirectOrigin(request, origin))
                        redirectUrl.searchParams.set('error', 'incomplete_profile')
                        return NextResponse.redirect(redirectUrl.toString())
                    }
                }
            }

            const redirectOrigin = getRedirectOrigin(request, origin)
            return NextResponse.redirect(`${redirectOrigin}${next}`)
        }
    }

    return NextResponse.redirect(`${getRedirectOrigin(request, origin)}/login?error=auth-code-error`)
}

function getRedirectOrigin(request: Request, fallbackOrigin: string): string {
    const forwardedHost = request.headers.get('x-forwarded-host')
    const isLocalhost = fallbackOrigin.includes('localhost')
    if (isLocalhost) return fallbackOrigin
    if (forwardedHost) return `https://${forwardedHost}`
    return fallbackOrigin
}
