import type { Metadata } from 'next';
import Chat from '@/components/Chat';

/**
 * /widget — kompaktna inačica chata za ugradnju na vanjsko web sjedište
 * putem iframea (vidi public/widget.js i upute u README-u).
 * CSP zaglavlje frame-ancestors definirano je u next.config.mjs.
 */
export const metadata: Metadata = {
  // Embed inačica se ne indeksira (izbjegavamo dvostruki sadržaj u tražilicama).
  robots: { index: false, follow: false },
};

export default function WidgetPage() {
  return (
    <main className="page page-widget">
      <Chat />
    </main>
  );
}
