'use strict';

/**
 * 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名。
 *
 * 单独成文件是为了能被单测直接调用：签名一旦算错，线上表现只有一句
 * AuthFailure.SignatureFailure，很难定位。拆出来后可以先拿官方文档的示例
 * 把规范请求串和它的哈希钉死，再拼 Authorization。
 *
 * 校验脚本：.workbuddy-ai/tmp/check-tc3.js
 */

const crypto = require('crypto');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/* 参数顺序 key 在前、message 在后，返回二进制，中途不要转字符串 */
function hmac(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

/* 日期必须由时间戳按 UTC 换算。取本地时区会在凌晨那几个小时签错，表现为「白天能用、凌晨必失败」 */
function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

const DEFAULT_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * 规范请求串。
 * 注意 canonicalHeaders 末尾带换行，再拼一个 \n，headers 与 signedHeaders 之间就会多出空行 ——
 * 规范要求如此，漏掉这个空行是最常见的签名失败原因。
 */
function canonicalRequestOf({ host, action, payload, contentType = DEFAULT_CONTENT_TYPE, signedHeaders }) {
  const headers =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-tc-action:${String(action).toLowerCase()}\n`;
  const signed = signedHeaders || 'content-type;host;x-tc-action';

  return {
    signedHeaders: signed,
    canonicalRequest: ['POST', '/', '', headers, signed, sha256Hex(payload)].join('\n')
  };
}

function stringToSignOf({ canonicalRequest, timestamp, date, service }) {
  return [
    'TC3-HMAC-SHA256',
    String(timestamp),
    `${date}/${service}/tc3_request`,
    sha256Hex(canonicalRequest)
  ].join('\n');
}

/* 派生密钥链：kDate -> kService -> kSigning，三步都是二进制传递 */
function signingKeyOf({ secretKey, date, service }) {
  const kDate = hmac('TC3' + secretKey, date);
  const kService = hmac(kDate, service);
  return hmac(kService, 'tc3_request');
}

function buildAuthorization({ host, service, secretId, secretKey, action, timestamp, payload, contentType }) {
  const date = utcDate(timestamp);
  const { signedHeaders, canonicalRequest } = canonicalRequestOf({ host, action, payload, contentType });
  const stringToSign = stringToSignOf({ canonicalRequest, timestamp, date, service });
  const signingKey = signingKeyOf({ secretKey, date, service });
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${date}/${service}/tc3_request, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    date,
    signature,
    canonicalRequest
  };
}

module.exports = {
  DEFAULT_CONTENT_TYPE,
  sha256Hex,
  utcDate,
  canonicalRequestOf,
  stringToSignOf,
  signingKeyOf,
  buildAuthorization
};
