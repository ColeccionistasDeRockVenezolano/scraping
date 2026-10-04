# Sincopa: discos separados que necesitan revisión (2026-10-03)

Tras separar las 60 fichas mezcladas (runs 11730–11731 y 11758–11761) quedan casos que no se resuelven por regla.

## 1. Pistas de otra fuente que siguen en el disco viejo

Hippito (dos entradas por artista, también fusionadas en un disco), MusicBrainz o el lote de IA sostienen en el disco viejo pistas que son del disco separado. Hay que decidir, entrada por entrada de esa fuente, a qué disco pertenece y mover sus pistas. Lo urgente son 4172, 8597, 4125 y 4283 (la otra fuente sostiene el repertorio del disco separado); en las demás filas puede ser repertorio común (recopilaciones, regrabaciones).

| Disco viejo | Disco nuevo | Ficha | Pistas repetidas |
|---|---|---|---|
| 14610 | 15375 | simondiaz_tonadasyllanerias.htm | 4/12: 12 Tonada De Las Espigas [Sincopa]; 6 El Alcaraván [Deezer (API), Sincopa]; 10 Mi Querencia [Deezer (API), Sincopa]; 11 Tonada De Luna Llena [Deezer (API), Sincopa] |
| 8597 | 15403 | gual_ibarreto_gualbertoibarreto.htm | 8/10: 1 El Calamar [MusicBrainz (API)]; 7 Amor En Todas Partes [MusicBrainz (API)]; 9 Pero Es El Tiempo [MusicBrainz (API)]; 10 Lo Que Le Gusta A La Gente [MusicBrainz (API)]; 2 De Amor No Se Ha Muerto Nadie [MusicBrainz (API)]; 3 Todo Lo Que Es Mi Vida [MusicBrainz (API)]; 4 La Mala Intención [MusicBrainz (API)]; 5 Canción Para María Teresa [MusicBrainz (API)] |
| 9559 | 15410 | raices_1982.htm | 2/7: 3 Raíces Tocuyanas [Operador del catálogo (API), Sincopa]; 16 Raíces Llaneras [Operador del catálogo (API), Sincopa] |
| 259 | 15670 | impala_09_1996.htm | 2/13: 7 Muévanse Todos [Sincopa, YouTube Data API v3]; 13 Roll Over Beethoven [sin claims] |
| 4081 | 15673 | francodvita_grandesexitos.htm | 3/12: 1 Un Buen Perdedor [Operador del catálogo (API), Sincopa]; 3 Solo Importas Tú [Operador del catálogo (API), Sincopa]; 6 Aquí Estás Otra Vez [Operador del catálogo (API), Sincopa] |
| 4125 | 15674 | germanfreytes2_6276.htm | 7/12: 4 Tu sentirás [Hippito y Sus Chatarritas]; 12 Vendrán nuevos días [Hippito y Sus Chatarritas]; 11 Cuatro muchachos [Hippito y Sus Chatarritas]; 2 Cuatro palabras [Hippito y Sus Chatarritas]; 10 Yo también se perder [Hippito y Sus Chatarritas]; 5 Ayer tuve un sueño [Hippito y Sus Chatarritas]; 9 Tu torre de papel [Hippito y Sus Chatarritas] |
| 4172 | 15678 | grupobota_1977.htm | 10/10: 1 Acaracawinkiri [Hippito y Sus Chatarritas]; 6 El Sol No Alumbra [Hippito y Sus Chatarritas]; 3 Batisan [Hippito y Sus Chatarritas]; 7 Solos [Hippito y Sus Chatarritas]; 10 Papa Low Dos [Hippito y Sus Chatarritas]; 9 Ana [Hippito y Sus Chatarritas]; 4 El Nacerá [Hippito y Sus Chatarritas]; 8 Luces [Hippito y Sus Chatarritas]; 5 Ya Es Hora [Hippito y Sus Chatarritas]; 2 Todo [Hippito y Sus Chatarritas] |
| 4283 | 15681 | ivo_3ivo.htm | 4/12: 5 Quiero ser feliz [Hippito y Sus Chatarritas]; 7 Una noche de amor [Hippito y Sus Chatarritas]; 8 Núnca lo tendrás [Hippito y Sus Chatarritas]; 4 Imagíname [Hippito y Sus Chatarritas, Sincopa] |

## 2. Pistas de la ficha dueña sin lugar

La posición la ocupa una pista de la ficha separada (sección 1). No se añadieron al final para no volver a mezclar el disco (`fix-sincopa-position-collisions --from-db` sin confirmar).

- 4125 (germanfreytes1_6254.htm): 01 Aleluya Nº 2; 02 Hoy; 03 Dime Que Sí; 04 Alegría, Alegría; 05 Protesta Contra Los Cohetes; 6 Para Ti; 7 Estoy Hirviendo; 8 O.K. Baby; 9 Judy Con Disfraz; 10 La Hierba Del Jardín
- 4172 (grupobota_1974.htm): 01 Bambele; 02 Algo Pasa En Mi; 04 El Quererte; 05 Brujeria; 6 Dime; 7 Española; 8 Ayudalos; 9 Yanohama
- 4283 (ivo_1ivo.htm): 03 Me Lo Dices Tú; 05 Verán Que Fuerte; 7 Judy Con Disfraz; 8 Marina
- 5771 (aliriodiaz_recital.htm): 3 Tocata; 4 Sonata; 6 Suite
- 7785 (6ttojuventud_cocinandosalsa.htm): 6 La Que Se Fue
- 7786 (6ttojuventud_brujeria.htm): 9 Conmigo
- 7905 (mayramarti_84mayramarti.htm): 03 Mi Mundo Cambió
- 8597 (gual_ibarreto_01.htm): 01 Mi Nieta Francisca Antonia; 02 El Sancocho; 03 Ceresita; 04 La Chivita Cana; 05 Jota Carupanera; 7 María Antonia; 9 Cosas Nuestras; 10 La Guacara
- 9210 (jvt_torrealberos500.htm): 04 El Macán
- 9559 (raices_raicesdvzla2014.htm): 01 Pajarito y Chipola

## 3. Títulos repetidos que sí son correctos

Canciones regrabadas o recopiladas: la ficha dueña también las sostiene. No se tocan.

- 15250 → 15376 (simondiaz_carachanegro.htm): 3 Cobardía
- 5771 → 15377 (aliriodiaz_74recital.htm): 4 Canción; 5 Guasa
- 7785 → 15386 (6ttojuventud_cocinandosalsa_cd.htm): 8 Mi Viejita; 6 Sed De Oro
- 7786 → 15387 (6ttojuventud_brujeria_cd.htm): 11 Brujería; 5 El Panadero; 9 Corazón De Araña Negra
- 8587 → 15402 (grupovera_84grupovera.htm): 8 La Llora
- 9210 → 15407 (jvt_torrealberos503.htm): 4 Sueño Llanero
- 9210 → 15408 (jvt_torrealberos504.htm): 3 Aguacerito
- 9559 → 15411 (raices_1983.htm): 7 Pinceladas Venezolanas; 15 Choro
- 9559 → 15412 (raices_1984.htm): 1 El Negro Eliezer
- 3507 → 3894 (los_cazadores_71thehunters.htm): 10 Lejano Oeste; 7 La Noche Me Ilusiona; 8 Que Has Dejado En Mi Corazón; 5 Al Fin
- 4145 → 15675 (gina_agny3.htm): 10 Es Amor; 9 Lejos
- 4640 → 15683 (antbellobluesband_2bumblebee.htm): 7 Life By The Drop
- 4650 → 15684 (2020_20exitos2_6070.htm): 14 Quiero Ser Yo

## 4. Otros

- Artista 1798 «La Banda de» (disco 3413 «La Banana Voladora»): nombre truncado; debería ser La Banda de la Banana Voladora (1212).
- Los Impala (259, disco del canal): sus tres fichas separadas tienen disco propio (2520, 15669, 15670); del disco del canal no se movió nada.
