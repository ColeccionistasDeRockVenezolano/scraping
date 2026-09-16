# Reconciliación del canal de YouTube

> Generado por `crv yt:reconcile` (PHASES.md E6). Determinista: sin IA y sin
> tocar el core. Solo se escriben relaciones de identidad exacta en
> `media.video_artists` y `media.video_tracks`; lo demás va a `youtube_match`.
> La lista completa, incluidos todos los discos sin video, está en
> `youtube-reconciliation.json`.

## Resumen

| Medida | Valor |
|---|---|
| Videos | 649 |
| Discos en el catálogo | 4694 |
| MATCHED_HIGH | 638 — todas sus relaciones salen de identidades exactas o de un enlace confirmado; escritas |
| MATCHED_MEDIUM | 0 — relación probable que necesita confirmación humana; en revisión |
| AMBIGUOUS | 0 — varios candidatos igual de plausibles; en revisión |
| UNMATCHED_VIDEO | 11 — no casa con el catálogo (o su relación principal no existe en él) |
| CONFLICT | 0 — las fuentes se contradicen; en revisión, sin tocar el catálogo |
| UNMATCHED_ALBUM | 4090 discos sin ningún video (672 de artistas presentes en el canal) |
| Entradas de tracklist | 6602 (6597 casadas, 5 sin pista) |
| media.video_artists | 638 (0 nuevas en esta corrida; 0 existentes que el plan no deriva) |
| media.video_tracks | 6664 (28 nuevas; 6562 con claim; 56 no derivadas) |
| Revisiones youtube_match nuevas | 0 |

Por tipo de video: full_album 603 · music_video 17 · live_concert 15 · documentary 3 · editorial 11

## CONFLICT (0)

Ninguno.

## AMBIGUOUS (0)

Ninguno.

## MATCHED_MEDIUM (0)

Ninguno.

## UNMATCHED_VIDEO (11)

- **Dermis Tatú y su álbum debut por @lacajadeares #repost** · `4upIHF5VPmU` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Entrevista a Coleccionistas De Rock Venezolano por @Exitos103.1** · `6D5RhoPLotE` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Interesante reseña sobre la Primera y Segunda Experiencia Psicotomimética por @lacajadeares #repost** · `CIx3Fmn-GBE` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Interesante reseña sobre sobre Tribop por @nuevasbandasvzl, disponible ya en el canal #repost** · `CZOVMWEVuas` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Canserbero: la historia por detrás del diseño del álbum "Mu*erte" por @lacajadeares #repost** · `ODoxzNxcFxE` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Todosantos con su disco debut Aeropuerto por @nuevasbandasvzl #repost** · `P98UKUoYBzI` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Extracto de nuestra primera entrevista para Éxitos 103.1 de CRV #repost #agradecido** · `UcPUBDw5eFY` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Interesante reseña sobre "Caracas High Tech", compilado electrónico de @nuevasbandasvzl #repost** · `Y69Wufy_fFE` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Venezuela by @pil_kyu.** · `agRQFOZMrv8` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Interesante reseña sobre Ladies WC de @lacajadeares #repost** · `k5R_Dc8s_dA` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)
- **Babylon Motorhome, disponible mañana en el canal. Reseña por @nuevasbandasvzl #repost** · `zNdcRR1rBZE` · editorial
  - el título no nombra un artista con la forma «Artista - Título»
  - pieza editorial del canal (reseña, entrevista o repost)

## UNMATCHED_ALBUM de artistas presentes en el canal (672)

Discos sin video cuyo artista sí tiene videos en el canal. No es un error: la
hoja es una discografía curada y el canal no publica todo. Los
3418 discos restantes son de artistas sin ningún video (lista en el JSON).

- **10MC** (1): Ep (2009)
- **A'mbar** (3): California Shade (1981) · The Witch (1980) · (María Conchita Alonso)
- **Aditus** (22): 25 aniversario / Serie 32 (2000) · En este país (1993) · De Alcabala A Peligro (2008) · Reversible por Ambos Lados (1997) · Años Después (1995) · Diez (1992) · Otro Mundo (1990) · Algo Eléctrico (1987) · Juegos de Azar (1985) · AM-Vision (1984) · Posición Adelantada (1983) · Fuera de la Ley (1981) · Lo Mejor y Lo Peor... (1988) · Lo Mejor de Aditus (1991) · Aditus 25 Años (Serie 32) (2000) · Sólo Exitos (2001) · 21 Exitos de Aditus (Lo Máximo) (2005) · Lo Mejor de Aditus (Milenio) (2000) · Ni En Concierto Ni En Estudio... (2015) · 25 Aniversario · Serie Lo Máximo · Ni En Concierto
- **Agresión** (1): Silent Smile (1999)
- **Alban Arthuan** (1): Demo (1995)
- **Alfombra Roja** (1): Pueblo Chiquito, Infierno Grande (2012)
- **Americania** (3): Animal (2010) · Saludos De Americania (2026) · La Fiesta Del Rey Drama (2013)
- **Arkangel** (13): Singles · Hard Times (2013) · No más Apariencias (1987) · Inmortal (1992) · El Angel De La Muerte (2000) · MMVII (2008) · Theatrum Timorem (2019) · Recopilatorio (1994) · Platinum (2021) · Wasted Years (2003) · EP's 1987-2000 (2018) · Arkangel (CD Reissue LP 1 & 3) (1994) · El Viaje - 40º Aniversario (2017)
- **Azúcar, Cacao & Leche** (4): Los Más Grandes Exitos de Edgar Alexander & Azúcar, Cacao y Leche (1975) · Tiempo para Amar (2009) · Gente (2008) · Volumen 2 (1972)
- **Babylon Motorhome** (1): La G.A.N Ya! (2002)
- **Bala Perdida** (2): Rarezas (2009) · En vivo Mega Session (2005)
- **Billy Se Fue** (1): Demo (2004)
- **Buenaparte** (2): La Estoy De Paso · Estoy De Paso (2014)
- **C4 Trío** (1): Desorden Público
- **Candy66** (11): Hijos del Abismo (2019) · No más Violencia SINGLE (2014) · Sombras En El Sol (2015) · Veneno (2009) · Entrevista en La Mega (6/4/09) · En Vivo en Maturín (2003) · En Vivo (2003) · En Vivo Ni Tan Nuevas Bandas (2011) · Lo Mejor de Candy 66 (2016) · Archivo Vol.1 · Archivo Vol.1 - Siempre Fuertes (2018)
- **Cangrejo** (1): Maquétas / En Vivo
- **Caramelos De Cianuro** (9): El Ultimo polvo · Éxitos · Solo Exitos (2001) · Live in Paris - Lado A (2018) · Live in Paris - Lado B (2018) · Flor De Fuego (CD/DVD) (2006) · Flor De Fuego (CD) (2007) · Retrovisor Acústico (2019) · Control (2021)
- **Cebollas Ardientes** (2): Encebollame éste (2000) · Exitos de Ayer, Hoy y Siempre (2014)
- **Charliepapa** (1): Y O (2015)
- **Chucknorris** (3): Malabares (2010) · Incandescente (2010) · Chuckmix (2009)
- **Chupi Lumpi** (1): Alright! (2010)
- **Circo Vulkano** (1): La Vida Es ... (2011)
- **Claroscuro** (3): Ultramegaram · Demos 2003 · En Vivo (2001)
- **Colina** (10): Lo Mejor de Colina (2001) · Amanecer (1982) · Sampler (1986) · Cuando Un Loco Ama... (1988) · Vuelve (1993) · A Través Del Tiempo (2013) · 7 (2019) · Sólo Exitos (2019) · Serie Premium · 2 Super Exitos: México / Si tu te vas (1984)
- **Culto Oculto** (4): Puticlub (2012) · BarAlt000mix (2000) · Culto Oculto (1995) · Culto Oculto (Cassette) (1995)
- **Decibel** (1): Midi-Chlorian (2003)
- **Del Pez** (3): En Vivo En El Centro Cultural Chacao (2013) · Del Pez (2019) · Maquetas (2020)
- **Dermis Tatú** (1): La Mató, La Violó Y La Picó (1995)
- **Desorden Público** (22): 18 años de Ska (2003) dvd · El Tren de la Vida · DP 18 / Desorden Público en Concierto (2004) · Sex (2006) · En Vivo Vive Latino (2007) · The Ska Album (2004) · En Vivo 18 Años · Edición 20 Años · Orgánico · Guarachando En Navidad Volumen · y Muerte (1994) · Edición 20 Aniversario (2008) · México (2008) · Valle de Balas singles (2004) · Desorden Público Box (2000) · Todos Sus Exitos (2001) · Orgánico - Rarezas Acústicas Vol.1 (2013) · Bailando Sobre Las Ruinas (2016) · Guarachando En Navidad (2014) · Pa' Fuera (2016) · En Vivo Teatro Teresa Carreño (2013) · Guarachando en Navidad Vol. 1 (2014)
- **DespuésDeVieja** (1): En Vivo en Corp Banca (2002)
- **Dischord** (1): Por Muchos Años Más EP (2017)
- **Distrust** (5): Chaos Redefined (2017) · Behold The Zombie Nation Ep (2010) · Walk This World Alone EP (2007) · Losing Our World (2015) · Behold The Zombie
- **DJ Afro** (1): Will work for fun (2007)
- **Dogon** (1): Notdunjusta (1996)
- **EntreNos** (1): Once cero tres (2009)
- **Faceless** (6): Becoming Nothing (2008) · Enslaved To a Memory (2006) · Redefining Violence (2006) · Demos (2004) · EP (2004) · Faceless (2007)
- **Fibonacci** (2): EP (2010) · Fibonacci (2009)
- **Fordelucs** (2): B- Side (2007) · Despierta (2017)
- **Franco De Vita** (31): Gold (2001) · Libre (2016) · En Vivo (Marzo 16) (1992) · Simplemente La Verdad (2008) · CD Colección (1998) · Idolos De Siempre (1998) · Sus Mejores Exitos (2000) · Mil y Una Historias En Vivo (2006) · Diez Años Vol. 2 (1994) · Serie 32 (2000) · Grandes Exitos (1995) · Vuelve En Primera Fila (2013) · Diez Años Vol. 1 (1994) · Diez Años Vol. 3 (1994) · Lo Mejor De...18 Temas Originales (1997) · Diez Años Vol. 4 (1994) · Segundas Partes También Son Buenas (2002) · En Primera Fila (2011) · 14 Super Exitos (1991) · Serie Millennium 21 (2000) · Mis 30 Mejores Canciones (2001) · Exitos Eternos (2004) · Leyendas (2004) · Hits (2006) · Solo Exitos (Serie Premium) (2014) · Colección Top 50 - Franco De Vita (2006) · 18 Exitos de Franco De Vita (Lo Máximo) (2003) · Franco & Ilan en Concierto (Lo Máximo) (2007) · Sólo Para Mujeres (2014) · 22 Ultimate Hits (2002) · Icaro (1983)
- **Gaêlica** (2): I / O (2007) · Celta en Venezuela (2009)
- **Garnica** (2): Muchas Maravillas Remixes (2007) · Hielo sobre arena (2007)
- **Gillman** (1): Escalofrío XX Aniversario (2013)
- **Grand Bite** (6): La Sombra (2010) · Túnel Hacia lo Desconocido (2015) · Profetas Del Fin (2005) · Todos Hasta el Final (1990) · No Moriré (1998) · Al Borde del Precipicio (1985)
- **Grupo Pan** (1): Comunícate (1972)
- **Henrique Lazo** (2): Un lugar en el cielo (1968) · Este es...! Henrique Lazo (1969)
- **Henry Stephen** (22): El Rey Negro (1969) · 40 Años, 40 Éxitos (2008) · Henry Stephen: Sus Éxitos (2001) · Salsomanía (1983) · I Don´t Know Why (1982) · Ya no estás a mi lado (1979) · Nuestro Grupo (1970) · Carita Mimada (1970) · Un Vaso de Vino (1969) · Un vaso de vino/Stella (1969) · Mamá regó azúcar en mi (1966) · Lord Henry (1966) · Sus Exitos (2000) · Conozca A Los Impala (1963) · Limón Limonero 40 Años 40 Exitos (2008) · Los Impala (1964) · Regresan Los Impala (1975) · 14 Grandes Exitos (1990) · Deborah / Limón Limonero (1968) · I Don't Know... Yo No Sé (2016) · I've Lost You / Ti Ho Perduto (1974) · Te He Perdido / Mhaida (1974)
- **Horacero** (3): Desde Cero: Demos y Rarezas (2008) · Desde Cero (2008) · Domingos Desenchufados (2006)
- **Ilan Chester** (39): Amistad (1984) · Canciones De Todos Los Días (1983) · Por Principio... Fin (1979) · Opus # 10 (1990) · Ilan Chester (Sólo Faltas Tú) (1985) · Un Mundo Mejor (1992) · Terciopelo (1994) · Bhakti (1998) · Cancionero Del Amor Venezolano (1998) · Sínfonico - En Vivo (2000) · Cancionero Del Amor Venezolano II (2000) · Corazón Navideño (2001) · Así (2004) · Tesoros de La Música Vzlana: LLANOS (2009) · Lo Mejor de Ilan Chester (1991) · Ilan Chester de Colección Vol. 2 · Ilan Chester En Vivo (1995) · Ofrenda Para Un Niño (1999) · Ilan Canta Onda Nueva (2002) · Cancionero Del Amor Venezolano III (2007) · Tesoros de La Música Vzlana: LARA (2009) · Tesoros de La Música Vzlana: ANDES (2009) · Ilan Chester de Colección · CD Colección (2 CDs) (1998) · Solo Exitos (2001) · 32 Grandes Exitos (Serie 32) (1999) · Al Pie De La Letra (1987) · Tesoros de La Música Vzlana: CARACAS (2009) · Ilan C. En Vivo (Gira Nac. Amor Vzlano) (2000) · Tesoros de La Música Vzlana: ZULIA (2009) · Tesoros de La Música Vzlana: COSTAS (2009) · Hits (2006) · 20 Exitos de Ilan Chester (Lo Máximo) (2003) · Cancionero Del Amor Puertorriqueño (2002) · Ilan Chester El Músico de Venezuela (2000) · Solo Exitos (Serie Premium) (2015) · Franco & Ilan en Concierto (Lo Máximo) (2007) · Tesoros De La Música Venezolana: ZULIA (2009) · Gusto Particular (1978)
- **Kodigo De Bar** (2): En Vivo (2002) · Jingo Bar (2002)
- **KRé** (3): El Radio Esta En La Cocina (2005) · Cosas Raras + Live (2011) · Cosas Raras Live at Goethe Institut (2011)
- **La Abuela Disco** (2): Generador (2016) · Demo (2010)
- **La Cándida Virgen** (1): In Nomine Domini EP (2013)
- **La Corte** (4): En Vivo · Evoluxión (2003) · Codigo Demente (New Edition) (2000) · Lo Mejor De La Corte (2002)
- **La Leche** (1): En Vivo En Discovery Bar (2009)
- **La Misma Gente** (4): A La Calle (1992) · Tres (1986) · Luz Y Fuerza (1984) · La Vela Que No Se Apaga (2011)
- **La Mosca Punk** (2): La Mosca Punk (1999) · En vivo (2001)
- **La Puta Eléctrica** (4): Kazando Malandras (2005) · Misión Fantasma (2002) · Rayos X (1999) · EP (1996)
- **La Vida Bohème** (8): La Lucha (2017) · EP (2007) · Sera (2013) · Plaza Alfredo Sadel, Caracas (2010) · Rarezas (2010) · Compilations · Caribe Caribe (2023) · El Nombre De Esta Banda Es La Vida Bohéme (2017)
- **Laberinto** (7): The World Might Suck (2008) · De Colección Vol. 1 (2012) · Mask of a Thousand Faces (2010) · Live (2000) · EP (1995) · Barlovento (1993) · De Colección (2012)
- **LaMueka** (2): Directo En Tu Cara (2015) · Demo (2013)
- **Las Cuatro Monedas** (13): Las Cuatro Monedas Vol. 3 (1970) · 40 Años 40 Exitos (2011) · Las Cuatro Monedas Vol. 2 (1969) · Presentan A Gregory (1973) · Venezolanísimos (1980) · Eternos Triunfadores (1977) · La Araña (1970) · Yo Creo en Dios (1969) · El Amor es Triste (1968) · Ritmo del Alma (1968) · Las 4 Monedas Vol. 3 (1970) · Las 4 Monedas Vol. 2 (1969) · Una bella historia (1973)
- **Le Picó** (1): All Around
- **Levítico** (3): Los X + @levitico (2011) · Q.S.U.T (1997) · Quiero Ser Un Terrorista (Cassette) (1997)
- **Los Amigos Invisibles** (13): En Vivo En una noche tan linda como esta (CD I) (2008) · En Vivo En una noche tan linda como esta (CD II) (2008) · En Vivo en Maracaibo (1999) · En Vivo - Maracaibo (1999) · En Vivo - Hawai (1997) · Telefunky (2006) · Grandes Exitos de LAI…The Beginnings (2000) · Acústico (2015) · El Paradise (2017) · Repeat After Me (2013) · The Venezuelan Zinga Son Vol. I (2003) · A Typical And Autoctonal Venezuelan... (1995) · Grandes Exitos de Los Amigos Invisibles…
- **Los Beat3** (1): Liverpool Tapes (1999)
- **Los Chevynovas** (5): Los Chevynovas (2003) · Carne en vara (2006) · Los Chevynovas A80 (2003) · DEMO (2004) · 'Tamos En Yopo (2010)
- **Los Crema Paraíso** (1): De Película (2015)
- **Los Impala** (14): 40 Años 40 Éxitos (2006) · Los Impala En Concierto (2003) · 14 Grandes Éxitos (1990) · Regresan Los Impala (1975) · Los Impala en Europa (1967) · The Impala and Their Music (1966) · Los Impala y su Música (1966) · Nuevamente Los Impala (1965) · The Impala and Their Music (In English) (1966) · Los Impala y Su Música (In Spanish) (1966) · Impala's ¡Welcome! · Taxi / Todo es extraño (1967) · Taxi (1967) · Los Impala y sus primeras grabaciones (1962)
- **Los Mentas** (6): En Vivo Vive Latino (2008) · Arriba Carajo (2013) · Dios, El Diablo y El Dinero (2014) · Unidad Educativa Los Mentas (2010) · En Vivo (2008) · U.E.L.M. (2010)
- **Los Mesoneros** (6): Concierto En La Sala (2012) · Caiga La Noche (2017) · Pangea (2019) · Live Desde Pangea (2020) · 10 Años de Indeleble (2021) · Nuestro Año (2024)
- **Los Oceánicos** (1): Demo (2005)
- **Los Paranoias** (1): Demo (2002)
- **Luz Verde** (4): El Final del Mundo Vol. 2: Nada es Imposible · Luz Verde (Cassette) (1998) · Vida (2021) · El Final Del Mundo Vol. II (2014)
- **Malanga** (3): Ta' Trancao (2nd Edition) (2001) · Sr. Malanga (2012) · Nos Volvemos A Encontrar (2024)
- **Mantra** (1): Complexity (2018)
- **Más Quejas** (1): Demo (2000)
- **Maskhera** (4): Maskhovers (2017) · Némesis (2016) · Iskander (2015) · De que estamos hechos (2010)
- **Masseratti 2lts** (7): Vacilón dans la chambre (2003) · tin.Mar.in (2006) · Coctel #5 Cacao, Mujer y Beats (2005) · Cuentos de Ada 6 (2007) · Exposición Verano-Verano (2004) · Folklore No-Tradicional venezolano #4 (2005) · Colores de ideas (2009)
- **Mata Rica** (1): Ritmo Revolution (1997)
- **Meganeura Monji** (2): Dépit (2007) · Unspoken Words (2011)
- **Mermelada Bunch** (3): Dale a Play (2005) · 15 Años - El Concierto (2015) · Te La Dedico (2013)
- **Okills** (4): Iniciando Transmisión (2011) · Estar Bien (2022) · La Ultima Mudanza (2024) · Dimensión Caribe (2020)
- **Pablo Dagnino** (14): Eús El Último Sentimiento · Sin Sombra No Hay Luz (1989) · Sólo Exitos (1996) · Infecto De Afecto (1991) · Fin Del Cuento 1981-1993 (1993) · El Amor No Existe (1987) · Aunque Usted No Lo Quiera (1996) · Invítame (2003) · Lo Ultimo Que Se Pierde (2007) · Ahora Lo Sabes Todo (2018) · Pixel (2001) · En Vivo NYC 1990 (2025) · En Vivo 2013 (2013) · Cuanto Cuesta (2010)
- **Palmeras Kanibales** (5): Nos Tendrán que Reventar (1997) · 13 Super Kañonazos Bailables Vol 13. (1996) · 13 Kañonazos Súper Bailables (2000) · El Basurero (Cassette) (1994) · En Vivo - Mont de Marsan (2004)
- **PAN** (1): PAN (1999)
- **PapaShanty Saund System** (5): En Vivo Circus Bar (2002) · En Vivo en Valencia · Papashanty Saundsystem and Boomer (2003) · En Vivo (2002) · Rarezas en vivo (2002)
- **Patafunk** (2): Patafunk (2008) · Playa (2011)
- **Petrula** (2): Single (2011) · Piraña Punk Destroyer (2009)
- **Pharmacy** (2): Demos (1998) · Ambulance (2011)
- **Pixel** (3): Los Pixel (2001) · Simplemente Acústico (2009) · Ahora Lo Sabes Todo (2018)
- **Planeador** (2): Donde sale el sol SINGLE · Planeador (2010)
- **PP's** (4): En el Aire (1982) · Pp´s (1981) · La Iguana (2012) · En Vivo! (2014)
- **Pzoom** (1): Apocalipsis Ayer (2010)
- **Radio Clip** (1): La Respuesta (1987)
- **Rawayana** (3): Cuando los Acéfalos Predominan (2021) · Quién Trae Las Cornetas? (2023) · Trippy Caribbean (2016)
- **Reciclaje** (2): Caretas (2001) · Reciclaje (1995)
- **Recipe Morado** (3): Santa Fe EP (2019) · Fluctuando (2012) · Dulce EP (2018)
- **Resistencia** (7): Intenso (2004) · Epílogo (2015) · Zodiaco (1985) · Decapo (1984) · Estrategia Contra El Movimiento (1984) · Tierra Prometida (1981) · Muerto en vida (1985)
- **Reyes** (2): Lado A (2013) · Ego de Fuego (2013)
- **Ricochet** (2): Mafia Inc (2008) · Vol. 13 (2002)
- **Rigel Michelena** (1): Mitxelena 3: Nauthiz (2004)
- **Seguridad Nacional** (2): Seguridad Nacional 1983-1993 (2005) · Seguridad Nacional (1985)
- **Sentencia** (8): Solve et Coagula (2020) · Tu Abismo (2019) · Silence (1993) · Silence Demo (1992) · Sentenia (1991) · Okta (Maracay 1996) (1996) · Promo Tape (1995) · En Vivo (FNB Ateneo de Caracas) (1994)
- **Sentimiento Muerto** (5): Tributo Lo-Fi (2002) · El Ultimo Sentimiento (2003) · En Vivo en Maracaibo · Solo Exitos (1996) · En Vivo NYC 1990 (2025)
- **Sincrónica** (3): Aquí te espero (2009) · Pupu Artificial (2001) · Grabaciones (2005)
- **Skin** (1): Demo (2009)
- **Solares** (1): En Vivo En Club Judibana (2007)
- **Sónica** (4): Demos · B - side y Rarezas (2000) · Demo (1999) · B-Sides (2008)
- **Spias** (1): Maquetas (1997)
- **Spiteri** (1): The Power Of Disco (2020)
- **Submarino** (1): En Vivo (2009)
- **Superglicerina** (1): Demo (1996)
- **Telegrama** (2): Cambia Tus Amigos (2013) · Country Club (2008)
- **Témpano** (13): Selective Memory (2008) · Nowhere (2016) · The Seven Samurai (2006) · Odissey: The Greates Tale (2005) · Lo Mejor de Témpano (1990) · Producto de Consumo (1984) · En Vivo Desde Brasil (2021) · Atabal Yémal (CD Reissue) (1998) · El Fin de La Infancia (1999) · En Reclamación (CD Reissue) (2002) · Nowhere NowHere (2016) · 30 Grandes Exitos De Oro (2001) · Atabal Yémal (Super Deluxe Vinyl Edition) (2023)
- **The Asbestos** (3): Demo (2008) · Waking The Nightmare (2009) · Alzheimer Single (2011)
- **The Six** (1): Six (1968)
- **Tisuby & Georgina** (1): Sueños Simples (2001)
- **Tomates Fritos** (1): La Primera Cosecha (1996)
- **Torre de Marfil** (7): En Vivo en Ciudad Ojeda (2001) · Torre de Marfil (1999) · El poder del lado oscuro (2000) · Cantos De Victoria II (Jinetes De Rohan) (2021) · 1997-2001 (2002) · En Vivo (2001) · El Poder Del Lado Oscuro 2.0 (2020)
- **Trance Nuance** (1): Inéditos
- **Various Artists** (125): Compilado Punk Union & Valentia (2015) · Venezuela Rock y Metal Vol. 2 (2020) · Extreme Gore Fest 9 (2015) · Ecos de La Peste, recopilatorio de punk venezolano 1995 - 2008 (2011) · Edición Especial Power Baladas (2020) · Capitulo Trujillo (2020) · Capitulo Migración (2019) · Capitulo Caracas (2019) · Capitulo Monagas (2019) · Capítulo Aragua (2019) · Capítulo Mérida (2019) · Capítulo Anzoátegui (2019) · Capítulo Yaracuy (2019) · Capítulo Falcón (2019) · Capítulo Carabobo (2019) · Capítulo Lara (2019) · Rock contra la dictadura. Venezuela, volumen 02 (2018) · Música por Medicinas (2018) · Rock contra la dictadura. Venezuela, volumen 01 (2018) · A Coñazo! Compilado de Metal Venezolano Vol​.​1 (2017) · Sons of Ancient Woods Where His River Has No End... (2012) · In Lies We Trust - 4​-​Way Split. · Tributo Internacional a Kraken · Lo Mejor De 2015! (2017) · Copilado Venezuela Heavy Metal (VOL.1) (2016) · Araguarock Vol. I (2010) · Coro Subterráneo (2009) · Dance Venezuela Vol I (2006) · La Historia (2001) · La Bronka Petrolera (1995) · Borrachos y Bolingas (2006) · Venezuela Bruthal (2014) · Venerock (1982) · 20 Años Festival Nuevas Bandas (2010) · Festival Nuevas Bandas (2001) · Canciones de Telenovelas Vol. 1 (2007) · Lo-Fi SM (2002) · Serie 32 · La Magia Continua... (1997) · Grandes Grupos · Lo Mejor de Los 60 y 70 (1991) · Aquella Magia De Los 60 & 70 (Colección 20/20) (2001) · Los Años 60 & 70 (Colección de Hierro) (2004) · 20 Exitos de Los · 5 De Colección (1993) · Canciones de Telenovelas Vol. 2 (2007) · Serie Lo Máximo · Escenario Juvenil (1969) · La Otra Magia de · Parece Que Fue Ayer (Serie 32) (2000) · El Club De La Amistad y El Amor (2005) · 1967 - Caracas 400 Gente En Ambiente (2005) · En La Onda (1987) · Los Reyes Del Acetato Años 60' 70 · La Nueva Canción Venezolana / CD Manía (1999) · Venezuela 70: Cosmic Visions Of A Latin Amercan Earth (2016) · Los Grandes Exitos Yare (1974) · ¡Qué Nota! date con el Rock (1987) · Gogoteca: Entra al Mundo Psicomusical (1968) · Aquellos Años 60 & 70 Vol. 2 (2002) · Los Años 60's en Acción (1999) · Recuerdos (Memories) (1980) · Momentos... (1980) · España Rinde Homenaje a The Beatles (2008) · "Hey Jude" Tributo a Los Beatles (1995) · La Estación de la Alegría (1972) · Disco Coraven (1987) · El Club del Clan (1965) · Radio Caracas 750 Cincuentenaria (1980) · Guaicaipuro de Oro 1961 (1962) · Clemente Vargas Jr. : Desfile de Exitos (1969) · Grandes Interpretes Venezolanos (1984) · Venezolanos ante todo (1981) · Fiesta Existencialista (1965) · Aquellos Años 60 & 70 Vol. 1 (2002) · 50 Años de Pop Rock en Venezuela: Venezuelan Pop Rockers 3 (2010) · Alfredo Churión: Sólo 60 & 70 Vol. 3 (2011) · En la Onda de los 70 (1987) · Alfredo Churión: Sólo 60 & 70 Vol. 2 (2011) · 50 Años de Pop Rock en Venezuela: Venezuelan Pop Rockers 2 (2010) · Alfredo Churión: Sólo 60 & 70 Vol. 1 (2011) · 50 Años de Pop Rock en Venezuela: Venezuelan Pop Rockers 1 (2010) · Top Hits (1974) · Los Duros del Rock (1984) · Top Hits de Venezuela Vol. 2 (1972) · Una Auténtica Carrera de Exitos: Hits '66 Vol. 1 (1966) · Selecciones del 73 (1973) · Top Hits '74 (1974) · Top Hits '73 (1973) · El Taller del Orfebre (1984) · Canciorema (1973) · Exitos 1.090 (1970) · Venezuela y sus Intérpretes: Canciones de Grandes Festivales (1969) · Eduardo Morell: La Dos Caracas De Un Programa (1966) · Exitos de Ayer Vol. IV (1973) · Génesis 99.5 FM: Encuentro de Generaciones (2001) · Gente en Ambiente: Pop And Op Musical (1968) · Radio Caracas 750: Top Hits Vol. 5 (1972) · Grandes Exitos de los Años 70 (1985) · Hit Parade de Venezuela Vol. 4 (1965) · Hit Parade de Venezuela Vol. 3 (1965) · Hit Parade de Venezuela Vol. 2 (1964) · En la Onda de los 60 (1987) · Aquellos Años 60 & 70 Vol. 3 (2002) · Hit Parade de Venezuela Vol. 6 (1966) · Turbo Hits (1984) · La Década Prodigiosa · Grandes Exitos de Los '70 (1980) · Twist y Crimen · Hits '66 Vol. 2 · Hits '67 Vol. 1 · Volver a Vivir (1986) · Superéxitos (1974) · Sólo Hits (1974) · Venezuela 70 Vol. 2: Cosmic Visions Of A Latin American Earth (2018) · 4to Compilado (2003) · COT2 - Pack Bandas (2017) · Venezuela Bruthal (2012) · Capitulo Zulia (2020) · 100 Goregrind - PornGore & CyberGrind Bands! (Compilation N°2) (2017) · Capitulo Sucre (2019) · Compilado Vaginal (2016) · Maquinaria Infernal (2015) · Capitulo Nueva Esparta (2020) · Capitulo Portuguesa (2020)
- **Vinicio Adames** (2): Luminol in Anima Tuus (1998) · Cinema (1992)
- **Viniloversus** (9): Remixes (2008) · Days Of Exile (2017) · Cambie De Nombre (2012) · En Vivo Hard Rock Café (2010) · VVV (2019) · En Vivo (2021) · Live From The Woods (2023) · Mi Mejor Enemigo (2024) · El Día Es Hoy (2008)
- **Vytas Brenner** (11): Lo Máximo de Vytas Brenner (1994) · El Vals del Mar (1986) · Sí (1982) · Estoy Como Quiero (1982) · I Belong (1981) · La Ofrenda de Vytas (1973) · Brenner's Folk: Daurat Oest (1966) · Vytas Brenner (2014) · Vytas Meets Mozart (2006) · Mírame Señor / Viéndote Crecer (1972) · Bang Going Gone / Ganado (1973)
- **Yátu** (1): Churuguara Blues (2000)
- **Yordano** (2): El Tren de los Regresos (2016) · Yordano Hoy... En Vivo (2010)
- **Zapato 3** (10): Gira Besame y Suicidate · En Vivo · Doble Colección · Lo Mejor De Zapato 3 "La Colección Del Milenium" · 18 Éxitos De Zapato 3 · Sólo Éxitos · CD Colección (1997) · Lo Mejor de Zapato 3 (2000) · 18 Exitos de Zapato 3 (Lo Máximo) (2005) · Solo Exitos (Serie Premium) (2014)
