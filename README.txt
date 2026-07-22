Bonos Empresa
==============

Sistema aparte para controlar los bonos mensuales de empleados.

Base de datos
-------------

Puede trabajar de dos formas:

1. Supabase, recomendado para dejarlo online.
2. JSON local, solo para probar en una PC.

Para Supabase:

1. Entrar a Supabase.
2. Ir a SQL Editor.
3. Ejecutar el archivo:
   supabase.sql

Variables necesarias para el hosting:

  BONOS_PIN=1234
  SUPABASE_URL=https://tu-proyecto.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=tu-service-role-key

Importante: usar la service_role key solo en el servidor/hosting, nunca en el navegador.

GitHub
------

Subir esta carpeta como repositorio:

  C:\Users\FrancoBuet\Documents\Codex\2026-07-20\cc\outputs\bonos-app

Vercel
------

Crear un proyecto nuevo conectado al repo de GitHub.

Configuracion:

  Framework Preset:
    Other

  Build Command:
    Ninguno, dejar vacio o usar el default

  Output Directory:
    public

Environment Variables:

  BONOS_PIN
  AUTH_SECRET
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Notas:

- Vercel usa la carpeta api como funciones serverless.
- El archivo vercel.json ya deja configuradas las rutas /api.
- La base debe ser Supabase; no usar JSON local en Vercel.

Render
------

Crear un Web Service conectado a GitHub:

  Build Command:
    npm install

  Start Command:
    npm start

  Environment Variables:
    BONOS_PIN
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Cuando Render termine, te da una URL publica tipo:

  https://bonos-empresa.onrender.com

Uso local
---------

Para probar en esta PC:

  node server.js

Abrir:

  http://localhost:3333

PIN inicial:

  1234
