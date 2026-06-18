import Chat from '@/components/Chat';

export default function HomePage() {
  return (
    <main className="page">
      <header className="page-header">
        {/* Statična SVG ikona logotipa — next/image nije potreban; eslint-disable za <img>. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/grb-valpovo.svg"
          alt="Grad Valpovo — City of Valpovo"
          className="page-logo"
          width={452}
          height={120}
        />
        <h1>Valpovački AI gradski informator</h1>
        <p>
          Dobro došli! Ovaj servis nastojanje je Gradske uprave i gradonačelnika Grada Valpova
          da građane što pravodobnije i kvalitetnije informiraju o svim pitanjima od interesa
          za žitelje Valpova i prigradskih naselja. Slobodno postavite pitanje o uslugama
          gradske uprave, natječajima, komunalnim temama, ustanovama i događanjima.
        </p>
        <p className="page-signature">Vaš gradonačelnik Matko</p>
      </header>
      <Chat />
    </main>
  );
}
