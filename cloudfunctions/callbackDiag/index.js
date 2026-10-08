// 云函数 callbackDiag - 链路 A（服务号消息回调）的 HTTP 诊断哨兵
//
// ⭐ 存在意义：`receiveCallback` 一旦在**模块加载阶段**崩（云端依赖没装好、文件残缺等），
//    HTTP 访问服务会直接返回 500，微信后台只报「HTTP 返回非 200」，从外部完全看不到原因。
//    本函数**零依赖**（package.json 的 dependencies 为空），只要有路径映射就一定跑得起来，
//    用来把「路径通不通」与「receiveCallback 本身好不好」这两件事**分开定位**。
//
// 用法：① 腾讯云控制台 / 开发者工具给本函数建 HTTP 访问路径，例如 /diag
//      ② 浏览器打开 https://<默认域名>/diag?x=1
//         · 返回本 JSON（含 echo 与 headers）→ **域名与 HTTP 访问服务链路完全正常**
//         · 返回 INVALID_PATH → 路径没映射上，是路径问题，不是代码问题
//      ③ 再用同一浏览器打开 /receiveCallback?signature=x&timestamp=1&nonce=1&echostr=hello
//         · 返回 invalid signature → receiveCallback 也正常，可以回微信后台提交 URL
//         · 返回 500 / 非 JSON → receiveCallback 确有问题（用其 {"selftest":true} 查依赖）

exports.main = async (event) => {
  event = event || {};
  const out = {
    ok: true,
    fn: 'callbackDiag',
    version: '2026-09-28',
    message: '✅ 这个云函数被成功调起了 —— 说明域名 + HTTP 访问服务 + 路径映射全部正常。',
    runtime: process.version,
    env_id: process.env.TCB_ENV || process.env.SCF_NAMESPACE || '(未知)',
    httpMethod: event.httpMethod || '(非 HTTP 触发，可能是控制台测试)',
    path: event.path || '',
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    note: '下一步：用同一台设备打开 /receiveCallback?signature=x&timestamp=1&nonce=1&echostr=hello',
  };
  // HTTP 访问服务要求返回 {statusCode, body}
  if (event.httpMethod) {
    return { statusCode: 200, body: JSON.stringify(out, null, 2) };
  }
  return out;
};
