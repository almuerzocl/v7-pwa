/**
 * Lector mínimo de tarjetas vCard (.vcf) para importar invitados sin acceso a la agenda
 * (iPhone no expone la Contact Picker API). Corre en el navegador: el archivo no se sube.
 * Soporta vCard 2.1, 3.0 y 4.0 con varias tarjetas por archivo; toma nombre, primer correo
 * y primer teléfono.
 */
export interface VCardContact {
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
}

export const VCARD_MAX_BYTES = 1024 * 1024;
export const VCARD_MAX_CONTACTS = 50;

/** Une las líneas plegadas (las que empiezan con espacio o tab) y las de quoted-printable con "=" final. */
function unfold(text: string): string[] {
    const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out: string[] = [];
    for (const line of raw) {
        if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
        else out.push(line);
    }
    const joined: string[] = [];
    for (let i = 0; i < out.length; i++) {
        let l = out[i];
        while (/QUOTED-PRINTABLE/i.test(l) && l.endsWith('=') && i + 1 < out.length) { l = l.slice(0, -1) + out[++i]; }
        joined.push(l);
    }
    return joined;
}

function decodeQP(s: string): string {
    try {
        const bytes: number[] = [];
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
            else bytes.push(...Array.from(new TextEncoder().encode(s[i])));
        }
        return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    } catch { return s; }
}

function unescapeValue(s: string): string {
    return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

export function normalizePhone(raw: string): string | null {
    const cleaned = raw.replace(/[^\d+]/g, '');
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return null;
    return cleaned.startsWith('+') ? `+${digits}` : digits;
}

export function parseVCards(text: string): VCardContact[] {
    const lines = unfold(text);
    const result: VCardContact[] = [];
    let cur: { fn?: string; n?: string[]; email?: string; tel?: string } | null = null;

    for (const line of lines) {
        const upper = line.toUpperCase();
        if (upper === 'BEGIN:VCARD') { cur = {}; continue; }
        if (upper === 'END:VCARD') {
            if (cur) {
                let first = '';
                let last = '';
                if (cur.n && (cur.n[1] || cur.n[0])) { last = cur.n[0] || ''; first = [cur.n[1], cur.n[2]].filter(Boolean).join(' '); }
                if (!first && !last && cur.fn) { const p = cur.fn.split(/\s+/); first = p[0] || ''; last = p.slice(1).join(' '); }
                const phone = cur.tel ? normalizePhone(cur.tel) : null;
                const email = cur.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cur.email) ? cur.email : null;
                if ((first || last) && (phone || email)) result.push({ first_name: first.trim(), last_name: last.trim(), email, phone });
            }
            cur = null;
            continue;
        }
        if (!cur) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const head = line.slice(0, idx);
        let value = line.slice(idx + 1);
        const [propRaw, ...params] = head.split(';');
        const prop = propRaw.split('.').pop()!.toUpperCase(); // quita el grupo "item1."
        if (params.some(p => /ENCODING=QUOTED-PRINTABLE/i.test(p))) value = decodeQP(value);
        if (prop === 'FN' && !cur.fn) cur.fn = unescapeValue(value);
        else if (prop === 'N' && !cur.n) cur.n = value.split(';').map(unescapeValue);
        else if (prop === 'EMAIL' && !cur.email) cur.email = unescapeValue(value);
        else if (prop === 'TEL' && !cur.tel) cur.tel = unescapeValue(value).replace(/^tel:/i, '');
        if (result.length >= VCARD_MAX_CONTACTS) break;
    }
    return result.slice(0, VCARD_MAX_CONTACTS);
}
