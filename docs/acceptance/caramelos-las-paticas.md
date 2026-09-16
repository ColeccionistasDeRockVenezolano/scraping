# Aceptación — Escenario "Caramelos de Cianuro · Las Paticas De La Abuela"

> Escenario flagship de aceptación (F2, con extensión F5 en §4). Usa **solo
> datos reales** del `YT Master Spreadsheet.xlsx`. Las 16 filas de Caramelos
> De Cianuro del archivo (órdenes: 28, 32, 36, 53, 93, 100, 121, 308, 319,
> 349, 370, 404, 423, 527, 553, 564) son el fixture de entrada.
>
> Fixture y conteos re-verificados programáticamente contra el XLSX el
> 2026-09-07: 16 filas, 14 de tipo álbum (14 títulos distintos) y 2 de tipo
> `Live Concert`.

---

## 1. Datos de entrada relevantes (verbatim del XLSX)

| Upload Order | Album Name | Year | Type of Album | URL | Status |
|---|---|---|---|---|---|
| 28 | Las Paticas De La Abuela | 1992 | EP | watch?v=Q-pRpO2sYSI&t=11s | — |
| 32 | Cuentos Para Adultos | 1993 | Studio Album | watch?v=SDk8WO1f_qY&t=13s | — |
| 36 | Harakiri City | 1996 | Studio Album | watch?v=0EDnetbiEwA&t=1s | — |
| 53 | B-Side: Harakiri City | 1996 | B-Sides | watch?v=KLXp1um-404 | — |
| 93 | Miss Mujerzuela | 2000 | Studio Album | watch?v=wnnS3TGV_6I&t=12s | — |
| 100 | B-Sides: Miss Mujerzuela | 2000 | B-Sides | watch?v=Pasy_1BfLxo | — |
| 121 | Frisbee | 2002 | Studio Album | watch?v=4I1MR8hEWXU&t=55s | — |
| 308 | Flor De Fuego | 2006 | Studio Album | watch?v=OU6GuTigygM | — |
| 319 | La Historia: Grandes Éxitos | 2004 | Compilation Album | watch?v=a5PKDT79JfM | — |
| 349 | 2 Lados B | 2011 | Studio Album | watch?v=dEqq-ux0dOM | — |
| 370 | En Vivo | 2009 | Live Album | watch?v=Yk9qA6F0XB0 | — |
| 404 | Rubia Sol Morena Luna | 2010 | Single | watch?v=iYFypjtOxzM | — |
| 423 | Caramelos De Cianuro | 2010 | Studio Album | watch?v=zxsw8j3hHFA | — |
| 527 | 8 | 2015 | Studio Album | watch?v=RFWjCxf-BK8&t=408s&pp=… | — |
| 553 | En Vivo | 2009 | Live Concert | youtu.be/1ij7EFYxRlc | — |
| 564 | Live Sessions At Equilibrio.Net | 2010 | Live Concert | youtu.be/CI31AGZQe0c | — |

---

## 2. Criterios de aceptación (todos obligatorios)

### A. Identidad única del artista
1. Existe **exactamente 1** fila en `artists` con `name = 'Caramelos De
   Cianuro'` y `artist_type = 'band'`, `origin_country = 'Venezuela'`
   (default del core).
2. No existe variante duplicada del nombre (ni con distinto case ni con
   tildes: 'Caramelos De Cianuro' == 'Caramelos de Cianuro' para el resolver).

### B. Álbum insignia: Las Paticas De La Abuela
3. Existe **exactamente 1** fila en `albums` con `artist_id` = el de (A),
   `title = 'Las Paticas De La Abuela'`, `release_year = 1992`,
   `album_type = 'ep'`.
4. `youtube_url` del álbum = `https://www.youtube.com/watch?v=Q-pRpO2sYSI`
   (URL canónica **sin** `&t=`), `youtube_status` = valor inicial `unknown`
   hasta F3 (el seed no trae Status para esta fila).
5. Existe 1 fila en `media.youtube_videos` con `video_id = 'Q-pRpO2sYSI'`,
   cuyo `seed_upload_id` apunta a la fila de `ingest.seed_uploads` con
   `upload_order = 28`, y 1 fila en `media.video_albums` que la enlaza con
   ese álbum (`album_kind='full_album'`, `is_primary_link=true`). La fila del
   XLSX es, por diseño, un vínculo explícito video↔álbum.

### C. Gating de tipos de video (decisión de gobierno)
6. Las filas 553 ('En Vivo', **Live Concert**) y 564 ('Live Sessions At
   Equilibrio.Net', **Live Concert**) **NO crean ningún álbum**. De las 16
   filas, 14 son de tipo álbum y generan álbum (ver D para 'En Vivo'):
   total esperado = **14 álbumes** de Caramelos De Cianuro
   (órdenes 28, 32, 36, 53, 93, 100, 121, 308, 319, 349, 370, 404, 423, 527).
7. La fila 564 genera 1 fila en `media.youtube_videos` (video_id
   `CI31AGZQe0c`, vía `seed_upload_id` → `upload_order` 564) y **cero**
   álbumes.
8. `ingest.review_queue` contiene un ítem `media_type_no_album` (kind
   disponible desde la migración `0004_review_kinds`) o `possible_duplicate`
   documentando que la fila 553 (Live Concert) no creó álbum y se propuso su
   vínculo.

### D. Par duplicado 'En Vivo' (entity resolution + conflicto conservado)
9. Existe **exactamente 1** álbum 'En Vivo' (año 2009, `album_type =
   'live_album'`, creado desde la fila 370).
10. Existen **2** filas en `media.youtube_videos` correspondientes a
    'En Vivo' (IDs `Yk9qA6F0XB0` y `1ij7EFYxRlc`). Ambas pueden enlazarse al
    **mismo** álbum vía `media.video_albums` (N:N), pero **solo una** puede
    tener `is_primary_link=true`: lo garantiza el índice parcial
    `video_albums_one_primary_per_album_uk`. La segunda entra por propuesta
    aceptada en revisión o queda pendiente — **jamás como un segundo álbum**.
    El enlace de la fila 553 lleva `album_kind='live_concert'`.
11. Si la discrepancia de tipo (Live Album vs Live Concert) se registra como
    conflicto, `ingest.conflicts` conserva **ambas** afirmaciones con sus
    evidencias (upload_order 370 y 553) y el core queda intacto mientras
    esté `open`.

### E. Idempotencia (obligatoria)
12. Ejecutar la importación del seed **2 veces** produce conteos idénticos:
    mismo número de filas en `artists`, `albums`, `youtube_videos`,
    `seed_uploads`, `claims` y `review_queue` antes/después del segundo run.
    (Los `import_runs` sí aumentan: 1 por ejecución; los counters del
    segundo deben marcar created=0, skipped=todo.)

### F. Procedencia
13. Cada hecho de B, C y D tiene su claim en `ingest.claims` con
    `source_id` = `yt_master_seed`, `confidence = 'high'`, `created_by =
    'system'`, `status = 'accepted'` y `seed_upload_id` apuntando a la fila
    XLSX correcta.
14. `ingest.merge_audit` registra las escrituras en `artists` y `albums`
    (acción insert), y `ingest.merge_audit_claims` enlaza cada escritura con
    los claims que la respaldan.
15. Los valores originales ('Las Paticas De La Abuela' con capitalización
    real, año 1992, tipo 'EP') permanecen en `seed_uploads.*_raw` sin
    alteración.

### G. Reglas transversales
16. Ninguna fila de `artist_members` se crea a partir de este seed (el seed
    no contiene información de membresías; y aunque la contuviera, crédito ≠
    membresía).
17. `albums.genre` queda NULL o con valor validado; ningún valor de género
    inventado. Si el seed trajera géneros no listados en `ingest.genres` →
    review `genre_unknown`, nunca rechazo silencioso.
18. `Various Artists` del seed (50 filas en todo el archivo) no genera un
    artista ficticio: se registran como compilaciones con nota; este
    escenario lo verifica solo si alguna fila de Caramelos lo usara (no es
    el caso) — criterio global, no específico de este fixture.

---

## 3. Comandos de verificación

```bash
# Doctor de integridad (core intacto + esquemas)
npm run cli -- doctor

# Importación idempotente del seed
npm run cli -- youtube import-sheet "YT Master Spreadsheet.xlsx"
npm run cli -- youtube seed-claims
npm run cli -- youtube import-sheet "YT Master Spreadsheet.xlsx"   # 2ª vez: unchanged
npm run cli -- youtube seed-claims                                  # 2ª vez: claims reutilizados

# Aserciones SQL (crv_test o producción tras F2)
psql "$DATABASE_URL" -c "
SELECT count(*) AS n_artists FROM artists WHERE name='Caramelos De Cianuro';

SELECT count(*) AS n_albums FROM albums a
  JOIN artists ar ON ar.id = a.artist_id
 WHERE ar.name = 'Caramelos De Cianuro';

SELECT count(*) AS n_videos FROM media.youtube_videos v
  JOIN ingest.seed_uploads s ON s.id = v.seed_upload_id
 WHERE s.artist_name_raw = 'Caramelos De Cianuro';

SELECT count(*) AS n_en_vivo FROM albums a
  JOIN artists ar ON ar.id = a.artist_id
 WHERE ar.name = 'Caramelos De Cianuro' AND a.title = 'En Vivo';

-- 'En Vivo' tiene 2 videos enlazados pero un solo enlace primario
SELECT count(*) AS n_links, count(*) FILTER (WHERE va.is_primary_link) AS n_primary
  FROM media.video_albums va
  JOIN albums a  ON a.id  = va.album_id
  JOIN artists ar ON ar.id = a.artist_id
 WHERE ar.name = 'Caramelos De Cianuro' AND a.title = 'En Vivo';

-- Ninguna membresía puede nacer de este seed
SELECT count(*) AS n_members FROM artist_members am
  JOIN artists ar ON ar.id = am.artist_id
 WHERE ar.name = 'Caramelos De Cianuro';

SELECT count(*) AS n_review FROM ingest.review_queue WHERE status = 'open';
"
```

Valores históricos esperados al cerrar F2: `n_artists=1` · `n_albums=14` · `n_videos=16` ·
`n_en_vivo=1` · `n_links=2` con `n_primary=1` · **`n_members=0`** ·
`n_review ≥ 1` (ítems de las filas 553/564 u otros pendientes). En la base
actual, fases posteriores ya resolvieron esas revisiones y añadieron datos de
otras fuentes; esos conteos globales no deben usarse como aserción de E11.
La repetición del caso sobre la base actual (E11) está en
`docs/FINAL_AUDIT.md`, sección «Caso de aceptación real: Caramelos».

---

## 4. Extensión F5 — conflicto real entre fuentes

Detectado en la auditoría del 2026-09-07 al cruzar el seed con la ficha de
Sincopa (`rock_pop/artist_rock/caramelos_dcianuro.htm`). **No es un caso
inventado:** ambas fuentes están autorizadas y afirman años distintos para el
álbum insignia de este escenario.

| Campo | Seed YT (`high`) | Sincopa (`medium`) |
|---|---|---|
| `Las Paticas De La Abuela` · `release_year` | **1992** | **1993** |
| `8` · `release_year` | **2015** | **2016** |
| `La Historia: Grandes Éxitos` · `title` | con subtítulo | `La Historia` |

Criterios adicionales cuando F5 incorpore Sincopa:

19. El claim de Sincopa (1993) **no sobrescribe** el valor canónico 1992: la
    política de merge solo permite a `medium` rellenar campos vacíos, y este
    campo ya tiene valor.
20. Se crea una fila en `ingest.conflicts` con `claim_a` (seed, 1992) y
    `claim_b` (Sincopa, 1993), ambas con su evidencia en
    `ingest.claim_evidence` (fila XLSX y URL+fragmento de Sincopa
    respectivamente), y `status='open'`.
21. Mientras el conflicto esté `open`, `albums.release_year` **permanece
    intacto**. Ninguna resolución es automática.
22. `La Historia` se resuelve como **variante de título** en
    `ingest.album_aliases` (no como conflicto ni como segundo álbum).
23. Sincopa aporta además datos que el seed no tiene y que **sí** deben
    entrar (campos vacíos, sin conflicto): miembros con rol y años en
    `artist_members` (Asier Cazalis, voz y guitarra, 1991-) y sellos en
    `organizations` con `albums.label_id` (CNR, Polygram/Rodven, Latin World,
    Sonográfica…). Ninguno de esos créditos puede inferirse del seed.
24. Regla dura verificada aquí: los miembros vienen de la sección
    "Group Members" de la ficha de artista, **no** de créditos de álbum. Un
    crédito de álbum nunca genera una fila en `artist_members`.

## 4b. Extensión E6 — video, pistas y créditos con IDs reales (2026-09-14)

Verificado en la base de desarrollo tras `crv yt:reconcile` (runs 191 y 192;
la segunda no insertó ninguna fila ni revisión). IDs reales:

| Entidad | ID | Valor |
|---|---|---|
| Artista | 58 | Caramelos De Cianuro (1 fila; 26 discos, 26 títulos+año distintos) |
| Disco | 57 | Las Paticas De La Abuela · 1992 · `ep` · `youtube_url` = `https://www.youtube.com/watch?v=Q-pRpO2sYSI` |
| Video | 54 | `Q-pRpO2sYSI` · `video_albums`: `full_album`, `is_primary_link=true` · `video_artists`: `performer`, `high` |
| Pistas | 4373 · 4379 · 4385 · 4391 | inicios 0 · 247 · 475 · 615, fin 247 · 475 · 615 · 940 |
| Claims de inicio | 43920 · 43926 · 43932 · 43938 | `youtube_start_seconds`, `accepted`, evidencia `tracklist:0..3` del video |
| Estudio | 176 | Mad Box's Studios · `recording_studio` · créditos 3073 (`recorded at`) y 4253 (`mixed at`) |

```sql
-- álbum ↔ video
SELECT ar.id, ar.name, a.id, a.title, a.release_year, a.album_type, v.video_id, va.album_kind, va.is_primary_link
  FROM albums a JOIN artists ar ON ar.id=a.artist_id
  JOIN media.video_albums va ON va.album_id=a.id JOIN media.youtube_videos v ON v.id=va.video_id
 WHERE ar.name='Caramelos De Cianuro' AND a.title='Las Paticas De La Abuela';

-- pista ↔ video, con el claim que respalda cada inicio
SELECT t.id, t.track_number, t.title, vt.start_seconds, vt.end_seconds, vt.confidence, vt.claim_id
  FROM media.video_tracks vt JOIN tracks t ON t.id=vt.track_id
  JOIN media.youtube_videos v ON v.id=vt.video_id
 WHERE v.video_id='Q-pRpO2sYSI' ORDER BY vt.start_seconds;

-- créditos del disco con su persona, artista u organización
SELECT ac.id, ac.credit_type, ac.role, p.name AS person, ar.name AS artist, o.name AS organization
  FROM album_credits ac LEFT JOIN persons p ON p.id=ac.person_id
  LEFT JOIN artists ar ON ar.id=ac.artist_id LEFT JOIN organizations o ON o.id=ac.organization_id
 WHERE ac.album_id=57 ORDER BY ac.credit_type, ac.id;

-- sin duplicados de ocurrencias
SELECT count(*), count(DISTINCT (video_id, track_id, start_seconds)) FROM media.video_tracks;
```

Cumple: 1 artista, 1 disco 1992 EP, 4 pistas con los inicios esperados
enlazadas al video, los cuatro músicos con su rol exacto (Asier Cazalis 6940,
Miguel Gonzáles "El Enano" 4857, Luis "Golding" Barrios 3767, Pablo Martínez
1792), Caramelos De Cianuro como productor (4975) y autor (4365) por su ficha
de artista, Mad Box's Studios como organización, 0 membresías creadas desde
créditos y "August 1992" fuera de `release_year`.

**Desviaciones encontradas y corregidas el 2026-09-14** (heredadas de la
ingesta, no de E6; cada una por decisión del propietario, con plan versionado
en `docs/decisions/` y auditoría en `merge_audit`):

1. **Boris Milán** (persona 2966) llevaba tilde y el video dice «Boris Milan».
   → Renombrada a **Boris Milan**, «Boris Milán» queda como alias (run 194).
2. **Carlos Rondon no existía:** Sincopa aportó «Car» (4189, crédito 8938) y
   «los Rondon» (4192, crédito 8942). → 4189 renombrada a **Carlos Rondon**,
   4192 fusionada en ella, los alias «Car» y «los Rondon» retirados y los dos
   créditos de foto unidos en 8938 (run 194).
3. **Luis Barrios** (546, Sincopa) y **Luis "Golding" Barrios** (1672, video)
   eran dos personas. → 546 fusionada en 1672 con «Luis Barrios» como alias;
   su membresía y sus 11 créditos se movieron y los equivalentes se unieron
   (run 194).
4. **«Caramelos de Cianuro» era también una persona** (4186, `producer`). →
   Sus 17 créditos pasaron al artista 58 (el de *Paticas* se unió a 4975), sus
   17 claims de nombre quedaron rechazados y su historia copiada en la
   auditoría del artista (run 194).
5. **Créditos del video sin leer.** → `CREDIT_LINE` reconoce «Artwork &
   Illustration by» y «Photography by»; los claims del video se aprobaron y,
   por la equivalencia de foto y arte, respaldan los créditos 8939 (Pablo
   Martínez) y 8938 (Carlos Rondon) en vez de duplicarlos (runs 197 y 199).

Créditos de *Paticas* tras las correcciones (12, sin equivalentes duplicados):
Asier Cazalis, Miguel Gonzáles "El Enano", Luis "Golding" Barrios y Pablo
Martínez como músicos; Caramelos De Cianuro como autor (4365) y productor
(4975); Boris Milan como grabación (2214) y mezcla (2157); Mad Box's Studios
como estudio de grabación (3073) y mezcla (4253); Carlos Rondon en foto (8938)
y Pablo Martínez en arte (8939).

## 5. Definición de fallo

El escenario **falla** si: aparece más de un artista Caramelos; existe más de
un álbum 'En Vivo' o 'Las Paticas De La Abuela'; una fila Live
Concert/Documentary/Music Video creó un álbum; el segundo run incrementó
algún conteo de entidades; un claim del seed no puede rastrearse a su fila
XLSX (`seed_upload_id`); se creó alguna fila en `artist_members` a partir del
seed; un álbum tiene más de un `is_primary_link`; el claim `medium` de
Sincopa sobrescribió un año ya establecido, o el conflicto 1992/1993 se
resolvió sin intervención humana perdiendo una de las dos afirmaciones; o
cualquier verificación requirió alterar el core (`crv_simple_v1.sql`).
