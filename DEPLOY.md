# Despliegue de Telegram-Bots

ZEUS, CERBERO y AFRODITA son proyectos independientes. Instala, configura,
compila y ejecuta cada bot desde su propia carpeta; no inicies dos réplicas del
mismo bot, porque el polling y el estado local no se coordinan entre procesos.

## Requisitos y variables

- Node.js `24.20.0` (fijado en `.node-version` en cada proyecto).
- Un token de Telegram distinto para cada bot.
- Copia el `.env.example` correspondiente a `.env` y completa los valores.
  Los archivos `.env` no deben compartirse ni subirse a Git.

| Proyecto | Variables obligatorias | Opcionales / notas |
|---|---|---|
| ZEUS | `BOT_TOKEN` | `OWNER_ID`; `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` para las funciones que usan Supabase; ajustes documentados en `.env.example`. |
| CERBERO | `CERBERO_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CERBERO_INSTANCE_ID` | `CERBERO_SECURITY_MODE` (`alert` o `automatic`; predeterminado `alert`). |
| AFRODITA | `AFRODITA_BOT_TOKEN` | `AFRODITA_DATA_DIR`; `AFRODITA_SUPABASE_URL` + `AFRODITA_SUPABASE_KEY` de solo lectura; configuración de IA opcional completa. No usa `OWNER_ID` ni `SUPABASE_SERVICE_ROLE_KEY`. |

La clave `SUPABASE_SERVICE_ROLE_KEY` concede acceso elevado: guárdala solo en
el entorno privado del servidor de ZEUS/CERBERO. No la pongas en AFRODITA, en
un archivo versionado ni en una aplicación cliente. Para otras opciones,
consulta los `.env.example` de cada proyecto.

## Instalación, compilación y arranque

En cada proyecto, desde su propia carpeta:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm start
```

`npm start` ejecuta `dist/bot.js`; por ello, compila después de cada
actualización antes de reiniciar. No hay un script `npm run prod` definido en
los `package.json` actuales.

Ejemplos desde PowerShell:

```powershell
Set-Location C:\Users\cjus2\OneDrive\Documentos\Telegram-Bots\ZEUS
Copy-Item .env.example .env
npm ci
npm run build
npm start
```

Repite los pasos en `CERBERO` y `AFRODITA`, completando las variables del
`.env` local en cada caso. Para operación sostenida en Windows, usa una tarea
programada configurada para iniciar el comando en el directorio del proyecto y
reiniciarlo tras un fallo; almacena el `.env` con permisos de acceso
restringidos.

## Mantener procesos activos en un VPS con PM2

Instala PM2 en el servidor (`npm install --global pm2`), instala dependencias y
compila cada proyecto. Después, desde la carpeta raíz del ecosistema:

```sh
pm2 start npm --name zeus --cwd /ruta/Telegram-Bots/ZEUS -- start
pm2 start npm --name cerbero --cwd /ruta/Telegram-Bots/CERBERO -- start
pm2 start npm --name afrodita --cwd /ruta/Telegram-Bots/AFRODITA -- start
pm2 save
pm2 startup
```

Ejecuta el comando que `pm2 startup` imprima para habilitar el inicio al
arrancar el VPS. Los archivos `.env` deben estar creados en las carpetas
indicadas antes de iniciar los procesos.

Comandos de operación:

```sh
pm2 status
pm2 logs zeus
pm2 restart zeus
pm2 restart cerbero
pm2 restart afrodita
```

Tras desplegar una actualización, ejecuta `npm ci` y `npm run build` en el
proyecto actualizado antes de su `pm2 restart`. Configura el monitoreo y las
alertas del VPS para detectar procesos caídos, errores de polling y falta de
conectividad con Telegram/Supabase.

## Android con Termux

Termux puede mantener los bots en ejecución mientras Android y la sesión estén
activas, pero el ahorro de batería, la suspensión y las restricciones de red
pueden detenerlos. No equivale a un servicio de producción con disponibilidad
garantizada.

1. Instala Termux y Termux:Boot desde una fuente compatible, y configura Node
   y PM2.
2. Clona cada repositorio por separado, crea su `.env` local, ejecuta `npm ci`
   y `npm run build`.
3. Inicia los procesos PM2 con los comandos anteriores, adaptando las rutas a
   `$HOME`, y ejecuta `pm2 save`.
4. Para restaurarlos al arrancar el dispositivo, habilita Termux:Boot y crea
   `~/.termux/boot/start-bots`:

```sh
#!/data/data/com.termux/files/usr/bin/sh
export PATH="$PREFIX/bin:$PATH"
termux-wake-lock
pm2 resurrect
```

Haz ejecutable el script con `chmod +x ~/.termux/boot/start-bots`. Mantén el
dispositivo conectado a energía y evita forzar el cierre de Termux. Para
disponibilidad continua, prefiere un VPS.

## Persistencia y límites operativos

- Conserva el directorio `ZEUS/data/storage` y el directorio definido por
  `AFRODITA_DATA_DIR` en almacenamiento persistente y con permisos restringidos.
- AFRODITA consulta ciertas verificaciones en el almacenamiento local de ZEUS.
  Si corren en servicios o máquinas distintos, ese directorio no se comparte
  automáticamente y esas verificaciones fallarán de forma segura.
- Asigna a cada bot únicamente los permisos necesarios en Telegram. CERBERO
  requiere conexión Supabase válida y permisos Telegram adecuados para ejecutar
  moderación; revisa primero el modo `alert` antes de habilitar `automatic`.
- Antes de considerar el entorno listo, valida los tokens, las credenciales y
  los permisos en el servicio de despliegue; `npm test` y `npm run build` no
  prueban conexiones reales ni la disponibilidad de Telegram/Supabase.
