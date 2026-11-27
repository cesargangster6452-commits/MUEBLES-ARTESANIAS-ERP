# Guía de Implementación a Producción — Muebles & Artesanías

Este paquete contiene el **frontend completo** (`public/index.html`) y el **backend en Node.js + Express** (`server.js` + `schema.sql`) listos para desplegarse.

## Paso 1: Instalar Node.js y preparar el proyecto
1. Instala **Node.js 20 LTS** en tu computadora o servidor.
2. Descomprime este proyecto, abre una terminal dentro de la carpeta y ejecuta:
   ```bash
   npm install
   ```
3. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```

## Paso 2: Configurar credenciales externas en `.env`
1. **Motor OCR (API de Visión):** Crea una API Key en Google AI Studio (Gemini Vision) o Google Cloud Vision y colócala en `VISION_API_KEY`.
2. **Google Drive y Google Calendar:** En Google Cloud Console crea un proyecto, habilita **Google Drive API** y **Google Calendar API**, genera una Cuenta de Servicio (Service Account), comparte tus carpetas de notas (`Matriz` y `Sucursal`) y tus dos calendarios con el correo de esa cuenta, y pega sus IDs en `.env`.
3. **Correo automático de entregas (Módulo 5):** En tu cuenta de Gmail (o correo corporativo) genera una **Contraseña de Aplicación** y colócala en `SMTP_USER` y `SMTP_PASS`. Así cada entrega firmada enviará automáticamente la copia al cliente.
4. **PIN del Chofer:** Verifica `DRIVER_PIN=1111` para **David Altamirano** (`USER_DAVID_ADG`).

## Paso 3: Arrancar en local y probar
1. Inicia el servidor:
   ```bash
   npm start
   ```
2. Abre `http://localhost:3000` en tu navegador o desde la misma red Wi-Fi en el celular del chofer usando la IP local de tu equipo (por ejemplo `http://192.168.1.50:3000`).

## Paso 4: Publicar en la nube (para usar desde cualquier celular)
1. Sube esta carpeta a un repositorio privado de GitHub.
2. Conéctala en **Render**, **Railway** o un **VPS (DigitalOcean / AWS Lightsail)** con HTTPS automático (necesario para abrir la cámara del celular en el Módulo 1 OCR y firmar con el dedo en el Módulo 5).
3. Configura las variables de `.env` en el panel de tu proveedor y agrega un volumen persistente para `./data/muebles_artesanias.db` (o cambia a PostgreSQL si prefieres base administrada).
4. En el celular de **David Altamirano**, abre la URL HTTPS y selecciona **"Agregar a pantalla de inicio"** para usarla como app instalada.

## Paso 5: Notificaciones push
1. Las **notificaciones push** requieren que la app se abra por **HTTPS** (en pruebas locales funciona con `http://localhost`).
2. **En Android (Chrome):** inicia sesión, toca la campana **🔔** en la barra superior y presiona **"Activar notificaciones push"**.
3. **En iPhone (iOS 16.4 o superior):** primero toca el botón **Compartir** de Safari → **"Agregar a pantalla de inicio"**, abre la app desde ese ícono instalado y después entra a **🔔** → **"Activar notificaciones push"**.
