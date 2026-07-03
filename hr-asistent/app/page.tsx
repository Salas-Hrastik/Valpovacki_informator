import Chat from '@/components/Chat';
import HeaderInfo from '@/components/HeaderInfo';
import Intro from '@/components/Intro';

export default function HomePage() {
  return (
    <main className="page">
      <header className="page-header">
        <HeaderInfo />
        {/* Statična SVG ikona logotipa — next/image nije potreban; eslint-disable za <img>. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-ljudski-potencijali.svg"
          alt="AI asistent ljudskih potencijala"
          className="page-logo"
          width={640}
          height={180}
        />
        {/* Naslov + skočni prozor s dobrodošlicom (klik na podnaslov). */}
        <Intro />
      </header>
      <Chat />
    </main>
  );
}
