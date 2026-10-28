import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSurveyUrl, signSurveyToken } from '@/lib/server/survey-token';
import { buildWelcomeEmailHtml, buildWelcomeEmailText } from '@/lib/server/welcome-email';
import { processWelcomeEmails, readWelcomeConfig, type WelcomeConfig } from '@/lib/server/welcome-email-job';

const SECRET = 'x'.repeat(40);
const NOW = new Date('2026-10-26T12:00:00Z');

// Misma verificación que el Worker `encuestaalmuerzo` (src/worker.js, verifyIdentity), copiada tal cual.
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function workerVerify(token: string, secret: string, nowSec: number) {
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    try {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const ok = await crypto.subtle.verify('HMAC', key, unb64u(parts[1]), new TextEncoder().encode(parts[0]));
        if (!ok) return null;
        const p = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
        if (!p.email || typeof p.email !== 'string' || !p.exp) return null;
        if (p.exp < nowSec) return { expired: true };
        return { email: p.email.slice(0, 200), exp: p.exp };
    } catch { return null; }
}

describe('token de la encuesta (compatibilidad con el Worker)', () => {
    it('el Worker lo acepta, con el correo en minúsculas y 30 días de vigencia', async () => {
        const t = signSurveyToken(' Ana@Correo.cl ', SECRET, 30, NOW.getTime());
        const r: any = await workerVerify(t, SECRET, NOW.getTime() / 1000);
        expect(r.email).toBe('ana@correo.cl');
        expect(r.exp).toBe(NOW.getTime() / 1000 + 30 * 86400);
    });
    it('vence a los 30 días y lo rechaza con otro secreto o alterado', async () => {
        const t = signSurveyToken('ana@correo.cl', SECRET, 30, NOW.getTime());
        expect(await workerVerify(t, SECRET, NOW.getTime() / 1000 + 30 * 86400 + 1)).toEqual({ expired: true });
        expect(await workerVerify(t, 'y'.repeat(40), NOW.getTime() / 1000)).toBeNull();
        const [b, s] = t.split('.');
        expect(await workerVerify(`${b}x.${s}`, SECRET, NOW.getTime() / 1000)).toBeNull();
    });
    it('rechaza un secreto corto o vacío', () => {
        expect(() => signSurveyToken('a@b.cl', 'corto', 30)).toThrow();
        expect(() => signSurveyToken('  ', SECRET, 30)).toThrow();
    });
    it('el enlace lleva el token en el fragmento, no en la query', () => {
        expect(buildSurveyUrl('https://tuopinion.almuerzo.cl/', 'T.S')).toBe('https://tuopinion.almuerzo.cl/#t=T.S');
    });
});

describe('contenido del correo', () => {
    const input = { firstName: 'María', surveyUrl: 'https://tuopinion.almuerzo.cl/#t=A.B', renewUrl: 'https://app2.almuerzo.cl/encuesta', validityDays: 30 };
    it('incluye lo acordado y no menciona lo excluido', () => {
        const all = buildWelcomeEmailText(input) + buildWelcomeEmailHtml(input);
        for (const s of [
            'Gracias por sumarte', 'Pedir para retirar', 'Reservar mesa', 'menú del día',
            'https://almuerzo.cl/collections/para-comensales',
            'Tu tiempo de almuerzo es tuyo: queremos ayudarte a disfrutarlo más, trabajando con restaurantes y proveedores para que salir a almorzar sea más fácil. ¿Qué es lo que más te importaría mejorar de tu experiencia al salir a almorzar? Son solo unos minutos.',
            'Contar mi experiencia',
            'https://tuopinion.almuerzo.cl/#t=A.B', 'https://app2.almuerzo.cl/encuesta',
            'Pides, llegas y listo: ¡cero filas!', 'almuerzo.cl: solo para Vivaldis', '30 días',
        ]) expect(all).toContain(s);
        expect(all).not.toMatch(/prepago|entel|promoci|descuento|audio|grab|qué te complica|qué me complica/i);
    });
    it('incluye un botón para compartir por WhatsApp con el mensaje ya escrito y sin correo', () => {
        const text = buildWelcomeEmailText(input);
        const html = buildWelcomeEmailHtml(input);
        expect(text + html).toContain('¿Te gustó almuerzo.cl? ¿Quieres compartirlo con alguien?');
        expect(html).toContain('Compartir por WhatsApp');
        expect(text + html).not.toContain('mailto:');
        const msg = decodeURIComponent(/https:\/\/wa\.me\/\?text=([^\s"&]+)/.exec(text)![1]);
        expect(msg).toContain('https://almuerzo.cl/collections/para-comensales');
        expect(msg).not.toContain('tuopinion');
        expect(msg).not.toMatch(/#t=/);
    });
    it('escapa el nombre en el HTML', () => {
        const html = buildWelcomeEmailHtml({ ...input, firstName: '<img src=x onerror=1>' });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });
    it('sin nombre saluda sin él', () => {
        expect(buildWelcomeEmailText({ ...input, firstName: null })).toMatch(/^Hola,\n/);
    });
});

describe('configuración', () => {
    const ok = { WELCOME_EMAILS_ENABLED: 'true', IDENTITY_SECRET: SECRET };
    it('apagada por defecto y sin secreto válido', () => {
        expect(readWelcomeConfig({ IDENTITY_SECRET: SECRET })).toBeNull();
        expect(readWelcomeConfig({ ...ok, IDENTITY_SECRET: 'corto' })).toBeNull();
        expect(readWelcomeConfig({ WELCOME_EMAILS_ENABLED: 'true' })).toBeNull();
    });
    it('usa tuopinion.almuerzo.cl y 30 días por defecto; la base es configurable y solo https', () => {
        const c = readWelcomeConfig(ok)!;
        expect(c.surveyBaseUrl).toBe('https://tuopinion.almuerzo.cl');
        expect(c.validityDays).toBe(30);
        expect(readWelcomeConfig({ ...ok, SURVEY_BASE_URL: 'https://encuesta.almuerzo.cl/' })!.surveyBaseUrl).toBe('https://encuesta.almuerzo.cl');
        expect(readWelcomeConfig({ ...ok, SURVEY_BASE_URL: 'http://x.cl' })).toBeNull();
        expect(readWelcomeConfig({ ...ok, SURVEY_BASE_URL: 'https://x.cl/ruta?q=1' })).toBeNull();
    });
    it('la vigencia se acota a 1-90 días', () => {
        expect(readWelcomeConfig({ ...ok, WELCOME_SURVEY_TOKEN_DAYS: '45' })!.validityDays).toBe(45);
        expect(readWelcomeConfig({ ...ok, WELCOME_SURVEY_TOKEN_DAYS: '0' })!.validityDays).toBe(30);
        expect(readWelcomeConfig({ ...ok, WELCOME_SURVEY_TOKEN_DAYS: '400' })!.validityDays).toBe(30);
    });
});

function fakeAdmin(claimed: any[], claimError?: string) {
    const updates: { table: string; patch: any; user: string }[] = [];
    const logs: any[] = [];
    const rpc = vi.fn().mockResolvedValue(claimError ? { data: null, error: { message: claimError } } : { data: claimed, error: null });
    const admin: any = {
        rpc,
        from: (table: string) => ({
            update: (patch: any) => ({ eq: (_c: string, user: string) => { updates.push({ table, patch, user }); return Promise.resolve({ error: null }); } }),
            insert: (r: any) => { logs.push({ table, ...r }); return Promise.resolve({ error: null }); },
        }),
    };
    return { admin, rpc, updates, logs };
}

describe('emisor', () => {
    const config: WelcomeConfig = { identitySecret: SECRET, surveyBaseUrl: 'https://tuopinion.almuerzo.cl', renewUrl: 'https://app2.almuerzo.cl/encuesta', validityDays: 30 };
    const row = { user_id: 'u1', email: 'ana@correo.cl', first_name: 'Ana', attempts: 1 };

    it('apagado: no reclama ni envía', async () => {
        const f = fakeAdmin([row]); const send = vi.fn();
        const r = await processWelcomeEmails({}, { admin: f.admin, send, now: () => NOW, config: null });
        expect(r.disabled).toBe(true);
        expect(f.rpc).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });
    it('envía una vez con enlace válido, marca sent_at y usa el id como clave de límite', async () => {
        const f = fakeAdmin([row]); const send = vi.fn().mockResolvedValue({ success: true });
        const r = await processWelcomeEmails({}, { admin: f.admin, send, now: () => NOW, config });
        expect(r).toMatchObject({ claimed: 1, completed: 1, emailsSent: 1, failed: 0 });
        const p = send.mock.calls[0][0];
        expect(p.to).toBe('ana@correo.cl');
        expect(p.rateLimitKey).toBe('u1');
        const token = /#t=([\w.-]+)/.exec(p.text)![1];
        expect(await workerVerify(token, SECRET, NOW.getTime() / 1000)).toMatchObject({ email: 'ana@correo.cl' });
        expect(f.updates[0].patch.sent_at).toBe(NOW.toISOString());
        expect(f.updates[0].patch.claimed_at).toBeNull();
    });
    it('si el envío falla libera el reclamo, guarda el motivo y no filtra el enlace al registro', async () => {
        const f = fakeAdmin([row]); const send = vi.fn().mockResolvedValue({ success: false, error: 'rate limited' });
        const r = await processWelcomeEmails({}, { admin: f.admin, send, now: () => NOW, config });
        expect(r).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
        expect(f.updates[0].patch).toEqual({ claimed_at: null, last_error: 'rate limited' });
        expect(JSON.stringify([f.updates, f.logs])).not.toMatch(/#t=|tuopinion|x{40}/);
    });
    it('al quinto intento fallido lo registra como abandonado', async () => {
        const f = fakeAdmin([{ ...row, attempts: 5 }]); const send = vi.fn().mockResolvedValue({ success: false, error: 'boom' });
        await processWelcomeEmails({}, { admin: f.admin, send, now: () => NOW, config });
        expect(f.logs[0].message).toContain('SE ABANDONA');
    });
    it('sin correo se cierra sin enviar', async () => {
        const f = fakeAdmin([{ ...row, email: ' ' }]); const send = vi.fn();
        const r = await processWelcomeEmails({}, { admin: f.admin, send, now: () => NOW, config });
        expect(r.skipped).toBe(1);
        expect(send).not.toHaveBeenCalled();
        expect(f.updates[0].patch.sent_at).toBe(NOW.toISOString());
    });
    it('un error del reclamo se propaga', async () => {
        const f = fakeAdmin([], 'no existe la función');
        await expect(processWelcomeEmails({}, { admin: f.admin, send: vi.fn(), now: () => NOW, config })).rejects.toThrow('no existe la función');
    });
});

describe('GET /encuesta', () => {
    let user: any;
    beforeEach(() => {
        vi.resetModules();
        user = { email: 'ana@correo.cl', email_confirmed_at: '2026-10-01T00:00:00Z' };
        vi.doMock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }));
        process.env.IDENTITY_SECRET = SECRET;
        delete process.env.SURVEY_BASE_URL;
    });
    afterEach(() => { vi.doUnmock('@/utils/supabase/server'); delete process.env.IDENTITY_SECRET; });

    it('sin secreto configurado responde 503', async () => {
        delete process.env.IDENTITY_SECRET;
        const { GET } = await import('@/app/encuesta/route');
        expect((await GET()).status).toBe(503);
    });
    it('sin sesión redirige al login con redirect relativo', async () => {
        user = null;
        const { GET } = await import('@/app/encuesta/route');
        const r = await GET();
        expect(r.status).toBe(303);
        expect(r.headers.get('location')).toBe('/login?redirect=%2Fencuesta');
    });
    it('con correo sin verificar responde 403', async () => {
        user = { email: 'ana@correo.cl', email_confirmed_at: null };
        const { GET } = await import('@/app/encuesta/route');
        expect((await GET()).status).toBe(403);
    });
    it('con sesión emite un enlace válido a la URL base y sin caché', async () => {
        const { GET } = await import('@/app/encuesta/route');
        const r = await GET();
        expect(r.status).toBe(303);
        expect(r.headers.get('cache-control')).toBe('no-store');
        const loc = r.headers.get('location')!;
        expect(loc.startsWith('https://tuopinion.almuerzo.cl/#t=')).toBe(true);
        expect(await workerVerify(loc.split('#t=')[1], SECRET, Date.now() / 1000)).toMatchObject({ email: 'ana@correo.cl' });
    });
});
