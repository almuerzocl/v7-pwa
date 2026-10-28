import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { logError } from '@/lib/error-logger';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
    }
    return _supabaseAdmin;
}

const GetSchema = z.object({
    userId: z.string().uuid('Invalid userId format'),
});

const PostSchema = z.object({
    userId: z.string().uuid('Invalid userId format'),
    first_name: z.string().min(1).max(100),
    last_name: z.string().max(100).optional().default(''),
    email: z.string().email().nullish(),
    whatsapp_phone: z.string().max(20).nullish(),
});

async function getAuthUser(req: NextRequest): Promise<string | null> {
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() { return req.cookies.getAll(); },
                setAll() { /* read-only in API routes */ },
            },
        }
    );
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
}

// GET /api/contacts?userId=xxx — fetch user contacts
export async function GET(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed } = rateLimit(`contacts:${ip}`, 60, 60_000); // 60 req/min per IP
    if (!allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });

    const parsed = GetSchema.safeParse({ userId: req.nextUrl.searchParams.get('userId') });
    if (!parsed.success) {
        return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }

    const { userId } = parsed.data;

    const authUserId = await getAuthUser(req);
    if (!authUserId || authUserId !== userId) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { data, error } = await supabaseAdmin()
            .from('contacts')
            .select('*')
            .eq('owner_id', userId)
            .order('first_name', { ascending: true });

        if (error) {
            logError({ source: '/api/contacts GET', message: error.message, userId });
            return NextResponse.json({ success: false, contacts: [], error: 'Database error' }, { status: 500 });
        }

        return NextResponse.json({ success: true, contacts: data || [] });
    } catch (err: any) {
        logError({ source: '/api/contacts GET', message: err.message, userId });
        return NextResponse.json({ success: false, contacts: [], error: 'Internal error' }, { status: 500 });
    }
}

// POST /api/contacts — save a new contact
export async function POST(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed } = rateLimit(`contacts:${ip}`, 30, 60_000); // 30 writes/min per IP
    if (!allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }

    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ success: false, error: parsed.error.issues[0].message }, { status: 400 });
    }

    const { userId, first_name, last_name, email, whatsapp_phone } = parsed.data;

    const authUserId = await getAuthUser(req);
    if (!authUserId || authUserId !== userId) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { data, error } = await supabaseAdmin()
            .from('contacts')
            .insert({
                owner_id: userId,
                first_name,
                last_name: last_name || '',
                email: email || null,
                whatsapp_phone: whatsapp_phone || null,
            })
            .select()
            .single();

        if (error) {
            logError({ source: '/api/contacts POST', message: error.message, userId });
            return NextResponse.json({ success: false, contact: null, error: 'Database error' }, { status: 500 });
        }

        return NextResponse.json({ success: true, contact: data });
    } catch (err: any) {
        logError({ source: '/api/contacts POST', message: err.message, userId });
        return NextResponse.json({ success: false, contact: null, error: 'Internal error' }, { status: 500 });
    }
}
