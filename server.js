require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// 1. BASE DE DATOS
// =========================================================
const dbDir = path.dirname(process.env.DB_PATH || './data/muebles_artesanias.db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(process.env.DB_PATH || './data/muebles_artesanias.db');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// =========================================================
// 2. ROLES, CHOFER Y REGLAS LOGÍSTICAS
// =========================================================
const usuarioChofer = {
  id: 'USER_DAVID_ADG',
  nombre: 'David Altamirano',
  claveAcceso: process.env.DRIVER_PIN || '1111',
  rol: 'CHOFER_LOGISTICA',
  permisos: {
    verCatalogo: false,
    gestionarCaja: false,
    subirNotas: false,
    verReportesFinancieros: false,
    verCalendarioOperativo: true,
    verRutaAsignadaGoogleMaps: true,
    confirmarEntrega: true,
    verDetalleCargaDimensiones: true
  },
  vehiculoAsignado: {
    tipo: 'Nissan Pickup Caja Seca',
    dimensionesMaximas: { altoMetros: 2.10, largoMetros: 3.20 },
    copete: { anchoMetros: 0.50, altoMetros: 0.40 },
    capacidadVolumenMetrosCubicos: 14.5
  }
};

function verificarAccesoChofer(usuario, accionRequerida) {
  if (usuario.rol === 'CHOFER_LOGISTICA') {
    return usuario.permisos[accionRequerida] === true;
  }
  return true;
}

function extraerDatosLogisticosOCR(textoCompletoImagen) {
  const datosLogistica = {
    ubicacionOrigen: 'Sucursal Matriz',
    requiereDespachoEspecial: false
  };
  const patronBodega = /bodega/i;
  if (patronBodega.test(textoCompletoImagen || '')) {
    datosLogistica.ubicacionOrigen = 'Bodega San Antonio Totoltepec';
    datosLogistica.requiereDespachoEspecial = true;
  }
  return datosLogistica;
}

// =========================================================
// 3. SUBIDA DE FOTOS Y MOTOR OCR
// =========================================================
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

app.post('/api/ocr/procesar', upload.single('nota'), async (req, res) => {
  try {
    const rawText = req.body.textoSimulado || '';
    const unit = req.body.location_unit || 'Matriz';
    const fileName = req.file ? req.file.originalname : `IMG_${Date.now()}.jpg`;

    // Aquí se conecta la API de Visión (Gemini Vision / Cloud Vision) con process.env.VISION_API_KEY
    // y se sube req.file a Google Drive usando googleapis.
    const driveUrl = `gdrive://${unit.toLowerCase()}/notas/${fileName}`;
    const datosLogistica = extraerDatosLogisticosOCR(rawText);

    res.json({
      ok: true,
      receipt_image_url: driveUrl,
      logistics: datosLogistica,
      raw_text: rawText
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =========================================================
// 4. AUTENTICACIÓN POR ROL
// =========================================================
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body || {};
  if (String(pin) === String(usuarioChofer.claveAcceso)) {
    return res.json({ ok: true, usuario: usuarioChofer });
  }
  return res.status(401).json({ ok: false, error: 'PIN inválido' });
});

// =========================================================
// 5. MOVIMIENTOS, INVENTARIO Y CALENDARIO SINCRONIZADO
// =========================================================
app.post('/api/movimientos', (req, res) => {
  const tx = req.body;
  if (!tx || !Array.isArray(tx.items) || !tx.items.length) {
    return res.status(400).json({ ok: false, error: 'Partidas inválidas' });
  }

  const txId = tx.id || `TX-${Date.now()}`;
  const subMuebles = tx.items.filter((i) => i.category === 'Muebles').reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const subArtesanias = tx.items.filter((i) => i.category === 'Artesanías').reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const totalVenta = subMuebles + subArtesanias;

  const insertAll = db.transaction(() => {
    db.prepare(`
      INSERT INTO transactions (
        id, timestamp, receipt_image_url, location_unit, client, movement_type,
        payment_method, subtotal_muebles, subtotal_artesanias, total_venta,
        requires_delivery, delivery_date, delivery_address, origin_location, special_dispatch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      txId, tx.timestamp, tx.receipt_image_url, tx.location_unit, tx.client || 'Cliente Mostrador',
      tx.movement_type, tx.payment_method || 'Efectivo', subMuebles, subArtesanias, totalVenta,
      tx.scheduling?.requires_delivery ? 1 : 0,
      tx.scheduling?.delivery_date || null,
      tx.scheduling?.delivery_address || null,
      tx.scheduling?.ubicacionOrigen || 'Sucursal Matriz',
      tx.scheduling?.requiereDespachoEspecial ? 1 : 0
    );

    const insItem = db.prepare(`INSERT INTO transaction_items (transaction_id, category, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)`);
    const stockCol = tx.location_unit === 'Matriz' ? 'stock_matriz' : 'stock_sucursal';

    for (const it of tx.items) {
      insItem.run(txId, it.category, it.description, it.quantity, it.unit_price);
      if (tx.movement_type !== 'Gasto') {
        const delta = tx.movement_type === 'Entrada' ? it.quantity : -it.quantity;
        db.prepare(`UPDATE inventory SET ${stockCol} = MAX(0, ${stockCol} + ?) WHERE LOWER(description) = LOWER(?)`).run(delta, it.description);
      }
    }

    let evType = null;
    let evDate = tx.timestamp.slice(0, 10);
    let evAddr = `Mostrador ${tx.location_unit}`;
    if (tx.movement_type === 'Entrada') {
      evType = 'Entrada';
      evAddr = `Recepción ${tx.location_unit}`;
    } else if (tx.movement_type === 'Salida') {
      evType = 'Salida';
    } else if (tx.movement_type === 'Venta') {
      if (tx.scheduling?.requires_delivery) {
        evType = 'Entrega';
        evDate = tx.scheduling.delivery_date || evDate;
        evAddr = tx.scheduling.delivery_address || 'Dirección por confirmar';
      } else {
        evType = 'Salida';
      }
    }

    if (evType) {
      const evId = `EV-${Date.now().toString().slice(-6)}`;
      const summary = tx.items.map((i) => `${i.quantity}x ${i.description}`).join(', ');
      db.prepare(`
        INSERT INTO calendar_events (
          id, unit, type, date, title, client, address, amount, receipt_image_url,
          transaction_id, dispatch_origin, special_dispatch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evId, tx.location_unit, evType, evDate, `${evType}: ${summary}`,
        tx.client || 'Cliente', evAddr, totalVenta, tx.receipt_image_url, txId,
        tx.scheduling?.ubicacionOrigen || 'Sucursal Matriz',
        tx.scheduling?.requiereDespachoEspecial ? 1 : 0
      );

      db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, ?, ?, ?)`).run(
        new Date().toISOString(), tx.location_unit, 'ical.sync.created', `${evId} (${evType} ${evDate}) -> ${tx.receipt_image_url}`
      );
    }
  });

  insertAll();
  res.json({ ok: true, id: txId, total_venta: totalVenta });
});

app.get('/api/calendario/:unidad', (req, res) => {
  const { unidad } = req.params;
  if (!['Matriz', 'Sucursal'].includes(unidad)) {
    return res.status(400).json({ ok: false, error: 'Unidad inválida (Matriz o Sucursal)' });
  }
  const events = db.prepare(`SELECT * FROM calendar_events WHERE unit = ? ORDER BY date ASC`).all(unidad);
  res.json({ ok: true, unidad, events });
});

app.get('/api/calendario/:unidad/ical', (req, res) => {
  const { unidad } = req.params;
  const events = db.prepare(`SELECT * FROM calendar_events WHERE unit = ?`).all(unidad);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Muebles y Artesanias//ERP//ES'];
  for (const ev of events) {
    const dt = ev.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.id}@mueblesartesanias.local`);
    lines.push(`DTSTART;VALUE=DATE:${dt}`);
    lines.push(`SUMMARY:[${ev.unit} - ${ev.type}] ${ev.title}`);
    lines.push(`LOCATION:${ev.address}`);
    lines.push(`DESCRIPTION:Origen: ${ev.dispatch_origin}\\nCliente: ${ev.client}\\nNota Drive: ${ev.receipt_image_url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="calendario_${unidad.toLowerCase()}.ics"`);
  res.send(lines.join('\r\n'));
});

// =========================================================
// 6. INVENTARIO Y ARQUEO DE CAJA DIARIO
// =========================================================
app.get('/api/inventario', (req, res) => {
  const rows = db.prepare(`SELECT * FROM inventory ORDER BY category, description`).all();
  res.json({ ok: true, inventory: rows });
});

app.get('/api/caja/arqueo', (req, res) => {
  const unit = req.query.unit || 'Matriz';
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const reg = db.prepare(`SELECT * FROM cash_register_days WHERE unit = ? AND date = ?`).get(unit, date) || { fondo_inicial: 5000 };
  const ingresos = db.prepare(`
    SELECT COALESCE(SUM(total_venta), 0) AS total FROM transactions
    WHERE location_unit = ? AND substr(timestamp, 1, 10) = ? AND movement_type = 'Venta' AND payment_method = 'Efectivo'
  `).get(unit, date).total;
  const egresos = db.prepare(`
    SELECT COALESCE(SUM(total_venta), 0) AS total FROM transactions
    WHERE location_unit = ? AND substr(timestamp, 1, 10) = ? AND movement_type = 'Gasto'
  `).get(unit, date).total;

  res.json({
    ok: true,
    unit,
    date,
    fondo_inicial: reg.fondo_inicial,
    ingresos_efectivo: ingresos,
    egresos,
    efectivo_esperado: reg.fondo_inicial + ingresos - egresos
  });
});

// =========================================================
// 7. ENTREGAS: SATISFACCIÓN, CLÁUSULA MÁRMOL, FIRMA Y CORREO
// =========================================================
const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

app.post('/api/entregas/:id/finalizar', async (req, res) => {
  const { id } = req.params;
  const { satisfactionRating, satisfactionComment, clientEmail, signatureDataUrl, marbleClauseAccepted, deliveredBy } = req.body || {};

  const ev = db.prepare(`SELECT * FROM calendar_events WHERE id = ? AND type = 'Entrega'`).get(id);
  if (!ev) return res.status(404).json({ ok: false, error: 'Entrega no encontrada' });

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

  const deliveredAt = new Date().toISOString();
  db.prepare(`
    UPDATE calendar_events SET
      delivered = 1,
      delivered_at = ?,
      delivered_by = ?,
      client_email = ?,
      satisfaction_rating = ?,
      satisfaction_comment = ?,
      marble_clause_accepted = ?,
      signature_data_url = ?
    WHERE id = ?
  `).run(deliveredAt, deliveredBy || 'David Altamirano', clientEmail, satisfactionRating || 5, satisfactionComment || '', marbleClauseAccepted ? 1 : 0, signatureDataUrl, id);

  // Envío automático de copia del formato firmado al correo del cliente
  let emailStatus = 'simulado_sin_smtp';
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await mailTransporter.sendMail({
        from: `"Muebles & Artesanías" <${process.env.SMTP_USER}>`,
        to: clientEmail,
        subject: `Comprobante de Entrega Firmado — ${ev.client} (${ev.id})`,
        html: `
          <h2>Comprobante de Entrega — Muebles &amp; Artesanías</h2>
          <p><strong>Cliente:</strong> ${ev.client}</p>
          <p><strong>Artículos:</strong> ${ev.title}</p>
          <p><strong>Fecha de entrega:</strong> ${deliveredAt}</p>
          <p><strong>Satisfacción registrada:</strong> ${satisfactionRating || 5}/5 estrellas</p>
          ${esComedor ? `<p style="background:#fef3c7;padding:10px;border:1px solid #f59e0b;"><strong>Cláusula de Mármol Aceptada:</strong> No nos hacemos responsables por daños y mal uso del mármol, ya que se puede manchar fácilmente.</p>` : ''}
          <p><strong>Firma de conformidad:</strong></p>
          <img src="${signatureDataUrl}" alt="Firma" style="max-width:360px;border:1px solid #ccc;" />
        `
      });
      emailStatus = 'enviado';
    } catch (mailErr) {
      emailStatus = `error_smtp: ${mailErr.message}`;
    }
  }

  res.json({ ok: true, id, deliveredAt, emailStatus });
});

// =========================================================
// 8. REPORTES Y CIERRE AUTOMÁTICO DIARIO (00:00)
// =========================================================
app.get('/api/reportes/:periodo', (req, res) => {
  const { periodo } = req.params;
  const rows = db.prepare(`
    SELECT location_unit,
      COALESCE(SUM(CASE WHEN movement_type = 'Venta' THEN subtotal_muebles ELSE 0 END), 0) AS muebles,
      COALESCE(SUM(CASE WHEN movement_type = 'Venta' THEN subtotal_artesanias ELSE 0 END), 0) AS artesanias,
      COALESCE(SUM(CASE WHEN movement_type = 'Gasto' THEN total_venta ELSE 0 END), 0) AS gastos
    FROM transactions
    GROUP BY location_unit
  `).all();
  res.json({ ok: true, periodo, resumen: rows });
});

cron.schedule('0 0 * * *', () => {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO webhook_logs (created_at, unit, event_name, detail) VALUES (?, 'Consolidado', 'cierre.diario.0000', ?)`).run(
    new Date().toISOString(), `Cierre automático ejecutado para jornada ${today}`
  );
  console.log(`[CRON 00:00] Cierre diario consolidado: ${today}`);
});

app.listen(PORT, () => {
  console.log(`Servidor Muebles & Artesanías activo en http://localhost:${PORT}`);
});
