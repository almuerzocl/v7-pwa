import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
    const pathname = request.nextUrl.pathname;

    // 1. Skip auth entirely for static assets and public API endpoints
    const isPublicAsset = pathname.startsWith('/images/') || /\.(png|jpg|jpeg|gif|svg|ico|css|js|woff2?|ttf|eot|mp3|webp|avif)$/i.test(pathname);
    const isAuthCallback = pathname.startsWith('/auth/');
    const isHealthCheck = pathname === '/api/health';
    // Cron/task routes handle their own CRON_SECRET auth — don't redirect them to /login
    const isCronRoute = pathname.startsWith('/api/cron/') || pathname.startsWith('/api/tasks/');
    // Public API routes — these handle their own auth or serve public data
    const isPublicApi = pathname.startsWith('/api/takeaway-slots') || pathname.startsWith('/api/contacts') || pathname === '/api/auth/recuperar' || pathname === '/api/auth/enlace-magico';
    // Public pages accessible without login
    const isPublicPage = pathname === '/privacidad' || pathname === '/terminos' || pathname === '/cookies' || pathname === '/restablecer-contrasena';
    // Static landing page for bots/crawlers (Google OAuth verification)
    const isLandingHtml = pathname === '/landing.html';

    if (isPublicAsset || isAuthCallback || isHealthCheck || isCronRoute || isPublicApi || isPublicPage || isLandingHtml) {
        return NextResponse.next();
    }

    let response = NextResponse.next({ request });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) =>
                        request.cookies.set(name, value)
                    );
                    response = NextResponse.next({ request });
                    cookiesToSet.forEach(({ name, value, options }) =>
                        response.cookies.set(name, value, options)
                    );
                },
            },
        }
    );

    // Read session from cookie — no network round-trip.
    // getUser() validates the token against Supabase's auth server on EVERY request,
    // adding 200-800ms latency per navigation. getSession() reads the JWT from the
    // cookie locally and is sufficient for routing guards. Security-critical operations
    // use verifyUser() with the service role inside server actions.
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user ?? null;

    const isLoginPage = pathname === '/login';

    // Only accept same-origin relative paths as redirect targets
    const safeRedirect = (raw: string | null): string => {
        if (!raw) return '/';
        if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
        if (raw.startsWith('/login')) return '/';
        return raw;
    };

    // 2. Redirect logged-in users away from login, honoring ?redirect=
    if (user && isLoginPage) {
        const target = safeRedirect(request.nextUrl.searchParams.get('redirect'));
        return NextResponse.redirect(new URL(target, request.url));
    }

    // 3. Allow login page
    if (isLoginPage) {
        return response;
    }

    // 4. Strict Auth Check — preserve attempted URL so we can return to it after login
    if (!user) {
        const loginUrl = new URL('/login', request.url);
        const attempted = pathname + (request.nextUrl.search || '');
        if (attempted && attempted !== '/') {
            loginUrl.searchParams.set('redirect', attempted);
        }
        return NextResponse.redirect(loginUrl);
    }

    return response;
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * Feel free to modify this pattern to include more paths.
         */
        '/((?!_next/static|_next/image|favicon.ico|manifest.json|icons/|images/|sw\\.js|notification\\.mp3).*)',
    ],
};
