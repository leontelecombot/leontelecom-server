/**
 * Persistencia de datos.
 *
 * Guarda todo el estado del bot (perfiles de clientes, avisos programados,
 * historial, clientes manuales, folios, casos de asesor, etc.) para que NO se
 * pierda cuando Render reinicia o se hace un nuevo deploy.
 *
 * - Si existe DATABASE_URL  → usa PostgreSQL (persistente de verdad en Render).
 * - Si NO existe            → usa un archivo local data/store.json (solo sirve
 *                             en desarrollo; en Render free se borra al redeploy).
 *
 * Todo el estado se guarda como un único registro JSON, lo cual es más que
 * suficiente para el volumen de un ISP local y evita esquemas complicados.
 */

const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const FILE_PATH = path.join(__dirname, '..', 'data', 'store.json');
const STATE_KEY = 'leontelecom_state';

let pool = null;
let _usingPg = false;

async function init() {
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
      });
      await pool.query(
        `CREATE TABLE IF NOT EXISTS kv_store (
           key TEXT PRIMARY KEY,
           value JSONB NOT NULL,
           updated_at TIMESTAMPTZ DEFAULT now()
         )`
      );
      _usingPg = true;
      console.log('[persistence] PostgreSQL conectado — datos persistentes ✅');
      return;
    } catch (e) {
      console.error('[persistence] No se pudo conectar a PostgreSQL, usando archivo local:', e.message);
      pool = null;
      _usingPg = false;
    }
  }
  try { fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true }); } catch (_) {}
  console.log(
    DATABASE_URL
      ? '[persistence] Usando archivo local (falló PostgreSQL)'
      : '[persistence] Sin DATABASE_URL — usando archivo local ⚠️ (configura DATABASE_URL para que persista en Render)'
  );
}

async function load() {
  try {
    if (_usingPg && pool) {
      const r = await pool.query('SELECT value FROM kv_store WHERE key = $1', [STATE_KEY]);
      return r.rows.length ? (r.rows[0].value || {}) : {};
    }
    if (fs.existsSync(FILE_PATH)) {
      return JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8') || '{}');
    }
  } catch (e) {
    console.error('[persistence] Error al cargar estado:', e.message);
  }
  return {};
}

async function save(state) {
  const json = JSON.stringify(state || {});
  try {
    if (_usingPg && pool) {
      await pool.query(
        `INSERT INTO kv_store (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [STATE_KEY, json]
      );
    } else {
      fs.writeFileSync(FILE_PATH, json);
    }
  } catch (e) {
    console.error('[persistence] Error al guardar estado:', e.message);
  }
}

module.exports = {
  init,
  load,
  save,
  get usingPg() { return _usingPg; }
};
