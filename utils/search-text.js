// Literal matching only: punctuation in user input is never interpreted as regex or markup.
function parts(value, keyword) {
  const text=String(value||''),key=String(keyword||'').trim().slice(0,100);
  if(!key)return [{text,hit:false,index:0}];
  const lower=text.toLowerCase(),needle=key.toLowerCase(),out=[];let start=0,index;
  while((index=lower.indexOf(needle,start))>=0){if(index>start)out.push({text:text.slice(start,index),hit:false});out.push({text:text.slice(index,index+key.length),hit:true});start=index+key.length;}
  if(start<text.length)out.push({text:text.slice(start),hit:false});
  return (out.length?out:[{text,hit:false}]).map((part,index)=>Object.assign(part,{index}));
}

// 命中处截取一段上下文（列表卡片上的「文案匹配 · …」）。
// ⚠️ 口径必须与云函数 cloud-common/copy-search.js#snippet 一致：同样是
//    原文 → 钩子 → 金句 → 要点 → 兼容正文 的顺序、命中点前 32 后 64 字、截断处补省略号。
//    云端返回的 search_snippet 才是权威值，这里只服务「输入瞬间的本地即时反馈」——
//    两处不一致的话，云端结果回来时片段会跳一下。改一处必须同步另一处。
const SNIP_BEFORE = 32, SNIP_AFTER = 64;
function snippet(detail, keyword) {
  const key = String(keyword || '').trim().slice(0, 100).toLowerCase();
  if (!key || !detail) return '';
  const s = detail.structured || {};
  const texts = [
    detail.transcript,
    s.hook,
    ...(Array.isArray(s.highlights) ? s.highlights : []),
    ...(Array.isArray(s.points)
      ? s.points.map((p) => [p && p.title, p && p.text].filter(Boolean).join(' '))
      : []),
    detail.content,
  ];
  for (const value of texts) {
    const text = String(value || '').replace(/\s+/g, ' ');
    const index = text.toLowerCase().indexOf(key);
    if (index < 0) continue;
    const start = Math.max(0, index - SNIP_BEFORE);
    const end = Math.min(text.length, index + key.length + SNIP_AFTER);
    return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }
  return '';
}
module.exports={parts,snippet};
