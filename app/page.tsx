import Chat from '@/components/Chat';

export default function HomePage() {
  return (
    <main className="page">
      <header className="page-header">
        <h1>Valpovački AI gradski informator</h1>
        <p>
          Postavite pitanje o uslugama gradske uprave, natječajima, komunalnim temama i
          događanjima u Gradu Valpovu i pripadajućim naseljima.
        </p>
      </header>
      <Chat />
    </main>
  );
}
