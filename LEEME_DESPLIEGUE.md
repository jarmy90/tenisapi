# Bolita - Tennis Live Scraper API

Esta es una API construida con **Node.js, Express y Playwright** que funciona como un "Headless Browser" (navegador invisible) para scrapear en tiempo real los marcadores de tenis que están ocultos detrás de sistemas React/JavaScript.

## ¿Por qué esta arquitectura?

Sitios interactivos ocultan sus datos bajo scripts bloqueando peticiones estándar (`requests` de Python, `curl`, etc.). Al usar Playwright, levantamos un entorno Chromium real en un servidor, esperamos a que la página se pinte, y sacamos los datos puros en JSON.

## Guía de Despliegue en la Nube (Gratis o muy barato)

La mejor manera de usar esta API desde tu aplicación Android (o web `index2.html`) es subir esta carpeta a un servidor en la Nube como **Render.com**.

### Pasos exactos para Render.com

1. Sube esta carpeta (`tennis-api`) a un repositorio en **GitHub**.
2. Entra en [Render.com](https://render.com) y crea una cuenta.
3. Haz click en **New +** y selecciona **Web Service**.
4. Conecta tu cuenta de GitHub y selecciona el repositorio que acabas de subir.
5. Usa esta configuración exacta:
   - **Environment:** Node
   - **Build Command:** `npm install && npx playwright install chromium --with-deps`
   - **Start Command:** `npm start`
6. Dale a *Create Web Service*. Render instalará el navegador fantasma por ti.

### ¿Cómo usar la API?

Una vez desplegada, Render te dará una URL (ej: `https://bolita-tennis-api.onrender.com`).
Desde el Cloudflare Worker de Bolita, o desde tu App de Android, solo tienes que hacer una llamada:

```javascript
fetch("https://tu-url-de-render.com/api/tennis/live")
  .then(res => res.json())
  .then(data => {
      console.log("¡Tenemos los partidos!", data.events);
  });
```

El servidor te devolverá al instante un JSON estructurado con todos los partidos, sets, local/visitante y estado del encuentro. No tendrás problemas de bloqueos ni errores de CORS.
