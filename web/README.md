# Interfaz CRV

SPA administrativa React para buscar, consultar y editar el catálogo mediante la API Fastify.

## Desarrollo

En una terminal, desde la raíz:

```bash
npm run api
```

En otra:

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

La interfaz abre en `http://127.0.0.1:5173`. `VITE_API_BASE_URL` debe apuntar a la API, por defecto `http://127.0.0.1:8080`.

Las lecturas funcionan sin credenciales. Para escribir, crea una cuenta desde
la raíz y reinicia la API:

```bash
npm run auth:set-collaborator -- usuario "Nombre visible"
systemctl --user restart crv-api
```

El control “Solo lectura” abre el login. La API verifica el hash scrypt y crea
una sesión en cookie `HttpOnly`; ni la contraseña, ni el hash, ni la sesión se
guardan en `localStorage` o se incluyen en el bundle.

## Verificación

```bash
npm run typecheck
npm run build
npm run qa:smoke
npm run qa:capture
```

La prueba extrema aislada se ejecuta desde la raíz con `npm run test:visual-extreme`.

## Publicación con Tailscale Funnel

El gateway `server.mjs` sirve la SPA bajo `/crv` y reenvía únicamente
`/crv/api/*` al API local. Base de datos y API permanecen en loopback.

El build público se escribe en `dist-public/` y `server.mjs` sirve ESE
directorio. `npm run build` (verificación o vista local) escribe `dist/` y no
toca lo publicado: el bundle del Funnel no se pisa con un build de verificación
(esa mezcla dejó la página en blanco el 2026-09-16).

```bash
cd web
VITE_API_BASE_URL=https://NODO.TAILNET.ts.net/crv/api npm run build:public
CRV_WEB_PORT=3120 npm run serve:public
tailscale funnel --bg --https=443 --set-path=/crv http://127.0.0.1:3120
```

En el servidor configurado para este proyecto, los servicios persistentes de
usuario son `crv-api.service` y `crv-web.service`. Comprueba su estado con
`systemctl --user status crv-api crv-web` y el enrutamiento con
`tailscale funnel status`.
