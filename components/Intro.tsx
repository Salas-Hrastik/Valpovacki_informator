'use client';

/**
 * Naslov asistentice + skočni prozor s dobrodošlicom.
 *
 * Tekst dobrodošlice (uvodna poruka i potpis gradonačelnika) opširan je i
 * zakrčio bi početni zaslon, pa ga premještamo u skočni prozor (modal) koji se
 * otvara klikom na podnaslov „Valpovačka AI informatorica".
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
        <span className="page-title-name">Marica sveznalica</span>
        <button
          type="button"
          className="page-title-sub-link"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          title="Više o servisu"
        >
          Valpovačka AI informatorica
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
              Ovaj servis na tragu je nastojanja Gradske uprave i gradonačelnika Grada Valpova da
              građane što pravodobnije i kvalitetnije informiraju o svim pitanjima od njihovog
              interesa. Slobodno postavite pitanje o uslugama gradske uprave, natječajima,
              komunalnim temama, ustanovama i događanjima. Vaše sugestije bit će nam dragocjene u
              unapređenju AI informatora!
            </p>
            <p className="intro-modal-signature">Vaš gradonačelnik Matko</p>
          </div>
        </div>
      )}
    </>
  );
}
