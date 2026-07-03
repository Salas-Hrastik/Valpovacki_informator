'use client';

/**
 * Naslov asistentice + skočni prozor s dobrodošlicom.
 *
 * Tekst dobrodošlice (namjena servisa i način rada) opširan je i zakrčio bi
 * početni zaslon, pa ga premještamo u skočni prozor (modal) koji se otvara
 * klikom na podnaslov „AI asistentica ljudskih potencijala".
 */
import { useEffect, useState } from 'react';

export default function Intro() {
  const [open, setOpen] = useState(false);

  // Zatvaranje skočnog prozora tipkom Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <h1 className="page-title">
        <span className="page-title-name">Petra</span>
        <button
          type="button"
          className="page-title-sub-link"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          title="Više o servisu"
        >
          AI asistentica ljudskih potencijala
        </button>
      </h1>

      {open && (
        <div
          className="sources-modal-backdrop"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            className="sources-modal intro-modal"
            role="dialog"
            aria-modal="true"
            aria-label="O servisu"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sources-modal-head">
              <strong>Dobro došli!</strong>
              <button
                type="button"
                className="sources-modal-close"
                onClick={() => setOpen(false)}
                aria-label="Zatvori"
              >
                ✕
              </button>
            </div>
            <p>
              Ovaj edukativni servis pomaže studentima, polaznicima i praktičarima u učenju
              menadžmenta ljudskih potencijala. Odgovaram isključivo na temelju knjige
              <strong> Menadžment ljudskih potencijala</strong> — mogu objasniti pojmove, sažeti
              poglavlja, usporediti metode i provjeriti Vaše znanje (recite npr. „ispitaj me iz
              motivacije&rdquo;). Vaše sugestije bit će nam dragocjene u unapređenju asistentice!
            </p>
            <p className="intro-modal-signature">Vaša Petra</p>
          </div>
        </div>
      )}
    </>
  );
}
