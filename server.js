const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE_THIS_PASSWORD';
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_THIS_RANDOM_SECRET';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '994512379292';
const STORE_NAME = process.env.STORE_NAME || 'HH Store';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'hhstore.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 spec TEXT DEFAULT '',
 price REAL NOT NULL,
 img TEXT NOT NULL,
 gallery TEXT NOT NULL DEFAULT '[]',
 badge TEXT DEFAULT '',
 brand TEXT DEFAULT '',
 cat TEXT DEFAULT '',
 stock INTEGER NOT NULL DEFAULT 0,
 colors TEXT NOT NULL DEFAULT '[]',
 storage TEXT NOT NULL DEFAULT '[]',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_name TEXT NOT NULL,
 customer_phone TEXT NOT NULL,
 address TEXT NOT NULL,
 note TEXT DEFAULT '',
 items TEXT NOT NULL,
 total REAL NOT NULL,
 status TEXT NOT NULL DEFAULT 'new',
 restocked INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (count) return;
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-products.json'), 'utf8'));
  const stmt = db.prepare(`INSERT INTO products(name,spec,price,img,gallery,badge,brand,cat,stock,colors,storage) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => seed.forEach(p => stmt.run(p.name,p.spec,p.price,p.img,JSON.stringify([p.img]),p.badge||'',p.brand||'',p.cat||'',p.stock||0,JSON.stringify(p.colors||[]),JSON.stringify(p.storage||[]))));
  tx();
}
seed();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
function makeToken() { return crypto.createHmac('sha256', SESSION_SECRET).update(crypto.randomBytes(32)).digest('hex'); }
function requireAdmin(req,res,next) {
  const token = req.headers['x-admin-token'] || (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('hh_admin='))?.split('=')[1];
  if (!token || !sessions.has(token)) return res.status(401).json({error:'Admin giriş tələb olunur'});
  next();
}
function productOut(r) {
  return {...r, gallery: JSON.parse(r.gallery||'[]'), colors: JSON.parse(r.colors||'[]'), storage: JSON.parse(r.storage||'[]'), active: !!r.active};
}

app.get('/api/config', (req,res)=>res.json({storeName:STORE_NAME, whatsappNumber:WHATSAPP_NUMBER}));
app.get('/api/products', (req,res)=>{
  const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id DESC').all().map(productOut);
  res.json(rows);
});

app.post('/api/orders', (req,res)=>{
  const { customerName, customerPhone, address, note='', items } = req.body || {};
  if (!customerName || !customerPhone || !address || !Array.isArray(items) || !items.length) return res.status(400).json({error:'Ad, telefon, ünvan və ən azı bir məhsul tələb olunur.'});
  try {
    const result = db.transaction(() => {
      const normalized=[]; let total=0;
      for (const item of items) {
        const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(item.productId));
        const qty=Number(item.qty);
        if(!p || !Number.isInteger(qty) || qty<1) throw new Error('Məhsul və ya miqdar yanlışdır.');
        if(p.stock<qty) throw new Error(`${p.name} üçün stok kifayət etmir. Hazır stok: ${p.stock}`);
        const color = String(item.color||'').trim();
        const storage = String(item.storage||'').trim();
        const lineTotal=p.price*qty; total+=lineTotal;
        normalized.push({productId:p.id,name:p.name,price:p.price,qty,color,storage,img:p.img,lineTotal});
      }
      for(const x of normalized) db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(x.qty,x.productId);
      const info=db.prepare('INSERT INTO orders(customer_name,customer_phone,address,note,items,total,status) VALUES(?,?,?,?,?,?,?)').run(customerName,customerPhone,address,note,JSON.stringify(normalized),total,'new');
      return {id:info.lastInsertRowid,total,items:normalized};
    })();
    const lines=result.items.map(x=>`• ${x.name}\n  Rəng: ${x.color||'-'}\n  Variant: ${x.storage||'-'}\n  Miqdar: ${x.qty}\n  Qiymət: ${x.lineTotal.toLocaleString('az-AZ')} ₼`).join('\n');
    const msg=`Salam ${STORE_NAME}, yeni sifariş vermək istəyirəm.\n\nSifariş #${result.id}\n${lines}\n\nCəmi: ${result.total.toLocaleString('az-AZ')} ₼\n\nMüştəri: ${customerName}\nTelefon: ${customerPhone}\nÜnvan: ${address}${note?'\nQeyd: '+note:''}`;
    res.json({ok:true, orderId:result.id,total:result.total,whatsappUrl:`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`});
  } catch(e) { res.status(409).json({error:e.message}); }
});

app.post('/api/admin/login',(req,res)=>{
  if ((req.body?.password||'') !== ADMIN_PASSWORD) return res.status(401).json({error:'Şifrə yanlışdır'});
  const token=makeToken(); sessions.set(token, Date.now()+1000*60*60*12);
  res.setHeader('Set-Cookie',`hh_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  res.json({ok:true,token});
});
app.post('/api/admin/logout',requireAdmin,(req,res)=>{const token=req.headers['x-admin-token']||(req.headers.cookie||'').split(';').find(x=>x.trim().startsWith('hh_admin='))?.split('=')[1]; if(token)sessions.delete(token); res.json({ok:true});});
app.get('/api/admin/orders',requireAdmin,(req,res)=>{
  const rows=db.prepare('SELECT * FROM orders ORDER BY id DESC').all().map(x=>({...x,items:JSON.parse(x.items)}));
  res.json(rows);
});
app.patch('/api/admin/orders/:id',requireAdmin,(req,res)=>{
  const id=Number(req.params.id), status=String(req.body?.status||'');
  const allowed=['new','confirmed','shipped','completed','cancelled']; if(!allowed.includes(status)) return res.status(400).json({error:'Status yanlışdır'});
  const tx=db.transaction(()=>{
    const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id); if(!o) throw new Error('Sifariş tapılmadı');
    if(o.status!=='cancelled' && status==='cancelled' && !o.restocked){
      const items=JSON.parse(o.items); for(const x of items) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(x.qty,x.productId);
      db.prepare('UPDATE orders SET status=?,restocked=1 WHERE id=?').run(status,id);
    } else db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);
  });
  try{tx();res.json({ok:true});}catch(e){res.status(409).json({error:e.message});}
});
app.get('/api/admin/products',requireAdmin,(req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(productOut)));
app.patch('/api/admin/products/:id',requireAdmin,(req,res)=>{
  const id=Number(req.params.id), p=req.body||{};
  const old=db.prepare('SELECT * FROM products WHERE id=?').get(id); if(!old)return res.status(404).json({error:'Məhsul tapılmadı'});
  const fields=['name','spec','price','img','badge','brand','cat','stock','active']; const vals=fields.map(k=>p[k]===undefined?old[k]:p[k]);
  db.prepare(`UPDATE products SET ${fields.map(k=>k+'=?').join(',')} WHERE id=?`).run(...vals,id);
  res.json({ok:true,product:productOut(db.prepare('SELECT * FROM products WHERE id=?').get(id))});
});
app.post('/api/admin/products',requireAdmin,(req,res)=>{
  const p=req.body||{}; if(!p.name||!p.price||!p.img)return res.status(400).json({error:'Ad, qiymət və şəkil tələb olunur'});
  const info=db.prepare('INSERT INTO products(name,spec,price,img,gallery,badge,brand,cat,stock,colors,storage,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)').run(p.name,p.spec||'',Number(p.price),p.img,JSON.stringify(p.gallery?.length?p.gallery:[p.img]),p.badge||'',p.brand||'',p.cat||'',Number(p.stock||0),JSON.stringify(p.colors||[]),JSON.stringify(p.storage||[]));
  res.json({ok:true,id:info.lastInsertRowid});
});
app.delete('/api/admin/products/:id',requireAdmin,(req,res)=>{db.prepare('UPDATE products SET active=0 WHERE id=?').run(Number(req.params.id));res.json({ok:true});});

app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

app.listen(PORT,()=>console.log(`${STORE_NAME} running on http://localhost:${PORT}`));
