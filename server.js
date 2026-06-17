const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const multer    = require('multer');
const { v4: uuid } = require('uuid');
const { parse } = require('csv-parse/sync');
const XLSX      = require('xlsx');
const cors      = require('cors');
const low       = require('lowdb');
const FileSync  = require('lowdb/adapters/FileSync');

const app = express();
const PORT       = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'wholesale-reseller-secret-2025';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── DB ────────────────────────────────────────────────────────────────────
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const adapter = new FileSync(path.join(dbDir, 'db.json'));
const db = low(adapter);
db.defaults({ users: [], catalogs: [], products: [], orders: [], wholesaleOrders: [] }).write();

const DB = {
  findUser(q)        { return db.get('users').find(q).value(); },
  findUsers(q = {})  { return db.get('users').filter(q).value(); },
  createUser(u)      { db.get('users').push(u).write(); },
  updateUser(q, u)   { db.get('users').find(q).assign(u).write(); },

  findCatalog(q)        { return db.get('catalogs').find(q).value(); },
  findCatalogs(q = {})  { return db.get('catalogs').filter(q).value(); },
  createCatalog(c)      { db.get('catalogs').push(c).write(); },
  updateCatalog(q, u)   { db.get('catalogs').find(q).assign(u).write(); },

  findProduct(q)        { return db.get('products').find(q).value(); },
  findProducts(q = {})  { return db.get('products').filter(q).value(); },
  createProduct(p)      { db.get('products').push(p).write(); },
  bulkCreateProducts(arr) { arr.forEach(p => db.get('products').push(p).write()); },
  updateProduct(q, u)   { db.get('products').find(q).assign(u).write(); },
  deleteProducts(q)     { db.get('products').remove(q).write(); },

  findOrder(q)        { return db.get('orders').find(q).value(); },
  findOrders(q = {})  { return db.get('orders').filter(q).value(); },
  createOrder(o)       { db.get('orders').push(o).write(); },
  updateOrder(q, u)    { db.get('orders').find(q).assign(u).write(); },

  findWholesaleOrders(q = {}) { return db.get('wholesaleOrders').filter(q).value(); },
  createWholesaleOrder(o)     { db.get('wholesaleOrders').push(o).write(); },
};

// ── SEED ADMIN ────────────────────────────────────────────────────────────
function seedAdmin() {
  const users = db.get('users').value();
  if (users.length === 0) {
    const admin = {
      id: uuid(), role: 'admin', userId: 'admin', firmName: 'Platform Admin',
      contactPerson: 'Admin', email: 'admin@platform.local',
      password: bcrypt.hashSync('admin123', 10),
      slug: null, wholesalerId: null, status: 'active',
      createdAt: new Date().toISOString(),
    };
    db.get('users').push(admin).write();
    console.log('Seeded admin user (userId: admin / password: admin123)');
  }
}
seedAdmin();

// ── HELPERS ───────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 60) || 'firm';
}
function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 1;
  while (DB.findUser({ slug })) { slug = `${slugify(base)}-${n}`; n++; }
  return slug;
}
function genOrderNo(prefix) {
  const d = new Date();
  return `${prefix}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
function wholesalerOnly(req, res, next) {
  if (req.user.role !== 'wholesaler') return res.status(403).json({ error: 'Wholesaler only' });
  next();
}
function resellerOnly(req, res, next) {
  if (req.user.role !== 'reseller') return res.status(403).json({ error: 'Reseller only' });
  next();
}
function approvedResellerOnly(req, res, next) {
  if (req.user.role !== 'reseller') return res.status(403).json({ error: 'Reseller only' });
  const user = DB.findUser({ id: req.user.id });
  if (!user || user.status !== 'approved') {
    return res.status(403).json({ error: 'Your account is pending wholesaler approval. You cannot build a catalog yet.' });
  }
  next();
}

function safeUser(u) { if (!u) return u; const { password, ...rest } = u; return rest; }

// ── AUTH ──────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ error: 'User ID and password required' });
  const all = db.get('users').value();
  const user = all.find(u => (u.userId || '').toLowerCase() === userId.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid user ID or password' });
  const token = jwt.sign({ id: user.id, role: user.role, userId: user.userId, firmName: user.firmName }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: safeUser(user) });
});

// Register: role wholesaler (self-serve, auto-approved) or reseller (needs slug, status pending)
app.post('/api/register', (req, res) => {
  const { userId, password, firmName, contactPerson, email, role, wholesalerSlug } = req.body;
  if (!userId || !password || !firmName || !contactPerson || !email || !role) {
    return res.status(400).json({ error: 'All required fields must be filled' });
  }
  if (!['wholesaler', 'reseller'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (DB.findUser({ userId })) return res.status(400).json({ error: 'User ID already taken' });

  if (role === 'wholesaler') {
    const slug = uniqueSlug(firmName);
    const user = {
      id: uuid(), role: 'wholesaler', userId, firmName, contactPerson, email,
      password: bcrypt.hashSync(password, 10), slug, wholesalerId: null,
      status: 'active', createdAt: new Date().toISOString(),
    };
    DB.createUser(user);
    const token = jwt.sign({ id: user.id, role: user.role, userId: user.userId, firmName: user.firmName }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: safeUser(user), signupLink: `/w/${slug}/signup` });
  }

  // reseller
  if (!wholesalerSlug) return res.status(400).json({ error: 'wholesalerSlug is required for reseller registration' });
  const wholesaler = DB.findUser({ slug: wholesalerSlug, role: 'wholesaler' });
  if (!wholesaler) return res.status(404).json({ error: 'Wholesaler not found for this signup link' });
  const user = {
    id: uuid(), role: 'reseller', userId, firmName, contactPerson, email,
    password: bcrypt.hashSync(password, 10), slug: null, wholesalerId: wholesaler.id,
    status: 'pending', createdAt: new Date().toISOString(),
  };
  DB.createUser(user);
  const token = jwt.sign({ id: user.id, role: user.role, userId: user.userId, firmName: user.firmName }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const user = DB.findUser({ id: req.user.id });
  if (!user) return res.status(401).json({ error: 'Session expired' });
  res.json(safeUser(user));
});

// Resolve a wholesaler by slug (for the reseller signup page)
app.get('/api/wholesalers/by-slug/:slug', (req, res) => {
  const w = DB.findUser({ slug: req.params.slug, role: 'wholesaler' });
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json({ id: w.id, firmName: w.firmName, slug: w.slug });
});

// ── WHOLESALER: CATALOGS ─────────────────────────────────────────────────
app.get('/api/catalogs', auth, (req, res) => {
  if (req.user.role === 'wholesaler') return res.json(DB.findCatalogs({ ownerId: req.user.id }));
  if (req.user.role === 'reseller') return res.json(DB.findCatalogs({ ownerId: req.user.id }));
  if (req.user.role === 'admin') return res.json(DB.findCatalogs());
  res.status(403).json({ error: 'Forbidden' });
});

app.post('/api/catalogs', auth, (req, res) => {
  if (req.user.role === 'reseller') {
    const user = DB.findUser({ id: req.user.id });
    if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Your account is pending wholesaler approval.' });
  } else if (req.user.role !== 'wholesaler') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const slug = slugify(name) + '-' + Math.random().toString(36).substring(2, 6);
  const cat = { id: uuid(), ownerId: req.user.id, name, slug, status: 'active', createdAt: new Date().toISOString() };
  DB.createCatalog(cat);
  res.json(cat);
});

app.put('/api/catalogs/:id', auth, (req, res) => {
  const cat = DB.findCatalog({ id: req.params.id });
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (cat.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const updates = {};
  ['name', 'status'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  DB.updateCatalog({ id: req.params.id }, updates);
  res.json({ ok: true });
});

// ── PRODUCTS (wholesaler manual entry) ───────────────────────────────────
app.get('/api/catalogs/:catalogId/products', auth, (req, res) => {
  res.json(DB.findProducts({ catalogId: req.params.catalogId }));
});

app.post('/api/catalogs/:catalogId/products', auth, wholesalerOnly, (req, res) => {
  const cat = DB.findCatalog({ id: req.params.catalogId });
  if (!cat) return res.status(404).json({ error: 'Catalog not found' });
  if (cat.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { itemNo, productName, imageName, category, minQty, unit, salePrice,
    description, description2, filter1, filter2, filter3, tag1, tag2 } = req.body;
  if (!itemNo || salePrice === undefined) return res.status(400).json({ error: 'itemNo and salePrice are required' });
  const p = {
    id: uuid(), catalogId: req.params.catalogId, ownerId: req.user.id,
    itemNo, productName: productName || itemNo, imageName: imageName || '',
    category: category || '', minQty: Number(minQty) || 1, unit: unit || 'Pcs',
    salePrice: Number(salePrice) || 0, discPrice: 0,
    description: description || '', description2: description2 || '',
    filter1: filter1 || '', filter2: filter2 || '', filter3: filter3 || '',
    tag1: tag1 || '', tag2: tag2 || '',
    sourceWholesalerProductId: null,
    createdAt: new Date().toISOString(),
  };
  DB.createProduct(p);
  res.json(p);
});

app.put('/api/products/:id', auth, wholesalerOnly, (req, res) => {
  const p = DB.findProduct({ id: req.params.id });
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const allowed = ['itemNo', 'productName', 'imageName', 'category', 'minQty', 'unit', 'salePrice',
    'description', 'description2', 'filter1', 'filter2', 'filter3', 'tag1', 'tag2'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  DB.updateProduct({ id: req.params.id }, updates);
  res.json({ ok: true });
});

app.delete('/api/products/:id', auth, wholesalerOnly, (req, res) => {
  const p = DB.findProduct({ id: req.params.id });
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  DB.deleteProducts({ id: req.params.id });
  res.json({ ok: true });
});

// ── CSV/XLSX UPLOAD (wholesaler items, no discPrice) ─────────────────────
const csvUploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { const d = path.join(__dirname, 'uploads', 'csv'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, uuid() + '_' + file.originalname),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post('/api/catalogs/:catalogId/upload-csv', auth, wholesalerOnly, csvUploader.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const catId = req.params.catalogId;
    const cat = DB.findCatalog({ id: catId });
    if (!cat) return res.status(404).json({ error: 'Catalog not found' });
    if (cat.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    let rows = [];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.csv') {
      rows = parse(fs.readFileSync(req.file.path, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      let hi = -1;
      for (let i = 0; i < Math.min(allRows.length, 10); i++) {
        if (allRows[i].some(c => String(c).toLowerCase().includes('item no'))) { hi = i; break; }
      }
      if (hi === -1) return res.status(400).json({ error: 'Cannot find header row with "Item No" column' });
      rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: hi });
    } else {
      return res.status(400).json({ error: 'Please upload .csv or .xlsx' });
    }
    if (!rows.length) return res.status(400).json({ error: 'File is empty' });

    const col = (row, ...keys) => {
      for (const k of keys) {
        const found = Object.keys(row).find(rk => rk.toLowerCase().replace(/[\s*_()]/g, '').startsWith(k.toLowerCase().replace(/[\s*_()]/g, '')));
        if (found && String(row[found]).trim() !== '') return String(row[found]).trim();
      }
      return '';
    };

    let inserted = [], errors = [];
    rows.forEach((row, idx) => {
      const rowNum = idx + 2, rowErrors = [];
      const itemNo = col(row, 'itemno', 'item no', 'code', 'sku');
      const sp = col(row, 'saleprice', 'sale price', 'saleamount', 'sale amount', 'price', 'mrp');
      if (!itemNo) rowErrors.push('Item No is missing');
      if (!sp || isNaN(parseFloat(sp))) rowErrors.push('Sale Price missing or invalid');
      if (parseFloat(sp) < 0) rowErrors.push('Sale Price cannot be negative');
      if (rowErrors.length) { errors.push({ row: rowNum, itemNo: itemNo || '(blank)', errors: rowErrors }); return; }
      inserted.push({
        id: uuid(), catalogId: catId, ownerId: req.user.id,
        itemNo, productName: col(row, 'productname', 'product name', 'name') || itemNo,
        imageName: (col(row, 'imagename', 'image name', 'image', 'img') || itemNo).replace(/\s+/g, '-').trim(),
        category: col(row, 'category', 'cat'),
        minQty: parseFloat(col(row, 'minqty', 'min qty', 'minimumqty', 'minium qty')) || 1,
        unit: col(row, 'unit') || 'Pcs',
        salePrice: parseFloat(sp), discPrice: 0,
        description: col(row, 'description', 'desc'),
        description2: col(row, 'description2', 'desc2'),
        filter1: col(row, 'filter1', 'color', 'colour'), filter2: col(row, 'filter2', 'size'),
        filter3: col(row, 'filter3', 'material'), tag1: col(row, 'tag1', 'tag 1'), tag2: col(row, 'tag2', 'tag 2'),
        sourceWholesalerProductId: null,
        createdAt: new Date().toISOString(),
      });
    });

    if (inserted.length > 0) DB.bulkCreateProducts(inserted);
    res.json({
      ok: inserted.length > 0, count: inserted.length, errorCount: errors.length, errors,
      preview: inserted.slice(0, 5),
      message: inserted.length > 0
        ? `${inserted.length} products imported${errors.length > 0 ? ` · ${errors.length} rows skipped` : ''}`
        : `No products imported — ${errors.length} rows had errors`,
    });
  } catch (err) {
    res.status(400).json({ error: 'Parse error: ' + err.message });
  }
});

// ── WHOLESALER: RESELLERS MANAGEMENT ─────────────────────────────────────
app.get('/api/wholesaler/resellers', auth, wholesalerOnly, (req, res) => {
  const resellers = DB.findUsers({ wholesalerId: req.user.id, role: 'reseller' });
  res.json(resellers.map(safeUser));
});

app.put('/api/wholesaler/resellers/:id/approve', auth, wholesalerOnly, (req, res) => {
  const reseller = DB.findUser({ id: req.params.id, role: 'reseller' });
  if (!reseller) return res.status(404).json({ error: 'Reseller not found' });
  if (reseller.wholesalerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  DB.updateUser({ id: req.params.id }, { status: 'approved' });
  res.json({ ok: true, status: 'approved' });
});

app.put('/api/wholesaler/resellers/:id/reject', auth, wholesalerOnly, (req, res) => {
  const reseller = DB.findUser({ id: req.params.id, role: 'reseller' });
  if (!reseller) return res.status(404).json({ error: 'Reseller not found' });
  if (reseller.wholesalerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  DB.updateUser({ id: req.params.id }, { status: 'rejected' });
  res.json({ ok: true, status: 'rejected' });
});

// Wholesaler's view of B2B orders forwarded from resellers
app.get('/api/wholesaler/wholesale-orders', auth, wholesalerOnly, (req, res) => {
  res.json(DB.findWholesaleOrders({ wholesalerId: req.user.id }));
});

// ── RESELLER: BROWSE WHOLESALER ITEMS (read-only) ────────────────────────
app.get('/api/reseller/wholesaler-items', auth, resellerOnly, (req, res) => {
  const user = DB.findUser({ id: req.user.id });
  if (!user.wholesalerId) return res.status(400).json({ error: 'No wholesaler linked' });
  const items = DB.findProducts({ ownerId: user.wholesalerId });
  res.json(items);
});

// ── RESELLER: BUILD CATALOG WITH MARGIN/DISCOUNT ─────────────────────────
function computePrices(wholesalerPrice, marginPct, discountPct) {
  const margin = Number(marginPct) || 0;
  const discount = Number(discountPct) || 0;
  const finalPrice = wholesalerPrice * (1 + margin / 100); // discPrice
  const displayedMRP = discount > 0 ? finalPrice / (1 - discount / 100) : finalPrice; // salePrice
  return { discPrice: round2(finalPrice), salePrice: round2(displayedMRP) };
}

// Add a wholesaler item into reseller's own catalog with margin/discount
app.post('/api/reseller/catalog-items', auth, approvedResellerOnly, (req, res) => {
  const { catalogId, wholesalerProductId, marginPct, discountPct } = req.body;
  if (!catalogId || !wholesalerProductId) return res.status(400).json({ error: 'catalogId and wholesalerProductId are required' });
  const cat = DB.findCatalog({ id: catalogId });
  if (!cat || cat.ownerId !== req.user.id) return res.status(404).json({ error: 'Catalog not found' });
  const wp = DB.findProduct({ id: wholesalerProductId });
  if (!wp) return res.status(404).json({ error: 'Wholesaler product not found' });
  const user = DB.findUser({ id: req.user.id });
  if (wp.ownerId !== user.wholesalerId) return res.status(403).json({ error: 'Item does not belong to your linked wholesaler' });

  const { discPrice, salePrice } = computePrices(wp.salePrice, marginPct, discountPct);
  const p = {
    id: uuid(), catalogId, ownerId: req.user.id,
    itemNo: wp.itemNo, productName: wp.productName, imageName: wp.imageName,
    category: wp.category, minQty: wp.minQty, unit: wp.unit,
    salePrice, discPrice,
    description: wp.description, description2: wp.description2,
    filter1: wp.filter1, filter2: wp.filter2, filter3: wp.filter3, tag1: wp.tag1, tag2: wp.tag2,
    sourceWholesalerProductId: wp.id,
    marginPct: Number(marginPct) || 0, discountPct: Number(discountPct) || 0,
    createdAt: new Date().toISOString(),
  };
  DB.createProduct(p);
  res.json(p);
});

// Bulk apply margin/discount to multiple wholesaler items at once
app.post('/api/reseller/catalog-items/bulk', auth, approvedResellerOnly, (req, res) => {
  const { catalogId, wholesalerProductIds, marginPct, discountPct } = req.body;
  if (!catalogId || !Array.isArray(wholesalerProductIds) || !wholesalerProductIds.length) {
    return res.status(400).json({ error: 'catalogId and wholesalerProductIds[] are required' });
  }
  const cat = DB.findCatalog({ id: catalogId });
  if (!cat || cat.ownerId !== req.user.id) return res.status(404).json({ error: 'Catalog not found' });
  const user = DB.findUser({ id: req.user.id });
  const created = [];
  for (const wpId of wholesalerProductIds) {
    const wp = DB.findProduct({ id: wpId });
    if (!wp || wp.ownerId !== user.wholesalerId) continue;
    const { discPrice, salePrice } = computePrices(wp.salePrice, marginPct, discountPct);
    const p = {
      id: uuid(), catalogId, ownerId: req.user.id,
      itemNo: wp.itemNo, productName: wp.productName, imageName: wp.imageName,
      category: wp.category, minQty: wp.minQty, unit: wp.unit,
      salePrice, discPrice,
      description: wp.description, description2: wp.description2,
      filter1: wp.filter1, filter2: wp.filter2, filter3: wp.filter3, tag1: wp.tag1, tag2: wp.tag2,
      sourceWholesalerProductId: wp.id,
      marginPct: Number(marginPct) || 0, discountPct: Number(discountPct) || 0,
      createdAt: new Date().toISOString(),
    };
    DB.createProduct(p);
    created.push(p);
  }
  res.json({ ok: true, count: created.length, items: created });
});

app.put('/api/reseller/catalog-items/:id', auth, approvedResellerOnly, (req, res) => {
  const p = DB.findProduct({ id: req.params.id });
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { marginPct, discountPct } = req.body;
  if (marginPct === undefined && discountPct === undefined) return res.status(400).json({ error: 'Nothing to update' });
  const wp = p.sourceWholesalerProductId ? DB.findProduct({ id: p.sourceWholesalerProductId }) : null;
  const basePrice = wp ? wp.salePrice : p.salePrice;
  const { discPrice, salePrice } = computePrices(
    basePrice,
    marginPct !== undefined ? marginPct : p.marginPct,
    discountPct !== undefined ? discountPct : p.discountPct
  );
  DB.updateProduct({ id: req.params.id }, {
    marginPct: marginPct !== undefined ? Number(marginPct) : p.marginPct,
    discountPct: discountPct !== undefined ? Number(discountPct) : p.discountPct,
    discPrice, salePrice,
  });
  res.json({ ok: true, discPrice, salePrice });
});

// ── PUBLIC CATALOG ────────────────────────────────────────────────────────
app.get('/api/public/:userId/:slug', (req, res) => {
  const owner = DB.findUser({ id: req.params.userId });
  if (!owner) return res.status(404).json({ error: 'Not found' });
  const cat = DB.findCatalog({ ownerId: owner.id, slug: req.params.slug });
  if (!cat) return res.status(404).json({ error: 'Catalog not found' });
  const products = DB.findProducts({ catalogId: cat.id });
  res.json({ catalog: cat, owner: safeUser(owner), products });
});

// ── ORDERS (public customer orders against reseller catalogs) ───────────
app.get('/api/orders', auth, (req, res) => {
  if (req.user.role === 'admin') return res.json(db.get('orders').value());
  res.json(DB.findOrders({ ownerId: req.user.id }));
});

app.post('/api/orders', (req, res) => {
  const { catalogId, customerName, customerPhone, customerEmail, address, items, total } = req.body;
  if (!catalogId || !customerName || !customerPhone) return res.status(400).json({ error: 'Name and phone required' });
  const cat = DB.findCatalog({ id: catalogId });
  if (!cat) return res.status(404).json({ error: 'Catalog not found' });
  const order = {
    id: uuid(), orderNo: genOrderNo('ORD'), catalogId, catalogName: cat.name, ownerId: cat.ownerId,
    customerName, customerPhone, customerEmail: customerEmail || '', address: address || '',
    items: items || [], total: total || 0, forwardedToWholesaler: false,
    createdAt: new Date().toISOString(),
  };
  DB.createOrder(order);
  res.json(order);
});

// ── FORWARD ORDER TO WHOLESALER ──────────────────────────────────────────
app.post('/api/orders/:id/forward-to-wholesaler', auth, resellerOnly, (req, res) => {
  const order = DB.findOrder({ id: req.params.id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (order.forwardedToWholesaler) return res.status(400).json({ error: 'Order already forwarded' });

  const user = DB.findUser({ id: req.user.id });
  if (!user.wholesalerId) return res.status(400).json({ error: 'No wholesaler linked to your account' });

  // Map each ordered item back to wholesaler item code/price (the ORIGINAL wholesaler price)
  const wholesaleItems = (order.items || []).map(item => {
    const resellerProduct = DB.findProducts({ catalogId: order.catalogId, itemNo: item.itemNo })[0];
    let wholesalerPrice = item.price;
    let wholesalerItemNo = item.itemNo;
    if (resellerProduct && resellerProduct.sourceWholesalerProductId) {
      const wp = DB.findProduct({ id: resellerProduct.sourceWholesalerProductId });
      if (wp) { wholesalerPrice = wp.salePrice; wholesalerItemNo = wp.itemNo; }
    }
    return { itemNo: wholesalerItemNo, productName: item.productName, qty: item.qty, unit: item.unit, price: wholesalerPrice };
  });
  const total = wholesaleItems.reduce((sum, i) => sum + (i.price * i.qty), 0);

  const wsOrder = {
    id: uuid(), orderNo: genOrderNo('WHO'), originalOrderId: order.id,
    wholesalerId: user.wholesalerId, resellerId: user.id,
    items: wholesaleItems, total: round2(total), status: 'pending',
    createdAt: new Date().toISOString(),
  };
  DB.createWholesaleOrder(wsOrder);
  DB.updateOrder({ id: order.id }, { forwardedToWholesaler: true });
  res.json({ ok: true, wholesaleOrder: wsOrder });
});

// ── ADMIN ─────────────────────────────────────────────────────────────────
app.get('/api/admin/wholesalers', auth, adminOnly, (req, res) => {
  res.json(DB.findUsers({ role: 'wholesaler' }).map(safeUser));
});
app.get('/api/admin/resellers', auth, adminOnly, (req, res) => {
  res.json(DB.findUsers({ role: 'reseller' }).map(safeUser));
});
app.put('/api/admin/users/:id/deactivate', auth, adminOnly, (req, res) => {
  const u = DB.findUser({ id: req.params.id });
  if (!u) return res.status(404).json({ error: 'Not found' });
  DB.updateUser({ id: req.params.id }, { status: 'inactive' });
  res.json({ ok: true });
});

// ── STATIC + SPA ──────────────────────────────────────────────────────────
app.get('/w/:slug/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/catalog/:userId/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wholesale Reseller SaaS running at http://localhost:${PORT}`);
});
