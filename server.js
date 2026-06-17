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

const app = express();
const PORT       = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'wholesale-reseller-secret-2025';
const MONGO_URI  = process.env.MONGO_URI || '';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── HELPERS ───────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 60) || 'firm';
}
function genOrderNo(prefix) {
  const d = new Date();
  return `${prefix}-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function defaultFieldSchema() {
  const schema = {};
  for (let i = 1; i <= 13; i++) {
    schema[`field${i}`] = {
      name: i === 1 ? 'MRP' : '',
      type: i === 1 ? 'number' : 'text',
      required: false, decimals: i === 1 ? 2 : 0, enabled: i <= 10,
    };
  }
  return schema;
}

function safeUser(u) {
  if (!u) return u;
  const { password, _id, __v, ...rest } = u;
  return rest;
}

// ── DB LAYER ──────────────────────────────────────────────────────────────
let DB;

async function initMongoDB() {
  const mongoose = require('mongoose');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  console.log('Connected to MongoDB Atlas');

  const anySchema = new mongoose.Schema({}, { strict: false, versionKey: false });
  const clean = doc => { if (!doc) return null; const o = doc.toObject ? doc.toObject() : {...doc}; delete o._id; return o; };
  const cleanArr = arr => arr.map(d => { const o = d.toObject ? d.toObject() : {...d}; delete o._id; return o; });

  const User    = mongoose.models.User    || mongoose.model('User',    anySchema);
  const Cat     = mongoose.models.Cat     || mongoose.model('Cat',     anySchema);
  const Product = mongoose.models.Product || mongoose.model('Product', anySchema);
  const Order   = mongoose.models.Order   || mongoose.model('Order',   anySchema);
  const WOrder  = mongoose.models.WOrder  || mongoose.model('WOrder',  anySchema);

  DB = {
    findUser:   q => User.findOne(q).lean().then(d => d ? (delete d._id, d) : null),
    findUsers:  (q={}) => User.find(q).lean().then(arr => arr.map(d => { delete d._id; return d; })),
    createUser: u => new User(u).save().then(() => u),
    updateUser: (q, u) => User.updateOne(q, { $set: u }),

    findCatalog:   q => Cat.findOne(q).lean().then(d => d ? (delete d._id, d) : null),
    findCatalogs:  (q={}) => Cat.find(q).lean().then(arr => arr.map(d => { delete d._id; return d; })),
    createCatalog: c => new Cat(c).save().then(() => c),
    updateCatalog: (q, u) => Cat.updateOne(q, { $set: u }),

    findProduct:   q => Product.findOne(q).lean().then(d => d ? (delete d._id, d) : null),
    findProducts:  (q={}) => Product.find(q).lean().then(arr => arr.map(d => { delete d._id; return d; })),
    createProduct: p => new Product(p).save().then(() => p),
    bulkCreateProducts: arr => Product.insertMany(arr),
    updateProduct: (q, u) => Product.updateOne(q, { $set: u }),
    deleteProducts: q => Product.deleteMany(q),

    findOrder:   q => Order.findOne(q).lean().then(d => d ? (delete d._id, d) : null),
    findOrders:  (q={}) => Order.find(q).lean().then(arr => arr.map(d => { delete d._id; return d; })),
    createOrder: o => new Order(o).save().then(() => o),
    updateOrder: (q, u) => Order.updateOne(q, { $set: u }),

    findWholesaleOrders: (q={}) => WOrder.find(q).lean().then(arr => arr.map(d => { delete d._id; return d; })),
    createWholesaleOrder: o => new WOrder(o).save().then(() => o),
  };
}

function initLowDB() {
  const low      = require('lowdb');
  const FileSync = require('lowdb/adapters/FileSync');
  const dbDir    = path.join(__dirname, 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const db = low(new FileSync(path.join(dbDir, 'db.json')));
  db.defaults({ users: [], catalogs: [], products: [], orders: [], wholesaleOrders: [] }).write();
  console.log('Using lowdb (local JSON database)');

  const wrap = v => Promise.resolve(v);
  DB = {
    findUser:   q => wrap(db.get('users').find(q).value() || null),
    findUsers:  (q={}) => wrap(db.get('users').filter(q).value()),
    createUser: u => { db.get('users').push(u).write(); return wrap(u); },
    updateUser: (q, u) => { db.get('users').find(q).assign(u).write(); return wrap(null); },

    findCatalog:   q => wrap(db.get('catalogs').find(q).value() || null),
    findCatalogs:  (q={}) => wrap(db.get('catalogs').filter(q).value()),
    createCatalog: c => { db.get('catalogs').push(c).write(); return wrap(c); },
    updateCatalog: (q, u) => { db.get('catalogs').find(q).assign(u).write(); return wrap(null); },

    findProduct:   q => wrap(db.get('products').find(q).value() || null),
    findProducts:  (q={}) => wrap(db.get('products').filter(q).value()),
    createProduct: p => { db.get('products').push(p).write(); return wrap(p); },
    bulkCreateProducts: arr => { arr.forEach(p => db.get('products').push(p).write()); return wrap(null); },
    updateProduct: (q, u) => { db.get('products').find(q).assign(u).write(); return wrap(null); },
    deleteProducts: q => { db.get('products').remove(q).write(); return wrap(null); },

    findOrder:   q => wrap(db.get('orders').find(q).value() || null),
    findOrders:  (q={}) => wrap(db.get('orders').filter(q).value()),
    createOrder: o => { db.get('orders').push(o).write(); return wrap(o); },
    updateOrder: (q, u) => { db.get('orders').find(q).assign(u).write(); return wrap(null); },

    findWholesaleOrders: (q={}) => wrap(db.get('wholesaleOrders').filter(q).value()),
    createWholesaleOrder: o => { db.get('wholesaleOrders').push(o).write(); return wrap(o); },
  };
}

async function seedAdmin() {
  const users = await DB.findUsers({ role: 'admin' });
  if (!users.length) {
    await DB.createUser({
      id: uuid(), role: 'admin', userId: 'admin', firmName: 'Platform Admin',
      contactPerson: 'Admin', email: 'admin@platform.local',
      password: bcrypt.hashSync('admin123', 10),
      slug: null, wholesalerId: null, status: 'active',
      createdAt: new Date().toISOString(),
    });
    console.log('Seeded admin user (userId: admin / password: admin123)');
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
const adminOnly      = (req,res,next) => req.user.role==='admin'      ? next() : res.status(403).json({error:'Admin only'});
const wholesalerOnly = (req,res,next) => req.user.role==='wholesaler' ? next() : res.status(403).json({error:'Wholesaler only'});
const resellerOnly   = (req,res,next) => req.user.role==='reseller'   ? next() : res.status(403).json({error:'Reseller only'});

async function approvedResellerOnly(req, res, next) {
  if (req.user.role !== 'reseller') return res.status(403).json({ error: 'Reseller only' });
  const user = await DB.findUser({ id: req.user.id });
  if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Your account is pending wholesaler approval.' });
  next();
}

function uniqueSlug(base, existingUsers) {
  let slug = slugify(base), n = 1;
  while (existingUsers.find(u => u.slug === slug)) { slug = `${slugify(base)}-${n}`; n++; }
  return slug;
}

// ── AUTH ──────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) return res.status(400).json({ error: 'User ID and password required' });
    const all = await DB.findUsers();
    const user = all.find(u => (u.userId||'').toLowerCase() === userId.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid user ID or password' });
    const token = jwt.sign({ id: user.id, role: user.role, userId: user.userId, firmName: user.firmName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: safeUser(user) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { userId, password, firmName, contactPerson, email, role, wholesalerSlug } = req.body;
    if (!userId || !password || !firmName || !contactPerson || !email || !role)
      return res.status(400).json({ error: 'All required fields must be filled' });
    if (!['wholesaler','reseller'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (await DB.findUser({ userId })) return res.status(400).json({ error: 'User ID already taken' });

    if (role === 'wholesaler') {
      const allUsers = await DB.findUsers();
      const slug = uniqueSlug(firmName, allUsers);
      const user = { id: uuid(), role:'wholesaler', userId, firmName, contactPerson, email,
        password: bcrypt.hashSync(password,10), slug, wholesalerId:null, status:'active', createdAt:new Date().toISOString() };
      await DB.createUser(user);
      const token = jwt.sign({ id:user.id, role:user.role, userId:user.userId, firmName:user.firmName }, JWT_SECRET, { expiresIn:'7d' });
      return res.json({ token, user: safeUser(user), signupLink: `/w/${slug}/signup` });
    }

    if (!wholesalerSlug) return res.status(400).json({ error: 'wholesalerSlug required for reseller registration' });
    const wholesaler = await DB.findUser({ slug: wholesalerSlug, role: 'wholesaler' });
    if (!wholesaler) return res.status(404).json({ error: 'Wholesaler not found for this signup link' });
    const user = { id: uuid(), role:'reseller', userId, firmName, contactPerson, email,
      password: bcrypt.hashSync(password,10), slug:null, wholesalerSlug, wholesalerId:wholesaler.id,
      status:'pending', createdAt:new Date().toISOString() };
    await DB.createUser(user);
    const token = jwt.sign({ id:user.id, role:user.role, userId:user.userId, firmName:user.firmName }, JWT_SECRET, { expiresIn:'7d' });
    res.json({ token, user: safeUser(user) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await DB.findUser({ id: req.user.id });
    if (!user) return res.status(401).json({ error: 'Session expired' });
    res.json(safeUser(user));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wholesalers/by-slug/:slug', async (req, res) => {
  try {
    const w = await DB.findUser({ slug: req.params.slug, role: 'wholesaler' });
    if (!w) return res.status(404).json({ error: 'Not found' });
    res.json({ id: w.id, firmName: w.firmName, slug: w.slug });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FIELD SCHEMA ──────────────────────────────────────────────────────────
app.get('/api/wholesaler/field-schema', auth, wholesalerOnly, async (req, res) => {
  try {
    const user = await DB.findUser({ id: req.user.id });
    res.json(user.fieldSchema || defaultFieldSchema());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/wholesaler/field-schema', auth, wholesalerOnly, async (req, res) => {
  try {
    const { schema } = req.body;
    if (!schema) return res.status(400).json({ error: 'schema required' });
    await DB.updateUser({ id: req.user.id }, { fieldSchema: schema });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/field-schema/:wholesalerId', async (req, res) => {
  try {
    const user = await DB.findUser({ id: req.params.wholesalerId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user.fieldSchema || defaultFieldSchema());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CATALOGS ──────────────────────────────────────────────────────────────
app.get('/api/catalogs', auth, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.json(await DB.findCatalogs());
    res.json(await DB.findCatalogs({ ownerId: req.user.id }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/catalogs', auth, async (req, res) => {
  try {
    if (req.user.role === 'reseller') {
      const user = await DB.findUser({ id: req.user.id });
      if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Pending wholesaler approval.' });
    } else if (req.user.role !== 'wholesaler') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const cat = { id: uuid(), ownerId: req.user.id, name, slug: slugify(name)+'-'+Math.random().toString(36).substring(2,6), status:'active', createdAt:new Date().toISOString() };
    await DB.createCatalog(cat);
    res.json(cat);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────
app.get('/api/catalogs/:catalogId/products', auth, async (req, res) => {
  try { res.json(await DB.findProducts({ catalogId: req.params.catalogId })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/catalogs/:catalogId/products', auth, wholesalerOnly, async (req, res) => {
  try {
    const cat = await DB.findCatalog({ id: req.params.catalogId });
    if (!cat) return res.status(404).json({ error: 'Catalog not found' });
    if (cat.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const { itemNo, productName, imageName, category, minQty, unit, salePrice, description, description2 } = req.body;
    if (!itemNo || salePrice === undefined) return res.status(400).json({ error: 'itemNo and salePrice required' });
    const customFields = {};
    for (let i = 1; i <= 13; i++) { const k = `field${i}`; customFields[k] = req.body[k] !== undefined ? req.body[k] : ''; }
    const p = { id: uuid(), catalogId: req.params.catalogId, ownerId: req.user.id,
      itemNo, productName: productName||itemNo, imageName: imageName||'',
      category: category||'', minQty: Number(minQty)||1, unit: unit||'Pcs',
      salePrice: Number(salePrice)||0, discPrice: 0,
      description: description||'', description2: description2||'',
      ...customFields, sourceWholesalerProductId: null, createdAt: new Date().toISOString() };
    await DB.createProduct(p);
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', auth, wholesalerOnly, async (req, res) => {
  try {
    const p = await DB.findProduct({ id: req.params.id });
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await DB.deleteProducts({ id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV/XLSX UPLOAD ───────────────────────────────────────────────────────
const csvUploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { const d = path.join(__dirname,'uploads','csv'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
    filename: (_req, file, cb) => cb(null, uuid()+'_'+file.originalname),
  }),
  limits: { fileSize: 10*1024*1024 },
});

app.post('/api/catalogs/:catalogId/upload-csv', auth, wholesalerOnly, csvUploader.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const catId = req.params.catalogId;
    const cat = await DB.findCatalog({ id: catId });
    if (!cat) return res.status(404).json({ error: 'Catalog not found' });
    if (cat.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    let rows = [];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.csv') {
      rows = parse(fs.readFileSync(req.file.path,'utf8'), { columns:true, skip_empty_lines:true, trim:true });
    } else if (ext==='.xlsx'||ext==='.xls') {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const allRows = XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      let hi = -1;
      for (let i=0;i<Math.min(allRows.length,10);i++) {
        if (allRows[i].some(c=>String(c).toLowerCase().includes('item'))) { hi=i; break; }
      }
      if (hi===-1) return res.status(400).json({ error: 'Cannot find header row' });
      rows = XLSX.utils.sheet_to_json(ws,{defval:'',range:hi});
    } else {
      return res.status(400).json({ error: 'Please upload .csv or .xlsx' });
    }
    if (!rows.length) return res.status(400).json({ error: 'File is empty' });

    const col = (row,...keys) => {
      for (const k of keys) {
        const found = Object.keys(row).find(rk => rk.toLowerCase().replace(/[\s*_()]/g,'').startsWith(k.toLowerCase().replace(/[\s*_()]/g,'')));
        if (found && String(row[found]).trim()!=='') return String(row[found]).trim();
      }
      return '';
    };

    const wholesalerUser = await DB.findUser({ id: req.user.id });
    const schema = wholesalerUser.fieldSchema || defaultFieldSchema();

    let inserted=[], errors=[];
    rows.forEach((row,idx) => {
      const rowNum=idx+2, rowErrors=[];
      const itemNo = col(row,'itemno','item no','item code','code','sku');
      const sp = col(row,'sellingprice','selling price','saleprice','sale price','price');
      if (!itemNo) rowErrors.push('Item Code missing');
      if (!sp||isNaN(parseFloat(sp))) rowErrors.push('Selling Price missing or invalid');
      for (let i=1;i<=13;i++) {
        const fd=schema[`field${i}`];
        if (fd&&fd.enabled&&fd.name&&fd.required&&!col(row,fd.name)) rowErrors.push(`${fd.name} is required`);
      }
      if (rowErrors.length) { errors.push({row:rowNum,itemNo:itemNo||'(blank)',errors:rowErrors}); return; }

      const customFields={};
      for (let i=1;i<=13;i++) {
        const k=`field${i}`, fd=schema[k];
        if (fd&&fd.enabled&&fd.name) {
          const raw=col(row,fd.name);
          customFields[k] = fd.type==='number' ? (parseFloat(raw)||0) : raw;
        } else { customFields[k]=''; }
      }
      inserted.push({
        id:uuid(), catalogId:catId, ownerId:req.user.id,
        itemNo, productName:col(row,'productname','product name','item name','name')||itemNo,
        imageName:(col(row,'imagename','image name','image','img')||itemNo).replace(/\s+/g,'-').trim(),
        category:col(row,'category','cat'),
        minQty:parseFloat(col(row,'minqty','min qty','minimumqty'))||1,
        unit:col(row,'unit')||'Pcs',
        salePrice:parseFloat(sp), discPrice:0,
        description:col(row,'description','desc'), description2:col(row,'description2','desc2'),
        ...customFields, sourceWholesalerProductId:null, createdAt:new Date().toISOString(),
      });
    });

    if (inserted.length>0) await DB.bulkCreateProducts(inserted);
    res.json({
      ok:inserted.length>0, count:inserted.length, errorCount:errors.length, errors,
      message: inserted.length>0
        ? `${inserted.length} products imported${errors.length>0?` · ${errors.length} rows skipped`:''}`
        : `No products imported — ${errors.length} rows had errors`,
    });
  } catch(err) { res.status(400).json({ error:'Parse error: '+err.message }); }
});

// ── WHOLESALER: RESELLERS ─────────────────────────────────────────────────
app.get('/api/wholesaler/resellers', auth, wholesalerOnly, async (req, res) => {
  try { res.json((await DB.findUsers({ wholesalerId: req.user.id, role:'reseller' })).map(safeUser)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/wholesaler/resellers/:id/approve', auth, wholesalerOnly, async (req, res) => {
  try {
    const r = await DB.findUser({ id:req.params.id, role:'reseller' });
    if (!r) return res.status(404).json({ error:'Not found' });
    if (r.wholesalerId!==req.user.id) return res.status(403).json({ error:'Forbidden' });
    await DB.updateUser({ id:req.params.id }, { status:'approved' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/wholesaler/resellers/:id/reject', auth, wholesalerOnly, async (req, res) => {
  try {
    const r = await DB.findUser({ id:req.params.id, role:'reseller' });
    if (!r) return res.status(404).json({ error:'Not found' });
    if (r.wholesalerId!==req.user.id) return res.status(403).json({ error:'Forbidden' });
    await DB.updateUser({ id:req.params.id }, { status:'rejected' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wholesaler/wholesale-orders', auth, wholesalerOnly, async (req, res) => {
  try { res.json(await DB.findWholesaleOrders({ wholesalerId: req.user.id })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RESELLER ──────────────────────────────────────────────────────────────
app.get('/api/reseller/wholesaler-items', auth, resellerOnly, async (req, res) => {
  try {
    const user = await DB.findUser({ id: req.user.id });
    if (!user.wholesalerId) return res.status(400).json({ error:'No wholesaler linked' });
    const items = await DB.findProducts({ ownerId: user.wholesalerId });
    const wholesaler = await DB.findUser({ id: user.wholesalerId });
    const schema = wholesaler ? (wholesaler.fieldSchema || defaultFieldSchema()) : defaultFieldSchema();
    res.json({ items, schema });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function computePrices(wholesalerPrice, marginPct, discountPct) {
  const margin = Number(marginPct)||0, discount = Number(discountPct)||0;
  const finalPrice = wholesalerPrice*(1+margin/100);
  const displayedMRP = discount>0 ? finalPrice/(1-discount/100) : finalPrice;
  return { discPrice:round2(finalPrice), salePrice:round2(displayedMRP) };
}

app.post('/api/reseller/catalog-items/bulk', auth, approvedResellerOnly, async (req, res) => {
  try {
    const { catalogId, wholesalerProductIds, marginPct, discountPct } = req.body;
    if (!catalogId||!Array.isArray(wholesalerProductIds)||!wholesalerProductIds.length)
      return res.status(400).json({ error:'catalogId and wholesalerProductIds[] required' });
    const cat = await DB.findCatalog({ id:catalogId });
    if (!cat||cat.ownerId!==req.user.id) return res.status(404).json({ error:'Catalog not found' });
    const user = await DB.findUser({ id:req.user.id });
    const created=[];
    for (const wpId of wholesalerProductIds) {
      const wp = await DB.findProduct({ id:wpId });
      if (!wp||wp.ownerId!==user.wholesalerId) continue;
      const {discPrice,salePrice} = computePrices(wp.salePrice, marginPct, discountPct);
      const customFields={};
      for (let i=1;i<=13;i++) { const k=`field${i}`; customFields[k]=wp[k]||''; }
      const p = { id:uuid(), catalogId, ownerId:req.user.id,
        itemNo:wp.itemNo, productName:wp.productName, imageName:wp.imageName,
        category:wp.category, minQty:wp.minQty, unit:wp.unit, salePrice, discPrice,
        description:wp.description, description2:wp.description2, ...customFields,
        sourceWholesalerProductId:wp.id, marginPct:Number(marginPct)||0, discountPct:Number(discountPct)||0,
        createdAt:new Date().toISOString() };
      await DB.createProduct(p);
      created.push(p);
    }
    res.json({ ok:true, count:created.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUBLIC CATALOG ────────────────────────────────────────────────────────
app.get('/api/public/:userId/:slug', async (req, res) => {
  try {
    const owner = await DB.findUser({ id:req.params.userId });
    if (!owner) return res.status(404).json({ error:'Not found' });
    const cat = await DB.findCatalog({ ownerId:owner.id, slug:req.params.slug });
    if (!cat) return res.status(404).json({ error:'Catalog not found' });
    const products = await DB.findProducts({ catalogId:cat.id });
    let schema = defaultFieldSchema();
    if (owner.role==='reseller'&&owner.wholesalerId) {
      const w = await DB.findUser({ id:owner.wholesalerId });
      if (w) schema = w.fieldSchema||defaultFieldSchema();
    } else if (owner.role==='wholesaler') {
      schema = owner.fieldSchema||defaultFieldSchema();
    }
    res.json({ catalog:cat, owner:safeUser(owner), products, schema });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ORDERS ────────────────────────────────────────────────────────────────
app.get('/api/orders', auth, async (req, res) => {
  try {
    if (req.user.role==='admin') return res.json(await DB.findOrders());
    res.json(await DB.findOrders({ ownerId:req.user.id }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { catalogId, customerName, customerPhone, customerEmail, address, items, total } = req.body;
    if (!catalogId||!customerName||!customerPhone) return res.status(400).json({ error:'Name and phone required' });
    const cat = await DB.findCatalog({ id:catalogId });
    if (!cat) return res.status(404).json({ error:'Catalog not found' });
    const order = { id:uuid(), orderNo:genOrderNo('ORD'), catalogId, catalogName:cat.name, ownerId:cat.ownerId,
      customerName, customerPhone, customerEmail:customerEmail||'', address:address||'',
      items:items||[], total:total||0, forwardedToWholesaler:false, createdAt:new Date().toISOString() };
    await DB.createOrder(order);
    res.json(order);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id/forward-to-wholesaler', auth, resellerOnly, async (req, res) => {
  try {
    const order = await DB.findOrder({ id:req.params.id });
    if (!order) return res.status(404).json({ error:'Order not found' });
    if (order.ownerId!==req.user.id) return res.status(403).json({ error:'Forbidden' });
    if (order.forwardedToWholesaler) return res.status(400).json({ error:'Order already forwarded' });
    const user = await DB.findUser({ id:req.user.id });
    if (!user.wholesalerId) return res.status(400).json({ error:'No wholesaler linked' });
    const wholesaleItems = await Promise.all((order.items||[]).map(async item => {
      const prods = await DB.findProducts({ catalogId:order.catalogId, itemNo:item.itemNo });
      const rp = prods[0];
      let price=item.price, itemNo=item.itemNo;
      if (rp&&rp.sourceWholesalerProductId) {
        const wp = await DB.findProduct({ id:rp.sourceWholesalerProductId });
        if (wp) { price=wp.salePrice; itemNo=wp.itemNo; }
      }
      return { itemNo, productName:item.productName, qty:item.qty, unit:item.unit, price };
    }));
    const total = wholesaleItems.reduce((s,i)=>s+(i.price*i.qty),0);
    const wsOrder = { id:uuid(), orderNo:genOrderNo('WHO'), originalOrderId:order.id,
      wholesalerId:user.wholesalerId, resellerId:user.id,
      items:wholesaleItems, total:round2(total), status:'pending', createdAt:new Date().toISOString() };
    await DB.createWholesaleOrder(wsOrder);
    await DB.updateOrder({ id:order.id }, { forwardedToWholesaler:true });
    res.json({ ok:true, wholesaleOrder:wsOrder });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────
app.get('/api/admin/wholesalers', auth, adminOnly, async (req,res) => {
  try { res.json((await DB.findUsers({role:'wholesaler'})).map(safeUser)); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/admin/resellers', auth, adminOnly, async (req,res) => {
  try { res.json((await DB.findUsers({role:'reseller'})).map(safeUser)); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ── STATIC + SPA ──────────────────────────────────────────────────────────
app.get('/w/:slug/signup', (_req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/catalog/:userId/:slug', (_req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.use(express.static(path.join(__dirname,'public')));
app.get('/{*path}', (req,res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({error:'Not found'});
  res.sendFile(path.join(__dirname,'public','index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (MONGO_URI) {
      await initMongoDB();
    } else {
      initLowDB();
    }
    await seedAdmin();
    app.listen(PORT, () => console.log(`eCATLOG SaaS running at http://localhost:${PORT}`));
  } catch(err) {
    console.error('Startup error:', err.message);
    process.exit(1);
  }
})();
