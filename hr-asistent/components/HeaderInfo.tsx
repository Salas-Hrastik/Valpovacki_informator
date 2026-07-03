'use client';

/**
 * Info-traka u zaglavlju: "Danas je <dan, datum> · <blagdan> · Imendan: <ime>".
 * Datum/imendan/blagdan računaju se na klijentu (lokalno vrijeme).
 */
import { useEffect, useState } from 'react';
import { formatDatumHr, imendanZa, blagdanZa } from '@/lib/datumInfo';

interface DatumInfo {
  datum: string;
  imendan: string;
  blagdan: string;
}

export default function HeaderInfo() {
  const [info, setInfo] = useState<DatumInfo | null>(null);

  // Datum/imendan/blagdan tek nakon montiranja (izbjegava neslaganje SSR/CSR).
  useEffect(() => {
    const now = new Date();
    setInfo({ datum: formatDatumHr(now), imendan: imendanZa(now), blagdan: blagdanZa(now) });
  }, []);

  if (!info) return null;

  return (
    <div className="datum-info" aria-label="Današnji datum i informacije">
      Danas je <strong>{info.datum}</strong>
      {info.blagdan && (
        <span>
          {' · '}
          <strong>{info.blagdan}</strong>
        </span>
      )}
      {info.imendan && <span> · Imendan: {info.imendan}</span>}
    </div>
  );
}
