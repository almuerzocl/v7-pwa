import { z } from 'zod';

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1, 'Missing required env var: NEXT_PUBLIC_SUPABASE_URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'Missing required env var: NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'Missing required env var: SUPABASE_SERVICE_ROLE_KEY'),
  RESEND_API_KEY: z.string().min(1, 'Missing required env var: RESEND_API_KEY'),
});

// Skip validation during `next build` — server-only secrets (service_role,
// Resend) aren't available at build time (injected at runtime via Cloud Run
// Secret Manager). Still validated at runtime on first request.
const isBuild = process.env.NEXT_PHASE === 'phase-production-build';

const raw = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
};

let validated: z.infer<typeof schema>;

if (isBuild) {
  // Build-time stub — never used in actual request handling.
  validated = {
    NEXT_PUBLIC_SUPABASE_URL: raw.NEXT_PUBLIC_SUPABASE_URL || 'https://build-placeholder.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: raw.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'build-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: raw.SUPABASE_SERVICE_ROLE_KEY || 'build-placeholder',
    RESEND_API_KEY: raw.RESEND_API_KEY || 'build-placeholder',
  };
} else {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(first?.message ?? 'Missing required env var');
  }
  validated = parsed.data;
}

export const env = validated;
export type Env = typeof env;
