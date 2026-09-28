// CRV · Entorno mínimo para test/unit: estas pruebas no usan una base real
// (no hay contenedor), pero getEnv() exige DATABASE_URL sin excepción
// (src/config/env.ts, único punto de lectura de process.env). Se fija un
// valor dummy sintácticamente válido para que el resto de la validación
// (CRAWL_*, etc.) se comporte igual que en producción.
process.env["DATABASE_URL"] ??= "postgresql://unit-tests-no-db@127.0.0.1:1/unit_tests";

// Las banderas de funciones van apagadas, como en `.env.example`: el `.env` de
// la máquina puede tenerlas encendidas (la base de desarrollo usa la proyección
// de géneros) y la suite no debe depender de eso. dotenv no pisa lo ya fijado;
// las pruebas que necesitan una bandera la encienden ellas mismas.
process.env["GENRES_PROJECTION_ENABLED"] = "false";
