/**
 * Persistencia de datos.
 *
 * Guarda todo el estado del bot (perfiles de clientes, avisos programados,
 * historial, clientes manuales, folios, casos de asesor, etc.) para que NO se
 * pierda cuando Render reinicia o se hace un nuevo deploy.
 *
 * Soporta 3 backends, en este orden de prioridad:
 *   1. MONGODB_URI   → MongoDB Atlas (tier gratis M0 NO expira) ✅ recomendado
 *   2. DATABASE_URL  → PostgreSQL
 *   3. (ninguno)     → archivo local data/store.json (solo desarrollo; en Render
 *                      free se borra al redeploy)
 *
 * Todo el estado se guarda como un único documento/registro JSON, suficiente
 * para el volumen de un ISP local y sin esquemas complicados.
 */

const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'leontelecom';
const DATABASE_URL = process.env.DATABASE_URL || '';
const FILE_PATH = path.join(__dirname, '..', 'data', 'store.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const STATE_KEY = 'leontelecom_state';
const EXT_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

let _backend = 'file'; // 'mongodb' | 'postgres' | 'file'

// Mongo
let mongoClient = null;
let mongoCollection = null;
let mongoImages = null;
// Postgres
let pgPool = null;

async function init() {
  // 1) MongoDB Atlas
  if (MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      await mongoClient.connect();
      mongoCollection = mongoClient.db(MONGODB_DB).collection('state');
      mongoImages = mongoClient.db(MONGODB_DB).collection('images');
      await mongoCollection.findOne({ _id: STATE_KEY }); // valida la conexión
      _backend = 'mongodb';
      console.log('[persistence] MongoDB Atlas conectado — datos persistentes ✅');
      return;
    } catch (e) {
      console.error('[persistence] No se pudo conectar a MongoDB:', e.message);
      mongoClient = null; mongoCollection = null;
    }
  }

  // 2) PostgreSQL
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
      });
      await pgPool.query(
        `CREATE TABLE IF NOT EXISTS kv_store (
           key TEXT PRIMARY KEY,
           value JSONB NOT NULL,
           updated_at TIMESTAMPTZ DEFAULT now()
         )`
      );
      _backend = 'postgres';
      console.log('[persistence] PostgreSQL conectado — datos persistentes ✅');
      return;
    } catch (e) {
      console.error('[persistence] No se pudo conectar a PostgreSQL:', e.message);
      pgPool = null;
    }
  }

  // 3) Archivo local (fallback)
  _backend = 'file';
  try { fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true }); } catch (_) {}
  console.log(
    (MONGODB_URI || DATABASE_URL)
      ? '[persistence] Usando archivo local (falló la base de datos)'
      : '[persistence] Sin base de datos — usando archivo local ⚠️ (define MONGODB_URI o DATABASE_URL para que persista en Render)'
  );
}

async function load() {
  try {
    if (_backend === 'mongodb' && mongoCollection) {
      const doc = await mongoCollection.findOne({ _id: STATE_KEY });
      if (doc) { const { _id, ...rest } = doc; return rest; }
      return {};
    }
    if (_backend === 'postgres' && pgPool) {
      const r = await pgPool.query('SELECT value FROM kv_store WHERE key = $1', [STATE_KEY]);
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
  const data = state || {};
  try {
    if (_backend === 'mongodb' && mongoCollection) {
      await mongoCollection.replaceOne({ _id: STATE_KEY }, { _id: STATE_KEY, ...data }, { upsert: true });
      return;
    }
    if (_backend === 'postgres' && pgPool) {
      await pgPool.query(
        `INSERT INTO kv_store (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [STATE_KEY, JSON.stringify(data)]
      );
      return;
    }
    fs.writeFileSync(FILE_PATH, JSON.stringify(data));
  } catch (e) {
    console.error('[persistence] Error al guardar estado:', e.message);
  }
}

// ---- Imágenes (promos/avisos) ----
// En MongoDB se guardan como base64 (persisten entre redeploys). En modo archivo
// se guardan en data/uploads/ (no persiste en Render free, pero sirve en local).
async function saveImage(id, contentType, buffer) {
  try {
    if (_backend === 'mongodb' && mongoImages) {
      await mongoImages.replaceOne(
        { _id: id },
        { _id: id, contentType, data: buffer.toString('base64'), createdAt: new Date() },
        { upsert: true }
      );
      return true;
    }
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, id), buffer);
    return true;
  } catch (e) {
    console.error('[persistence] saveImage:', e.message);
    return false;
  }
}

async function loadImage(id) {
  try {
    if (_backend === 'mongodb' && mongoImages) {
      const doc = await mongoImages.findOne({ _id: id });
      if (!doc) return null;
      return { contentType: doc.contentType || 'image/jpeg', buffer: Buffer.from(doc.data, 'base64') };
    }
    const p = path.join(UPLOADS_DIR, id);
    if (!fs.existsSync(p)) return null;
    const ext = path.extname(id).toLowerCase();
    return { contentType: EXT_MIME[ext] || 'application/octet-stream', buffer: fs.readFileSync(p) };
  } catch (e) {
    console.error('[persistence] loadImage:', e.message);
    return null;
  }
}

module.exports = {
  init,
  load,
  save,
  saveImage,
  loadImage,
  get backend() { return _backend; },
  get usingPg() { return _backend === 'postgres'; },
  get label() {
    if (_backend === 'mongodb') return 'MongoDB Atlas ✅';
    if (_backend === 'postgres') return 'PostgreSQL ✅';
    return 'archivo local ⚠️ (define MONGODB_URI o DATABASE_URL para producción)';
  }
};
