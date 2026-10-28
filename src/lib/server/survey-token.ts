// Enlace personal a la encuesta (tuopinion.almuerzo.cl). SOLO SERVIDOR.
//
// Contrato idéntico al Worker `encuestaalmuerzo` (src/worker.js, verifyIdentity):
//   token   base64url(JSON {"email","exp"}) + "." + base64url(HMAC-SHA256(esa primera parte, IDENTITY_SECRET))
//   enlace  <SURVEY_BASE_URL>/#t=<token>   (fragmento, nunca query: el fragmento no viaja al servidor)
//   exp     segundos desde epoch
// IDENTITY_SECRET es el mismo del Worker y vive solo en Secret Manager: no se escribe en logs, base ni correos.
import { createHmac } from 'node:crypto';

export const MIN_SECRET_LENGTH = 32;

export function signSurveyToken(email: string, secret: string, ttlDays: number, nowMs: number = Date.now()): string {
    if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error('IDENTITY_SECRET ausente o demasiado corto');
    const clean = email.trim().toLowerCase();
    if (!clean) throw new Error('correo vacío');
    const exp = Math.floor(nowMs / 1000) + Math.round(ttlDays * 86400);
    const body = Buffer.from(JSON.stringify({ email: clean, exp })).toString('base64url');
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

export function buildSurveyUrl(baseUrl: string, token: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/#t=${token}`;
}
