import type { MetadataRoute } from 'next';

const BASE_URL = 'https://almuerzo.cl';

export default function sitemap(): MetadataRoute.Sitemap {
    const now = new Date();
    const routes = ['', '/terminos', '/privacidad', '/cookies'];

    return routes.map((path) => ({
        url: `${BASE_URL}${path}`,
        lastModified: now,
        changeFrequency: 'monthly',
        priority: path === '' ? 1 : 0.5,
    }));
}
