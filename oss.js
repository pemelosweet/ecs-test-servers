// 文件存储：阿里云 OSS（走 S3 兼容协议）
// 配置了 OSS_BUCKET_NAME 才启用，否则返回 undefined 回退 Parse Server 默认存储（MongoDB GridFS）
const config = require('./config');

function buildOssAdapter() {
  const { ACCESS_KEY_ID, ACCESS_KEY_SECRET, BUCKET_NAME, REGION, ENDPOINT } = config.OSS;
  if (!BUCKET_NAME) return undefined;

  // 端点规范化：OSS 的 S3 兼容端点需带 s3. 前缀和 https 协议
  // 如配置 oss-cn-beijing.aliyuncs.com → https://s3.oss-cn-beijing.aliyuncs.com
  let endpoint = ENDPOINT || `s3.oss-${REGION || 'cn-beijing'}.aliyuncs.com`;
  if (!endpoint.startsWith('http')) {
    endpoint = `https://${endpoint.startsWith('s3.') ? endpoint : `s3.${endpoint}`}`;
  }
  const region = REGION || endpoint.match(/oss-([a-z-]+\d?)\./)?.[1] || 'cn-beijing';
  console.log(`Files storage: Aliyun OSS (bucket=${BUCKET_NAME}, endpoint=${endpoint})`);

  const S3Adapter = require('@parse/s3-files-adapter');
  return new S3Adapter({
    bucket: BUCKET_NAME,
    region,
    // 凭证放顶层，适配器才会识别
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: ACCESS_KEY_SECRET,
    },
    // endpoint 等 S3 客户端参数需通过 s3overrides 传入
    s3overrides: {
      endpoint,
      // OSS S3 兼容接口要求 virtual-hosted style（bucket.域名），不能用 path-style
      forcePathStyle: false,
    },
    // 文件 URL 直接指向 OSS，不再走 Parse Server 转发
    directAccess: true,
    // 不设置 baseUrl 时适配器会硬编码 AWS 域名，这里指向 OSS 的 virtual-hosted 地址
    baseUrl: `https://${BUCKET_NAME}.s3.oss-${region}.aliyuncs.com`,
  });
}

module.exports = buildOssAdapter;
