require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, 'uploads');
const catalogUploadsDir = path.join(uploadsDir, 'catalog');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(catalogUploadsDir)) fs.mkdirSync(catalogUploadsDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// =========================================================
// 0. DIRECCIONES REALES EXACTAS — APIZACO & ATOTONILCO, TLAXCALA
// =========================================================
const BRANCH_LOCATIONS = {
  Matriz: {
    name: 'Sucursal Matriz',
    address: 'Avenida Juárez esq. 2 de Abril, Apizaco, Tlaxcala'
  },
  Sucursal: {
    name: 'Sucursal Centro',
    address: 'Calle Xicohténcatl 701, Apizaco Centro, Tlaxcala'
  },
  Bodega: {
    name: 'Bodega San Antonio Atotonilco',
    address: 'Calle Domingo Arenas, San Antonio Atotonilco, Tlaxcala'
  }
};

function resolveOriginAddress(originName) {
  const s = String(originName || '').toLowerCase();
  if (s.includes('bodega') || s.includes('atotonilco') || s.includes('domingo arenas')) {
    return BRANCH_LOCATIONS.Bodega.address;
  }
  if (s.includes('sucursal') && !s.includes('matriz')) {
    return BRANCH_LOCATIONS.Sucursal.address;
  }
  return BRANCH_LOCATIONS.Matriz.address;
}

// =========================================================
// 1. BASE DE DATOS SQLITE (v3 con auto-migración segura)
// =========================================================
const dbPath = process.env.DB_PATH || './data/muebles_artesanias.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db = new DatabaseSync(dbPath);
try {
  const hasUsers = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  const hasTx = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  if (hasTx && !hasUsers) {
    db.close();
    const backupPath = `${dbPath}.v1.bak`;
    fs.renameSync(dbPath, backupPath);
    db = new DatabaseSync(dbPath);
  }
} catch (migErr) {
  console.warn('[SQLite] Verificación v1->v2:', migErr.message);
}

db.exec('PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Auto-migración segura v2 -> v3 para columnas nuevas sin borrar datos existentes
function ensureColumn(table, colDef) {
  const colName = colDef.split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
  }
}
ensureColumn('catalog_items', "layaway_phone TEXT DEFAULT ''");
ensureColumn('calendar_events', "assigned_driver TEXT DEFAULT 'conductor1'");
ensureColumn('calendar_events', "delivery_status TEXT DEFAULT 'Pendiente'");
ensureColumn('calendar_events', "client_phone TEXT DEFAULT ''");
ensureColumn('calendar_events', 'client_confirmed_home INTEGER NOT NULL DEFAULT 0');
ensureColumn('calendar_events', "checklist_json TEXT DEFAULT '[]'");
ensureColumn('calendar_events', 'balance_to_collect REAL DEFAULT 0');
ensureColumn('calendar_events', 'balance_collected INTEGER NOT NULL DEFAULT 0');
ensureColumn('calendar_events', "balance_payment_method TEXT DEFAULT ''");
ensureColumn('calendar_events', "delivery_photo_url TEXT DEFAULT ''");
ensureColumn('calendar_events', "incident_photo_url TEXT DEFAULT ''");
ensureColumn('calendar_events', "incident_reason TEXT DEFAULT ''");

// Actualizar referencias antiguas de Bodega San Antonio Totoltepec -> San Antonio Atotonilco
try {
  db.prepare(`UPDATE calendar_events SET dispatch_origin = ? WHERE dispatch_origin LIKE '%Totoltepec%'`)
    .run('Bodega San Antonio Atotonilco');
  db.prepare(`UPDATE transactions SET origin_location = ? WHERE origin_location LIKE '%Totoltepec%'`)
    .run('Bodega San Antonio Atotonilco');
} catch (_) {}

function runTransaction(fn) {
  db.exec('BEGIN');
  try {
    const res = fn();
    db.exec('COMMIT');
    return res;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function hashPassword(plain) {
  const salt = 'adg_muebles_erp_2026_salt';
  return crypto.createHash('sha256').update(`${salt}:${String(plain)}`).digest('hex');
}

// =========================================================
// 2. LOS 9 USUARIOS OFICIALES Y PERMISOS GRANULARES
// =========================================================
const DRIVER_VEHICLE = {
  tipo: 'Nissan Pickup Caja Seca',
  dimensionesMaximas: { altoMetros: 2.10, largoMetros: 3.20 },
  copete: { anchoMetros: 0.50, altoMetros: 0.40 },
  capacidadVolumenMetrosCubicos: 14.5
};

const FULL_ADMIN_PERMS = {
  subirNotas: true,
  editarFotosNotas: true,
  verCatalogo: true,
  editarCatalogoFotos: true,
  reportarDesdeCatalogo: true,
  liberarApartado: true,
  verInventarioAmbasTiendas: true,
  gestionarCaja: true,
  verCalendarioOperativo: true,
  verRutaAsignadaGoogleMaps: true,
  confirmarEntrega: true,
  verDetalleCargaDimensiones: true,
  verReportesFinancieros: true,
  verBitacora: true,
  gestionarUsuarios: true,
  devTools: true
};

const ADMINISTRADORA_PERMS = {
  subirNotas: true,
  editarFotosNotas: true,
  verCatalogo: true,
  editarCatalogoFotos: false,
  reportarDesdeCatalogo: true,
  liberarApartado: true,
  verInventarioAmbasTiendas: true,
  gestionarCaja: true,
  verCalendarioOperativo: true,
  verRutaAsignadaGoogleMaps: true,
  confirmarEntrega: true,
  verDetalleCargaDimensiones: true,
  verReportesFinancieros: true,
  verBitacora: true,
  gestionarUsuarios: false,
  devTools: false
};

const WORKER_PERMS_STD = {
  subirNotas: true,
  editarFotosNotas: true,
  verCatalogo: true,
  editarCatalogoFotos: false,
  reportarDesdeCatalogo: true,
  liberarApartado: false,
  verInventarioAmbasTiendas: true,
  gestionarCaja: true,
  verCalendarioOperativo: true,
  verRutaAsignadaGoogleMaps: true,
  confirmarEntrega: true,
  verDetalleCargaDimensiones: true,
  verReportesFinancieros: false,
  verBitacora: false,
  gestionarUsuarios: false,
  devTools: false
};

const WORKER_PERMS_NO_PHOTO_EDIT = {
  ...WORKER_PERMS_STD,
  editarFotosNotas: false,
  editarCatalogoFotos: false
};

const DRIVER_PERMS = {
  subirNotas: false,
  editarFotosNotas: false,
  verCatalogo: false,
  editarCatalogoFotos: false,
  reportarDesdeCatalogo: false,
  liberarApartado: false,
  verInventarioAmbasTiendas: false,
  gestionarCaja: false,
  verCalendarioOperativo: true,
  verRutaAsignadaGoogleMaps: true,
  confirmarEntrega: true,
  verDetalleCargaDimensiones: true,
  verReportesFinancieros: false,
  verBitacora: false,
  gestionarUsuarios: false,
  devTools: false
};

const DEFAULT_USERS = [
  { username: 'desarrollador', password: 'adg2026', display_name: 'Desarrollador', role: 'DESARROLLADOR', unit: 'Global', permissions: FULL_ADMIN_PERMS },
  { username: 'admin', password: 'adg2026', display_name: 'Dueño / Administrador', role: 'ADMIN', unit: 'Global', permissions: FULL_ADMIN_PERMS },
  { username: 'administradora', password: 'adg2026', display_name: 'Administradora', role: 'ADMINISTRADORA', unit: 'Global', permissions: ADMINISTRADORA_PERMS },
  { username: 'matriz1', password: 'matriz123', display_name: 'Trabajadora Matriz 1', role: 'TRABAJADORA_MATRIZ', unit: 'Matriz', permissions: WORKER_PERMS_STD },
  { username: 'matriz2', password: 'matriz123', display_name: 'Trabajadora Matriz 2 (Sin Edición Fotos)', role: 'TRABAJADORA_MATRIZ', unit: 'Matriz', permissions: WORKER_PERMS_NO_PHOTO_EDIT },
  { username: 'sucursal1', password: 'sucursal123', display_name: 'Trabajadora Sucursal 1', role: 'TRABAJADORA_SUCURSAL', unit: 'Sucursal', permissions: WORKER_PERMS_STD },
  { username: 'sucursal2', password: 'sucursal123', display_name: 'Trabajadora Sucursal 2', role: 'TRABAJADORA_SUCURSAL', unit: 'Sucursal', permissions: WORKER_PERMS_STD },
  { username: 'conductor1', password: process.env.DRIVER_PIN || '1111', display_name: 'David Altamirano (Conductor 1)', role: 'CHOFER_LOGISTICA', unit: 'Logística', permissions: DRIVER_PERMS },
  { username: 'conductor2', password: '2222', display_name: 'Conductor 2', role: 'CHOFER_LOGISTICA', unit: 'Logística', permissions: DRIVER_PERMS }
];

function ensureUsersSeeded() {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, display_name, role, unit, permissions_json, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const now = new Date().toISOString();
  for (const u of DEFAULT_USERS) {
    ins.run(u.username, hashPassword(u.password), u.display_name, u.role, u.unit, JSON.stringify(u.permissions), now);
  }
  // Asegurar que desarrollador y admin tengan devTools: true incluso en DB migrada
  db.prepare(`UPDATE users SET permissions_json = ? WHERE username IN ('desarrollador', 'admin')`).run(JSON.stringify(FULL_ADMIN_PERMS));
}

function makeCatalogSvgPlaceholder(title, subtitle, accentColor = '#00f2fe') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="420" viewBox="0 0 600 420">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="100%" stop-color="#1e293b"/>
      </linearGradient>
    </defs>
    <rect width="600" height="420" fill="url(#bg)"/>
    <rect x="24" y="24" width="552" height="372" rx="18" fill="none" stroke="${accentColor}" stroke-opacity="0.45" stroke-width="2"/>
    <text x="300" y="185" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="26" fill="#f8fafc">${title}</text>
    <text x="300" y="226" text-anchor="middle" font-family="sans-serif" font-size="16" fill="${accentColor}">${subtitle}</text>
    <text x="300" y="340" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#94a3b8">A.D.G. Muebles &amp; Artesanías · Apizaco, Tlaxcala</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function defaultChecklistForTitle(title, decoracion) {
  const items = [
    { label: `Artículo principal: ${title || 'Mueble'}`, checked: false },
    { label: 'Bolsa de tornillería y herramienta de armado', checked: false },
    { label: 'Cobijas protectoras, cartón y emplaye', checked: false }
  ];
  if (decoracion && decoracion.trim()) {
    items.splice(1, 0, { label: `Decoración / Accesorios: ${decoracion.trim()}`, checked: false });
  }
  return JSON.stringify(items);
}

function seedDemoData(forceReset = false) {
  ensureUsersSeeded();
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory').get().c;
  if (count > 0 && !forceReset) return;

  runTransaction(() => {
    if (forceReset) {
      db.prepare('DELETE FROM transaction_items').run();
      db.prepare('DELETE FROM transactions').run();
      db.prepare('DELETE FROM calendar_events').run();
      db.prepare('DELETE FROM inventory').run();
      db.prepare('DELETE FROM layaway_payments').run();
      db.prepare('DELETE FROM catalog_items').run();
      db.prepare('DELETE FROM transfers').run();
      db.prepare('DELETE FROM fuel_logs').run();
      db.prepare('DELETE FROM order_notes').run();
      db.prepare('DELETE FROM cash_register_days').run();
      db.prepare('DELETE FROM webhook_logs').run();
    }

    const insInv = db.prepare(`
      INSERT INTO inventory (sku, description, category, stock_matriz, stock_sucursal, unit_price, min_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const initialInventory = [
      ['MUE-001', 'Comedor Roble 6 sillas', 'Muebles', 4, 2, 15000, 2],
      ['MUE-002', 'Credenza Nogal 1.80m', 'Muebles', 3, 1, 11500, 2],
      ['MUE-003', 'Mesa de Centro Parota', 'Muebles', 5, 3, 8900, 2],
      ['ART-001', 'Jarrón de Barro Policromado', 'Artesanías', 14, 18, 750, 5],
      ['ART-002', 'Alebrije Tallado Copal', 'Artesanías', 8, 6, 1200, 4],
      ['ART-003', 'Tapete Telar de Pedal', 'Artesanías', 6, 4, 2800, 3],
      ['ART-004', 'Lámpara Palma Tejida', 'Artesanías', 9, 5, 1150, 3]
    ];
    for (const row of initialInventory) insInv.run(...row);

    const insCat = db.prepare(`
      INSERT INTO catalog_items (
        id, sku, title, category, description, price, stock_matriz, stock_sucursal,
        image_url, folder_status, created_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Disponible', 'admin', ?)
    `);
    const nowIso = new Date().toISOString();
    const initialCatalog = [
      ['CAT-001', 'MUE-001', 'Comedor Roble 6 Sillas (Cubierta Mármol)', 'Comedores', 'Comedor artesanal en roble con cubierta de mármol natural y 6 sillas tapizadas.', 15000, 4, 2, makeCatalogSvgPlaceholder('Comedor Roble 6 Sillas', 'Cubierta Mármol · $15,000 MXN', '#00f2fe')],
      ['CAT-002', 'MUE-002', 'Credenza Nogal 1.80m', 'Muebles', 'Credenza fina en madera de nogal con 4 puertas talladas y acabado mate.', 11500, 3, 1, makeCatalogSvgPlaceholder('Credenza Nogal 1.80m', 'Madera Nogal · $11,500 MXN', '#38bdf8')],
      ['CAT-003', 'MUE-003', 'Mesa de Centro Parota', 'Muebles', 'Mesa de centro en losa sólida de parota con base metálica negra.', 8900, 5, 3, makeCatalogSvgPlaceholder('Mesa de Centro Parota', 'Parota Sólida · $8,900 MXN', '#a855f7')],
      ['CAT-004', 'ART-001', 'Jarrón de Barro Policromado', 'Jarrones y Floreros', 'Pieza hecha a mano con detalles dorados y esmalte cerámico.', 750, 14, 18, makeCatalogSvgPlaceholder('Jarrón Barro Policromado', 'Artesanía · $750 MXN', '#f59e0b')],
      ['CAT-005', 'ART-003', 'Tapete Telar de Pedal', 'Decoración', 'Tapete tejido en lana natural en telar de pedal 2.00 x 1.50m.', 2800, 6, 4, makeCatalogSvgPlaceholder('Tapete Telar de Pedal', 'Decoración · $2,800 MXN', '#10b981')],
      ['CAT-006', 'ART-004', 'Lámpara Palma Tejida', 'Iluminación y Accesorios', 'Lámpara colgante artesanal tejida en palma natural.', 1150, 9, 5, makeCatalogSvgPlaceholder('Lámpara Palma Tejida', 'Accesorios · $1,150 MXN', '#fb7185')]
    ];
    for (const c of initialCatalog) insCat.run(...c, nowIso);

    const insTx = db.prepare(`
      INSERT INTO transactions (
        id, timestamp, receipt_image_url, location_unit, client, movement_type,
        payment_method, subtotal_muebles, subtotal_artesanias, total_venta,
        deposit_amount, note_number, layaway_date, layaway_due_date, decoracion_detalle,
        requires_delivery, delivery_date, delivery_address, origin_location, special_dispatch, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insItem = db.prepare(`
      INSERT INTO transaction_items (transaction_id, category, description, quantity, unit_price)
      VALUES (?, ?, ?, ?, ?)
    `);

    const initialTxs = [
      {
        id: 'TX-20261122-01', timestamp: '2026-11-22T04:12:00', receipt_image_url: 'gdrive://matriz/notas/IMG_20261122_01.jpg',
        location_unit: 'Matriz', client: 'Familia Mendoza', movement_type: 'Venta', payment_method: 'Efectivo',
        subtotal_muebles: 15000, subtotal_artesanias: 1500, total_venta: 16500, deposit_amount: 12000, note_number: 'Nota #01',
        layaway_date: null, layaway_due_date: null, decoracion_detalle: '2 Jarrones de Barro Policromado + Comedor Roble',
        requires_delivery: 1, delivery_date: '2026-11-25', delivery_address: 'Blvd. 16 de Septiembre 210, Apizaco, Tlaxcala',
        origin_location: 'Sucursal Matriz', special_dispatch: 0, created_by: 'matriz1',
        items: [['Muebles', 'Comedor Roble 6 sillas', 1, 15000], ['Artesanías', 'Jarrón de Barro Policromado', 2, 750]]
      },
      {
        id: 'TX-20261122-02', timestamp: '2026-11-22T10:30:00', receipt_image_url: 'gdrive://sucursal/notas/IMG_20261122_02.jpg',
        location_unit: 'Sucursal', client: 'Arq. Sofía Delgado', movement_type: 'Venta', payment_method: 'Tarjeta',
        subtotal_muebles: 0, subtotal_artesanias: 6400, total_venta: 6400, deposit_amount: 6400, note_number: 'Nota #02',
        layaway_date: null, layaway_due_date: null, decoracion_detalle: '3 Alebrijes + 1 Tapete Telar de Pedal',
        requires_delivery: 0, delivery_date: null, delivery_address: null,
        origin_location: 'Sucursal Centro', special_dispatch: 0, created_by: 'sucursal1',
        items: [['Artesanías', 'Alebrije Tallado Copal', 3, 1200], ['Artesanías', 'Tapete Telar de Pedal', 1, 2800]]
      },
      {
        id: 'TX-20261122-03', timestamp: '2026-11-22T11:45:00', receipt_image_url: 'gdrive://matriz/notas/VALE_20261122_03.jpg',
        location_unit: 'Matriz', client: 'Fletes y Embalajes MX', movement_type: 'Gasto', payment_method: 'Efectivo',
        subtotal_muebles: 850, subtotal_artesanias: 0, total_venta: 850, deposit_amount: 0, note_number: 'Vale #03',
        layaway_date: null, layaway_due_date: null, decoracion_detalle: 'Flete y emplaye entrega urgente',
        requires_delivery: 0, delivery_date: null, delivery_address: null,
        origin_location: 'Sucursal Matriz', special_dispatch: 0, created_by: 'matriz1',
        items: [['Muebles', 'Flete y emplaye entrega urgente', 1, 850]]
      },
      {
        id: 'TX-20261121-04', timestamp: '2026-11-21T16:20:00', receipt_image_url: 'gdrive://matriz/notas/IMG_20261121_04.jpg',
        location_unit: 'Matriz', client: 'Hotel Casa Nogal', movement_type: 'Venta', payment_method: 'Transferencia',
        subtotal_muebles: 23000, subtotal_artesanias: 4500, total_venta: 27500, deposit_amount: 27500, note_number: 'Nota #04',
        layaway_date: null, layaway_due_date: null, decoracion_detalle: '2 Credenzas Nogal + 6 Jarrones Barro Policromado',
        requires_delivery: 1, delivery_date: '2026-11-24', delivery_address: 'Av. Cuauhtémoc 450, Apizaco Centro, Tlaxcala',
        origin_location: 'Bodega San Antonio Atotonilco', special_dispatch: 1, created_by: 'admin',
        items: [['Muebles', 'Credenza Nogal 1.80m', 2, 11500], ['Artesanías', 'Jarrón de Barro Policromado', 6, 750]]
      }
    ];

    for (const tx of initialTxs) {
      insTx.run(
        tx.id, tx.timestamp, tx.receipt_image_url, tx.location_unit, tx.client,
        tx.movement_type, tx.payment_method, tx.subtotal_muebles, tx.subtotal_artesanias,
        tx.total_venta, tx.deposit_amount, tx.note_number, tx.layaway_date, tx.layaway_due_date,
        tx.decoracion_detalle, tx.requires_delivery, tx.delivery_date, tx.delivery_address,
        tx.origin_location, tx.special_dispatch, tx.created_by
      );
      for (const it of tx.items) insItem.run(tx.id, ...it);
    }

    const insEv = db.prepare(`
      INSERT INTO calendar_events (
        id, unit, type, date, title, client, address, amount, deposit_amount, note_number,
        decoracion_detalle, receipt_image_url, transaction_id, dispatch_origin, special_dispatch,
        cargo_volume_m3, cargo_length_m, cargo_height_m, assigned_driver, delivery_status,
        client_phone, checklist_json, balance_to_collect, delivered
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const initialEvents = [
      ['EV-101', 'Matriz', 'Entrega', '2026-11-25', 'Entrega: Comedor Roble 6 sillas + 2 Jarrones', 'Familia Mendoza', 'Blvd. 16 de Septiembre 210, Apizaco, Tlaxcala', 16500, 12000, 'Nota #01', '2 Jarrones Barro Policromado', 'gdrive://matriz/notas/IMG_20261122_01.jpg', 'TX-20261122-01', 'Sucursal Matriz', 0, 4.8, 2.2, 1.05, 'conductor1', 'Pendiente', '2411001122', defaultChecklistForTitle('Comedor Roble 6 sillas', '2 Jarrones Barro Policromado'), 4500, 0],
      ['EV-102', 'Matriz', 'Entrega', '2026-11-24', 'Entrega: 2 Credenzas Nogal + 6 Jarrones', 'Hotel Casa Nogal', 'Av. Cuauhtémoc 450, Apizaco Centro, Tlaxcala', 27500, 27500, 'Nota #04', '6 Jarrones Barro Policromado', 'gdrive://matriz/notas/IMG_20261121_04.jpg', 'TX-20261121-04', 'Bodega San Antonio Atotonilco', 1, 6.4, 1.8, 0.95, 'conductor1', 'Preparando en Bodega', '2412003344', defaultChecklistForTitle('2 Credenzas Nogal 1.80m', '6 Jarrones Barro Policromado'), 0, 0],
      ['EV-103', 'Matriz', 'Entrada', '2026-11-22', 'Entrada Proveedor: 3 Mesas de Centro Parota', 'Maderería Sierra Sur', 'Calle Domingo Arenas, San Antonio Atotonilco, Tlaxcala', 14700, 0, 'ENT-01', '', 'gdrive://matriz/notas/IMG_20261122_ENT.jpg', 'MANUAL-ENT-1', 'Bodega San Antonio Atotonilco', 0, 3.5, 1.9, 1.0, 'conductor1', 'Pendiente', '', '[]', 0, 0],
      ['EV-104', 'Sucursal', 'Salida', '2026-11-22', 'Salida Venta Directa: 3 Alebrijes + 1 Tapete', 'Arq. Sofía Delgado', 'Calle Xicohténcatl 701, Apizaco Centro, Tlaxcala', 6400, 6400, 'Nota #02', '3 Alebrijes + 1 Tapete', 'gdrive://sucursal/notas/IMG_20261122_02.jpg', 'TX-20261122-02', 'Sucursal Centro', 0, 1.2, 0.9, 0.6, 'conductor2', 'Entregado', '', '[]', 0, 1],
      ['EV-106', 'Sucursal', 'Entrega', '2026-11-23', 'Entrega: Mesa Parota + 2 Lámparas Palma', 'Carlos Herrera', 'Calle Morelos 88, Apizaco, Tlaxcala', 11200, 11200, 'Nota #06', '2 Lámparas Palma Tejida', 'gdrive://sucursal/notas/IMG_20261118_06.jpg', 'TX-20261118-06', 'Sucursal Centro', 0, 3.8, 1.9, 0.95, 'conductor2', 'Pendiente', '2413005566', defaultChecklistForTitle('Mesa de Centro Parota', '2 Lámparas Palma Tejida'), 0, 0]
    ];
    for (const ev of initialEvents) insEv.run(...ev);

    const insCash = db.prepare(`
      INSERT OR REPLACE INTO cash_register_days (unit, date, fondo_inicial, efectivo_contado)
      VALUES (?, ?, ?, ?)
    `);
    insCash.run('Matriz', '2026-11-22', 5000, null);
    insCash.run('Sucursal', '2026-11-22', 3000, null);

    db.prepare(`
      INSERT INTO transfers (id, sku, item_description, quantity, from_location, to_location, assigned_driver, status, notes, created_by, created_at, updated_at)
      VALUES ('TRF-001', 'MUE-001', 'Comedor Roble 6 sillas', 1, 'Bodega San Antonio Atotonilco', 'Sucursal Centro', 'conductor1', 'Solicitado', 'Para exhibición en Sucursal Xicohténcatl 701', 'sucursal1', ?, ?)
    `).run(nowIso, nowIso);

    db.prepare(`
      INSERT INTO order_notes (event_id, username, user_display_name, note, created_at)
      VALUES ('EV-101', 'matriz1', 'Trabajadora Matriz 1', 'Cliente solicita llamar 30 min antes de llegar. Llevar los 2 jarrones bien emplayados.', ?)
    `).run(nowIso);

    const insLog = db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, ?, ?)`);
    insLog.run('2026-11-22T04:12:05.000Z', 'Matriz', 'ical.sync.created', 'EV-101 (Entrega 2026-11-25) -> SQLite + Google Calendar');
    insLog.run('2026-11-22T10:30:11.000Z', 'Sucursal', 'ical.sync.created', 'EV-104 (Salida 2026-11-22) -> SQLite + Google Calendar');

    db.prepare(`
      INSERT INTO activity_logs (created_at, username, user_display_name, user_role, unit, action, entity_type, entity_id, detail, email_status)
      VALUES (?, 'admin', 'Dueño / Administrador', 'ADMIN', 'Global', 'sistema.inicializado', 'system', 'INIT', 'Sistema A.D.G. Muebles & Artesanías v3 (Logística Pro + Apizaco/Atotonilco) inicializado.', 'local')
    `).run(nowIso);
  });
}

seedDemoData(false);

// =========================================================
// 3. GOOGLE CLOUD (DRIVE + CALENDAR + SUBCARPETA APARTADOS)
// =========================================================
let googleAuthClient = null;
let serviceAccountMeta = { loaded: false, projectId: null, clientEmail: null };

function initGoogleAuth() {
  try {
    let credentials = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
      credentials = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const keyPath = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS);
      if (fs.existsSync(keyPath)) {
        credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      }
    }

    if (credentials && credentials.client_email && credentials.private_key) {
      googleAuthClient = new google.auth.GoogleAuth({
        credentials,
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/calendar'
        ]
      });
      serviceAccountMeta = {
        loaded: true,
        projectId: credentials.project_id,
        clientEmail: credentials.client_email
      };
      console.log(`[Google Auth] Cuenta de servicio cargada: ${credentials.client_email} (${credentials.project_id})`);
    }
  } catch (err) {
    console.error('[Google Auth] Error al inicializar credenciales:', err.message);
  }
}

initGoogleAuth();

async function ensureApartadosSubfolder(drive, parentFolderId) {
  try {
    const q = `mimeType='application/vnd.google-apps.folder' and name='APARTADOS' and '${parentFolderId}' in parents and trashed=false`;
    const list = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
    if (list.data.files && list.data.files.length > 0) return list.data.files[0].id;
    const created = await drive.files.create({
      requestBody: { name: 'APARTADOS', mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
      fields: 'id'
    });
    return created.data.id;
  } catch (err) {
    return parentFolderId;
  }
}

async function uploadToGoogleDrive(filePath, fileName, mimeType, unit, toApartadosSubfolder = false) {
  const folderId = unit === 'Sucursal'
    ? process.env.GOOGLE_DRIVE_FOLDER_SUCURSAL
    : process.env.GOOGLE_DRIVE_FOLDER_MATRIZ;

  const localUrl = `/uploads/${path.relative(uploadsDir, filePath).replace(/\\/g, '/')}`;
  if (!googleAuthClient || !folderId || folderId.startsWith('ID_CARPETA')) {
    return { uploaded: false, url: localUrl, localUrl };
  }

  try {
    const drive = google.drive({ version: 'v3', auth: googleAuthClient });
    const targetParent = toApartadosSubfolder ? await ensureApartadosSubfolder(drive, folderId) : folderId;
    const response = await drive.files.create({
      requestBody: { name: fileName, parents: [targetParent] },
      media: { mimeType: mimeType || 'image/jpeg', body: fs.createReadStream(filePath) },
      fields: 'id, webViewLink'
    });
    return {
      uploaded: true,
      fileId: response.data.id,
      url: response.data.webViewLink || `https://drive.google.com/file/d/${response.data.id}/view`,
      localUrl
    };
  } catch (err) {
    console.error('[Google Drive] Error al subir archivo:', err.message);
    return { uploaded: false, error: err.message, url: localUrl, localUrl };
  }
}

async function syncEventToGoogleCalendar(ev) {
  const calendarId = ev.unit === 'Sucursal'
    ? process.env.GOOGLE_CALENDAR_ID_SUCURSAL
    : process.env.GOOGLE_CALENDAR_ID_MATRIZ;

  if (!googleAuthClient || !calendarId || calendarId.startsWith('ID_CALENDARIO')) {
    return { synced: false, reason: 'calendar_id_no_configurado' };
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth: googleAuthClient });
    const nextDay = new Date(`${ev.date}T12:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const endDate = nextDay.toISOString().slice(0, 10);

    const descParts = [
      `Unidad: ${ev.unit}`,
      `Tipo: ${ev.type}`,
      ev.note_number ? `Nota: ${ev.note_number}` : '',
      `Cliente: ${ev.client}`,
      `Origen: ${ev.dispatch_origin || 'Sucursal Matriz'} (${resolveOriginAddress(ev.dispatch_origin)})`,
      `Total: $${ev.amount || 0}`,
      ev.deposit_amount ? `Anticipo: $${ev.deposit_amount} | Saldo por cobrar: $${Math.max(0, (ev.amount || 0) - ev.deposit_amount)}` : '',
      ev.decoracion_detalle ? `Decoración / Detalles: ${ev.decoracion_detalle}` : '',
      `Respaldo Nota Drive: ${ev.receipt_image_url || 'N/A'}`
    ].filter(Boolean).join('\n');

    const created = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: `[${ev.unit} - ${ev.type}] ${ev.title}`,
        location: ev.address || resolveOriginAddress(ev.unit),
        description: descParts,
        start: { date: ev.date },
        end: { date: endDate }
      }
    });
    return { synced: true, htmlLink: created.data.htmlLink, eventId: created.data.id };
  } catch (err) {
    console.error('[Google Calendar] Error al sincronizar evento:', err.message);
    return { synced: false, error: err.message };
  }
}

async function runGeminiVisionOCR(filePath, mimeType) {
  const apiKey = process.env.VISION_API_KEY;
  if (!apiKey || apiKey.startsWith('TU_API_KEY')) return null;

  try {
    const base64Data = fs.readFileSync(filePath).toString('base64');
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt = `Analiza esta nota o recibo de venta/apartado de "A.D.G. Muebles & Artesanías" (Apizaco, Tlaxcala).
Devuelve EXCLUSIVAMENTE un JSON válido (sin markdown ni texto extra):
{
  "raw_text": "texto completo legible de la nota",
  "note_number": "número de nota ej. Nota 1",
  "client": "nombre del cliente",
  "client_phone": "teléfono del cliente si aparece o vacío",
  "location_unit": "Matriz" | "Sucursal",
  "movement_type": "Venta" | "Apartado" | "Entrada" | "Salida" | "Gasto",
  "payment_method": "Efectivo" | "Tarjeta" | "Transferencia",
  "total_venta": 0,
  "deposit_amount": 0,
  "layaway_date": "YYYY-MM-DD o vacío",
  "layaway_due_date": "YYYY-MM-DD o vacío",
  "requires_delivery": true | false,
  "delivery_date": "YYYY-MM-DD o vacío",
  "delivery_address": "dirección si aparece o vacío",
  "decoracion_detalle": "toda la decoración, accesorios, acabados o notas especiales",
  "items": [
    { "category": "Muebles" | "Artesanías", "description": "descripción", "quantity": 1, "unit_price": 0 }
  ]
}`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64Data } }
          ]
        }]
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[Gemini Vision OCR] Fallback a extracción manual:', err.message);
    return null;
  }
}

// =========================================================
// 4. CORREO SMTP AUTOMÁTICO + COPIA A CESAR + BITÁCORA TOTAL
// =========================================================
const REPORT_COPY_EMAIL = process.env.REPORT_COPY_EMAIL || 'cesar6452gangster@gmail.com';
const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendNotificationEmail({ to, cc, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return 'sin_smtp';
  try {
    await mailTransporter.sendMail({
      from: `"A.D.G. Muebles & Artesanías ERP" <${process.env.SMTP_USER}>`,
      to,
      cc,
      subject,
      html
    });
    return 'enviado';
  } catch (err) {
    console.error('[SMTP] Error enviando correo:', err.message);
    return `error_smtp: ${err.message}`;
  }
}

function recordActivityAndNotify(user, { unit, action, entityType, entityId, detail, emailSubject, emailHtml, sendEmail = true }) {
  const now = new Date().toISOString();
  const uname = user ? user.username : 'sistema';
  const udisplay = user ? user.display_name : 'Sistema';
  const urole = user ? user.role : 'SYSTEM';
  const uunit = unit || (user ? user.unit : 'Global');

  const inserted = db.prepare(`
    INSERT INTO activity_logs (created_at, username, user_display_name, user_role, unit, action, entity_type, entity_id, detail, email_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now, uname, udisplay, urole, uunit, action, entityType, entityId || '', detail, sendEmail ? 'enviando' : 'solo_bitacora');

  const logId = inserted.lastInsertRowid;

  if (sendEmail && REPORT_COPY_EMAIL) {
    const subj = emailSubject || `[A.D.G. ERP · ${uunit}] ${action} — ${udisplay}`;
    const bodyHtml = emailHtml || `
      <div style="font-family:sans-serif;max-width:620px;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h2 style="margin-top:0;color:#0f172a;">A.D.G. Muebles &amp; Artesanías — Reporte Automático</h2>
        <p><strong>Usuario:</strong> ${udisplay} (<code>${uname}</code> · ${urole})</p>
        <p><strong>Unidad:</strong> ${uunit}</p>
        <p><strong>Acción:</strong> ${action}</p>
        <p><strong>Fecha/Hora:</strong> ${now}</p>
        <div style="background:#f8fafc;border-left:4px solid #0284c7;padding:12px;margin-top:12px;">${detail}</div>
      </div>
    `;
    sendNotificationEmail({ to: REPORT_COPY_EMAIL, subject: subj, html: bodyHtml })
      .then((status) => {
        try { db.prepare('UPDATE activity_logs SET email_status = ? WHERE id = ?').run(status, logId); } catch (_) {}
      })
      .catch(() => {});
  }

  return logId;
}

// =========================================================
// 5. MIDDLEWARE DE AUTENTICACIÓN Y PERMISOS
// =========================================================
function serializeUser(row) {
  if (!row) return null;
  let perms = {};
  try { perms = JSON.parse(row.permissions_json); } catch (_) {}
  const isDriver = row.role === 'CHOFER_LOGISTICA';
  return {
    username: row.username,
    display_name: row.display_name,
    nombre: row.display_name,
    role: row.role,
    rol: row.role,
    unit: row.unit,
    active: !!row.active,
    permisos: perms,
    vehiculoAsignado: isDriver ? DRIVER_VEHICLE : null
  };
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.query.token || '');
  if (!token) return res.status(401).json({ ok: false, error: 'Sesión requerida.' });
  const sess = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.username = s.username
    WHERE s.token = ? AND u.active = 1
  `).get(token);
  if (!sess) return res.status(401).json({ ok: false, error: 'Sesión inválida o usuario desactivado.' });
  req.user = serializeUser(sess);
  req.authToken = token;
  next();
}

function requirePermission(permKey) {
  return (req, res, next) => {
    if (!req.user || !req.user.permisos || req.user.permisos[permKey] !== true) {
      return res.status(403).json({ ok: false, error: `Acceso denegado: tu usuario (${req.user?.display_name || 'desconocido'}) no tiene permiso para esta acción.` });
    }
    next();
  };
}

function extraerDatosLogisticosOCR(textoCompletoImagen) {
  const datosLogistica = {
    ubicacionOrigen: 'Sucursal Matriz',
    direccionOrigen: BRANCH_LOCATIONS.Matriz.address,
    requiereDespachoEspecial: false
  };
  if (/bodega|atotonilco|domingo arenas/i.test(textoCompletoImagen || '')) {
    datosLogistica.ubicacionOrigen = 'Bodega San Antonio Atotonilco';
    datosLogistica.direccionOrigen = BRANCH_LOCATIONS.Bodega.address;
    datosLogistica.requiereDespachoEspecial = true;
  } else if (/sucursal|xicohtencatl|xicotencatl/i.test(textoCompletoImagen || '')) {
    datosLogistica.ubicacionOrigen = 'Sucursal Centro';
    datosLogistica.direccionOrigen = BRANCH_LOCATIONS.Sucursal.address;
  }
  return datosLogistica;
}

function getIntegrationStatus() {
  return {
    sqlite: true,
    googleServiceAccount: serviceAccountMeta.loaded,
    googleProjectId: serviceAccountMeta.projectId,
    googleClientEmail: serviceAccountMeta.clientEmail,
    driveConfigured: !!(serviceAccountMeta.loaded && (process.env.GOOGLE_DRIVE_FOLDER_MATRIZ || process.env.GOOGLE_DRIVE_FOLDER_SUCURSAL)),
    calendarConfigured: !!(serviceAccountMeta.loaded && (process.env.GOOGLE_CALENDAR_ID_MATRIZ || process.env.GOOGLE_CALENDAR_ID_SUCURSAL)),
    visionConfigured: !!(process.env.VISION_API_KEY && !process.env.VISION_API_KEY.startsWith('TU_API_KEY')),
    smtpConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
    reportCopyEmail: REPORT_COPY_EMAIL
  };
}

function getExpiringLayaways() {
  const today = new Date();
  const limit = new Date(today.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT id, title, layaway_note_no, layaway_client, layaway_phone, layaway_due_date, price, layaway_deposit
    FROM catalog_items
    WHERE folder_status = 'Apartado' AND layaway_due_date IS NOT NULL AND layaway_due_date <= ?
    ORDER BY layaway_due_date ASC
  `).all(limit);
  const todayStr = today.toISOString().slice(0, 10);
  return rows.map((r) => ({
    ...r,
    balance: Math.max(0, (r.price || 0) - (r.layaway_deposit || 0)),
    overdue: r.layaway_due_date < todayStr
  }));
}

function buildFrontendState(requestUser) {
  const txRows = db.prepare('SELECT * FROM transactions ORDER BY timestamp DESC').all();
  const itemRows = db.prepare('SELECT * FROM transaction_items ORDER BY id ASC').all();
  const itemsByTx = new Map();
  for (const it of itemRows) {
    if (!itemsByTx.has(it.transaction_id)) itemsByTx.set(it.transaction_id, []);
    itemsByTx.get(it.transaction_id).push({
      category: it.category,
      description: it.description,
      quantity: it.quantity,
      unit_price: it.unit_price
    });
  }

  const transactions = txRows.map((t) => ({
    id: t.id,
    timestamp: t.timestamp,
    receipt_image_url: t.receipt_image_url,
    location_unit: t.location_unit,
    client: t.client,
    movement_type: t.movement_type,
    payment_method: t.payment_method,
    deposit_amount: t.deposit_amount || 0,
    note_number: t.note_number || '',
    layaway_date: t.layaway_date || '',
    layaway_due_date: t.layaway_due_date || '',
    decoracion_detalle: t.decoracion_detalle || '',
    catalog_item_id: t.catalog_item_id || '',
    catalog_image_url: t.catalog_image_url || '',
    created_by: t.created_by || '',
    items: itemsByTx.get(t.id) || [],
    financial_summary: {
      subtotal_muebles: t.subtotal_muebles,
      subtotal_artesanias: t.subtotal_artesanias,
      total_venta: t.total_venta
    },
    scheduling: {
      requires_delivery: !!t.requires_delivery,
      delivery_date: t.delivery_date || '',
      delivery_address: t.delivery_address || '',
      ubicacionOrigen: t.origin_location || 'Sucursal Matriz',
      requiereDespachoEspecial: !!t.special_dispatch
    }
  }));

  const inventory = db.prepare('SELECT * FROM inventory ORDER BY category, sku').all();

  const paymentRows = db.prepare('SELECT * FROM layaway_payments ORDER BY id DESC').all();
  const paymentsByItem = new Map();
  for (const p of paymentRows) {
    if (!paymentsByItem.has(p.catalog_item_id)) paymentsByItem.set(p.catalog_item_id, []);
    paymentsByItem.get(p.catalog_item_id).push(p);
  }
  const catalogItems = db.prepare('SELECT * FROM catalog_items ORDER BY updated_at DESC, id ASC').all().map((c) => ({
    ...c,
    payments: paymentsByItem.get(c.id) || []
  }));

  const noteRows = db.prepare('SELECT * FROM order_notes ORDER BY id ASC').all();
  const notesByEvent = new Map();
  for (const n of noteRows) {
    if (!notesByEvent.has(n.event_id)) notesByEvent.set(n.event_id, []);
    notesByEvent.get(n.event_id).push(n);
  }

  const evRows = db.prepare('SELECT * FROM calendar_events ORDER BY date ASC, id ASC').all();
  const calendarEvents = evRows.map((ev) => {
    let checklist = [];
    try { checklist = JSON.parse(ev.checklist_json || '[]'); } catch (_) {}
    if (!checklist.length && ev.type === 'Entrega') {
      try { checklist = JSON.parse(defaultChecklistForTitle(ev.title, ev.decoracion_detalle)); } catch (_) {}
    }
    return {
      id: ev.id,
      unit: ev.unit,
      type: ev.type,
      date: ev.date,
      title: ev.title,
      client: ev.client,
      address: ev.address,
      amount: ev.amount,
      deposit_amount: ev.deposit_amount || 0,
      note_number: ev.note_number || '',
      decoracion_detalle: ev.decoracion_detalle || '',
      receipt_image_url: ev.receipt_image_url,
      catalog_image_url: ev.catalog_image_url || '',
      transaction_id: ev.transaction_id,
      dispatch_origin: ev.dispatch_origin || 'Sucursal Matriz',
      dispatch_origin_address: resolveOriginAddress(ev.dispatch_origin),
      requiereDespachoEspecial: !!ev.special_dispatch,
      cargo: {
        volumenM3: ev.cargo_volume_m3 || 3.5,
        largoM: ev.cargo_length_m || 1.9,
        altoM: ev.cargo_height_m || 1.0
      },
      assignedDriver: ev.assigned_driver || 'conductor1',
      deliveryStatus: ev.delivered ? 'Entregado' : (ev.delivery_status || 'Pendiente'),
      clientPhone: ev.client_phone || '',
      clientConfirmedHome: !!ev.client_confirmed_home,
      checklist,
      balanceToCollect: Number(ev.balance_to_collect) || 0,
      balanceCollected: !!ev.balance_collected,
      balancePaymentMethod: ev.balance_payment_method || '',
      deliveryPhotoUrl: ev.delivery_photo_url || '',
      incidentPhotoUrl: ev.incident_photo_url || '',
      incidentReason: ev.incident_reason || '',
      orderNotes: notesByEvent.get(ev.id) || [],
      delivered: !!ev.delivered,
      deliveredAt: ev.delivered_at || '',
      deliveredBy: ev.delivered_by || '',
      clientEmail: ev.client_email || '',
      satisfactionRating: ev.satisfaction_rating || 0,
      satisfactionComment: ev.satisfaction_comment || '',
      marbleClauseAccepted: !!ev.marble_clause_accepted,
      signatureDataUrl: ev.signature_data_url || ''
    };
  });

  const cashM = db.prepare(`SELECT * FROM cash_register_days WHERE unit = 'Matriz' ORDER BY date DESC LIMIT 1`).get();
  const cashS = db.prepare(`SELECT * FROM cash_register_days WHERE unit = 'Sucursal' ORDER BY date DESC LIMIT 1`).get();
  const cashRegister = {
    Matriz: {
      fondo_inicial: cashM ? cashM.fondo_inicial : 5000,
      efectivo_contado: cashM && cashM.efectivo_contado !== null ? String(cashM.efectivo_contado) : ''
    },
    Sucursal: {
      fondo_inicial: cashS ? cashS.fondo_inicial : 3000,
      efectivo_contado: cashS && cashS.efectivo_contado !== null ? String(cashS.efectivo_contado) : ''
    }
  };

  const logRows = db.prepare('SELECT * FROM webhook_logs ORDER BY id DESC LIMIT 40').all();
  const webhooks = logRows.map((w) => ({
    time: String(w.created_at || '').slice(11, 19) || '00:00:00',
    unit: w.unit,
    event: w.event_name,
    detail: w.detail
  }));

  const transfers = db.prepare('SELECT * FROM transfers ORDER BY updated_at DESC LIMIT 50').all();
  const fuelLogs = db.prepare('SELECT * FROM fuel_logs ORDER BY id DESC LIMIT 50').all();
  const expiringLayaways = getExpiringLayaways();

  const canSeeActivity = requestUser?.permisos?.verBitacora === true;
  const activityLogs = canSeeActivity
    ? db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 150').all()
    : [];

  return {
    transactions,
    inventory,
    catalogItems,
    calendarEvents,
    transfers,
    fuelLogs,
    expiringLayaways,
    cashRegister,
    webhooks,
    activityLogs,
    cierreLog: [],
    branchLocations: BRANCH_LOCATIONS,
    integrationStatus: getIntegrationStatus()
  };
}

// =========================================================
// 6. ENDPOINTS PÚBLICOS: LOGIN & CONFIG STATUS
// =========================================================
app.get('/api/config/status', (req, res) => {
  res.json({ ok: true, status: getIntegrationStatus(), branchLocations: BRANCH_LOCATIONS });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  const pass = String(password || '').trim();
  if (!uname || !pass) return res.status(400).json({ ok: false, error: 'Ingresa tu usuario y contraseña.' });

  const row = db.prepare('SELECT * FROM users WHERE LOWER(username) = ? AND active = 1').get(uname);
  if (!row || row.password_hash !== hashPassword(pass)) {
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos (o cuenta desactivada).' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)').run(token, row.username, new Date().toISOString());

  const userObj = serializeUser(row);
  recordActivityAndNotify(userObj, {
    unit: userObj.unit,
    action: 'auth.login',
    entityType: 'session',
    entityId: row.username,
    detail: `Inicio de sesión de ${userObj.display_name} (${userObj.role})`,
    sendEmail: false
  });

  res.json({ ok: true, token, usuario: userObj });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.authToken);
  recordActivityAndNotify(req.user, {
    unit: req.user.unit,
    action: 'auth.logout',
    entityType: 'session',
    entityId: req.user.username,
    detail: `Cierre de sesión de ${req.user.display_name}`,
    sendEmail: false
  });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, usuario: req.user });
});

// =========================================================
// 7. GESTIÓN DE USUARIOS, ALTAS, BAJAS Y CONTRASEÑAS (ADMIN / DEV)
// =========================================================
app.get('/api/users', requireAuth, requirePermission('gestionarUsuarios'), (req, res) => {
  const rows = db.prepare('SELECT username, display_name, role, unit, permissions_json, active, created_at FROM users ORDER BY rowid ASC').all();
  res.json({ ok: true, users: rows.map(serializeUser) });
});

app.post('/api/users', requireAuth, requirePermission('gestionarUsuarios'), (req, res) => {
  const { username, password, displayName, role, unit } = req.body || {};
  const uname = String(username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  const pass = String(password || '').trim();
  if (!uname || pass.length < 4 || !displayName) {
    return res.status(400).json({ ok: false, error: 'Ingresa usuario válido, nombre y contraseña (mín. 4 caracteres).' });
  }
  const exists = db.prepare('SELECT username FROM users WHERE LOWER(username) = ?').get(uname);
  if (exists) return res.status(409).json({ ok: false, error: `El usuario @${uname} ya existe.` });

  let perms = WORKER_PERMS_STD;
  if (role === 'DESARROLLADOR' || role === 'ADMIN') perms = FULL_ADMIN_PERMS;
  else if (role === 'ADMINISTRADORA') perms = ADMINISTRADORA_PERMS;
  else if (role === 'CHOFER_LOGISTICA') perms = DRIVER_PERMS;
  else if (role === 'TRABAJADORA_SIN_FOTOS') perms = WORKER_PERMS_NO_PHOTO_EDIT;

  db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, unit, permissions_json, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(uname, hashPassword(pass), displayName.trim(), role || 'TRABAJADORA_MATRIZ', unit || 'Matriz', JSON.stringify(perms), new Date().toISOString());

  recordActivityAndNotify(req.user, {
    unit: unit || 'Global',
    action: 'usuario.creado',
    entityType: 'user',
    entityId: uname,
    detail: `${req.user.display_name} creó el usuario "${displayName.trim()}" (@${uname} · ${role} · ${unit}).`,
    sendEmail: true
  });

  res.json({ ok: true, username: uname });
});

app.put('/api/users/:username/password', requireAuth, requirePermission('gestionarUsuarios'), (req, res) => {
  const targetUsername = String(req.params.username || '').trim().toLowerCase();
  const { newPassword, displayName } = req.body || {};
  if (!newPassword || String(newPassword).trim().length < 4) {
    return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  }
  const existing = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(targetUsername);
  if (!existing) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });

  db.prepare('UPDATE users SET password_hash = ?, display_name = ? WHERE username = ?')
    .run(hashPassword(String(newPassword).trim()), (displayName || existing.display_name).trim(), existing.username);

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'usuario.password.actualizada',
    entityType: 'user',
    entityId: existing.username,
    detail: `${req.user.display_name} actualizó la contraseña de "${existing.display_name}" (@${existing.username}).`,
    sendEmail: true
  });

  res.json({ ok: true, message: `Contraseña actualizada para ${existing.username}` });
});

app.put('/api/users/:username/active', requireAuth, requirePermission('gestionarUsuarios'), (req, res) => {
  const targetUsername = String(req.params.username || '').trim().toLowerCase();
  if (targetUsername === req.user.username) {
    return res.status(400).json({ ok: false, error: 'No puedes desactivar tu propia cuenta activa.' });
  }
  const existing = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(targetUsername);
  if (!existing) return res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });

  const nextActive = req.body?.active ? 1 : 0;
  db.prepare('UPDATE users SET active = ? WHERE username = ?').run(nextActive, existing.username);
  if (!nextActive) db.prepare('DELETE FROM sessions WHERE username = ?').run(existing.username);

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: nextActive ? 'usuario.activado' : 'usuario.desactivado',
    entityType: 'user',
    entityId: existing.username,
    detail: `${req.user.display_name} ${nextActive ? 'activó' : 'desactivó'} la cuenta de "${existing.display_name}" (@${existing.username}).`,
    sendEmail: true
  });

  res.json({ ok: true, active: !!nextActive });
});

// =========================================================
// 8. PANEL EXCLUSIVO DESARROLLADOR: DIAGNÓSTICO EN VIVO + BACKUP
// =========================================================
app.post('/api/dev/diagnostics', requireAuth, requirePermission('devTools'), async (req, res) => {
  const checks = {
    sqlite: { ok: false, detail: '' },
    googleAuth: { ok: false, detail: '' },
    googleDrive: { ok: false, detail: '' },
    googleCalendar: { ok: false, detail: '' },
    visionOcr: { ok: false, detail: '' },
    smtpEmail: { ok: false, detail: '' }
  };

  try {
    const c = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    checks.sqlite = { ok: true, detail: `SQLite activo (${c} usuarios, archivo ${dbPath})` };
  } catch (e) {
    checks.sqlite = { ok: false, detail: e.message };
  }

  checks.googleAuth = serviceAccountMeta.loaded
    ? { ok: true, detail: `Cuenta de servicio: ${serviceAccountMeta.clientEmail}` }
    : { ok: false, detail: 'Falta archivo secrets/google-service-account.json' };

  if (googleAuthClient && process.env.GOOGLE_DRIVE_FOLDER_MATRIZ) {
    try {
      const drive = google.drive({ version: 'v3', auth: googleAuthClient });
      const r = await drive.files.get({ fileId: process.env.GOOGLE_DRIVE_FOLDER_MATRIZ, fields: 'id, name' });
      checks.googleDrive = { ok: true, detail: `Conectado a carpeta "${r.data.name}" + Sucursal lista` };
    } catch (e) {
      checks.googleDrive = { ok: false, detail: `Error Drive: ${e.message}` };
    }
  } else {
    checks.googleDrive = { ok: false, detail: 'Falta GOOGLE_DRIVE_FOLDER_MATRIZ en .env' };
  }

  if (googleAuthClient && process.env.GOOGLE_CALENDAR_ID_MATRIZ) {
    try {
      const calendar = google.calendar({ version: 'v3', auth: googleAuthClient });
      const r = await calendar.calendars.get({ calendarId: process.env.GOOGLE_CALENDAR_ID_MATRIZ });
      checks.googleCalendar = { ok: true, detail: `Conectado a calendario "${r.data.summary}"` };
    } catch (e) {
      checks.googleCalendar = { ok: false, detail: `Comparte el calendario con ${serviceAccountMeta.clientEmail} (${e.message})` };
    }
  } else {
    checks.googleCalendar = { ok: false, detail: 'Falta GOOGLE_CALENDAR_ID_MATRIZ en .env' };
  }

  if (process.env.VISION_API_KEY && !process.env.VISION_API_KEY.startsWith('TU_API_KEY')) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(process.env.VISION_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'OK' }] }] })
      });
      if (r.ok) {
        checks.visionOcr = { ok: true, detail: 'Gemini 3.8 Flash Vision OCR conectado y verificado en vivo' };
      } else {
        const errTxt = await r.text();
        checks.visionOcr = { ok: false, detail: `Error Gemini Vision HTTP ${r.status}: ${errTxt.slice(0, 120)}` };
      }
    } catch (e) {
      checks.visionOcr = { ok: false, detail: `Error conexión Vision: ${e.message}` };
    }
  } else {
    checks.visionOcr = { ok: false, detail: 'Sin VISION_API_KEY en .env (OCR en modo captura manual/asistida)' };
  }

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await mailTransporter.verify();
      checks.smtpEmail = { ok: true, detail: `SMTP conectado (${process.env.SMTP_USER} → copias a ${REPORT_COPY_EMAIL})` };
    } catch (e) {
      checks.smtpEmail = { ok: false, detail: `Gmail rechazó login SMTP: usa una Contraseña de Aplicación de 16 letras (${e.message})` };
    }
  } else {
    checks.smtpEmail = { ok: false, detail: 'Falta SMTP_USER o SMTP_PASS en .env' };
  }

  res.json({ ok: true, checks });
});

app.get('/api/dev/backup', requireAuth, requirePermission('devTools'), (req, res) => {
  const fullPath = path.resolve(__dirname, dbPath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ ok: false, error: 'Base de datos no encontrada.' });
  const stamp = new Date().toISOString().slice(0, 10);
  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'dev.backup.descargado',
    entityType: 'system',
    entityId: stamp,
    detail: `${req.user.display_name} descargó respaldo completo de base de datos (${stamp}).`,
    sendEmail: false
  });
  res.download(fullPath, `adg_muebles_backup_${stamp}.db`);
});

// =========================================================
// 9. ESTADO COMPLETO, NOTIFICACIONES EN VIVO Y RESET DEMO
// =========================================================
app.get('/api/state', requireAuth, (req, res) => {
  res.json({ ok: true, state: buildFrontendState(req.user) });
});

app.get('/api/notifications/since', requireAuth, (req, res) => {
  const afterId = Number(req.query.afterId) || 0;
  const rows = db.prepare(`
    SELECT id, created_at, user_display_name, unit, action, detail
    FROM activity_logs
    WHERE id > ?
    ORDER BY id DESC
    LIMIT 30
  `).all(afterId);
  const notifications = rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    title: `${r.action} (${r.unit})`,
    body: `${r.user_display_name}: ${r.detail}`,
    unit: r.unit
  }));
  const latestId = rows.length ? rows[0].id : afterId;
  res.json({ ok: true, notifications, latestId });
});

app.post('/api/reset-demo', requireAuth, requirePermission('gestionarUsuarios'), (req, res) => {
  seedDemoData(true);
  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'sistema.reset_demo',
    entityType: 'system',
    entityId: 'RESET',
    detail: `${req.user.display_name} restauró los datos de demostración.`,
    sendEmail: true
  });
  res.json({ ok: true, state: buildFrontendState(req.user) });
});

// =========================================================
// 10. SUBIDA DE FOTOS Y MOTOR OCR
// =========================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

const catalogStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, catalogUploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `cat_${Date.now()}_${safe}`);
  }
});
const uploadCatalog = multer({ storage: catalogStorage });

app.post('/api/ocr/procesar', requireAuth, requirePermission('subirNotas'), upload.single('nota'), async (req, res) => {
  try {
    const unit = req.body.location_unit || (req.user.unit === 'Sucursal' ? 'Sucursal' : 'Matriz');
    const fileName = req.file ? req.file.originalname : `IMG_${Date.now()}.jpg`;
    let receiptUrl = `gdrive://${unit.toLowerCase()}/notas/${fileName}`;
    let localUrl = null;
    let driveUploaded = false;
    let extracted = null;

    if (req.file) {
      const [driveRes, ocrRes] = await Promise.all([
        uploadToGoogleDrive(req.file.path, fileName, req.file.mimetype, unit, false),
        runGeminiVisionOCR(req.file.path, req.file.mimetype)
      ]);
      receiptUrl = driveRes.url;
      localUrl = driveRes.localUrl || `/uploads/${req.file.filename}`;
      driveUploaded = driveRes.uploaded;
      extracted = ocrRes;
    }

    const rawText = (extracted && extracted.raw_text)
      || req.body.textoSimulado
      || `[NOTA SUBIDA: ${fileName}]\nUnidad: ${unit}\nVerifica cliente, anticipo, fecha de apartado/vencimiento, entrega y decoración antes de confirmar.`;
    const datosLogistica = extraerDatosLogisticosOCR(rawText);

    recordActivityAndNotify(req.user, {
      unit,
      action: 'ocr.nota.procesada',
      entityType: 'ocr',
      entityId: fileName,
      detail: `Nota "${fileName}" procesada (${driveUploaded ? 'subida a Google Drive' : 'respaldo local'}). Enlace: ${receiptUrl}`,
      sendEmail: false
    });

    res.json({
      ok: true,
      receipt_image_url: receiptUrl,
      local_image_url: localUrl,
      drive_uploaded: driveUploaded,
      vision_used: !!extracted,
      extracted,
      logistics: datosLogistica,
      raw_text: rawText
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================
// 11. MÓDULO 6: CATÁLOGOS DIGITALES + APARTADOS + ABONOS MÚLTIPLES
// =========================================================
app.post('/api/catalog', requireAuth, requirePermission('editarCatalogoFotos'), uploadCatalog.single('foto'), async (req, res) => {
  try {
    const { title, category, description, price, stock_matriz, stock_sucursal, sku } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ ok: false, error: 'El nombre del artículo es obligatorio.' });
    const id = `CAT-${Date.now().toString().slice(-6)}`;
    const nowIso = new Date().toISOString();
    let imageUrl = makeCatalogSvgPlaceholder(title.trim(), `$${Number(price || 0).toLocaleString('es-MX')} MXN`, '#00f2fe');
    if (req.file) imageUrl = `/uploads/catalog/${req.file.filename}`;

    db.prepare(`
      INSERT INTO catalog_items (
        id, sku, title, category, description, price, stock_matriz, stock_sucursal,
        image_url, folder_status, created_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Disponible', ?, ?)
    `).run(
      id, (sku || id).trim(), title.trim(), (category || 'Muebles').trim(), (description || '').trim(),
      Number(price) || 0, Number(stock_matriz) || 0, Number(stock_sucursal) || 0,
      imageUrl, req.user.username, nowIso
    );

    recordActivityAndNotify(req.user, {
      unit: 'Global',
      action: 'catalogo.articulo.agregado',
      entityType: 'catalog_item',
      entityId: id,
      detail: `Se agregó "${title.trim()}" (${category || 'Muebles'}, $${Number(price || 0).toLocaleString('es-MX')}) al Catálogo Digital.`,
      sendEmail: true
    });

    res.json({ ok: true, id, state: buildFrontendState(req.user) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/catalog/:id/photo', requireAuth, requirePermission('editarCatalogoFotos'), uploadCatalog.single('foto'), (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ ok: false, error: 'Artículo no encontrado.' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'Debes seleccionar una nueva foto.' });

  const newImageUrl = `/uploads/catalog/${req.file.filename}`;
  db.prepare('UPDATE catalog_items SET image_url = ?, updated_at = ? WHERE id = ?').run(newImageUrl, new Date().toISOString(), id);

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'catalogo.foto.reemplazada',
    entityType: 'catalog_item',
    entityId: id,
    detail: `Foto reemplazada en "${item.title}" (${id}) por ${req.user.display_name}.`,
    sendEmail: true
  });

  res.json({ ok: true, image_url: newImageUrl, state: buildFrontendState(req.user) });
});

app.delete('/api/catalog/:id', requireAuth, requirePermission('editarCatalogoFotos'), (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ ok: false, error: 'Artículo no encontrado.' });
  db.prepare('DELETE FROM catalog_items WHERE id = ?').run(id);

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'catalogo.articulo.eliminado',
    entityType: 'catalog_item',
    entityId: id,
    detail: `Artículo ELIMINADO del Catálogo: "${item.title}" (${id}, $${item.price}) por ${req.user.display_name}.`,
    sendEmail: true
  });

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

app.post('/api/catalog/:id/reportar', requireAuth, requirePermission('reportarDesdeCatalogo'), upload.single('nota'), async (req, res) => {
  try {
    const { id } = req.params;
    const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ ok: false, error: 'Artículo no encontrado en el catálogo.' });

    const body = req.body || {};
    const movementType = body.movement_type === 'Venta' ? 'Venta' : 'Apartado';
    const unit = body.location_unit === 'Sucursal' ? 'Sucursal' : 'Matriz';
    const client = (body.client || 'Cliente Mostrador').trim();
    const clientPhone = (body.client_phone || '').trim();
    const noteNumber = (body.note_number || `Nota ${Date.now().toString().slice(-4)}`).trim();
    const paymentMethod = ['Efectivo', 'Tarjeta', 'Transferencia'].includes(body.payment_method) ? body.payment_method : 'Efectivo';
    const totalVenta = Number(body.total_venta || item.price) || 0;
    const depositAmount = Number(body.deposit_amount || (movementType === 'Venta' ? totalVenta : 0)) || 0;
    const balanceDue = Math.max(0, totalVenta - depositAmount);
    const todayIso = new Date().toISOString().slice(0, 10);
    const layawayDate = body.layaway_date || todayIso;
    const layawayDueDate = body.layaway_due_date || todayIso;
    const deliveryDate = body.delivery_date || '';
    const deliveryAddress = (body.delivery_address || resolveOriginAddress(unit)).trim();
    const decoracionDetalle = (body.decoracion_detalle || item.description || '').trim();
    const isApartado = movementType === 'Apartado';
    const dispatchOrigin = unit === 'Matriz' ? 'Sucursal Matriz' : 'Sucursal Centro';

    let receiptUrl = body.receipt_image_url || `gdrive://${unit.toLowerCase()}/notas/${noteNumber.replace(/\s+/g, '_')}.jpg`;
    let driveUploaded = false;
    let articleDriveUrl = item.image_url;

    if (req.file) {
      const notaFileName = `${noteNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}_${client.replace(/[^a-zA-Z0-9_-]/g, '_')}_${req.file.originalname}`;
      const upNota = await uploadToGoogleDrive(req.file.path, notaFileName, req.file.mimetype, unit, isApartado);
      receiptUrl = upNota.url;
      driveUploaded = upNota.uploaded;
      if (isApartado) {
        await uploadToGoogleDrive(req.file.path, `NOTA_${notaFileName}`, req.file.mimetype, unit, false);
      }
    }

    if (item.image_url && item.image_url.startsWith('/uploads/')) {
      const localArticlePath = path.join(__dirname, item.image_url.replace(/^\//, ''));
      if (fs.existsSync(localArticlePath)) {
        const upArt = await uploadToGoogleDrive(localArticlePath, `ARTICULO_${noteNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}_${path.basename(localArticlePath)}`, 'image/jpeg', unit, isApartado);
        if (upArt.uploaded) articleDriveUrl = upArt.url;
      }
    }

    const txId = `${isApartado ? 'APT' : 'TX'}-${Date.now().toString().slice(-6)}`;
    const isMueble = !/artesan|jarr|vel|maripos|elefant|cuadro|accesor|decor/i.test(item.category || '');
    const subM = isMueble ? totalVenta : 0;
    const subA = isMueble ? 0 : totalVenta;
    const stockCol = unit === 'Matriz' ? 'stock_matriz' : 'stock_sucursal';
    const eventsToSync = [];

    runTransaction(() => {
      db.prepare(`
        INSERT INTO transactions (
          id, timestamp, receipt_image_url, location_unit, client, movement_type,
          payment_method, subtotal_muebles, subtotal_artesanias, total_venta,
          deposit_amount, note_number, layaway_date, layaway_due_date, decoracion_detalle,
          catalog_item_id, catalog_image_url, requires_delivery, delivery_date, delivery_address,
          origin_location, special_dispatch, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        txId, new Date().toISOString().slice(0, 19), receiptUrl, unit, client, movementType,
        paymentMethod, subM, subA, totalVenta, depositAmount, noteNumber,
        isApartado ? layawayDate : null, isApartado ? layawayDueDate : null, decoracionDetalle,
        item.id, articleDriveUrl, deliveryDate ? 1 : 0, deliveryDate || null, deliveryAddress,
        dispatchOrigin, 0, req.user.username
      );

      db.prepare(`INSERT INTO transaction_items (transaction_id, category, description, quantity, unit_price) VALUES (?, ?, ?, 1, ?)`)
        .run(txId, isMueble ? 'Muebles' : 'Artesanías', `${item.title}${decoracionDetalle ? ' · ' + decoracionDetalle : ''}`, totalVenta);

      if (isApartado) {
        db.prepare(`
          UPDATE catalog_items SET
            folder_status = 'Apartado',
            layaway_note_no = ?, layaway_client = ?, layaway_phone = ?, layaway_deposit = ?,
            layaway_date = ?, layaway_due_date = ?, layaway_decoracion = ?, layaway_receipt_url = ?, updated_at = ?
          WHERE id = ?
        `).run(noteNumber, client, clientPhone, depositAmount, layawayDate, layawayDueDate, decoracionDetalle, receiptUrl, new Date().toISOString(), item.id);

        if (depositAmount > 0) {
          db.prepare(`
            INSERT INTO layaway_payments (catalog_item_id, amount, payment_method, receipt_url, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(item.id, depositAmount, paymentMethod, receiptUrl, `Anticipo inicial (${noteNumber})`, req.user.display_name, new Date().toISOString());
        }
      } else {
        const newStockM = unit === 'Matriz' ? Math.max(0, item.stock_matriz - 1) : item.stock_matriz;
        const newStockS = unit === 'Sucursal' ? Math.max(0, item.stock_sucursal - 1) : item.stock_sucursal;
        const newStatus = (newStockM + newStockS) <= 0 ? 'Vendido' : 'Disponible';
        db.prepare(`UPDATE catalog_items SET stock_matriz = ?, stock_sucursal = ?, folder_status = ?, updated_at = ? WHERE id = ?`)
          .run(newStockM, newStockS, newStatus, new Date().toISOString(), item.id);
        db.prepare(`UPDATE inventory SET ${stockCol} = MAX(0, ${stockCol} - 1) WHERE sku = ?`).run(item.sku || '');
      }

      if (isApartado) {
        const evExpId = `EV-APT-${Date.now().toString().slice(-5)}`;
        const expTitle = `⏰ Se venció el tiempo de ${noteNumber} · ${item.title}${decoracionDetalle ? ' (' + decoracionDetalle + ')' : ''}`;
        const expEv = {
          id: evExpId, unit, type: 'Apartado', date: layawayDueDate, title: expTitle,
          client, address: deliveryAddress, amount: totalVenta, deposit_amount: depositAmount,
          note_number: noteNumber, decoracion_detalle: decoracionDetalle,
          receipt_image_url: receiptUrl, catalog_image_url: articleDriveUrl,
          transaction_id: txId, dispatch_origin: dispatchOrigin
        };
        db.prepare(`
          INSERT INTO calendar_events (
            id, unit, type, date, title, client, address, amount, deposit_amount, note_number,
            decoracion_detalle, receipt_image_url, catalog_image_url, transaction_id, dispatch_origin,
            client_phone, balance_to_collect
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          expEv.id, expEv.unit, expEv.type, expEv.date, expEv.title, expEv.client, expEv.address,
          expEv.amount, expEv.deposit_amount, expEv.note_number, expEv.decoracion_detalle,
          expEv.receipt_image_url, expEv.catalog_image_url, expEv.transaction_id, expEv.dispatch_origin,
          clientPhone, balanceDue
        );
        eventsToSync.push(expEv);
      }

      if (deliveryDate || !isApartado) {
        const evId = `EV-${Date.now().toString().slice(-6)}`;
        const evType = deliveryDate ? 'Entrega' : 'Salida';
        const evDate = deliveryDate || todayIso;
        const evTitle = `${evType} (${noteNumber}): ${item.title}${decoracionDetalle ? ' · Decoración: ' + decoracionDetalle : ''}`;
        const delEv = {
          id: evId, unit, type: evType, date: evDate, title: evTitle,
          client, address: deliveryAddress, amount: totalVenta, deposit_amount: depositAmount,
          note_number: noteNumber, decoracion_detalle: decoracionDetalle,
          receipt_image_url: receiptUrl, catalog_image_url: articleDriveUrl,
          transaction_id: txId, dispatch_origin: dispatchOrigin
        };
        db.prepare(`
          INSERT INTO calendar_events (
            id, unit, type, date, title, client, address, amount, deposit_amount, note_number,
            decoracion_detalle, receipt_image_url, catalog_image_url, transaction_id, dispatch_origin,
            client_phone, checklist_json, balance_to_collect
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          delEv.id, delEv.unit, delEv.type, delEv.date, delEv.title, delEv.client, delEv.address,
          delEv.amount, delEv.deposit_amount, delEv.note_number, delEv.decoracion_detalle,
          delEv.receipt_image_url, delEv.catalog_image_url, delEv.transaction_id, delEv.dispatch_origin,
          clientPhone, defaultChecklistForTitle(item.title, decoracionDetalle), balanceDue
        );
        eventsToSync.push(delEv);
      }

      db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, ?, ?)`).run(
        new Date().toISOString(), unit, isApartado ? 'apartado.agendado' : 'catalogo.venta.agendada',
        `${noteNumber} (${client}) · ${item.title} · Anticipo $${depositAmount} / Total $${totalVenta} -> ${receiptUrl}`
      );
    });

    const gcalResults = [];
    for (const ev of eventsToSync) gcalResults.push({ id: ev.id, ...(await syncEventToGoogleCalendar(ev)) });

    recordActivityAndNotify(req.user, {
      unit,
      action: isApartado ? 'catalogo.apartado.registrado' : 'catalogo.venta.registrada',
      entityType: 'catalog_item',
      entityId: item.id,
      detail: `${movementType.toUpperCase()} (${noteNumber}) | Artículo: "${item.title}" | Cliente: ${client} | Total: $${totalVenta.toLocaleString('es-MX')} | Anticipo: $${depositAmount.toLocaleString('es-MX')} | Saldo: $${balanceDue.toLocaleString('es-MX')} | ${isApartado ? `Apartado ${layawayDate} → Vence ${layawayDueDate}` : ''} | Decoración: ${decoracionDetalle || 'Sin notas'}`,
      emailSubject: `[A.D.G. ${unit}] ${movementType} ${noteNumber} — ${item.title} (${client})`,
      sendEmail: true
    });

    res.json({ ok: true, txId, driveUploaded, gcalResults, movedToApartados: isApartado, state: buildFrontendState(req.user) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Registrar Abono adicional en un Apartado
app.post('/api/catalog/:id/abono', requireAuth, requirePermission('reportarDesdeCatalogo'), upload.single('recibo'), async (req, res) => {
  try {
    const { id } = req.params;
    const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
    if (!item || item.folder_status !== 'Apartado') {
      return res.status(404).json({ ok: false, error: 'Artículo apartado no encontrado.' });
    }
    const amount = Number(req.body?.amount) || 0;
    const paymentMethod = req.body?.payment_method || 'Efectivo';
    const note = (req.body?.note || '').trim();
    if (amount <= 0) return res.status(400).json({ ok: false, error: 'El monto del abono debe ser mayor a $0.' });

    let receiptUrl = '';
    if (req.file) {
      const up = await uploadToGoogleDrive(req.file.path, `ABONO_${item.layaway_note_no || id}_${req.file.originalname}`, req.file.mimetype, req.user.unit === 'Sucursal' ? 'Sucursal' : 'Matriz', true);
      receiptUrl = up.url;
    }

    const newDeposit = Number(((item.layaway_deposit || 0) + amount).toFixed(2));
    const newBalance = Math.max(0, Number((item.price - newDeposit).toFixed(2)));
    const nowIso = new Date().toISOString();

    runTransaction(() => {
      db.prepare(`
        INSERT INTO layaway_payments (catalog_item_id, amount, payment_method, receipt_url, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, amount, paymentMethod, receiptUrl, note, req.user.display_name, nowIso);

      db.prepare(`UPDATE catalog_items SET layaway_deposit = ?, updated_at = ? WHERE id = ?`).run(newDeposit, nowIso, id);
      db.prepare(`UPDATE calendar_events SET deposit_amount = ?, balance_to_collect = ? WHERE note_number = ? AND client = ?`)
        .run(newDeposit, newBalance, item.layaway_note_no || '', item.layaway_client || '');
    });

    recordActivityAndNotify(req.user, {
      unit: req.user.unit || 'Global',
      action: 'apartado.abono.registrado',
      entityType: 'catalog_item',
      entityId: id,
      detail: `Abono de $${amount.toLocaleString('es-MX')} (${paymentMethod}) en ${item.layaway_note_no || id} — "${item.title}" (${item.layaway_client}). Acumulado: $${newDeposit.toLocaleString('es-MX')} | Saldo restante: $${newBalance.toLocaleString('es-MX')}. ${note}`,
      emailSubject: `[A.D.G. Abono] +$${amount.toLocaleString('es-MX')} en ${item.layaway_note_no || id} (${item.layaway_client})`,
      sendEmail: true
    });

    res.json({ ok: true, newDeposit, newBalance, state: buildFrontendState(req.user) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/catalog/:id/liberar', requireAuth, requirePermission('liberarApartado'), (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ ok: false, error: 'Artículo no encontrado.' });

  db.prepare(`
    UPDATE catalog_items SET
      folder_status = 'Disponible',
      layaway_note_no = NULL, layaway_client = NULL, layaway_phone = NULL, layaway_deposit = 0,
      layaway_date = NULL, layaway_due_date = NULL, layaway_decoracion = NULL, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'catalogo.apartado.liberado',
    entityType: 'catalog_item',
    entityId: id,
    detail: `Artículo "${item.title}" (${item.layaway_note_no || id}) liberado de APARTADOS a Disponible.`,
    sendEmail: true
  });

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

// =========================================================
// 12. TRASPASOS ENTRE MATRIZ ↔ SUCURSAL ↔ BODEGA ATOTONILCO
// =========================================================
app.post('/api/transfers', requireAuth, (req, res) => {
  const { item_description, sku, quantity, from_location, to_location, assigned_driver, notes } = req.body || {};
  if (!item_description || !from_location || !to_location || from_location === to_location) {
    return res.status(400).json({ ok: false, error: 'Selecciona artículo y ubicaciones de origen y destino distintas.' });
  }
  const id = `TRF-${Date.now().toString().slice(-5)}`;
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO transfers (id, sku, item_description, quantity, from_location, to_location, assigned_driver, status, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Solicitado', ?, ?, ?, ?)
  `).run(id, sku || '', item_description.trim(), Math.max(1, Number(quantity) || 1), from_location, to_location, assigned_driver || 'conductor1', (notes || '').trim(), req.user.display_name, nowIso, nowIso);

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: 'traspaso.solicitado',
    entityType: 'transfer',
    entityId: id,
    detail: `Traspaso ${id}: ${quantity || 1}x "${item_description.trim()}" de ${from_location} → ${to_location} (Chofer: ${assigned_driver || 'conductor1'}). ${notes || ''}`,
    emailSubject: `[A.D.G. Traspaso ${id}] ${from_location} → ${to_location}`,
    sendEmail: true
  });

  res.json({ ok: true, id, state: buildFrontendState(req.user) });
});

app.put('/api/transfers/:id/status', requireAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!['Solicitado', 'En Camino', 'Recibido'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Estado de traspaso inválido.' });
  }
  const trf = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
  if (!trf) return res.status(404).json({ ok: false, error: 'Traspaso no encontrado.' });

  runTransaction(() => {
    db.prepare('UPDATE transfers SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    if (status === 'Recibido' && trf.status !== 'Recibido') {
      const inv = db.prepare('SELECT * FROM inventory WHERE LOWER(description) = LOWER(?) OR sku = ?').get(trf.item_description, trf.sku || '');
      if (inv) {
        if (trf.from_location.includes('Matriz')) db.prepare('UPDATE inventory SET stock_matriz = MAX(0, stock_matriz - ?) WHERE sku = ?').run(trf.quantity, inv.sku);
        if (trf.from_location.includes('Sucursal Centro')) db.prepare('UPDATE inventory SET stock_sucursal = MAX(0, stock_sucursal - ?) WHERE sku = ?').run(trf.quantity, inv.sku);
        if (trf.to_location.includes('Matriz')) db.prepare('UPDATE inventory SET stock_matriz = stock_matriz + ? WHERE sku = ?').run(trf.quantity, inv.sku);
        if (trf.to_location.includes('Sucursal Centro')) db.prepare('UPDATE inventory SET stock_sucursal = stock_sucursal + ? WHERE sku = ?').run(trf.quantity, inv.sku);
      }
    }
  });

  recordActivityAndNotify(req.user, {
    unit: 'Global',
    action: `traspaso.${status.toLowerCase().replace(/\s+/g, '_')}`,
    entityType: 'transfer',
    entityId: id,
    detail: `Traspaso ${id} (${trf.quantity}x ${trf.item_description}: ${trf.from_location} → ${trf.to_location}) cambió a estado: ${status}.`,
    sendEmail: true
  });

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

// =========================================================
// 13. LOGÍSTICA PRO: ESTADO EN VIVO, CHECKLIST, NOTAS, EVIDENCIA, INCIDENCIA & GASOLINA
// =========================================================
app.put('/api/entregas/:id/logistica', requireAuth, requirePermission('confirmarEntrega'), (req, res) => {
  const { id } = req.params;
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ ok: false, error: 'Evento no encontrado.' });

  const b = req.body || {};
  const assignedDriver = b.assignedDriver ?? ev.assigned_driver;
  const deliveryStatus = b.deliveryStatus ?? ev.delivery_status;
  const clientPhone = b.clientPhone ?? ev.client_phone;
  const clientConfirmedHome = b.clientConfirmedHome !== undefined ? (b.clientConfirmedHome ? 1 : 0) : ev.client_confirmed_home;
  const checklistJson = Array.isArray(b.checklist) ? JSON.stringify(b.checklist) : ev.checklist_json;
  const balanceCollected = b.balanceCollected !== undefined ? (b.balanceCollected ? 1 : 0) : ev.balance_collected;
  const balancePaymentMethod = b.balancePaymentMethod ?? ev.balance_payment_method;

  db.prepare(`
    UPDATE calendar_events SET
      assigned_driver = ?, delivery_status = ?, client_phone = ?,
      client_confirmed_home = ?, checklist_json = ?,
      balance_collected = ?, balance_payment_method = ?
    WHERE id = ?
  `).run(assignedDriver, deliveryStatus, clientPhone, clientConfirmedHome, checklistJson, balanceCollected, balancePaymentMethod, id);

  if (b.deliveryStatus && b.deliveryStatus !== ev.delivery_status) {
    recordActivityAndNotify(req.user, {
      unit: ev.unit,
      action: 'entrega.estado.actualizado',
      entityType: 'delivery',
      entityId: id,
      detail: `Entrega ${id} (${ev.client}) cambió a "${deliveryStatus}" | Chofer: ${assignedDriver} | Cliente confirmó en casa: ${clientConfirmedHome ? 'Sí' : 'Pendiente'}`,
      sendEmail: ['En Ruta', 'Incidencia / Nadie en Domicilio'].includes(deliveryStatus)
    });
  }

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

app.post('/api/entregas/:id/nota', requireAuth, (req, res) => {
  const { id } = req.params;
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ ok: false, error: 'Escribe un comentario.' });
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

  db.prepare(`INSERT INTO order_notes (event_id, username, user_display_name, note, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.user.username, req.user.display_name, note, new Date().toISOString());

  recordActivityAndNotify(req.user, {
    unit: ev.unit,
    action: 'pedido.nota_interna',
    entityType: 'delivery',
    entityId: id,
    detail: `Nota interna en ${id} (${ev.client}) por ${req.user.display_name}: "${note}"`,
    sendEmail: false
  });

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

app.post('/api/entregas/:id/evidencia', requireAuth, requirePermission('confirmarEntrega'), upload.single('foto'), async (req, res) => {
  const { id } = req.params;
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ ok: false, error: 'Entrega no encontrada.' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'Selecciona o toma una foto de evidencia.' });

  const localUrl = `/uploads/${req.file.filename}`;
  await uploadToGoogleDrive(req.file.path, `EVIDENCIA_${id}_${req.file.originalname}`, req.file.mimetype, ev.unit, false);
  db.prepare('UPDATE calendar_events SET delivery_photo_url = ? WHERE id = ?').run(localUrl, id);

  recordActivityAndNotify(req.user, {
    unit: ev.unit,
    action: 'entrega.foto_evidencia',
    entityType: 'delivery',
    entityId: id,
    detail: `${req.user.display_name} subió foto de evidencia del mueble entregado para ${ev.client} (${id}).`,
    sendEmail: false
  });

  res.json({ ok: true, photoUrl: localUrl, state: buildFrontendState(req.user) });
});

app.post('/api/entregas/:id/incidencia', requireAuth, requirePermission('confirmarEntrega'), upload.single('foto'), async (req, res) => {
  const { id } = req.params;
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!ev) return res.status(404).json({ ok: false, error: 'Entrega no encontrada.' });
  const reason = String(req.body?.reason || 'Nadie en el domicilio al llegar').trim();

  let photoUrl = '';
  if (req.file) {
    photoUrl = `/uploads/${req.file.filename}`;
    await uploadToGoogleDrive(req.file.path, `INCIDENCIA_${id}_${req.file.originalname}`, req.file.mimetype, ev.unit, false);
  }

  db.prepare(`UPDATE calendar_events SET delivery_status = 'Incidencia / Nadie en Domicilio', incident_reason = ?, incident_photo_url = ? WHERE id = ?`)
    .run(reason, photoUrl, id);
  db.prepare(`INSERT INTO order_notes (event_id, username, user_display_name, note, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.user.username, req.user.display_name, `🚨 INCIDENCIA REPORTADA: ${reason}`, new Date().toISOString());

  recordActivityAndNotify(req.user, {
    unit: ev.unit,
    action: 'entrega.incidencia',
    entityType: 'delivery',
    entityId: id,
    detail: `🚨 INCIDENCIA en entrega ${id} (${ev.client} · ${ev.address}) reportada por ${req.user.display_name}: ${reason}`,
    emailSubject: `[URGENTE INCIDENCIA] Entrega ${id} — ${ev.client}`,
    sendEmail: true
  });

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

// Registro de Gasolina y Kilometraje (Odómetro + Ticket + Cálculo km/L)
app.post('/api/fuel', requireAuth, upload.fields([{ name: 'odometer_photo', maxCount: 1 }, { name: 'receipt_photo', maxCount: 1 }]), async (req, res) => {
  try {
    const kmStart = Number(req.body?.km_start) || 0;
    const kmEnd = Number(req.body?.km_end) || 0;
    const liters = Number(req.body?.liters) || 0;
    const cost = Number(req.body?.cost) || 0;
    const notes = String(req.body?.station_notes || '').trim();
    const vehicle = String(req.body?.vehicle || 'Nissan Pickup Caja Seca').trim();

    if (cost <= 0 && liters <= 0) {
      return res.status(400).json({ ok: false, error: 'Ingresa los litros o el monto de gasolina.' });
    }
    const distance = Math.max(0, kmEnd - kmStart);
    const kmPerLiter = (distance > 0 && liters > 0) ? Number((distance / liters).toFixed(2)) : 0;

    let odoUrl = '';
    let recUrl = '';
    const odoFile = req.files?.odometer_photo?.[0];
    const recFile = req.files?.receipt_photo?.[0];
    if (odoFile) {
      odoUrl = `/uploads/${odoFile.filename}`;
      await uploadToGoogleDrive(odoFile.path, `ODOMETRO_${req.user.username}_${odoFile.originalname}`, odoFile.mimetype, 'Matriz', false);
    }
    if (recFile) {
      recUrl = `/uploads/${recFile.filename}`;
      await uploadToGoogleDrive(recFile.path, `GASOLINA_${req.user.username}_${recFile.originalname}`, recFile.mimetype, 'Matriz', false);
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO fuel_logs (driver_username, driver_name, vehicle, km_start, km_end, liters, cost, km_per_liter, station_notes, odometer_photo_url, receipt_photo_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.username, req.user.display_name, vehicle, kmStart, kmEnd, liters, cost, kmPerLiter, notes, odoUrl, recUrl, nowIso);

    recordActivityAndNotify(req.user, {
      unit: 'Logística',
      action: 'logistica.gasolina.registrada',
      entityType: 'fuel',
      entityId: req.user.username,
      detail: `Carga de gasolina por ${req.user.display_name} (${vehicle}): ${liters} L · $${cost.toLocaleString('es-MX')} MXN · Odómetro: ${kmStart} → ${kmEnd} km (${distance} km recorridos · Rendimiento: ${kmPerLiter || 'N/A'} km/L). ${notes}`,
      emailSubject: `[A.D.G. Gasolina] $${cost.toLocaleString('es-MX')} (${liters} L · ${kmPerLiter} km/L) — ${req.user.display_name}`,
      sendEmail: true
    });

    res.json({ ok: true, kmPerLiter, state: buildFrontendState(req.user) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================
// 14. MOVIMIENTOS OCR, INVENTARIO, CAJA Y ENTREGAS FINALIZAR
// =========================================================
app.post('/api/movimientos', requireAuth, requirePermission('subirNotas'), async (req, res) => {
  const tx = req.body;
  if (!tx || !Array.isArray(tx.items) || !tx.items.length) {
    return res.status(400).json({ ok: false, error: 'Partidas inválidas' });
  }

  const txId = tx.id || `TX-${Date.now().toString().slice(-6)}`;
  const subMuebles = Number(tx.items.filter((i) => i.category === 'Muebles').reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0).toFixed(2));
  const subArtesanias = Number(tx.items.filter((i) => i.category === 'Artesanías').reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0).toFixed(2));
  const totalVenta = Number((subMuebles + subArtesanias).toFixed(2));
  const depositAmount = Number(tx.deposit_amount ?? (tx.movement_type === 'Apartado' ? 0 : totalVenta)) || 0;
  const balanceDue = Math.max(0, totalVenta - depositAmount);
  const noteNumber = (tx.note_number || '').trim();
  const decoracionDetalle = (tx.decoracion_detalle || '').trim();
  const originLoc = tx.scheduling?.ubicacionOrigen || (tx.location_unit === 'Sucursal' ? 'Sucursal Centro' : 'Sucursal Matriz');

  const eventsToSync = [];

  runTransaction(() => {
    db.prepare(`
      INSERT INTO transactions (
        id, timestamp, receipt_image_url, location_unit, client, movement_type,
        payment_method, subtotal_muebles, subtotal_artesanias, total_venta,
        deposit_amount, note_number, layaway_date, layaway_due_date, decoracion_detalle,
        requires_delivery, delivery_date, delivery_address, origin_location, special_dispatch, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      txId, tx.timestamp, tx.receipt_image_url || `gdrive://${tx.location_unit.toLowerCase()}/notas/${txId}.jpg`,
      tx.location_unit, tx.client || 'Cliente Mostrador',
      tx.movement_type, tx.payment_method || 'Efectivo', subMuebles, subArtesanias, totalVenta,
      depositAmount, noteNumber || null, tx.layaway_date || null, tx.layaway_due_date || null, decoracionDetalle || null,
      tx.scheduling?.requires_delivery ? 1 : 0,
      tx.scheduling?.delivery_date || null,
      tx.scheduling?.delivery_address || null,
      originLoc,
      tx.scheduling?.requiereDespachoEspecial ? 1 : 0,
      req.user.username
    );

    const insItem = db.prepare(`INSERT INTO transaction_items (transaction_id, category, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)`);
    const stockCol = tx.location_unit === 'Matriz' ? 'stock_matriz' : 'stock_sucursal';

    for (const it of tx.items) {
      const qty = Number(it.quantity) || 1;
      const price = Number(it.unit_price) || 0;
      insItem.run(txId, it.category, it.description, qty, price);

      if (tx.movement_type !== 'Gasto' && tx.movement_type !== 'Apartado') {
        const existing = db.prepare(`SELECT sku FROM inventory WHERE LOWER(description) = LOWER(?)`).get(it.description);
        if (!existing) {
          const totalInv = db.prepare('SELECT COUNT(*) AS c FROM inventory').get().c;
          const newSku = (it.category === 'Muebles' ? 'MUE-' : 'ART-') + String(totalInv + 1).padStart(3, '0');
          const initM = tx.location_unit === 'Matriz' && tx.movement_type === 'Entrada' ? qty : 0;
          const initS = tx.location_unit === 'Sucursal' && tx.movement_type === 'Entrada' ? qty : 0;
          db.prepare(`
            INSERT INTO inventory (sku, description, category, stock_matriz, stock_sucursal, unit_price, min_stock)
            VALUES (?, ?, ?, ?, ?, ?, 2)
          `).run(newSku, it.description, it.category, initM, initS, price);
        } else {
          const delta = tx.movement_type === 'Entrada' ? qty : -qty;
          db.prepare(`UPDATE inventory SET ${stockCol} = MAX(0, ${stockCol} + ?) WHERE sku = ?`).run(delta, existing.sku);
        }
      }
    }

    const summary = tx.items.map((i) => `${i.quantity}x ${i.description}`).join(', ');
    const estVol = Number(tx.items.reduce((s, it) => s + (it.category === 'Muebles' ? 3.2 : 0.45) * Number(it.quantity), 0).toFixed(1));
    const hasFurniture = tx.items.some((it) => it.category === 'Muebles');
    const vol = Math.min(14.0, Math.max(0.5, estVol));
    const len = hasFurniture ? 2.4 : 0.9;
    const hgt = hasFurniture ? 1.15 : 0.65;

    let evType = null;
    let evDate = (tx.timestamp || new Date().toISOString()).slice(0, 10);
    let evAddr = resolveOriginAddress(tx.location_unit);
    if (tx.movement_type === 'Entrada') evType = 'Entrada';
    else if (tx.movement_type === 'Salida') evType = 'Salida';
    else if (tx.movement_type === 'Venta' || tx.movement_type === 'Apartado') {
      if (tx.scheduling?.requires_delivery) {
        evType = 'Entrega';
        evDate = tx.scheduling.delivery_date || evDate;
        evAddr = tx.scheduling.delivery_address || 'Dirección por confirmar';
      } else if (tx.movement_type === 'Venta') {
        evType = 'Salida';
      }
    }

    if (evType) {
      const evId = `EV-${Date.now().toString().slice(-6)}`;
      const evObj = {
        id: evId, unit: tx.location_unit, type: evType, date: evDate,
        title: `${evType}${noteNumber ? ' (' + noteNumber + ')' : ''}: ${summary}`,
        client: tx.client || 'Cliente', address: evAddr, amount: totalVenta, deposit_amount: depositAmount,
        note_number: noteNumber, decoracion_detalle: decoracionDetalle, receipt_image_url: tx.receipt_image_url || '',
        dispatch_origin: originLoc
      };
      db.prepare(`
        INSERT INTO calendar_events (
          id, unit, type, date, title, client, address, amount, deposit_amount, note_number,
          decoracion_detalle, receipt_image_url, transaction_id, dispatch_origin, special_dispatch,
          cargo_volume_m3, cargo_length_m, cargo_height_m, checklist_json, balance_to_collect
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evObj.id, evObj.unit, evObj.type, evObj.date, evObj.title, evObj.client, evObj.address,
        evObj.amount, evObj.deposit_amount, evObj.note_number, evObj.decoracion_detalle,
        evObj.receipt_image_url, txId, evObj.dispatch_origin, tx.scheduling?.requiereDespachoEspecial ? 1 : 0,
        vol, len, hgt, defaultChecklistForTitle(summary, decoracionDetalle), balanceDue
      );
      eventsToSync.push(evObj);
      db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, ?, ?)`).run(
        new Date().toISOString(), tx.location_unit, 'ical.sync.created', `${evId} (${evType} ${evDate}) -> ${evObj.receipt_image_url}`
      );
    }
  });

  let gcalSync = { synced: false };
  for (const ev of eventsToSync) {
    const r = await syncEventToGoogleCalendar(ev);
    if (r.synced) gcalSync = r;
  }

  recordActivityAndNotify(req.user, {
    unit: tx.location_unit,
    action: `movimiento.${tx.movement_type.toLowerCase()}`,
    entityType: 'transaction',
    entityId: txId,
    detail: `${tx.movement_type} ${noteNumber || txId} | Cliente: ${tx.client || 'Mostrador'} | Total: $${totalVenta.toLocaleString('es-MX')} | Pago: ${tx.payment_method}`,
    sendEmail: true
  });

  res.json({ ok: true, id: txId, total_venta: totalVenta, gcalSync, state: buildFrontendState(req.user) });
});

app.post('/api/webhooks/sync', requireAuth, (req, res) => {
  const { unit, count } = req.body || {};
  const targetUnit = unit || 'Matriz';
  db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, ?, ?)`).run(
    new Date().toISOString(), targetUnit, 'webhook.batch.push', `Sincronizados ${count || 0} eventos de ${targetUnit} con enlaces Drive -> 200 OK`
  );
  recordActivityAndNotify(req.user, {
    unit: targetUnit,
    action: 'agenda.webhook.sync',
    entityType: 'calendar',
    entityId: targetUnit,
    detail: `Sincronización manual de agenda ${targetUnit} (${count || 0} eventos).`,
    sendEmail: true
  });
  res.json({ ok: true, state: buildFrontendState(req.user) });
});

app.post('/api/inventario/ajustar', requireAuth, requirePermission('verInventarioAmbasTiendas'), (req, res) => {
  const { sku, delta, unit, date } = req.body || {};
  const targetUnit = unit === 'Sucursal' ? 'Sucursal' : 'Matriz';
  const stockCol = targetUnit === 'Matriz' ? 'stock_matriz' : 'stock_sucursal';
  const item = db.prepare('SELECT * FROM inventory WHERE sku = ?').get(sku);
  if (!item) return res.status(404).json({ ok: false, error: 'SKU no encontrado' });

  const d = Number(delta) || 0;
  if (d < 0 && item[stockCol] <= 0) {
    return res.status(400).json({ ok: false, error: `Sin stock disponible en ${targetUnit} para ${item.description}.` });
  }

  runTransaction(() => {
    db.prepare(`UPDATE inventory SET ${stockCol} = MAX(0, ${stockCol} + ?) WHERE sku = ?`).run(d, sku);
    const evId = `EV-${Date.now().toString().slice(-6)}`;
    db.prepare(`
      INSERT INTO calendar_events (
        id, unit, type, date, title, client, address, amount, receipt_image_url, transaction_id, dispatch_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evId, targetUnit, d > 0 ? 'Entrada' : 'Salida', date || '2026-11-22',
      `${d > 0 ? 'Entrada' : 'Salida'} rápida: ${Math.abs(d)}x ${item.description}`,
      'Ajuste de Inventario', resolveOriginAddress(targetUnit), item.unit_price,
      `gdrive://${targetUnit.toLowerCase()}/ajustes/${sku}.jpg`, 'AJUSTE', targetUnit === 'Sucursal' ? 'Sucursal Centro' : 'Sucursal Matriz'
    );
  });

  recordActivityAndNotify(req.user, {
    unit: targetUnit,
    action: 'inventario.ajuste',
    entityType: 'inventory',
    entityId: sku,
    detail: `Ajuste ${d > 0 ? '+' + d : d} en ${targetUnit}: ${item.description} (${sku})`,
    sendEmail: true
  });

  res.json({ ok: true, state: buildFrontendState(req.user) });
});

app.put('/api/caja/arqueo', requireAuth, requirePermission('gestionarCaja'), (req, res) => {
  const { unit, date, fondo_inicial, efectivo_contado } = req.body || {};
  const targetUnit = unit === 'Sucursal' ? 'Sucursal' : 'Matriz';
  const targetDate = date || '2026-11-22';
  const fondo = Math.max(0, Number(fondo_inicial) || 0);
  const contado = (efectivo_contado === '' || efectivo_contado === null || efectivo_contado === undefined) ? null : Number(efectivo_contado);

  db.prepare(`
    INSERT INTO cash_register_days (unit, date, fondo_inicial, efectivo_contado)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(unit, date) DO UPDATE SET
      fondo_inicial = excluded.fondo_inicial,
      efectivo_contado = excluded.efectivo_contado
  `).run(targetUnit, targetDate, fondo, contado);

  res.json({ ok: true });
});

app.post('/api/entregas/:id/finalizar', requireAuth, requirePermission('confirmarEntrega'), async (req, res) => {
  const { id } = req.params;
  const { satisfactionRating, satisfactionComment, clientEmail, signatureDataUrl, marbleClauseAccepted, balanceCollected, balancePaymentMethod } = req.body || {};

  const ev = db.prepare(`SELECT * FROM calendar_events WHERE id = ? AND type = 'Entrega'`).get(id);
  if (!ev) return res.status(404).json({ ok: false, error: 'Entrega no encontrada' });

  if (Number(ev.balance_to_collect) > 0 && !balanceCollected && !ev.balance_collected) {
    return res.status(400).json({
      ok: false,
      error: `Esta entrega tiene un saldo pendiente por cobrar de $${Number(ev.balance_to_collect).toLocaleString('es-MX')}. Confirma el cobro antes de finalizar.`
    });
  }

  const esComedor = /comedor/i.test(ev.title || '');
  if (esComedor && !marbleClauseAccepted) {
    return res.status(400).json({
      ok: false,
      error: 'Alerta obligatoria: el cliente debe leer y aceptar la cláusula de no responsabilidad por daños y mal uso del mármol.'
    });
  }
  if (!signatureDataUrl || !clientEmail) {
    return res.status(400).json({ ok: false, error: 'Se requiere firma digital y correo del cliente.' });
  }

  const deliveredAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE calendar_events SET
      delivered = 1, delivery_status = 'Entregado',
      delivered_at = ?, delivered_by = ?, client_email = ?,
      satisfaction_rating = ?, satisfaction_comment = ?,
      marble_clause_accepted = ?, signature_data_url = ?,
      balance_collected = ?, balance_payment_method = ?
    WHERE id = ?
  `).run(
    deliveredAt, req.user.display_name, clientEmail,
    satisfactionRating || 5, satisfactionComment || '',
    marbleClauseAccepted ? 1 : 0, signatureDataUrl,
    (balanceCollected || ev.balance_collected) ? 1 : 0,
    balancePaymentMethod || ev.balance_payment_method || '',
    id
  );

  const htmlProof = `
    <h2>Comprobante de Entrega — A.D.G. Muebles &amp; Artesanías</h2>
    <p><strong>Cliente:</strong> ${ev.client}</p>
    <p><strong>Entregado por:</strong> ${req.user.display_name}</p>
    <p><strong>Artículos:</strong> ${ev.title}</p>
    ${ev.decoracion_detalle ? `<p><strong>Decoración:</strong> ${ev.decoracion_detalle}</p>` : ''}
    ${Number(ev.balance_to_collect) > 0 ? `<p><strong>Saldo cobrado al entregar:</strong> $${Number(ev.balance_to_collect).toLocaleString('es-MX')} (${balancePaymentMethod || ev.balance_payment_method || 'Efectivo'})</p>` : ''}
    <p><strong>Fecha de entrega:</strong> ${deliveredAt}</p>
    <p><strong>Satisfacción:</strong> ${satisfactionRating || 5}/5 estrellas</p>
    ${esComedor ? `<p style="background:#fef3c7;padding:10px;border:1px solid #f59e0b;"><strong>Cláusula de Mármol Aceptada:</strong> No nos hacemos responsables por daños y mal uso del mármol, ya que se puede manchar fácilmente.</p>` : ''}
    <p><strong>Firma de conformidad:</strong></p>
    <img src="${signatureDataUrl}" alt="Firma" style="max-width:360px;border:1px solid #ccc;" />
  `;

  const emailStatus = await sendNotificationEmail({
    to: clientEmail,
    cc: REPORT_COPY_EMAIL,
    subject: `Comprobante de Entrega Firmado — ${ev.client} (${ev.id})`,
    html: htmlProof
  });

  db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, ?, ?)`).run(
    new Date().toISOString(), ev.unit, 'delivery.email.dispatched',
    `Formato firmado de ${ev.client} (${satisfactionRating || 5}/5 ★) -> ${clientEmail} + copia ${REPORT_COPY_EMAIL} [${emailStatus}]`
  );

  recordActivityAndNotify(req.user, {
    unit: ev.unit,
    action: 'entrega.finalizada',
    entityType: 'delivery',
    entityId: id,
    detail: `Entrega finalizada para ${ev.client} (${ev.title}) · ${satisfactionRating || 5}/5 ★ · Saldo cobrado: $${Number(ev.balance_to_collect || 0).toLocaleString('es-MX')} · Correo: ${clientEmail} + copia ${REPORT_COPY_EMAIL} [${emailStatus}]`,
    sendEmail: false
  });

  res.json({ ok: true, id, deliveredAt, emailStatus, state: buildFrontendState(req.user) });
});

app.post('/api/cierre', requireAuth, requirePermission('verReportesFinancieros'), (req, res) => {
  const unit = (req.body && req.body.unit) || 'Consolidado';
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, 'cierre.diario.0000', ?)`).run(
    new Date().toISOString(), unit, `Cierre manual ejecutado para ${unit} (${today})`
  );
  recordActivityAndNotify(req.user, {
    unit,
    action: 'caja.cierre_diario',
    entityType: 'report',
    entityId: today,
    detail: `Cierre de jornada 00:00 ejecutado por ${req.user.display_name} para ${unit} (${today}).`,
    sendEmail: true
  });
  res.json({ ok: true, state: buildFrontendState(req.user) });
});

// Cron 9:00 AM diario: Alerta automática de apartados próximos a vencer (3 días o vencidos)
cron.schedule('0 9 * * *', () => {
  const expiring = getExpiringLayaways();
  if (!expiring.length) return;
  const listHtml = expiring.map((e) => `<li><strong>${e.layaway_note_no || e.id}</strong> — ${e.title} (${e.layaway_client}) · Vence: ${e.layaway_due_date} · Saldo: $${e.balance.toLocaleString('es-MX')}</li>`).join('');
  recordActivityAndNotify(null, {
    unit: 'Global',
    action: 'apartados.alerta_vencimiento',
    entityType: 'system',
    entityId: new Date().toISOString().slice(0, 10),
    detail: `Alerta 9:00 AM: ${expiring.length} apartado(s) vencidos o por vencer en los próximos 3 días.`,
    emailSubject: `[A.D.G. ALERTA] ${expiring.length} Apartado(s) por vencer o vencidos`,
    emailHtml: `<h2>Alerta de Apartados por Vencer — A.D.G. Muebles &amp; Artesanías</h2><ul>${listHtml}</ul>`,
    sendEmail: true
  });
});

cron.schedule('0 0 * * *', () => {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, 'Consolidado', 'cierre.diario.0000', ?)`).run(
    new Date().toISOString(), `Cierre automático ejecutado para jornada ${today}`
  );
});

app.listen(PORT, () => {
  console.log(`Servidor A.D.G. Muebles & Artesanías v3 (Logística Pro) activo en http://localhost:${PORT}`);
});
