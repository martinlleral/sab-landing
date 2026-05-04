// Cliente HTTP simple para Supabase REST. Hoy se usa solo para leer
// `waitlist_socios` desde el dashboard de Reportes. Cache in-memory 60s
// para que el dashboard no genere round-trips repetidos al recargar la
// pestaña — la lista de waitlist no cambia tan rápido.
//
// Cuando se implemente Suscripciones reales (cobro recurrente), este service
// puede crecer con `fetchSuscripciones()` o el endpoint /dashboard/waitlist
// puede mover su lógica a una tabla local sin cambiar el shape de respuesta.

const config = require('../config');

const CACHE_TTL_MS = 60 * 1000;
let cache = { ts: 0, key: null, data: null };

function isConfigured() {
  return Boolean(config.supabase.url && config.supabase.key);
}

async function fetchWaitlist() {
  if (!isConfigured()) {
    const err = new Error('Supabase no configurado');
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }
  // Cache key incluye URL + len de key para detectar rotación.
  const cacheKey = `${config.supabase.url}|${config.supabase.key.length}`;
  if (cache.key === cacheKey && Date.now() - cache.ts < CACHE_TTL_MS && cache.data) {
    return cache.data;
  }

  const url = `${config.supabase.url}/rest/v1/waitlist_socios?select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: config.supabase.key,
      Authorization: `Bearer ${config.supabase.key}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
    err.code = 'SUPABASE_FETCH_FAILED';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  cache = { ts: Date.now(), key: cacheKey, data };
  return data;
}

function clearCache() {
  cache = { ts: 0, key: null, data: null };
}

module.exports = { fetchWaitlist, clearCache, isConfigured };
