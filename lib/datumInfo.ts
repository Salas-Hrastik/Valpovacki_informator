/**
 * Pomoćnici za info-traku u zaglavlju: hrvatski datum, imendan (katolički
 * kalendar) i blagdani (državni + katolički, uključujući pomične preko Uskrsa).
 *
 * Napomena: imendanski kalendar je opsežan i ponegdje varira po izvoru; ovo je
 * uobičajeni hrvatski katolički raspored (po jedno glavno ime na dan).
 */

const DANI = ['nedjelja', 'ponedjeljak', 'utorak', 'srijeda', 'četvrtak', 'petak', 'subota'];
const MJESECI_GEN = [
  'siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja',
  'srpnja', 'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca',
];

/** "subota, 20. lipnja 2026." */
export function formatDatumHr(d: Date): string {
  return `${DANI[d.getDay()]}, ${d.getDate()}. ${MJESECI_GEN[d.getMonth()]} ${d.getFullYear()}.`;
}

// Imendani po mjesecima (indeks = dan − 1). Po jedno glavno ime na dan.
const IMENDANI: Record<number, string[]> = {
  1: ['Marija', 'Bazilije', 'Genoveva', 'Anđela', 'Emilija', 'Gašpar i Baltazar', 'Rajko', 'Severin', 'Julijan', 'Agaton',
      'Higin', 'Tatjana', 'Veronika', 'Feliks', 'Pavao', 'Marcel', 'Antun', 'Margareta', 'Mario', 'Sebastijan',
      'Agneza', 'Vinko', 'Ildefonso', 'Franjo Saleški', 'Pavao', 'Timotej', 'Anđela', 'Toma', 'Valerije', 'Martina', 'Ivan'],
  2: ['Brigita', 'Marija', 'Blaž', 'Vjeko', 'Agata', 'Dorotea', 'Rikard', 'Jeronim', 'Apolonija', 'Skolastika',
      'Marija', 'Eulalija', 'Kristina', 'Valentin', 'Faustin', 'Julijana', 'Aleksije', 'Šimun', 'Konrad', 'Leon',
      'Petar', 'Margareta', 'Polikarp', 'Matija', 'Cezarije', 'Aleksandar', 'Gabrijel', 'Roman', 'Augustin'],
  3: ['Albin', 'Henrik', 'Kunigunda', 'Kazimir', 'Olivija', 'Fridolin', 'Felicita', 'Ivan', 'Franciska', 'Makarije',
      'Konstantin', 'Inocent', 'Kristina', 'Matilda', 'Klement', 'Hilarije', 'Patrik', 'Ćiril', 'Josip', 'Klaudija',
      'Nikola', 'Lea', 'Turibije', 'Katarina', 'Marija', 'Emanuel', 'Ruperto', 'Sikst', 'Bertold', 'Amadej', 'Benjamin'],
  4: ['Hugo', 'Franjo', 'Rikard', 'Izidor', 'Vinko', 'Celestin', 'Hosana', 'Dionizije', 'Marija', 'Ezekiel',
      'Stanislav', 'Julije', 'Martin', 'Tiburcije', 'Anastazija', 'Bernardica', 'Robert', 'Galdin', 'Leon', 'Teodor',
      'Anzelmo', 'Leonid', 'Juraj', 'Fidelis', 'Marko', 'Marija', 'Cita', 'Petar', 'Katarina', 'Pio'],
  5: ['Josip', 'Atanazije', 'Filip i Jakov', 'Florijan', 'Anđelo', 'Dominik', 'Gizela', 'Viktor', 'Beatrica', 'Antonin',
      'Mamerto', 'Pankracije', 'Marija', 'Bonifacije', 'Sofija', 'Ivan Nepomuk', 'Paskal', 'Erik', 'Ivo', 'Bernardin',
      'Konstantin', 'Rita', 'Deziderije', 'Marija', 'Magdalena', 'Filip Neri', 'Augustin', 'German', 'Maksimin', 'Ivana', 'Petronila'],
  6: ['Justin', 'Marcelin', 'Karlo', 'Kvirin', 'Bonifacije', 'Norbert', 'Robert', 'Medard', 'Efrem', 'Margareta',
      'Barnaba', 'Ivana', 'Antun', 'Elizej', 'Vid', 'Beno', 'Rajner', 'Marko', 'Romualdo', 'Silverije',
      'Alojzije', 'Toma More', 'Agripina', 'Ivan', 'Vilim', 'Vigilije', 'Ema', 'Irenej', 'Petar i Pavao', 'Emilijana'],
  7: ['Estera', 'Marija', 'Toma', 'Berta', 'Ćiril i Metod', 'Marija Goretti', 'Vilibald', 'Eugen', 'Veronika', 'Amalija',
      'Benedikt', 'Mohor', 'Joel', 'Kamilo', 'Bonaventura', 'Marija', 'Aleksije', 'Friderik', 'Vjekoslav', 'Ilija',
      'Danijel', 'Marija Magdalena', 'Brigita', 'Kristina', 'Jakov', 'Ana', 'Vladimir', 'Nazarije', 'Marta', 'Petar', 'Ignacije'],
  8: ['Alfonz', 'Euzebije', 'Lidija', 'Ivan Marija', 'Marija Snježna', 'Preobraženje', 'Kajetan', 'Dominik', 'Terezija', 'Lovro',
      'Klara', 'Ivana', 'Hipolit', 'Maksimilijan', 'Velika Gospa', 'Rok', 'Jacint', 'Jelena', 'Ivan', 'Bernard',
      'Pio', 'Marija Kraljica', 'Ruža', 'Bartol', 'Ljudevit', 'Zefirin', 'Monika', 'Augustin', 'Ivan Krstitelj', 'Feliks', 'Rajmund'],
  9: ['Egidije', 'Stjepan', 'Grgur', 'Rozalija', 'Lovro', 'Zaharija', 'Regina', 'Mala Gospa', 'Petar', 'Nikola',
      'Prot', 'Marija', 'Ivan', 'Križevo', 'Marija', 'Kornelije', 'Hildegarda', 'Josip', 'Januarije', 'Eustahije',
      'Matej', 'Mauricije', 'Padre Pio', 'Gerard', 'Aurelija', 'Kuzma i Damjan', 'Vinko', 'Vjenceslav', 'Mihael', 'Jeronim'],
  10: ['Terezija', 'Anđeli čuvari', 'Ewald', 'Franjo', 'Faustina', 'Bruno', 'Marija', 'Brigita', 'Dionizije', 'Danijel',
       'Filip', 'Maksimilijan', 'Eduard', 'Kalist', 'Terezija', 'Hedviga', 'Ignacije', 'Luka', 'Pavao', 'Vendelin',
       'Uršula', 'Ivan Pavao', 'Ivan Kapistran', 'Antun', 'Darija', 'Dimitrije', 'Sabina', 'Šimun i Juda', 'Narcis', 'Alfonz', 'Lucila'],
  11: ['Svi sveti', 'Dušni dan', 'Silvije', 'Karlo', 'Zaharija', 'Lenart', 'Engelbert', 'Bogdan', 'Gotfrid', 'Lav',
       'Martin', 'Josafat', 'Stanislav', 'Nikola Tavelić', 'Leopold', 'Gertruda', 'Elizabeta', 'Roman', 'Matilda', 'Feliks',
       'Marija', 'Cecilija', 'Klement', 'Flora', 'Katarina', 'Konrad', 'Virgilije', 'Jakov', 'Saturnin', 'Andrija'],
  12: ['Natalija', 'Bibijana', 'Franjo Ksaverski', 'Barbara', 'Saba', 'Nikola', 'Ambrozije', 'Marija', 'Valerija', 'Marija',
       'Damaz', 'Ivana', 'Lucija', 'Ivan', 'Kristijana', 'Adelajda', 'Lazar', 'Gracijan', 'Urban', 'Bogoljub',
       'Petar', 'Franciska', 'Ivan', 'Adam i Eva', 'Božić', 'Stjepan', 'Ivan', 'Nevina dječica', 'David', 'Eugen', 'Silvestar'],
};

/** Imendan za zadani datum (ili prazno ako nije u kalendaru). */
export function imendanZa(d: Date): string {
  return IMENDANI[d.getMonth() + 1]?.[d.getDate() - 1] ?? '';
}

// Fiksni blagdani (državni + glavni katolički). Ključ: "MM-DD".
const BLAGDANI_FIKSNI: Record<string, string> = {
  '01-01': 'Nova godina',
  '01-06': 'Sveta tri kralja',
  '03-19': 'Sv. Josip',
  '05-01': 'Praznik rada',
  '05-30': 'Dan državnosti',
  '06-22': 'Dan antifašističke borbe',
  '06-29': 'Sv. Petar i Pavao',
  '08-05': 'Dan pobjede i domovinske zahvalnosti',
  '08-15': 'Velika Gospa',
  '11-01': 'Svi sveti',
  '11-18': 'Dan sjećanja na žrtve Domovinskog rata',
  '12-08': 'Bezgrešno začeće',
  '12-25': 'Božić',
  '12-26': 'Sveti Stjepan',
};

/** Uskrs (Gregorijanski kalendar, Meeusov algoritam). */
function uskrs(godina: number): Date {
  const a = godina % 19;
  const b = Math.floor(godina / 100);
  const c = godina % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mjesec = Math.floor((h + l - 7 * m + 114) / 31);
  const dan = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(godina, mjesec - 1, dan);
}

const isti = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Blagdan za zadani datum (državni ili katolički), ili prazno. */
export function blagdanZa(d: Date): string {
  const kljuc = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (BLAGDANI_FIKSNI[kljuc]) return BLAGDANI_FIKSNI[kljuc];

  const u = uskrs(d.getFullYear());
  const dodaj = (dana: number) => new Date(u.getFullYear(), u.getMonth(), u.getDate() + dana);
  if (isti(d, u)) return 'Uskrs';
  if (isti(d, dodaj(1))) return 'Uskrsni ponedjeljak';
  if (isti(d, dodaj(60))) return 'Tijelovo';
  return '';
}
