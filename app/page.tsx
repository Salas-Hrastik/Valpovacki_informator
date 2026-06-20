import Chat from '@/components/Chat';
import HeaderInfo from '@/components/HeaderInfo';

export default function HomePage() {
  return (
    <main className="page">
      <header className="page-header">
        <HeaderInfo />
        {/* Statična SVG ikona logotipa — next/image nije potreban; eslint-disable za <img>. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/grb-valpovo.svg"
          alt="Grad Valpovo — City of Valpovo"
          className="page-logo"
          width={816}
          height={235}
        />
        <h1>Valpovački AI gradski informator</h1>
        <p>
          Dobro došli! Ovaj servis na tragu je nastojanja Gradske uprave i gradonačelnika
          Grada Valpova da građane što pravodobnije i kvalitetnije informiraju o svim pitanjima
          od njihovog interesa. Slobodno postavite pitanje o uslugama gradske uprave,
          natječajima, komunalnim temama, ustanovama i događanjima. Vaše sugestije bit će nam
          dragocjene u unapređenju AI informatora!
        </p>
        <p className="page-signature">Vaš gradonačelnik Matko</p>
      </header>
      <Chat />
    </main>
  );
}
