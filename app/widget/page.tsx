import Chat from '@/components/Chat';

/**
 * /widget — kompaktna inačica chata za ugradnju na gradsko web sjedište
 * putem iframea (vidi public/widget.js i upute u README-u).
 * CSP zaglavlje frame-ancestors definirano je u next.config.mjs.
 */
export default function WidgetPage() {
  return (
    <main className="page page-widget">
      <Chat />
    </main>
  );
}
