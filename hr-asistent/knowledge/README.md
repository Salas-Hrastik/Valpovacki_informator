# Mapa znanja — knjiga

U ovu mapu stavite sadržaj knjige **Menadžment ljudskih potencijala** na kojoj
asistentica temelji odgovore. Podržani formati:

| Format | Napomena |
|---|---|
| `.pdf` | Mora imati **tekstualni sloj** (tekst se može označiti mišem). Skenirane knjige prije ingestije provucite kroz OCR, npr. `ocrmypdf -l hrv ulaz.pdf izlaz.pdf` ili Adobe Acrobat. |
| `.md` | Preporučeno za najbolju kvalitetu: naslovi `#`/`##`/`###` postaju odjeljci (poglavlja). |
| `.txt` | Poglavlja se prepoznaju heuristički (numerirani naslovi / VELIKA SLOVA). |

Datoteka može biti jedna (cijela knjiga) ili više njih (npr. poglavlje po
datoteci — nazivi datoteka određuju redoslijed, pa koristite prefikse
`01-`, `02-`…).

## Postupak

1. Kopirajte knjigu ovdje (npr. `knowledge/menadzment-ljudskih-potencijala.pdf`).
2. Provjerite kako je knjiga podijeljena na odjeljke (bez upisa u bazu):
   ```bash
   npm run ingest -- --dry-run
   ```
3. Pokrenite indeksiranje:
   ```bash
   npm run ingest
   ```

> **Autorska prava:** knjiga je zaštićeno djelo — u javni repozitorij NE
> commitajte sadržaj knjige bez dopuštenja nositelja prava. Ova mapa je za
> lokalnu/privatnu upotrebu; `.gitignore` po potrebi dopunite pravilom
> `knowledge/*.pdf`.
