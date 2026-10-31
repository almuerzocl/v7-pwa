import '@/lib/env';
// import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";


const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: 'optional',
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: 'optional',
});

import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Almuerzo.cl",
  description: "0% delivery, 100% comida rica",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Almuerzo",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  formatDetection: {
    telephone: false,
  },
};

import { AuthProvider } from "@/context/AuthContext";
import { LocationProvider } from "@/context/LocationContext";
import { NotificationProvider } from "@/context/NotificationContext";
import { CartProvider } from "@/context/CartContext";
import { OfflineSyncProvider } from "@/components/OfflineSyncProvider";
import { Toaster } from "react-hot-toast";
import ConsentAnalytics from "@/components/ConsentAnalytics";
import { CapacitorInit } from "@/components/CapacitorInit";
import { PwaUpdateNotifier } from "@/components/PwaUpdateNotifier";
import CookieBanner from "@/components/CookieBanner";
import Footer from "@/components/Footer";


export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Almuerzo.cl",
              "url": "https://www.almuerzo.cl",
              "description": "Directorio de menú del día que integra reservas y pedidos para restaurantes en Chile.",
              "sameAs": ["https://www.saborez.cl"],
              "parentOrganization": {
                "@type": "Organization",
                "name": "Saborez",
                "url": "https://www.saborez.cl"
              }
            }),
          }}
        />
        <link rel="preconnect" href="https://kqanordhsmbtcwtjtrme.supabase.co" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://kqanordhsmbtcwtjtrme.supabase.co" />
        <CapacitorInit />
        <PwaUpdateNotifier />
        <AuthProvider>
          <LocationProvider>
            <NotificationProvider>
              <CartProvider>
                <OfflineSyncProvider>
                  {children}
                  <Footer />
                </OfflineSyncProvider>
                <CookieBanner />
              </CartProvider>
              <Toaster position="bottom-center" containerStyle={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)', zIndex: 100000 }} toastOptions={{ style: { zIndex: 100000 } }} />
            </NotificationProvider>
          </LocationProvider>
        </AuthProvider>
        {/* GA4: solo carga si la persona acepta las cookies analíticas en el aviso */}
        <ConsentAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID || "G-Q31E5NMWTK"} />
      </body>
    </html>
  );
}
