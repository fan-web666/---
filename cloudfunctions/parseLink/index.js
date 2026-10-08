// 云函数 parseLink - B 链路：小程序内粘贴跨平台链接解析（PRD F-01b / R-02 / R-03 / R-04 / R-05 / R-06）
// 承诺平台：视频号 / 抖音 / 小红书 / B站 / 快手；其余平台架构兼容、按适配器扩展（PRD 12.10）
// ⚠️ 平台识别只做「归类」，识别不出不再硬拒（域名变体太多，硬拒会误杀真实链接），
//    能否取到源由取源环节判定。
// 行为：平台识别 → 当日去重 → 并发检查 → 建任务 → 即时尝试解析（超时则由 parsePipeline 兜底）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { db, cmd, COLL } = require('./_common/db');
const { ok, err } = require('./_common/util');
const { ensureUserFromContext } = require('./_common/user');
const providers = require('./_common/providers');
const { md5 } = require('./_common/crypto');
const { DUP_WINDOW_MS, MAX_USER_CONCURRENT } = require('./_common/consts');
const { countActiveTasks } = require('./_common/credit');
const { track } = require('./_common/track');

/** 从混杂文本（带口令 / 分享文案）里抽 http 链接；裸域名自动补 https:// */
function normalizeShareUrl(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  const m = t.match(/https?:\/\/[^\s，,。、"'）)】\]]+/i);
  if (m) return m[0].replace(/[，,。、"'）)】\]]+$/, '');
  t = t.replace(/[，,。、"'）)】\]\s]+$/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s，,。、"'）)】\]]*)?$/i.test(t)) return 'https://' + t;
  return t;
}

/** 同日同源去重（PRD R-05）：命中回档上次结果、不重复扣积分 */
async function findDup(userId, hashKey) {
  const since = new Date(Date.now() - DUP_WINDOW_MS);
  const r = await COLL
    .copywritings()
    .where({
      uid: userId,
      deleted: false,
      dedup_key: hashKey,
      created_at: cmd().gt(since),
    })
    .orderBy('created_at', 'desc')
    .limit(1)
    .get();
  return r.data && r.data.length ? r.data[0] : null;
}

exports.main = async (event) => {
  try {
    const rawUrl = String((event && (event.url || event.shareUrl)) || '').trim();
    // 链接常混着口令 / 分享文案，兜底再抽一次；裸域名自动补协议头
    const url = normalizeShareUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) {
      return err(
        '没找到链接，请粘贴完整的视频分享链接（支持：' + providers.SUPPORTED_PLATFORM_TEXT + '）',
        2
      );
    }

    const user = await ensureUserFromContext();
    if (!user) return err('请先登录', 401);

    // 平台识别：未识别平台不再硬拒（域名变体太多，硬拒会误杀真实视频号链接），
    // 能否取到源由取源环节判定，见 PRD 12.10。
    const platform = providers.detectPlatform(url);
    if (!providers.isSupportedPlatform(platform)) {
      console.warn('[parseLink] 未识别平台，按通用方式尝试：', platform);
    }

    // 去重（同源 hash）
    const hashKey = md5(url.replace(/[?#].*$/, ''));
    const dup = await findDup(user._id, hashKey);
    if (dup) {
      await track({
        uid: user._id,
        event: 'forward_received',
        props: { source_platform: platform, duplicated: true },
      });
      return ok({
        duplicated: true,
        copywritingId: dup._id,
        hint: '这条你之前提取过，点击查看上次结果',
      });
    }

    // 并发检查（≤3）
    const active = await countActiveTasks(user._id);
    if (active >= MAX_USER_CONCURRENT) {
      return err('正在解析的任务有点多，请稍等片刻再试', 2);
    }

    // 建任务（pending 先落库，防丢，PRD 8.2）
    const addRes = await COLL.tasks().add({
      data: {
        uid: user._id,
        userOpenid: '',
        channel: 'B',
        msg_id: '',
        share_url: url,
        video_url: url,
        source_platform: platform,
        dedup_key: hashKey,
        status: 'pending',
        attempt_log: [],
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // 只入队，不在此处跑流水线：
    // 真实链路（取源 → 下载 → 转写 → 整理）单步就可能超过云函数超时上限，
    // 推进交给前端轮询 getTask（每次一步）与 parsePipeline 定时器兜底。任务已落库，可续跑。
    await track({
      uid: user._id,
      event: 'forward_received',
      props: { source_platform: platform, duplicated: false },
    });

    return ok({
      taskId: addRes._id,
      duplicated: false,
      status: 'pending',
      platform,
    });
  } catch (e) {
    return err((e && (e.msg || e.message)) || '解析发起失败，请稍后重试', (e && e.code) || 1);
  }
};
