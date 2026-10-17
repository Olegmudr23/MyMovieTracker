import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCatalogCache } from './catalog-cache.mjs';
const scrypt = promisify(scryptCallback);
const file = process.env.DATABASE_PATH || './data/kinocircle.sqlite';
mkdirSync(dirname(file), { recursive: true });
const identityFile=resolve(dirname(file),'identity.key');
if(!process.env.IDENTITY_SECRET&&!existsSync(identityFile))writeFileSync(identityFile,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
const identitySecret=process.env.IDENTITY_SECRET||readFileSync(identityFile,'utf8');
const emailKey=email=>createHmac('sha256',identitySecret).update(email).digest('hex');
const db = new DatabaseSync(file);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT,slug TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS movies(id TEXT PRIMARY KEY,data TEXT);
CREATE TABLE IF NOT EXISTS library(user_id INTEGER REFERENCES users(id),movie_id TEXT REFERENCES movies(id),status TEXT,rating INTEGER,episode INTEGER DEFAULT 0,PRIMARY KEY(user_id,movie_id));
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),movie_id TEXT REFERENCES movies(id),text TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS recommendations(id INTEGER PRIMARY KEY,sender INTEGER REFERENCES users(id),recipient INTEGER REFERENCES users(id),movie_id TEXT REFERENCES movies(id),text TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);`);
const demo = [
 ['demo-1','Дюна: Часть вторая','2024','film','Фантастика',8.6,'Пол Атрейдес отправляется в путешествие вместе с Чани и фременами, чтобы найти свой путь среди песков Арракиса.','/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg'],
 ['demo-2','Разделение','2022','series','Триллер',8.7,'Сотрудники компании соглашаются на процедуру, которая разделяет воспоминания о работе и личной жизни.','/lFf6LLrQjYldcZItzOkGmAkNq9R.jpg'],
 ['demo-3','Интерстеллар','2014','film','Фантастика',8.8,'Команда исследователей отправляется за пределы нашей галактики, чтобы найти будущее для человечества.','/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg'],
 ['demo-4','Медведь','2022','series','Драма',8.5,'Молодой шеф-повар возвращается в Чикаго, чтобы управлять семейной закусочной.','/sHFlbKS3WLqMnp9t2ghADIJFnuQ.jpg'],
 ['demo-5','Отель «Гранд Будапешт»','2014','film','Комедия',8.1,'Невероятные приключения консьержа Густава и его юного друга в знаменитом европейском отеле.','/eWdyYQreja6JGCzqHWXpWHDrrPo.jpg'],
 ['demo-6','Настоящий детектив','2014','series','Детектив',8.9,'Сложные расследования и люди, которые ищут правду, сталкиваясь со своими собственными тайнами.','/aowr4xpLP5sRCL50TkuADomJ98T.jpg'],
 ['demo-7','Бедные-несчастные','2023','film','Фэнтези',7.9,'История Беллы Бакстер, которая открывает для себя мир и свободу быть собой.','/kCGlIMHnOm8JPXq3rXM6c5wMxcT.jpg'],
 ['demo-8','Унесённые призраками','2001','film','Анимация',8.8,'Тихиро попадает в мир духов, где ей предстоит спасти родителей и найти дорогу домой.','/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg']
].map(([id,title,year,type,genre,rating,description,poster])=>({id,title,year,type,genre,rating,description,poster:'https://image.tmdb.org/t/p/w500'+poster,demo:true}));
const store = m => {const old=db.prepare('SELECT data FROM movies WHERE id=?').get(m.id);if(old&&!m.description)m.description=JSON.parse(old.data).description;db.prepare('INSERT INTO movies VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(m.id,JSON.stringify(m));return m;};
demo.forEach(store);
const hash = s => createHash('sha256').update(s).digest('hex');
const attempts = new Map();
const getCatalog = createCatalogCache(db);
const json = (res,status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
const publicUser = u => u && ({id:u.id,name:u.name,slug:u.slug});
async function body(req) {let text='';for await(const chunk of req){text+=chunk;if(text.length>24000)fail('Слишком большой запрос',413);}try{return JSON.parse(text||'{}');}catch{fail('Некорректный JSON');}}
async function kp(path) {return getCatalog(path,process.env.KINOPOISK_API_KEY);}
function normalize(m){return store({id:'kp-'+m.kinopoiskId,title:m.nameRu||m.nameOriginal||m.nameEn,year:m.year,type:['TV_SERIES','MINI_SERIES'].includes(m.type)?'series':'film',genre:m.genres?.map(g=>g.genre).join(', ')||'Кино',rating:m.ratingKinopoisk,description:m.description||'',poster:m.posterUrlPreview||m.posterUrl,demo:false});}
const server=http.createServer(async(req,res)=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 const url=new URL(req.url,'http://localhost');const p=url.pathname;
 const token=req.headers.cookie?.match(/(?:^|; )session=([a-f0-9]+)/)?.[1];
 const user=token?db.prepare('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE token=? AND expires>?').get(hash(token),Date.now()):null;
 if(p.startsWith('/api/')){
 if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==`${process.env.COOKIE_SECURE==='1'?'https':'http'}://${req.headers.host}`)fail('Недопустимый источник запроса',403);
 if(p==='/api/me')return json(res,200,{user:publicUser(user),demo:!process.env.KINOPOISK_API_KEY});
 if(p==='/api/health')return json(res,200,{ok:true});
 if(['/api/register','/api/login'].includes(p)&&req.method==='POST'){
 const ip=req.socket.remoteAddress;let a=attempts.get(ip);if(!a||a.until<Date.now()){a={count:0,until:Date.now()+900000};attempts.set(ip,a);}if(++a.count>20)fail('Слишком много попыток. Подождите 15 минут.',429);
 const b=await body(req);const email=String(b.email||'').trim().toLowerCase();const password=String(b.password||'');let u;
 if(p.endsWith('register')){if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail('Укажите корректный email');if(password.length<10||password.length>128)fail('Пароль должен содержать от 10 до 128 символов');const name=String(b.name||'').trim();if(!name||name.length>50)fail('Имя должно содержать от 1 до 50 символов');const salt=randomBytes(16).toString('hex');const derived=await scrypt(password,salt,64);try{const result=db.prepare('INSERT INTO users(email,name,password,slug) VALUES (?,?,?,?)').run(emailKey(email),name,salt+':'+derived.toString('hex'),randomBytes(8).toString('hex'));u=db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);}catch{fail('Этот email уже зарегистрирован');}}
 else{if(password.length>128)fail('Неверный email или пароль',401);u=db.prepare('SELECT * FROM users WHERE email=?').get(emailKey(email));const [salt,expected]=(u?.password||'dummy:'+ '0'.repeat(128)).split(':');const actual=await scrypt(password,salt,64);if(!u||!timingSafeEqual(actual,Buffer.from(expected,'hex')))fail('Неверный email или пароль',401);}
 db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());const sid=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(sid),u.id,Date.now()+604800000);res.setHeader('Set-Cookie',`session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);return json(res,200,publicUser(u));}
 if(p==='/api/logout'&&req.method==='POST'){if(token)db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
 if(p==='/api/catalog'){const q=(url.searchParams.get('q')||'').trim().replace(/\s+/g,' ').toLowerCase().slice(0,100);const data=await kp('/api/v2.2/films?order=RATING&type=ALL&page=1'+(q?'&keyword='+encodeURIComponent(q):''));return json(res,200,{movies:data?data.items.map(normalize):demo.filter(m=>m.title.toLowerCase().includes(q.toLowerCase())),demo:!data});}
 const detail=p.match(/^\/api\/movies\/(kp-\d+|demo-\d+)$/);if(detail){let m=db.prepare('SELECT data FROM movies WHERE id=?').get(detail[1]);if(!m)fail('Фильм не найден',404);m=JSON.parse(m.data);if(m.id.startsWith('kp-')){const data=await kp('/api/v2.2/films/'+m.id.slice(3));if(data)m=normalize(data);}const comments=db.prepare('SELECT comments.id,text,created,users.name FROM comments JOIN users ON users.id=comments.user_id WHERE movie_id=? ORDER BY comments.id DESC LIMIT 100').all(m.id);return json(res,200,{movie:m,comments});}
 if(p.startsWith('/api/shared/')){const u=db.prepare('SELECT * FROM users WHERE slug=?').get(p.split('/').pop());if(!u)fail('Подборка не найдена',404);return json(res,200,{user:publicUser(u),items:db.prepare("SELECT movies.data,library.status,library.rating FROM library JOIN movies ON movie_id=movies.id WHERE user_id=? AND status='watched'").all(u.id).map(r=>({...JSON.parse(r.data),status:r.status,myRating:r.rating}))});}
 if(!user)fail('Войдите в аккаунт',401);
 if(p==='/api/library'&&req.method==='GET')return json(res,200,db.prepare('SELECT movies.data,library.status,library.rating,episode FROM library JOIN movies ON movie_id=movies.id WHERE user_id=?').all(user.id).map(r=>({...JSON.parse(r.data),status:r.status,myRating:r.rating,episode:r.episode})));
 if(p==='/api/library'&&req.method==='POST'){const b=await body(req);if(!db.prepare('SELECT id FROM movies WHERE id=?').get(String(b.id)))fail('Фильм не найден',404);if(!['planned','watching','watched'].includes(b.status))fail('Неизвестный статус');const rating=b.rating==null?null:Number(b.rating);if(rating!==null&&(!Number.isInteger(rating)||rating<1||rating>10))fail('Оценка от 1 до 10');const episode=Number(b.episode||0);if(!Number.isInteger(episode)||episode<0||episode>100000)fail('Некорректный номер серии');db.prepare('INSERT INTO library VALUES (?,?,?,?,?) ON CONFLICT(user_id,movie_id) DO UPDATE SET status=excluded.status,rating=excluded.rating,episode=excluded.episode').run(user.id,b.id,b.status,rating,episode);return json(res,200,{ok:true});}
 if(p==='/api/library'&&req.method==='DELETE'){const b=await body(req);db.prepare('DELETE FROM library WHERE user_id=? AND movie_id=?').run(user.id,String(b.id));return json(res,200,{ok:true});}
 if(p==='/api/comments'&&req.method==='POST'){const b=await body(req);const text=String(b.text||'').trim();if(!text||text.length>2000)fail('Комментарий от 1 до 2000 символов');if(!db.prepare('SELECT id FROM movies WHERE id=?').get(String(b.id)))fail('Фильм не найден',404);db.prepare('INSERT INTO comments(user_id,movie_id,text) VALUES (?,?,?)').run(user.id,b.id,text);return json(res,201,{ok:true});}
 if(p==='/api/recommendations'&&req.method==='POST'){const b=await body(req);const recipient=db.prepare('SELECT id FROM users WHERE email=?').get(emailKey(String(b.email||'').trim().toLowerCase()));if(!recipient)fail('Пользователь с таким email не найден');if(recipient.id===user.id)fail('Укажите email друга');if(!db.prepare('SELECT id FROM movies WHERE id=?').get(String(b.id)))fail('Фильм не найден',404);db.prepare('INSERT INTO recommendations(sender,recipient,movie_id,text) VALUES (?,?,?,?)').run(user.id,recipient.id,b.id,String(b.text||'').slice(0,500));return json(res,201,{ok:true});}
 if(p==='/api/recommendations')return json(res,200,db.prepare('SELECT recommendations.id,users.name,recommendations.text,created,movies.data FROM recommendations JOIN users ON sender=users.id JOIN movies ON movie_id=movies.id WHERE recipient=? ORDER BY recommendations.id DESC').all(user.id).map(r=>({...r,movie:JSON.parse(r.data),data:undefined})));
 fail('Не найдено',404);
 }
 const assets={'/':'index.html','/app.js':'app.js','/theme.js':'theme.js','/themes.css':'themes.css','/style.css':'style.css'};const asset=assets[p]||(p.startsWith('/share/')?'index.html':null);if(!asset)fail('Не найдено',404);res.setHeader('Content-Type',asset.endsWith('.css')?'text/css':asset.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.end(readFileSync(resolve('public',asset)));
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Ошибка сервера. Попробуйте ещё раз.'});else res.end();}});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Кинокруг: http://localhost:'+(process.env.PORT||3000)));
