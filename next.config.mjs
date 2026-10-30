import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
    swSrc: "src/app/sw.ts",
    swDest: "public/sw.js",
    register: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    eslint: {
        ignoreDuringBuilds: true,
    },
    images: {
        remotePatterns: [
            { protocol: 'https', hostname: 'kqanordhsmbtcwtjtrme.supabase.co' },
            { protocol: 'https', hostname: '*.supabase.co' },
        ],
    },
    async headers() {
        const common = [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
            { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ];
        return [
            // /orders/<id> se muestra dentro de OrderModal (iframe del mismo origen).
            {
                source: '/orders/:path*',
                headers: [
                    ...common,
                    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
                    { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
                ],
            },
            // Resto de la PWA: no embebible.
            {
                source: '/:path((?!orders(?:/|$)).*)',
                headers: [...common, { key: 'X-Frame-Options', value: 'DENY' }],
            },
        ];
    },
};

export default withSerwist(nextConfig);
