import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { format } from 'date-fns';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { getOpeningShiftsForDay, dayIndexForDateStr } from '@/lib/core-business/restaurant-hours';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

let _supabaseAdmin: SupabaseClient<any> | null = null;
function supabaseAdmin() {
    if (!_supabaseAdmin) {
        _supabaseAdmin = createClient<any>(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { global: { fetch: noStoreFetch } }
        );
    }
    return _supabaseAdmin;
}

const TIMEZONE = 'America/Santiago';

export async function GET(req: NextRequest) {
    const ip = getClientIp(req.headers);
    const { allowed } = rateLimit(`slots:${ip}`, 60, 60_000);
    if (!allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });

    const restaurantId = req.nextUrl.searchParams.get('restaurantId');
    if (!restaurantId) {
        return NextResponse.json({ success: false, error: 'Missing restaurantId' }, { status: 400 });
    }

    try {
        const { data: rest, error } = await supabaseAdmin()
            .from('restaurants')
            .select('opening_hours, takeaway_settings, is_active, has_takeaway, name')
            .eq('id', restaurantId)
            .single();

        if (error || !rest) {
            console.log(`[TakeawaySlots] Restaurant ${restaurantId} not found:`, error?.message);
            return NextResponse.json({ success: false, error: 'Restaurant not found' }, { status: 404 });
        }

        if (rest.is_active === false || !rest.has_takeaway) {
            console.log(`[TakeawaySlots] ${rest.name}: is_active=${rest.is_active}, has_takeaway=${rest.has_takeaway}`);
            return NextResponse.json({ success: true, slots: [] });
        }

        const today = new Date();
        const zonedNow = toZonedTime(today, TIMEZONE);
        const dateStr = format(zonedNow, 'yyyy-MM-dd');

        const shifts = getOpeningShiftsForDay(rest.opening_hours, dayIndexForDateStr(dateStr));

        if (shifts.length === 0) {
            console.log(`[TakeawaySlots] ${rest.name}: closed today (${dateStr})`);
            return NextResponse.json({ success: true, slots: [] });
        }

        const ts = rest.takeaway_settings || {};
        const rawOpen = parseInt(ts.opening_offset ?? '0', 10);
        const rawClose = parseInt(ts.closing_offset ?? '0', 10);
        const offsetOpen = Number.isFinite(rawOpen) ? rawOpen : 0;
        const offsetClose = Number.isFinite(rawClose) ? rawClose : 0;

        const validSlots: string[] = [];

        shifts.forEach((shift: any) => {
            if (shift.is_closed || !shift.open || !shift.close) return;

            const openTime = fromZonedTime(`${dateStr} ${shift.open}:00`, TIMEZONE);
            let closeTime = fromZonedTime(`${dateStr} ${shift.close}:00`, TIMEZONE);

            if (closeTime <= openTime) {
                closeTime = new Date(closeTime.getTime() + 24 * 60 * 60 * 1000);
            }

            const kitchenOpen = new Date(openTime.getTime() + offsetOpen * 60000);
            const kitchenClose = new Date(closeTime.getTime() - offsetClose * 60000);

            const absoluteNow = new Date();
            absoluteNow.setSeconds(0, 0);

            const minPrepTime = new Date(absoluteNow.getTime() + 20 * 60000);
            let currentSlot = new Date(Math.max(minPrepTime.getTime(), kitchenOpen.getTime()));

            const localMinsStr = formatInTimeZone(currentSlot, TIMEZONE, 'mm');
            const localMins = parseInt(localMinsStr, 10);
            const diffToNext15 = (15 - (localMins % 15)) % 15;
            currentSlot = new Date(currentSlot.getTime() + diffToNext15 * 60000);
            currentSlot.setUTCSeconds(0, 0);

            while (currentSlot <= kitchenClose) {
                validSlots.push(formatInTimeZone(currentSlot, TIMEZONE, 'HH:mm'));
                currentSlot = new Date(currentSlot.getTime() + 15 * 60000);
            }
        });

        const uniqueSlots = Array.from(new Set(validSlots)).sort((a, b) => a.localeCompare(b));

        console.log(`[TakeawaySlots] ${rest.name}: ${uniqueSlots.length} slots, offsets open=${offsetOpen} close=${offsetClose}`);

        return NextResponse.json({ success: true, slots: uniqueSlots });
    } catch (error: any) {
        console.error('[TakeawaySlots] Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
