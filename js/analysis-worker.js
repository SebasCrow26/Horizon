// Calcula los 5 modelos en un hilo aparte para que la pantalla no se congele mientras se analiza un activo.
// Recibe { id, args } y responde { id, result } o { id, error }.
import { analyzeAll } from "./models/ensemble.js";

self.onmessage = (e) => {
  const { id, args } = e.data;
  try {
    self.postMessage({ id, result: analyzeAll(args) });
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
