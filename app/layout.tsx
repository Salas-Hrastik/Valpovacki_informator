import type { Metadata, Viewport } from 'next';
import './globals.css';

// Apsolutna bazna adresa za kanonske i OG poveznice. Postavi NEXT_PUBLIC_SITE_URL
// na produkcijsku domenu; na Vercelu se inače koristi automatski VERCEL_URL.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);

const OPIS =
  'Službeni AI asistent Grada Valpova — odgovori na pitanja građana o uslugama gradske ' +
  'uprave, natječajima, komunalnim temama, ustanovama i događanjima, na temelju javno ' +
  'dostupnih službenih izvora.';

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: {
    default: 'Valpovački AI gradski informator',
    template: '%s · Valpovački AI gradski informator',
  },
  description: OPIS,
  applicationName: 'Valpovački AI gradski informator',
  keywords: [
    'Valpovo', 'Grad Valpovo', 'gradska uprava', 'informator', 'AI asistent',
    'natječaji', 'komunalno', 'građani', 'usluge', 'Valpovština',
  ],
  authors: [{ name: 'Grad Valpovo' }],
  category: 'government',
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'hr_HR',
    siteName: 'Valpovački AI gradski informator',
    title: 'Valpovački AI gradski informator',
    description: OPIS,
    ...(siteUrl ? { url: siteUrl } : {}),
  },
  twitter: {
    card: 'summary',
    title: 'Valpovački AI gradski informator',
    description: OPIS,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1f4e79',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hr">
      <body>{children}</body>
    </html>
  );
}
