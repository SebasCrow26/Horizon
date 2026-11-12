# Horizon: actualización automática (gratis)

**Cómo funciona:** GitHub guarda el código y cada noche corre una tarea que descarga precios nuevos y recalcula el ranking. Netlify detecta el cambio y vuelve a publicar la página solo. No tienes que hacer nada más después de configurarlo una vez (unos 15 minutos).

Además, la app se cuida sola: si los datos guardados tienen más de 2 días (porque la tarea falló o no la configuraste), descarga en vivo las canastas regionales al abrir un activo.

---

## Paso 1 · Crear el repositorio en GitHub
1. Entra a **github.com** y crea una cuenta, si no tienes.
2. Arriba a la derecha, **+ → New repository**.
   - Nombre: `horizon`.
   - **Private** está bien (Netlify y Actions funcionan igual y es gratis).
   - No marques "Add a README".
   - Pulsa **Create repository**.

## Paso 2 · Subir los archivos
La carpeta lista para subir es **`Descargas\Horizon_Repo`**. Ya trae las tareas automáticas (`.github`), las herramientas y los datos, y deja por fuera los archivos grandes del backtest.

**Opción fácil: GitHub Desktop** (desktop.github.com)
1. Instálalo e inicia sesión.
2. **File → Add local repository →** elige `Descargas\Horizon_Repo`. Cuando diga que no es un repositorio, pulsa **"create a repository"** y luego **Create repository**.
3. Pulsa **Publish repository**. Deja marcado "Keep this code private" y elige tu cuenta.

**Opción con la terminal** (si tienes git instalado), dentro de `Horizon_Repo`:
```
git init
git add .
git commit -m "Horizon v2"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/horizon.git
git push -u origin main
```

## Paso 3 · Dar permiso a la tarea para guardar datos
En tu repositorio: **Settings → Actions → General → Workflow permissions → "Read and write permissions" → Save**.

## Paso 4 · Probar la tarea a mano
1. Pestaña **Actions**. Si pide habilitarlas, pulsa el botón verde.
2. A la izquierda, **"Actualizar datos" → Run workflow → Run workflow**.
3. En 2 o 3 minutos debe salir con ✓ verde, y en la lista de commits aparecerá "Datos actualizados AAAA-MM-DD".
   - Si sale ✗ roja con "Solo llegaron X de 113 series", Yahoo bloqueó esa vez. No se dañó nada: los datos anteriores se conservan y se reintenta la noche siguiente.
4. Opcional: **"Backtest mensual" → Run workflow** (≈ 10 minutos) actualiza el historial que muestra la app.

## Paso 5 · Conectar Netlify a GitHub
1. En **app.netlify.com → Add new site → Import an existing project → GitHub**. Autoriza y elige `horizon`.
2. Configuración:
   - Branch: `main`.
   - Build command: **vacío**.
   - Publish directory: `.` (un punto).
   - **Deploy**.
3. Si ya tenías el sitio creado arrastrando la carpeta y quieres conservar la misma dirección: en ese sitio entra a **Site configuration → Build & deploy → Link repository** y sigue los mismos pasos.

## Paso 6 · Comprobar
- Abre tu sitio y un activo. Arriba a la derecha debe decir **"Yahoo Finance · en vivo"**.
- En **Descubrir**, la nota de abajo muestra la fecha de los datos. Al día siguiente debe cambiar sola.

## Horarios
- **Datos:** de lunes a viernes, 8:30 p. m. hora de Colombia, después del cierre de Nueva York.
- **Backtest:** el día 1 de cada mes.
- GitHub puede retrasar las tareas programadas unos minutos, o hasta una hora, en momentos de mucha carga.

## Límites
- La API de Yahoo no es oficial: puede cambiar o bloquear sin aviso.
- GitHub Actions gratis da 2.000 minutos al mes en repositorios privados. Esto usa unos 60 a 80 (ilimitado si el repositorio es público).
- Los precios de las canastas descargados en vivo no están ajustados por dividendos. La diferencia es pequeña para medir tendencia.
