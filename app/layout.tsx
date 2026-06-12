import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Valpovački AI gradski informator',
  description:
    'Službeni AI asistent Grada Valpova — odgovori na pitanja građana na temelju javno dostupnih gradskih dokumenata.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hr">
      <body>{children}</body>
    </html>
  );
}
