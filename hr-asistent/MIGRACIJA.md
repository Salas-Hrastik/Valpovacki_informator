# Migracija u zaseban repozitorij

Ovaj projekt je **potpuno samostalan** i privremeno se nalazi u repozitoriju
`Valpovacki_informator` samo zato što je radna sesija bila vezana uz njega.
Cilj je vlastiti repozitorij (npr. `Salas-Hrastik/Asistent_ljudskih_potencijala`),
kao kod asistenta *Počela gastronomije*.

> GitHub aplikacija koju koristi Claude **nema dopuštenje kreirati repozitorije**
> (403), pa prazan repozitorij mora kreirati vlasnik računa.

## Način A — uz Claudeovu pomoć (preporučeno)

1. Na GitHubu kreirajte **prazan** repozitorij (bez README-a):
   `Asistent_ljudskih_potencijala` (naziv po želji).
2. Dodijelite Claude GitHub aplikaciji pristup repozitoriju
   (GitHub → Settings → Applications → Claude → Repository access).
3. U Claude sesiji napišite:
   *„dodaj repozitorij Salas-Hrastik/Asistent_ljudskih_potencijala i pushaj projekt"*.
   Claude će pushati samostalnu verziju i očistiti ovu granu.

## Način B — ručno (iz ZIP arhive koju je Claude poslao)

```bash
unzip Asistent_ljudskih_potencijala.zip
cd Asistent_ljudskih_potencijala
git init -b main
git add -A
git commit -m "Početna verzija"
git remote add origin https://github.com/Salas-Hrastik/Asistent_ljudskih_potencijala.git
git push -u origin main
```

## Način C — ručno (iz ove grane, bez arhive)

```bash
git clone --branch claude/hr-ai-assistant-project-ytln26 \
  https://github.com/Salas-Hrastik/Valpovacki_informator.git tmp-informator
mkdir Asistent_ljudskih_potencijala
cp -r tmp-informator/hr-asistent/. Asistent_ljudskih_potencijala/
cd Asistent_ljudskih_potencijala
# CI workflow na standardno mjesto samostalnog repozitorija:
mkdir -p .github/workflows
cp ../tmp-informator/.github/workflows/hr-asistent-ci.yml .github/workflows/ci.yml
# u ci.yml zatim: maknite "paths" filtre, "working-directory: hr-asistent"
# i "cache-dependency-path" (vidi Način B — arhiva to već sadrži).
git init -b main && git add -A && git commit -m "Početna verzija"
git remote add origin https://github.com/Salas-Hrastik/Asistent_ljudskih_potencijala.git
git push -u origin main
```

Samostalna verzija (Način B) sadrži i sitne prilagodbe tekstova: CI na
`.github/workflows/ci.yml`, README bez monorepo napomena. Nakon uspješne
migracije ovu granu (`claude/hr-ai-assistant-project-ytln26`) slobodno obrišite.
