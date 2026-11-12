// Configuración de la aplicación (se carga antes que el resto del código)
window.APP_CONFIG = {
  // Si usas el Cloudflare Worker de /worker/yahoo-proxy.js, pega aquí su dirección. Ejemplo:
  // PROXY_URL: "https://yahoo-proxy.tu-usuario.workers.dev",
  PROXY_URL: "",
  // true = no intenta Yahoo en vivo y usa siempre los datos guardados (modo demostración sin internet)
  FORCE_SNAPSHOT: false,
};
