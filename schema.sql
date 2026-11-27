-- Esquema relacional para A.D.G. Muebles & Artesanías ERP (v3 - Logística Pro)

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'Global',
  permissions_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Muebles', 'Artesanías')),
  stock_matriz INTEGER NOT NULL DEFAULT 0,
  stock_sucursal INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  sku TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Muebles',
  description TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  stock_matriz INTEGER NOT NULL DEFAULT 1,
  stock_sucursal INTEGER NOT NULL DEFAULT 0,
  image_url TEXT NOT NULL,
  folder_status TEXT NOT NULL DEFAULT 'Disponible' CHECK (folder_status IN ('Disponible', 'Apartado', 'Vendido')),
  layaway_note_no TEXT,
  layaway_client TEXT,
  layaway_phone TEXT,
  layaway_deposit REAL DEFAULT 0,
  layaway_date TEXT,
  layaway_due_date TEXT,
  layaway_decoracion TEXT,
  layaway_receipt_url TEXT,
  created_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS layaway_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_item_id TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'Efectivo',
  receipt_url TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  receipt_image_url TEXT NOT NULL,
  location_unit TEXT NOT NULL CHECK (location_unit IN ('Matriz', 'Sucursal')),
  client TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('Venta', 'Apartado', 'Entrada', 'Salida', 'Gasto')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Efectivo', 'Tarjeta', 'Transferencia')),
  subtotal_muebles REAL NOT NULL DEFAULT 0,
  subtotal_artesanias REAL NOT NULL DEFAULT 0,
  total_venta REAL NOT NULL DEFAULT 0,
  deposit_amount REAL NOT NULL DEFAULT 0,
  note_number TEXT,
  layaway_date TEXT,
  layaway_due_date TEXT,
  decoracion_detalle TEXT,
  catalog_item_id TEXT,
  catalog_image_url TEXT,
  requires_delivery INTEGER NOT NULL DEFAULT 0,
  delivery_date TEXT,
  delivery_address TEXT,
  origin_location TEXT DEFAULT 'Matriz · Av. Juárez esq. 2 de Abril, Apizaco, Tlaxcala',
  special_dispatch INTEGER NOT NULL DEFAULT 0,
  created_by TEXT
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
  type TEXT NOT NULL CHECK (type IN ('Entrega', 'Entrada', 'Salida', 'Apartado')),
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  client TEXT NOT NULL,
  address TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  deposit_amount REAL NOT NULL DEFAULT 0,
  note_number TEXT,
  decoracion_detalle TEXT,
  receipt_image_url TEXT NOT NULL,
  catalog_image_url TEXT,
  transaction_id TEXT,
  dispatch_origin TEXT DEFAULT 'Matriz · Av. Juárez esq. 2 de Abril, Apizaco, Tlaxcala',
  special_dispatch INTEGER NOT NULL DEFAULT 0,
  cargo_volume_m3 REAL DEFAULT 3.5,
  cargo_length_m REAL DEFAULT 1.9,
  cargo_height_m REAL DEFAULT 1.0,
  assigned_driver TEXT DEFAULT 'conductor1',
  delivery_status TEXT DEFAULT 'Pendiente',
  client_phone TEXT DEFAULT '',
  client_confirmed_home INTEGER NOT NULL DEFAULT 0,
  checklist_json TEXT DEFAULT '[]',
  balance_to_collect REAL DEFAULT 0,
  balance_collected INTEGER NOT NULL DEFAULT 0,
  balance_payment_method TEXT DEFAULT '',
  delivery_photo_url TEXT DEFAULT '',
  incident_photo_url TEXT DEFAULT '',
  incident_reason TEXT DEFAULT '',
  delivered INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  delivered_by TEXT,
  client_email TEXT,
  satisfaction_rating INTEGER,
  satisfaction_comment TEXT,
  marble_clause_accepted INTEGER NOT NULL DEFAULT 0,
  signature_data_url TEXT
);

CREATE TABLE IF NOT EXISTS order_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  username TEXT NOT NULL,
  user_display_name TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  sku TEXT DEFAULT '',
  item_description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  assigned_driver TEXT DEFAULT 'conductor1',
  status TEXT NOT NULL DEFAULT 'Solicitado' CHECK (status IN ('Solicitado', 'En Camino', 'Recibido')),
  notes TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fuel_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_username TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  vehicle TEXT NOT NULL DEFAULT 'Nissan Pickup Caja Seca',
  km_start REAL NOT NULL DEFAULT 0,
  km_end REAL NOT NULL DEFAULT 0,
  liters REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  km_per_liter REAL NOT NULL DEFAULT 0,
  station_notes TEXT DEFAULT '',
  odometer_photo_url TEXT DEFAULT '',
  receipt_photo_url TEXT DEFAULT '',
  created_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  username TEXT NOT NULL,
  user_display_name TEXT NOT NULL,
  user_role TEXT NOT NULL,
  unit TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL,
  email_status TEXT DEFAULT 'pendiente'
);
