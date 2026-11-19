'use strict';

/**
 * AK/SK 落盘加密。主密钥来源优先级：
 *   1. 环境变量 MASTER_KEY（32 字节的 base64）
 *   2. $DATA_DIR/master.key（首次启动自动生成，权限 600）
 * 换了主密钥，已存的所有账号凭据都解不开，只能重新录入 —— 这个文件要单独备份。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function readKeyFile(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${file} 不是 32 字节 base64，删掉它重启会自动重建（已存的账号需重新录入）`);
  return buf;
}

function loadKey(dataDir) {
  const fromEnv = process.env.MASTER_KEY;
  if (fromEnv && fromEnv.trim()) {
    const buf = Buffer.from(fromEnv.trim(), 'base64');
    if (buf.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节的 base64（例如 openssl rand -base64 32）');
    return buf;
  }

  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) return readKeyFile(file);

  const buf = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, buf.toString('base64') + '\n', { mode: 0o600 });
  return buf;
}

function createCipher(key) {
  return {
    encrypt(plain) {
      if (plain === null || plain === undefined || plain === '') return null;
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },

    decrypt(payload) {
      if (!payload) return null;
      const raw = Buffer.from(payload, 'base64');
      const iv = raw.subarray(0, IV_LEN);
      const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const body = raw.subarray(IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    }
  };
}

module.exports = { loadKey, createCipher };
