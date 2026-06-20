'use client';

/**
 * Info-traka u zaglavlju: "Danas je <dan, datum> · <temperatura> · <blagdan> ·
 * Imendan: <ime>". Datum/imendan/blagdan računaju se na klijentu (lokalno
 * vrijeme), a temperatura se dohvaća s Open-Meteo (besplatno, bez ključa).
 */
import { useEffect, useState } from 'react';
import { formatDatumHr, imendanZa, blagdanZa } from '@/lib/datumInfo';

// Grad Valpovo (približne koordinate)
const VALPOVO = { lat: 45.66, lon: 18.42 };

interface DatumInfo {
  datum: string;
  imendan: string;
  blagdan: string;
}

export default function HeaderInfo() {
  const [info, setInfo] = useState<DatumInfo | null>(null);
  const [temp, setTemp] = useState<number | null>(null);

  // Datum/imendan/blagdan tek nakon montiranja (izbjegava neslaganje SSR/CSR).
  useEffect(() => {
    const now = new Date();
    setInfo({ datum: formatDatumHr(now), imendan: imendanZa(now), blagdan: blagdanZa(now) });
  }, []);

  // Trenutna temperatura za Valpovo.
  useEffect(() => {
    let alive = true;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${VALPOVO.lat}&longitude=${VALPOVO.lon}&current=temperature_2m`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('weather'))))
      .then((d: { current?: { temperature_2m?: number } }) => {
        const t = d?.current?.temperature_2m;
        if (alive && typeof t === 'number') setTemp(Math.round(t));
      })
      .catch(() => {
        /* vrijeme nedostupno — traka radi i bez temperature */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;

  return (
    <div className="datum-info" aria-label="Današnji datum i informacije">
      Danas je <strong>{info.datum}</strong>
      {temp !== null && <span> · {temp} °C</span>}
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
