import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://panda1151-netizen.github.io';

const SYSTEM = `את "היועצת האישית" של רוני. עני תמיד בעברית, בגוף שני נקבה, בחום ובקצרה.
רוני צמחונית ואוכלת דגים. אין להציע בשר או עוף. אין לתת קלוריות או לבקש לשקול מזון.
עובדים במנות ובמידות ביתיות בלבד. אין להמציא כמויות או המרות.
רעב: קודם ירקות חופשיים ושתייה חמה, אחר כך התוספת הגמישה אם פנויה, ורק אם כל היום הושלם והתוספת נוצלה — מנת חלבון קלה חד־פעמית.
אין פיצוי על אכילה לא מתוכננת: לא דילוג, צום, הקטנת מנה או אימון פיצוי.
אם תמונה לא ברורה, אומרים מה ניתן לזהות ושואלים שאלה קצרה אחת.`;

const rate = new Map();
function rateLimited(req){
  const key=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').toString().split(',')[0].trim();
  const now=Date.now(), windowMs=60*60*1000, max=60;
  const rec=rate.get(key);
  if(!rec || now-rec.start>windowMs){rate.set(key,{start:now,count:1});return false;}
  rec.count++;
  return rec.count>max;
}

function corsHeaders(req){
  const origin=req.headers.origin;
  const allowed = !origin || origin===ALLOWED_ORIGIN || origin==='http://localhost:3000' || origin==='http://127.0.0.1:3000';
  return {
    allowed,
    headers: {
      'Access-Control-Allow-Origin': allowed && origin ? origin : ALLOWED_ORIGIN,
      'Vary':'Origin',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type',
    }
  };
}

function send(req,res,status,body,type='application/json; charset=utf-8'){
  const cors=corsHeaders(req);
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...cors.headers});
  res.end(typeof body==='string'?body:JSON.stringify(body));
}

async function openai(body){
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const data=await r.json();
  if(!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

function extractText(data){
  if(data.output_text) return data.output_text;
  for(const out of data.output||[]) for(const c of out.content||[]) if(c.type==='output_text'&&c.text) return c.text;
  return '';
}

const server=http.createServer(async(req,res)=>{
  const cors=corsHeaders(req);
  if(req.method==='OPTIONS'){
    if(!cors.allowed) return send(req,res,403,{error:'Origin not allowed'});
    res.writeHead(204,cors.headers); return res.end();
  }
  if(!cors.allowed) return send(req,res,403,{error:'Origin not allowed'});

  if(req.method==='GET'&&req.url==='/health'){
    return send(req,res,200,{ok:true,model:OPENAI_MODEL,hasKey:Boolean(OPENAI_API_KEY)});
  }

  if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){
    return send(req,res,200,fs.readFileSync(path.join(__dirname,'index.html')),'text/html; charset=utf-8');
  }

  if(req.method==='POST'&&(req.url==='/api/chat'||req.url==='/api/plate')){
    if(rateLimited(req)) return send(req,res,429,{error:'Too many requests'});
    if(!OPENAI_API_KEY) return send(req,res,503,{error:'OPENAI_API_KEY missing'});
    let raw='';for await(const chunk of req)raw+=chunk;
    try{
      const payload=JSON.parse(raw||'{}');

      if(req.url==='/api/plate'){
        const meal=payload.meal||{};
        const content=[{type:'input_text',text:`נתחי את תמונת הצלחת מול הארוחה המתוכננת של רוני: ${meal.name||''}. מבנה הארוחה: ${JSON.stringify(meal.groups||[])}.\nהחזירי JSON בלבד בפורמט: {"components":["..."],"match":"מתאים / חלקית מתאים / לא ברור","note":"המלצה אחת קצרה להמשך במסגרת התפריט"}. אל תתני קלוריות ואל תעריכי משקל מדויק.`}];
        if(payload.image) content.push({type:'input_image',image_url:payload.image});
        const data=await openai({model:OPENAI_MODEL,reasoning:{effort:'low'},input:[{role:'system',content:[{type:'input_text',text:SYSTEM}]},{role:'user',content}],max_output_tokens:350});
        const text=extractText(data).trim().replace(/^```json\s*/,'').replace(/```$/,'').trim();
        try{return send(req,res,200,JSON.parse(text));}
        catch{return send(req,res,200,{components:['זוהו רכיבים בתמונה'],match:'לא ברור',note:text||'אם משהו לא ברור, אפשר לשאול שאלה קצרה.'});}
      }

      const content=[{type:'input_text',text:`מצב היום: ${JSON.stringify(payload.state||{})}\n\nהודעת רוני: ${payload.message||'נשלחה תמונה'}`}];
      if(payload.image) content.push({type:'input_image',image_url:payload.image});
      const data=await openai({model:OPENAI_MODEL,reasoning:{effort:'low'},input:[{role:'system',content:[{type:'input_text',text:SYSTEM}]},{role:'user',content}],max_output_tokens:500});
      return send(req,res,200,{reply:extractText(data)});
    }catch(err){return send(req,res,500,{error:String(err)});}
  }

  return send(req,res,404,{error:'Not found'});
});

server.listen(PORT,()=>console.log(`Roni Advisor running on http://localhost:${PORT}`));