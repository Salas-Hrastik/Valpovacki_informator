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

// Imendani po mjesecima (indeks = dan − 1). Do tri uobičajena imena po danu
// (hrvatski katolički kalendar). Izvori ponegdje variraju; prvo je ime glavno.
const IMENDANI: Record<number, string[]> = {
  1: ['Marija, Marijan, Marin', 'Bazilije, Makarije, Gita', 'Genoveva, Gordana, Danica', 'Anđela, Anđelko, Tito',
      'Emilija, Milan, Simeon', 'Gašpar, Melkior i Baltazar, Bogdan', 'Rajko, Lucijan, Valentin', 'Severin, Teofil, Mladen',
      'Julijan, Marijan, Marcelin', 'Agaton, Vilim, Aldo', 'Higin, Pavao, Teodozije', 'Tatjana, Ernest, Cezarija',
      'Veronika, Hilarije, Gita', 'Feliks, Oton, Nina', 'Pavao, Mauro, Ivan', 'Marcel, Honorat, Maro',
      'Antun, Antonija, Roza', 'Margareta, Priska, Liberata', 'Mario, Marta, Henrik', 'Sebastijan, Fabijan, Bože',
      'Agneza, Janja, Neva', 'Vinko, Vinka, Anastazije', 'Ildefonso, Emerencijana, Roman', 'Franjo Saleški, Vera, Felicija',
      'Pavao, Tea, Ananija', 'Timotej, Tit, Paula', 'Anđela, Marija, Julijan', 'Toma Akvinski, Petar, Valerije',
      'Valerije, Konstancije, Sava', 'Martina, Hijacinta, Savina', 'Ivan Bosco, Marcela, Ljudevit'],
  2: ['Brigita, Ignacije, Verdijana', 'Marija, Korona, Teofil', 'Blaž, Oskar, Ivan', 'Vjekoslav, Andrija, Gilberta',
      'Agata, Ingrid, Avito', 'Dorotea, Tit, Pavao', 'Rikard, Teodor, Egidije', 'Jeronim, Honorat, Stjepan',
      'Apolonija, Mansvet, Nikon', 'Skolastika, Silvan, Viktor', 'Marija Lurdska, Saturnin, Deziderije', 'Eulalija, Damjan, Modest',
      'Kristina, Jordan, Benigno', 'Valentin, Ciril i Metod, Zdenko', 'Faustin, Jovita, Georgija', 'Julijana, Onezim, Lucila',
      'Aleksije, Julijan, Donat', 'Šimun, Bernadica, Flavijan', 'Konrad, Gabin, Mansvet', 'Leon, Eleuterije, Maksimilijan',
      'Petar Damiani, Eleonora, Irena', 'Margareta, Petar, Polikarp', 'Polikarp, Roman, Serenko', 'Matija, Sergije, Modest',
      'Cezarije, Valburga, Viktorin', 'Aleksandar, Porfirije, Nestor', 'Gabrijel, Leandar, Aleksandar', 'Roman, Antonija, Honorina',
      'Augustin, Ilarije, Osvald'],
  3: ['Albin, Antonina, David', 'Henrik, Simplicije, Anđelka', 'Kunigunda, Tea, Marin', 'Kazimir, Lucije, Arkadije',
      'Olivija, Fridolin, Teofil', 'Fridolin, Roza, Koleta', 'Felicita, Perpetua, Tomislav', 'Ivan, Beata, Filemon',
      'Franciska, Katarina, Dominik', 'Makarije, Atalija, Emil', 'Konstantin, Eulogije, Sofronije', 'Inocent, Doroteja, Maksimilijan',
      'Kristina, Patricija, Eufrazija', 'Matilda, Florentina, Boniface', 'Klement, Ludovika, Longin', 'Hilarije, Cirijak, Agapit',
      'Patrik, Gertruda, Jedrt', 'Ćiril, Edvard, Salvator', 'Josip, Bojan, Sibilina', 'Klaudija, Volfram, Aleksandra',
      'Nikola, Serapion, Fabiola', 'Lea, Oktavijan, Katarina', 'Turibije, Viktorijan, Oktavijan', 'Katarina, Gabrijel, Marko',
      'Marija, Dizma, Humbert', 'Emanuel, Kastul, Ludger', 'Ruperto, Lidija, Aleksandar', 'Sikst, Gvido, Roza',
      'Bertold, Eustazije, Sekundo', 'Amadej, Kvirin, Leonardo', 'Benjamin, Gvido, Balbina'],
  4: ['Hugo, Venancije, Irena', 'Franjo Paolski, Marija, Teodozija', 'Rikard, Sikst, Irena', 'Izidor, Benedikt, Zosim',
      'Vinko Ferreri, Irena, Julijana', 'Celestin, Vilim, Notker', 'Hosana, Ivan Krstitelj, Herman', 'Dionizije, Valter, Julija',
      'Marija, Demetrije, Valtruda', 'Ezekiel, Terencije, Mihej', 'Stanislav, Lav, Gema', 'Julije, Zenon, Saba',
      'Martin, Ida, Hermenegild', 'Tiburcije, Lambert, Justin', 'Anastazija, Telmo, Olimpija', 'Bernardica, Benedikt, Turibije',
      'Robert, Rudolf, Aniceto', 'Galdin, Apolonije, Eleuterije', 'Leon, Werner, Emo', 'Teodor, Sulpicije, Hilarije',
      'Anzelmo, Konrad, Apolon', 'Leonid, Aleksandra, Kajo', 'Juraj, Adalbert, Vojko', 'Fidelis, Marija, Benedikt',
      'Marko, Ervin, Anijan', 'Marija, Klet, Trudpert', 'Cita, Hozana, Petar', 'Petar Chanel, Ljudevit, Valerija',
      'Katarina Sienska, Robert, Hugo', 'Pio, Katarina, Sofija'],
  5: ['Josip Radnik, Jeremija, Sigismund', 'Atanazije, Boris, Cezarije', 'Filip i Jakov, Aleksandar, Ventura', 'Florijan, Cvjetko, Silvan',
      'Anđelo, Gotard, Irena', 'Dominik Savio, Benedikta, Valerijan', 'Gizela, Stanislav, Flavija', 'Viktor, Bonifacije, Ida',
      'Beatrica, Bonifacije, Katarina', 'Antonin, Izidor, Job', 'Pankracije, Mamerto, Estela', 'Pankracije, Leopold, Nereo',
      'Marija Fatimska, Servacije, Robert', 'Bonifacije, Matija, Petronije', 'Sofija, Izidor, Žofija', 'Ivan Nepomuk, Ubald, Brunon',
      'Paskal, Bruno, Solohon', 'Erik, Feliks, Ivan', 'Ivo, Petar Celestin, Krispin', 'Bernardin, Talija, Teofil',
      'Konstantin, Andrija, Timotej', 'Rita, Julija, Emil', 'Deziderije, Ivan, Julija', 'Marija Pomoćnica, Vinko, Suzana',
      'Magdalena, Grgur, Beda', 'Filip Neri, Maro, Eleuterije', 'Augustin, German, Julije', 'German, Emil, Vilim',
      'Maksimin, Bona, Teodozija', 'Ivana Orleanska, Ferdinand, Bosgan', 'Marijino pohođenje, Petronila, Anđela'],
  6: ['Justin, Pamfil, Konrad', 'Marcelin, Petar, Eugen', 'Karlo, Klotilda, Kevin', 'Kvirin, Franjo, Klara',
      'Bonifacije, Valerija, Igor', 'Norbert, Bertrand, Klaudije', 'Robert, Sabinijan, Ana', 'Medard, Vilim, Severin',
      'Efrem, Primož, Felicijan', 'Margareta, Bogumil, Dijana', 'Barnaba, Feliks, Roza', 'Ivana, Onufrije, Pavao',
      'Antun Padovanski, Ante, Marina', 'Elizej, Valerije, Anastazije', 'Vid, Vido, Germana', 'Beno, Gvido, Aurora',
      'Rajner, Albert, Adolf', 'Marko, Marcijan, Gregor', 'Romualdo, Marko, Gervazije', 'Silverije, Florentina, Adalbert',
      'Alojzije, Vjera, Demetrije', 'Toma More, Paulin, Ahacije', 'Agripina, Edeltruda, Zlatko', 'Ivan Krstitelj, Ivan, Ivana',
      'Vilim, Prosper, Oroslav', 'Vigilije, Ivan i Pavao, Hema', 'Ema, Ladislav, Cirilo', 'Irenej, Marcela, Ladislav',
      'Petar i Pavao, Petra, Pavla', 'Emilijana, Lucina, Vital'],
  7: ['Estera, Oliver, Teodorik', 'Marija, Othon, Vital', 'Toma apostol, Anatolije, Leon', 'Berta, Urh, Elizabeta',
      'Ćiril i Metod, Antun Zaccaria, Filomena', 'Marija Goretti, Izaija, Tomislav', 'Vilibald, Klaudije, Ciril', 'Eugen, Kilijan, Edgar',
      'Veronika, Augustin, Adrijan', 'Amalija, Felicita, Rufina', 'Benedikt, Olga, Pio', 'Mohor i Fortunat, Ivan, Nabor',
      'Joel, Henrik, Eugen', 'Kamilo, Bonaventura, Franjo', 'Bonaventura, Vladimir, Donald', 'Marija Karmelska, Karmen, Vitalijan',
      'Aleksije, Marcelina, Leon', 'Friderik, Arnold, Emilijan', 'Vjekoslav, Arsenije, Simah', 'Ilija, Margareta, Elizej',
      'Danijel, Lovro, Prakseda', 'Marija Magdalena, Magda, Verdijana', 'Brigita, Apolinar, Žiža', 'Kristina, Boris, Frano',
      'Jakov, Krištof, Valentina', 'Ana i Joakim, Ana, Jakica', 'Vladimir, Gajo, Natalija', 'Nazarije, Viktor, Samson',
      'Marta, Lazar, Beatrica', 'Petar Krizolog, Rufin, Ignacije', 'Ignacije Lojolski, German, Helena'],
  8: ['Alfonz, Petar, Vera', 'Euzebije, Marija, Stjepan', 'Lidija, Stjepan, Nikodem', 'Ivan Marija Vianney, Dominik, Perpetua',
      'Marija Snježna, Osvald, Emidije', 'Preobraženje Isusovo, Sikst, Oktavijan', 'Kajetan, Donat, Sikst', 'Dominik, Emilijan, Ciprijan',
      'Terezija Benedikta, Roman, Sekund', 'Lovro, Lovrenko, Asterije', 'Klara, Suzana, Filomena', 'Ivana Šantalska, Klara, Hilarija',
      'Hipolit, Poncijan, Kasijan', 'Maksimilijan Kolbe, Euzebije, Alfred', 'Velika Gospa, Marija, Tarsicije', 'Rok, Stjepan, Joakim',
      'Jacint, Liberat, Marijan', 'Jelena, Lena, Agapit', 'Ivan Eudes, Ljudevit, Sebald', 'Bernard, Samuel, Filiberto',
      'Pio X., Ivana, Baldovin', 'Marija Kraljica, Sigfrid, Fabricijan', 'Ruža Limska, Filip, Sigfrid', 'Bartol, Jure, Emilija',
      'Ljudevit, Patricija, Josip', 'Zefirin, Bregita, Aleksandar', 'Monika, Cezarije, Rufo', 'Augustin, Jasna, Hermes',
      'Ivan Krstitelj, Sabina, Adolf', 'Feliks, Gaudencija, Roza', 'Rajmund, Pavlin, Aristid'],
  9: ['Egidije, Tilo, Verena', 'Stjepan, Maksima, Antonin', 'Grgur Veliki, Doroteja, Zeno', 'Rozalija, Ida, Mojsije',
      'Lovro, Albert, Viktorin', 'Zaharija, Eva, Petronije', 'Regina, Marko, Grato', 'Mala Gospa, Marija, Sergije',
      'Petar Klaver, Gorgonije, Sergije', 'Nikola Tolentinski, Pulkerija, Otokar', 'Prot i Jacint, Emilijan, Danijel', 'Marijino ime, Gvido, Tacijan',
      'Ivan Zlatousti, Notburga, Amat', 'Uzvišenje sv. Križa, Just, Marin', 'Marija Žalosna, Dolores, Katarina', 'Kornelije i Ciprijan, Ljudmila, Eufemija',
      'Hildegarda, Robert, Lambert', 'Josip Kupertinski, Ariadna, Irena', 'Januarije, Suzana, Konstancije', 'Andrija Kim, Eustahije, Fausta',
      'Matej apostol, Mato, Jonas', 'Mauricije, Emil, Ivan', 'Padre Pio, Tekla, Konstancije', 'Gerard, Pacifik, Rupert',
      'Aurelija, Kleofa, Pacifik', 'Kuzma i Damjan, Justina, Nil', 'Vinko Paulski, Adolf, Florentin', 'Vjenceslav, Salomon, Lioba',
      'Mihael, Gabrijel i Rafael, Mihovil', 'Jeronim, Sofija, Honorije'],
  10: ['Terezija od Djeteta Isusa, Remigije, Bavo', 'Anđeli čuvari, Leodegar, Teofil', 'Ewald, Gerard, Kandid', 'Franjo Asiški, Petronije, Aurea',
       'Faustina, Donat, Placid', 'Bruno, Renato, Marija', 'Marija Krunična, Justina, Sergije', 'Brigita, Pelagija, Demetrije',
       'Dionizije, Abraham, Ivan', 'Danijel, Franjo, Paulin', 'Filip, Firmin, German', 'Maksimilijan, Serafin, Edvin',
       'Eduard, Koleman, Venancije', 'Kalist, Gaudencije, Dominik', 'Terezija Avilska, Roman, Tekla', 'Hedviga, Gal, Margareta',
       'Ignacije Antiohijski, Margareta, Rudolf', 'Luka evanđelist, Julijan, Just', 'Pavao od Križa, Laura, Petar', 'Vendelin, Irena, Adelina',
       'Uršula, Hilarion, Celina', 'Marija Saloma, Donat, Korduela', 'Ivan Kapistran, Josip, Severin', 'Antun Klaret, Rafael, Marin',
       'Darija i Krizant, Aretas, Florencije', 'Dimitrije, Lucijan, Roza', 'Sabina, Vincencije, Florencije', 'Šimun i Juda Tadej, Anastazija, Faro',
       'Narcis, Ermelinda, Zenobije', 'Alfonz, German, Marcel', 'Lucila, Volfgang, Antonin'],
  11: ['Svi sveti, Cezarije, Benigno', 'Dušni dan, Viktorin, Marcijan', 'Silvije, Martin, Huberт', 'Karlo Boromejski, Vital, Modesta',
       'Zaharija i Elizabeta, Slavko, Bertila', 'Lenart, Leonardo, Sever', 'Engelbert, Ernest, Vilibrord', 'Bogdan, Godfrid, Deusdedit',
       'Posveta lateranske bazilike, Teodor, Božidar', 'Lav Veliki, Andrija, Tripun', 'Martin Tourski, Mladen, Bartol', 'Josafat, Emilijan, Renato',
       'Stanislav Kostka, Eugen, Nikola', 'Nikola Tavelić, Lovro, Veneranda', 'Leopold, Albert, Artur', 'Gertruda, Edmund, Marija',
       'Elizabeta Ugarska, Grgur, Hilda', 'Posveta bazilika sv. Petra i Pavla, Odo, Roman', 'Matilda, Roman, Stanko', 'Feliks, Edmund, Ksaver',
       'Prikazanje BDM, Marija, Rufo', 'Cecilija, Filomen, Maur', 'Klement, Felicita, Kolumban', 'Flora, Krizogon, Firmina',
       'Katarina Aleksandrijska, Erazmo, Mojsije', 'Konrad, Leonard, Bilhildis', 'Virgilije, Leonard, Silvester', 'Jakov, Gustav, Valerijan',
       'Saturnin, Filomen, Berta', 'Andrija apostol, Andrija, Justina'],
  12: ['Natalija, Eligije, Florencije', 'Bibijana, Aurelija, Pavla', 'Franjo Ksaverski, Kasijan, Sofonija', 'Barbara, Varvara, Ivan',
       'Saba, Krispina, Ada', 'Nikola, Niko, Asela', 'Ambrozije, Marija, Agaton', 'Bezgrešno začeće BDM, Marija, Romarik', 'Valerija, Petar, Ana',
       'Loretska Gospa, Julija, Melkijad', 'Damaz, Danijel, Sabin', 'Ivana Šantalska, Aleksandar, Dijana', 'Lucija, Otilija, Ota',
       'Ivan od Križa, Nikazije, Spiridon', 'Kristijana, Valerijan, Nina', 'Adelajda, Albina, Estera', 'Lazar, Olimpija, Florijan',
       'Gracijan, Vunibald, Bazilijan', 'Urban, Darije, Gaj', 'Bogoljub, Eugen, Makarije', 'Petar Kanizije, Severin, Glicerije',
       'Franciska Cabrini, Demetrije, Honorat', 'Ivan Kety, Viktorija, Servul', 'Adam i Eva, Irmina, Tarsila', 'Božić — Isusovo rođenje, Eugenija, Anastazija',
       'Stjepan prvomučenik, Dionizije, Zosim', 'Ivan apostol, Ivan, Fabiola', 'Nevina dječica, Antonije, Domna', 'David, Toma, Vilibald',
       'Eugen, Liberije, Sabin', 'Silvestar, Silvije, Melanija'],
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
