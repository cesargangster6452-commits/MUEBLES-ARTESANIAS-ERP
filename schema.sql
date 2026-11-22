-- Esquema relacional para Muebles & Artesanías ERP

CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Muebles', 'Artesanías')),
  stock_matriz INTEGER NOT NULL DEFAULT 0,
  stock_sucursal INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  receipt_image_url TEXT NOT NULL,
  location_unit TEXT NOT NULL CHECK (location_unit IN ('Matriz', 'Sucursal')),
  client TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('Venta', 'Entrada', 'Salida', 'Gasto')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Efectivo', 'Tarjeta', 'Transferencia')),
  subtotal_muebles REAL NOT NULL DEFAULT 0,
  subtotal_artesanias REAL NOT NULL DEFAULT 0,
  total_venta REAL NOT NULL DEFAULT 0,
  requires_delivery INTEGER NOT NULL DEFAULT 0,
  delivery_date TEXT,
  delivery_address TEXT,
  origin_location TEXT DEFAULT 'Sucursal Matriz',
  special_dispatch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Muebles', 'Artesanías')),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL CHECK (unit IN ('Matriz', 'Sucursal')),
  type TEXT NOT NULL CHECK (type IN ('Entrega', 'Entrada', 'Salida')),
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  client TEXT NOT NULL,
  address TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  receipt_image_url TEXT NOT NULL,
  transaction_id TEXT,
  dispatch_origin TEXT DEFAULT 'Sucursal Matriz',
  special_dispatch INTEGER NOT NULL DEFAULT 0,
  cargo_volume_m3 REAL DEFAULT 3.5,
  cargo_length_m REAL DEFAULT 1.9,
  cargo_height_m REAL DEFAULT 1.0,
  delivered INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  delivered_by TEXT,
  client_email TEXT,
  satisfaction_rating INTEGER,
  satisfaction_comment TEXT,
  marble_clause_accepted INTEGER NOT NULL DEFAULT 0,
  signature_data_url TEXT
);

CREATE TABLE IF NOT EXISTS cash_register_days (
  unit TEXT NOT NULL,
  date TEXT NOT NULL,
  fondo_inicial REAL NOT NULL DEFAULT 0,
  efectivo_contado REAL,
  PRIMARY KEY (unit, date)
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  unit TEXT NOT NULL,
  event_name TEXT NOT NULL,
  detail TEXT NOT NULL
);
