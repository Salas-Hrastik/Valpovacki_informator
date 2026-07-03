import type { Metadata, Viewport } from 'next';
import './globals.css';

// Apsolutna bazna adresa za kanonske i OG poveznice. Postavi NEXT_PUBLIC_SITE_URL
// na produkcijsku domenu; na Vercelu se inače koristi automatski VERCEL_URL.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);

const OPIS =
  'Edukativni AI asistent za menadžment ljudskih potencijala — odgovori, objašnjenja, ' +
  'sažeci i provjera znanja na temelju knjige Menadžment ljudskih potencijala.';

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: {
    default: 'Petra — AI asistentica ljudskih potencijala',
    template: '%s · Petra — AI asistentica ljudskih potencijala',
  },
  description: OPIS,
  applicationName: 'AI asistent ljudskih potencijala',
  keywords: [
    'ljudski potencijali', 'menadžment ljudskih potencijala', 'HRM', 'HR',
    'AI asistent', 'edukacija', 'selekcija', 'motivacija', 'analiza posla',
  ],
  authors: [{ name: 'AI asistent ljudskih potencijala' }],
  category: 'education',
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'hr_HR',
    siteName: 'Petra — AI asistentica ljudskih potencijala',
    title: 'Petra — AI asistentica ljudskih potencijala',
    description: OPIS,
    ...(siteUrl ? { url: siteUrl } : {}),
  },
  twitter: {
    card: 'summary',
    title: 'Petra — AI asistentica ljudskih potencijala',
    description: OPIS,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#16406b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hr">
      <body>{children}</body>
    </html>
  );
}
