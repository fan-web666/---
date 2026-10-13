const PLATFORM_NAMES = {video_channel:'视频号',douyin:'抖音',xiaohongshu:'小红书',bilibili:'B站',kuaishou:'快手',local:'本地视频',other:'其他平台'};
const FIELDS = ['video_title','doc_title','source_platform','content_edited','content','content.transcript','content.full_markdown','content.hook','content.highlights','content.points.text','content.points.title','segments.text'];
function keyword(value) { return String(value || '').trim().slice(0,100); }
function condition(database, command, userId, input, platform) {
  const base = {uid:userId,deleted:false};
  if (PLATFORM_NAMES[platform]) base.source_platform=platform;
  const key=keyword(input);
  if(!key)return base;
  const regexp=database.RegExp({regexp:key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),options:'i'});
  const alternatives=FIELDS.map(field=>({[field]:regexp}));
  Object.keys(PLATFORM_NAMES).forEach(code=>{if(PLATFORM_NAMES[code].toLowerCase().includes(key.toLowerCase()))alternatives.push({source_platform:code});});
  return command.and([base,command.or(alternatives)]);
}
function snippet(detail,input) {
  const key=keyword(input).toLowerCase();if(!key)return '';
  const s=detail.structured||{};
  const texts=[detail.transcript,s.hook,...(s.highlights||[]),...(s.points||[]).map(p=>[p.title,p.text].filter(Boolean).join(' ')),detail.content];
  for(const value of texts){const text=String(value||'').replace(/\s+/g,' ');const index=text.toLowerCase().indexOf(key);if(index<0)continue;const start=Math.max(0,index-32),end=Math.min(text.length,index+key.length+64);return(start?'…':'')+text.slice(start,end)+(end<text.length?'…':'');}
  return '';
}
module.exports={condition,snippet,keyword};
